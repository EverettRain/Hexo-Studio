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

/// An image's uid: the first 12 hex digits of the SHA-256 of its original bytes. The same
/// picture always gets the same uid, so it is stored once however often it is added.
pub fn content_id(original: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(original);
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// `<prefix><project>/<uid>.<ext>`: images belong to the project, not to a page (one image may
/// be on many pages; which ones is worked out from the blog's text).
pub fn object_key(prefix: &str, project: &str, id: &str, ext: &str) -> String {
    format!("{prefix}{}/{id}.{ext}", segment(project))
}

/// The original's file name in the backup folder: `<uid>-<name>.<ext>`, readable in Finder and
/// unique by its uid.
pub fn backup_name(id: &str, original_file_name: &str) -> String {
    let (stem, ext) = split_name(original_file_name);
    if ext.is_empty() {
        format!("{id}-{}", segment(stem))
    } else {
        format!("{id}-{}.{ext}", segment(stem))
    }
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
    fn the_uid_depends_only_on_the_content() {
        // Act
        let a = content_id(b"same bytes");
        let again = content_id(b"same bytes");
        let other = content_id(b"other bytes");

        // Assert
        assert_eq!(a, again);
        assert_ne!(a, other);
        assert_eq!(a.len(), 12);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn keys_are_the_uid_under_the_project_and_prefix() {
        // Act / Assert
        assert_eq!(object_key("img/", "EverettBlog", "3f9a1c07b2e4", "webp"), "img/EverettBlog/3f9a1c07b2e4.webp");
        assert_eq!(object_key("", "My Blog", "3f9a1c07b2e4", "gif"), "My-Blog/3f9a1c07b2e4.gif");
    }

    #[test]
    fn backups_are_named_by_uid_and_original_name() {
        // Act / Assert
        assert_eq!(backup_name("3f9a1c07b2e4", "IMG 1442.JPG"), "3f9a1c07b2e4-IMG-1442.jpg");
        assert_eq!(backup_name("3f9a1c07b2e4", "README"), "3f9a1c07b2e4-README");
    }

    #[test]
    fn screenshots_are_named_by_time() {
        // Act
        let stem = screenshot_stem(jiff::civil::date(2025, 11, 24).at(1, 14, 20, 0));

        // Assert
        assert_eq!(stem, "image-20251124-011420");
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
