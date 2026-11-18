//! Naming uploaded images: `<prefix><project>/<page>/<image>` in the store, and how each image
//! is written (WebP or as it is).

use jiff::civil::DateTime;
use serde::{Deserialize, Serialize};

/// Characters that mean something in a URL or a path, or are awkward in one; each run of them
/// becomes a single `-`.
fn is_awkward(c: char) -> bool {
    c.is_whitespace() || c.is_control() || "?#%&+=/\\:*\"'<>|^`{}[]".contains(c)
}

/// One path segment from a file or folder name: URL-safe, Chinese kept, never empty.
pub fn segment(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if is_awkward(c) {
            if !out.ends_with('-') {
                out.push('-');
            }
        } else {
            out.push(c);
        }
    }
    let trimmed = out.trim_matches(|c| c == '-' || c == '.');
    if trimmed.is_empty() {
        "image".into()
    } else {
        trimmed.to_string()
    }
}

/// Splits `photo.JPG` into `("photo", "jpg")`; a name without one has an empty extension.
pub fn split_name(file_name: &str) -> (&str, String) {
    match file_name.rfind('.') {
        Some(i) if i > 0 => (&file_name[..i], file_name[i + 1..].to_ascii_lowercase()),
        _ => (file_name, String::new()),
    }
}

/// The name a pasted screenshot gets, from when it was pasted (in the blog's zone).
pub fn screenshot_stem(at: DateTime) -> String {
    format!("image-{}", at.strftime("%Y%m%d-%H%M%S"))
}

/// `<prefix><project>/<page>/<stem>.<ext>`; the page keeps its folders (`notes/c1`).
pub fn object_key(prefix: &str, project: &str, page: &str, stem: &str, ext: &str) -> String {
    let page: Vec<String> = page.split('/').filter(|p| !p.is_empty()).map(segment).collect();
    let name = if ext.is_empty() { segment(stem) } else { format!("{}.{ext}", segment(stem)) };
    format!("{prefix}{}/{}/{name}", segment(project), page.join("/"))
}

/// `a/b.webp` → `a/b-2.webp` for `n = 2`: the next name to try when one is taken.
pub fn numbered(key: &str, n: u32) -> String {
    let name_start = key.rfind('/').map_or(0, |i| i + 1);
    match key[name_start..].rfind('.') {
        Some(dot) if dot > 0 => {
            let at = name_start + dot;
            format!("{}-{n}{}", &key[..at], &key[at..])
        }
        _ => format!("{key}-{n}"),
    }
}

/// The first of `key`, `key-2`, `key-3`, ... that `taken` says is free.
pub fn first_free(key: &str, mut taken: impl FnMut(&str) -> bool) -> String {
    if !taken(key) {
        return key.to_string();
    }
    (2..).map(|n| numbered(key, n)).find(|k| !taken(k)).expect("an unbounded range ends with a free name")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    /// Lossy WebP, scaled down to the longest edge (the default).
    Webp,
    /// The file as it is.
    Original,
}

/// What is uploaded for a file of this extension: WebP unless asked for the original, or the
/// file is one WebP would spoil (an animated GIF loses its animation, an SVG its vectors).
pub fn output_format(ext: &str, asked: Format) -> Format {
    match (ext, asked) {
        ("gif" | "svg" | "ico", _) | (_, Format::Original) => Format::Original,
        _ => Format::Webp,
    }
}

/// Size within `max_edge` on the longer side, keeping the aspect; never enlarged.
pub fn fit(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge || max_edge == 0 {
        return (width, height);
    }
    let scale = max_edge as f64 / longest as f64;
    (((width as f64 * scale).round() as u32).max(1), ((height as f64 * scale).round() as u32).max(1))
}

/// The `Content-Type` an object is served with.
pub fn content_type(ext: &str) -> &'static str {
    match ext {
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_replace_awkward_characters_and_keep_chinese() {
        // Act / Assert
        assert_eq!(segment("屏幕截图 2025-11-24 at 01.14.20"), "屏幕截图-2025-11-24-at-01.14.20");
        assert_eq!(segment("a?b#c%d&e+f"), "a-b-c-d-e-f");
        assert_eq!(segment("  --IMG_1442--  "), "IMG_1442");
        assert_eq!(segment("..."), "image");
        assert_eq!(segment(""), "image");
    }

    #[test]
    fn names_split_into_stem_and_lowercase_extension() {
        // Act / Assert
        assert_eq!(split_name("IMG_1442.JPG"), ("IMG_1442", "jpg".to_string()));
        assert_eq!(split_name("archive.tar.gz"), ("archive.tar", "gz".to_string()));
        assert_eq!(split_name(".hidden"), (".hidden", String::new()));
        assert_eq!(split_name("README"), ("README", String::new()));
    }

    #[test]
    fn keys_are_project_page_image_under_the_prefix() {
        // Act
        let key = object_key("img/", "EverettBlog", "pointer-security", "Smart pointer 图", "webp");

        // Assert
        assert_eq!(key, "img/EverettBlog/pointer-security/Smart-pointer-图.webp");
    }

    #[test]
    fn a_page_in_a_subfolder_keeps_its_folders() {
        // Act
        let key = object_key("", "Blog", "notes/c 1", "a", "png");

        // Assert
        assert_eq!(key, "Blog/notes/c-1/a.png");
    }

    #[test]
    fn screenshots_are_named_by_time() {
        // Act
        let stem = screenshot_stem(jiff::civil::date(2025, 11, 24).at(1, 14, 20, 0));

        // Assert
        assert_eq!(stem, "image-20251124-011420");
    }

    #[test]
    fn taken_names_get_the_next_number_before_the_extension() {
        // Arrange
        let taken = ["p/a.webp", "p/a-2.webp"];

        // Act
        let key = first_free("p/a.webp", |k| taken.contains(&k));

        // Assert
        assert_eq!(key, "p/a-3.webp");
        assert_eq!(first_free("p/free.webp", |_| false), "p/free.webp");
        assert_eq!(numbered("p.v1/readme", 2), "p.v1/readme-2");
    }

    #[test]
    fn webp_is_the_default_except_where_it_would_spoil_the_image() {
        // Act / Assert
        assert_eq!(output_format("jpg", Format::Webp), Format::Webp);
        assert_eq!(output_format("png", Format::Webp), Format::Webp);
        assert_eq!(output_format("gif", Format::Webp), Format::Original);
        assert_eq!(output_format("svg", Format::Webp), Format::Original);
        assert_eq!(output_format("jpg", Format::Original), Format::Original);
    }

    #[test]
    fn large_images_shrink_to_the_longest_edge_and_small_ones_stay() {
        // Act / Assert
        assert_eq!(fit(4032, 3024, 2560), (2560, 1920));
        assert_eq!(fit(1170, 2532, 2560), (1170, 2532));
        assert_eq!(fit(3000, 1, 1500), (1500, 1));
        assert_eq!(fit(800, 600, 0), (800, 600));
    }

    #[test]
    fn content_types_follow_the_extension() {
        // Act / Assert
        assert_eq!(content_type("webp"), "image/webp");
        assert_eq!(content_type("jpeg"), "image/jpeg");
        assert_eq!(content_type("xyz"), "application/octet-stream");
    }
}
