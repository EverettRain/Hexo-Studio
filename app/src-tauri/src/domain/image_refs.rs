//! Finding a store's images in the blog's text: which library images each file uses, which
//! store images the library does not have yet, and rewriting addresses (design section 6.3).

use super::catalog::{Catalog, ChecklistRow};
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

/// A text file of the blog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    /// Path from the blog root, e.g. `source/_posts/a.md`.
    pub file: String,
    /// The post's or page's title; `None` for configs and data files.
    pub title: Option<String>,
    pub text: String,
}

/// Which files use each library image (by uid), found by its address or a former one.
pub fn usages(sources: &[Source], bases: &[String], catalog: &Catalog) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for src in sources {
        for f in find(&src.text, bases) {
            let Some(img) = catalog.by_key(&f.key).or_else(|| catalog.by_url(&f.url)) else { continue };
            let files = out.entry(img.id.clone()).or_default();
            if !files.contains(&src.file) {
                files.push(src.file.clone());
            }
        }
    }
    out
}

/// An image in the store that the library does not have yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub old_key: String,
    /// Every way the blog (or the checklist) writes its address.
    pub old_urls: Vec<String>,
    /// Files that refer to it, in the order given.
    pub files: Vec<String>,
    /// The title of the first post or page using it, for a default description.
    pub first_title: Option<String>,
    /// What the user's checklist says about it, when a checklist was given.
    pub row: Option<ChecklistRow>,
}

/// The store's images to take into the library: those the blog refers to and those the
/// checklist lists, minus what the library has (by key or former address). In order of first
/// mention: the blog's files first, then the checklist's remaining rows.
pub fn adoption(sources: &[Source], bases: &[String], catalog: &Catalog, checklist: &[ChecklistRow]) -> Vec<Candidate> {
    let mut list: Vec<Candidate> = Vec::new();
    let known = |f: &Found| catalog.by_key(&f.key).is_some() || catalog.by_url(&f.url).is_some();
    let mut note = |f: Found, file: Option<&str>, title: Option<&String>| {
        let at = match list.iter().position(|c| c.old_key == f.key) {
            Some(i) => i,
            None => {
                list.push(Candidate { old_key: f.key.clone(), old_urls: Vec::new(), files: Vec::new(), first_title: None, row: None });
                list.len() - 1
            }
        };
        let c = &mut list[at];
        if !c.old_urls.contains(&f.url) {
            c.old_urls.push(f.url.clone());
        }
        if let Some(file) = file {
            if !c.files.iter().any(|x| x == file) {
                c.files.push(file.to_string());
            }
        }
        if c.first_title.is_none() {
            c.first_title = title.cloned();
        }
    };
    for src in sources {
        for f in find(&src.text, bases) {
            if !known(&f) {
                note(f, Some(&src.file), src.title.as_ref());
            }
        }
    }
    for row in checklist {
        if let Some(f) = find(&row.url, bases).into_iter().next() {
            if !known(&f) {
                note(f, None, None);
            }
        }
    }
    for row in checklist {
        if let Some(f) = find(&row.url, bases).into_iter().next() {
            if let Some(c) = list.iter_mut().find(|c| c.old_key == f.key) {
                c.row = Some(row.clone());
            }
        }
    }
    list
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

    fn src(file: &str, title: Option<&str>, text: &str) -> Source {
        Source { file: file.into(), title: title.map(String::from), text: text.into() }
    }

    fn library_image(id: &str, legacy: &str) -> crate::domain::catalog::Image {
        crate::domain::catalog::Image {
            id: id.into(),
            name: id.into(),
            description: String::new(),
            ok: None,
            key: format!("Blog/{id}.webp"),
            url: format!("{BASE}/Blog/{id}.webp"),
            uploaded_at: String::new(),
            mirrors: vec![],
            format: crate::domain::image_key::Format::Webp,
            bytes: 0,
            width: 0,
            height: 0,
            original: Default::default(),
            legacy_urls: vec![legacy.into()],
        }
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
    fn usages_count_new_and_former_addresses_once_per_file() {
        // Arrange
        let catalog = Catalog { version: 1, images: vec![library_image("aaa", &format!("{BASE}/old.jpg"))] };
        let sources = [
            src("source/_posts/a.md", Some("A"), &format!("![]({BASE}/Blog/aaa.webp) ![]({BASE}/Blog/aaa.webp)")),
            src("source/_posts/b.md", Some("B"), &format!("cover: {BASE}/old.jpg")),
            src("_config.yml", None, &format!("x: {BASE}/unknown.png")),
        ];

        // Act
        let used = usages(&sources, &bases(), &catalog);

        // Assert
        assert_eq!(used.len(), 1);
        assert_eq!(used["aaa"], ["source/_posts/a.md", "source/_posts/b.md"]);
    }

    #[test]
    fn adoption_lists_images_the_library_lacks_with_their_files_and_checklist_row() {
        // Arrange
        let catalog = Catalog { version: 1, images: vec![library_image("aaa", &format!("{BASE}/known.jpg"))] };
        let sources = [
            src("_config.anzhiyu.yml", None, &format!("avatar: {BASE}/avatar.jpg")),
            src("source/_posts/a.md", Some("文章 A"), &format!("![]({BASE}/IMG_1.JPG) ![]({BASE}/avatar.jpg) ![]({BASE}/known.jpg)")),
            src("source/_posts/b.md", Some("文章 B"), &format!("![]({BASE}/IMG_1.JPG)")),
        ];
        let row = ChecklistRow { name: "unused one".into(), url: format!("{BASE}/unused.png"), ..ChecklistRow::default() };
        let avatar_row = ChecklistRow { name: "avatar".into(), url: format!("{BASE}/avatar.jpg"), ..ChecklistRow::default() };

        // Act
        let list = adoption(&sources, &bases(), &catalog, &[row.clone(), avatar_row.clone()]);

        // Assert
        let keys: Vec<&str> = list.iter().map(|c| c.old_key.as_str()).collect();
        assert_eq!(keys, ["avatar.jpg", "IMG_1.JPG", "unused.png"]);
        assert_eq!(list[0].files, ["_config.anzhiyu.yml", "source/_posts/a.md"]);
        assert_eq!(list[0].first_title.as_deref(), Some("文章 A"));
        assert_eq!(list[0].row, Some(avatar_row));
        assert_eq!(list[1].files, ["source/_posts/a.md", "source/_posts/b.md"]);
        assert!(list[2].files.is_empty());
        assert_eq!(list[2].row, Some(row));
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
