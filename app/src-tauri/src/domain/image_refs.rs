//! Finding a store's images in the blog's text, and planning their move to
//! `<prefix><project>/<page>/<name>.webp` (design section 6.3).

use super::image_key::{self, Format};
use std::collections::BTreeMap;

/// One occurrence of a store address in a file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub url: String,
    /// The object key the address names (percent-decoded).
    pub key: String,
}

/// Where an address ends in Markdown, HTML, YAML and Hexo tags: `![](…)`, `<img src="…">`,
/// `cover: …`, `{% image …, width=400px %}`.
fn ends_url(c: char) -> bool {
    c.is_whitespace() || "()\"'<>[]{},|`".contains(c)
}

/// Every address in `text` that starts with one of `bases` (each like
/// `https://bucket.oss-cn-shanghai.aliyuncs.com`, no trailing slash), in order.
pub fn find(text: &str, bases: &[String]) -> Vec<Found> {
    let mut out = Vec::new();
    for base in bases.iter().filter(|b| !b.is_empty()) {
        let prefix = format!("{base}/");
        let mut from = 0;
        while let Some(i) = text[from..].find(&prefix) {
            let start = from + i;
            let rest = &text[start + prefix.len()..];
            let len = rest.find(ends_url).unwrap_or(rest.len());
            let raw_key = &rest[..len];
            from = start + prefix.len() + len;
            if raw_key.is_empty() {
                continue;
            }
            let path = raw_key.split(['?', '#']).next().unwrap_or(raw_key);
            let key = url::form_urlencoded::parse(format!("k={}", path.replace('+', "%2B")).as_bytes())
                .next()
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            // The address without its query: rewriting keeps `?x-oss-process=…` as it is.
            out.push(Found { url: format!("{prefix}{path}"), key });
        }
    }
    out
}

/// A text file of the blog and the page its images belong to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    /// Path from the blog root, e.g. `source/_posts/a.md`.
    pub file: String,
    /// The page name for image paths; `None` for site-wide files (configs, `_data`).
    pub page: Option<String>,
    pub text: String,
}

/// One image to move.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Move {
    /// Every way the blog writes its address (encoded or not, custom domain or bucket's).
    pub old_urls: Vec<String>,
    pub old_key: String,
    /// Where it goes before a free name is chosen (`-2` … if taken).
    pub new_key: String,
    pub format: Format,
    /// Files that refer to it, in the order given.
    pub files: Vec<String>,
}

/// Page used for images that only site-wide files refer to.
pub const SITE_PAGE: &str = "_site";

/// Plans the move of every image of the store not yet under `<prefix><project>/`. An image goes
/// under the first page (in `sources` order) that refers to it, else under `_site`.
pub fn plan(sources: &[Source], bases: &[String], prefix: &str, project: &str) -> Vec<Move> {
    let done = format!("{prefix}{}/", image_key::segment(project));
    let mut moves: BTreeMap<String, (usize, Move, bool)> = BTreeMap::new();
    let mut order = 0;
    for src in sources {
        for f in find(&src.text, bases) {
            if f.key.starts_with(&done) {
                continue;
            }
            let entry = moves.entry(f.key.clone()).or_insert_with(|| {
                order += 1;
                (
                    order,
                    Move { old_urls: Vec::new(), old_key: f.key.clone(), new_key: String::new(), format: Format::Webp, files: Vec::new() },
                    false,
                )
            });
            if !entry.1.old_urls.contains(&f.url) {
                entry.1.old_urls.push(f.url.clone());
            }
            if !entry.1.files.contains(&src.file) {
                entry.1.files.push(src.file.clone());
            }
            if !entry.2 {
                if let Some(page) = &src.page {
                    entry.1.new_key = page.clone();
                    entry.2 = true;
                }
            }
        }
    }
    let mut list: Vec<(usize, Move)> = moves
        .into_values()
        .map(|(n, mut m, _)| {
            let page = if m.new_key.is_empty() { SITE_PAGE.to_string() } else { m.new_key.clone() };
            let file_name = m.old_key.rsplit('/').next().unwrap_or(&m.old_key).to_string();
            let (stem, ext) = image_key::split_name(&file_name);
            m.format = image_key::output_format(&ext, Format::Webp);
            let out_ext = if m.format == Format::Webp { "webp".to_string() } else { ext };
            m.new_key = image_key::object_key(prefix, project, &page, stem, &out_ext);
            (n, m)
        })
        .collect();
    list.sort_by_key(|(n, _)| *n);
    list.into_iter().map(|(_, m)| m).collect()
}

/// Replaces whole addresses in a text: `from` only where it ends at an address boundary, so
/// `…/a.jpg` does not touch `…/a.jpg.bak`. Everything else stays byte for byte.
pub fn rewrite(text: &str, replacements: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (from, to) in replacements {
        let mut result = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(i) = rest.find(from.as_str()) {
            let after = &rest[i + from.len()..];
            let boundary = after.chars().next().is_none_or(ends_url) || after.starts_with('?') || after.starts_with('#');
            result.push_str(&rest[..i]);
            result.push_str(if boundary { to } else { from });
            rest = after;
        }
        result.push_str(rest);
        out = result;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://hexo-image-storage.oss-cn-shanghai.aliyuncs.com";

    fn bases() -> Vec<String> {
        vec![BASE.to_string()]
    }

    fn src(file: &str, page: Option<&str>, text: &str) -> Source {
        Source { file: file.into(), page: page.map(String::from), text: text.into() }
    }

    #[test]
    fn finds_addresses_in_markdown_html_yaml_and_hexo_tags() {
        // Arrange
        let text = format!(
            "cover: {BASE}/IMG_1442.JPG\n![]({BASE}/a.png)\n<img src=\"{BASE}/b.jpg\" width=300>\n{{% image {BASE}/useTime.png, width=400px %}}\nhttps://example.com/x.png"
        );

        // Act
        let keys: Vec<String> = find(&text, &bases()).into_iter().map(|f| f.key).collect();

        // Assert
        assert_eq!(keys, ["IMG_1442.JPG", "a.png", "b.jpg", "useTime.png"]);
    }

    #[test]
    fn keys_are_percent_decoded_and_queries_dropped() {
        // Arrange
        let text = format!("![]({BASE}/%E5%9B%BE%201.png?x-oss-process=image/resize,w_240)");

        // Act
        let f = find(&text, &bases());

        // Assert
        assert_eq!(f[0].key, "图 1.png");
        assert_eq!(f[0].url, format!("{BASE}/%E5%9B%BE%201.png"));
    }

    #[test]
    fn an_image_goes_under_the_first_page_that_uses_it() {
        // Arrange
        let sources = [
            src("_config.anzhiyu.yml", None, &format!("avatar: {BASE}/avatar.jpg")),
            src("source/_posts/a.md", Some("a"), &format!("![]({BASE}/IMG_1.JPG) ![]({BASE}/avatar.jpg)")),
            src("source/_posts/b.md", Some("b"), &format!("![]({BASE}/IMG_1.JPG)")),
        ];

        // Act
        let moves = plan(&sources, &bases(), "", "EverettBlog");

        // Assert
        let keys: Vec<(&str, &str)> = moves.iter().map(|m| (m.old_key.as_str(), m.new_key.as_str())).collect();
        assert_eq!(keys, [("avatar.jpg", "EverettBlog/a/avatar.webp"), ("IMG_1.JPG", "EverettBlog/a/IMG_1.webp")]);
        assert_eq!(moves[0].files, ["_config.anzhiyu.yml", "source/_posts/a.md"]);
        assert_eq!(moves[1].files, ["source/_posts/a.md", "source/_posts/b.md"]);
    }

    #[test]
    fn site_wide_images_go_under_site_and_gifs_keep_their_format() {
        // Arrange
        let sources = [src("source/_data/link.yml", None, &format!("- avatar: {BASE}/friend.gif"))];

        // Act
        let moves = plan(&sources, &bases(), "img/", "EverettBlog");

        // Assert
        assert_eq!(moves[0].new_key, "img/EverettBlog/_site/friend.gif");
        assert_eq!(moves[0].format, Format::Original);
    }

    #[test]
    fn images_already_under_the_project_are_left_alone() {
        // Arrange
        let sources = [src("source/_posts/a.md", Some("a"), &format!("![]({BASE}/EverettBlog/a/x.webp) ![]({BASE}/old.png)"))];

        // Act
        let moves = plan(&sources, &bases(), "", "EverettBlog");

        // Assert
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].old_key, "old.png");
    }

    #[test]
    fn rewriting_keeps_a_query_after_the_address() {
        // Arrange
        let text = format!("![]({BASE}/a.jpg?x-oss-process=image/resize,w_240)");

        // Act
        let out = rewrite(&text, &[(format!("{BASE}/a.jpg"), "https://new/x.webp".into())]);

        // Assert
        assert_eq!(out, "![](https://new/x.webp?x-oss-process=image/resize,w_240)");
    }

    #[test]
    fn rewriting_replaces_whole_addresses_only() {
        // Arrange
        let text = format!("![]({BASE}/a.jpg)\nkeep {BASE}/a.jpg.bak\ncover: {BASE}/a.jpg\n");
        let to = "https://new/x.webp".to_string();

        // Act
        let out = rewrite(&text, &[(format!("{BASE}/a.jpg"), to)]);

        // Assert
        assert_eq!(out, format!("![](https://new/x.webp)\nkeep {BASE}/a.jpg.bak\ncover: https://new/x.webp\n"));
    }
}
