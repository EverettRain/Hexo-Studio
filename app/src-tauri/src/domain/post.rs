//! A post file: its front-matter block and the few fields the list shows.
//!
//! The list only reads; saving goes through the interface, which edits the YAML document in
//! place so formatting, comments and unknown keys survive (see `app/src/lib/frontmatter.ts`).

use yaml_rust2::{Yaml, YamlLoader};

/// A post's text cut into its parts; `prefix + yaml + suffix + body` is the whole file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parts<'a> {
    /// The opening delimiter line, with its line break; empty without front-matter.
    pub prefix: &'a str,
    pub yaml: &'a str,
    /// The closing delimiter line, with its line break.
    pub suffix: &'a str,
    pub body: &'a str,
}

fn is_delimiter(line: &str) -> bool {
    let line = line.trim_end_matches(['\r', '\n']);
    line.len() >= 3 && line.bytes().all(|b| b == b'-')
}

/// Splits off a front-matter block that opens on the first line with `---` and closes with the
/// next line of only dashes. Hexo also accepts JSON (`;;;`) and a block with no opening line;
/// neither is used by the blog, so such a file counts as all body.
pub fn split(text: &str) -> Parts<'_> {
    let none = Parts { prefix: "", yaml: "", suffix: "", body: text };
    let first_end = text.find('\n').map_or(text.len(), |i| i + 1);
    if !is_delimiter(&text[..first_end]) {
        return none;
    }
    let mut at = first_end;
    while at < text.len() {
        let end = text[at..].find('\n').map_or(text.len(), |i| at + i + 1);
        if is_delimiter(&text[at..end]) {
            return Parts { prefix: &text[..first_end], yaml: &text[first_end..at], suffix: &text[at..end], body: &text[end..] };
        }
        at = end;
    }
    none
}

/// The front-matter fields the post list and the preview address need.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Meta {
    pub title: Option<String>,
    /// As written, e.g. `2025-11-24 01:14:20`; interpreted by `permalink::post_date`.
    pub date: Option<String>,
    pub tags: Vec<String>,
    pub categories: Vec<String>,
    /// A per-post address that replaces the configured pattern.
    pub permalink: Option<String>,
}

fn scalar(y: &Yaml) -> Option<String> {
    match y {
        Yaml::String(s) => Some(s.clone()),
        Yaml::Integer(i) => Some(i.to_string()),
        Yaml::Real(r) => Some(r.clone()),
        Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
    .filter(|s| !s.trim().is_empty())
}

/// A string or a list of them; nested lists (Hexo's parallel category paths) are flattened.
fn names(y: &Yaml, out: &mut Vec<String>) {
    match y {
        Yaml::Array(items) => items.iter().for_each(|i| names(i, out)),
        other => {
            if let Some(s) = scalar(other) {
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    }
}

impl Meta {
    /// Reads the fields from a front-matter block; invalid YAML gives empty fields, as the list
    /// still shows the file (by its name) so it can be opened and fixed.
    pub fn parse(yaml: &str) -> Meta {
        let Some(doc) = YamlLoader::load_from_str(yaml).ok().and_then(|d| d.into_iter().next()) else { return Meta::default() };
        let mut tags = Vec::new();
        names(&doc["tags"], &mut tags);
        let mut categories = Vec::new();
        names(&doc["categories"], &mut categories);
        Meta { title: scalar(&doc["title"]), date: scalar(&doc["date"]), tags, categories, permalink: scalar(&doc["permalink"]) }
    }
}

/// Hexo's slug for a post with `new_post_name: :title.md`: the path under `_posts` or `_drafts`
/// without its extension.
pub fn slug(relative_path: &str) -> String {
    let p = relative_path.replace('\\', "/");
    match p.rfind('.') {
        Some(dot) if dot > p.rfind('/').map_or(0, |s| s + 1) => p[..dot].to_string(),
        _ => p,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_front_matter_from_body() {
        // Arrange
        let text = "---\ntitle: A\n---\n\nHello\n";

        // Act
        let p = split(text);

        // Assert
        assert_eq!(p, Parts { prefix: "---\n", yaml: "title: A\n", suffix: "---\n", body: "\nHello\n" });
    }

    #[test]
    fn the_parts_join_back_to_the_exact_text() {
        // Arrange
        let texts = ["---\r\ntitle: A\r\n----\r\nbody", "---\n---\n", "---\ntitle: A\n---", "no front matter\n---\n", ""];

        for text in texts {
            // Act
            let p = split(text);

            // Assert
            assert_eq!(format!("{}{}{}{}", p.prefix, p.yaml, p.suffix, p.body), text);
        }
    }

    #[test]
    fn crlf_and_longer_delimiters_are_recognised() {
        // Arrange
        let text = "---\r\ntitle: A\r\n-----\r\nbody";

        // Act
        let p = split(text);

        // Assert
        assert_eq!((p.yaml, p.body), ("title: A\r\n", "body"));
    }

    #[test]
    fn a_closing_line_at_the_very_end_needs_no_line_break() {
        // Act
        let p = split("---\ntitle: A\n---");

        // Assert
        assert_eq!((p.yaml, p.suffix, p.body), ("title: A\n", "---", ""));
    }

    #[test]
    fn an_unclosed_or_missing_block_is_all_body() {
        // Arrange
        let unclosed = "---\ntitle: A\nno end";
        let missing = "# Title\n---\nmore";

        // Act / Assert
        assert_eq!(split(unclosed).body, unclosed);
        assert_eq!(split(unclosed).yaml, "");
        assert_eq!(split(missing).body, missing);
    }

    #[test]
    fn a_horizontal_rule_in_the_body_is_not_a_delimiter() {
        // Act
        let p = split("---\ntitle: A\n---\ntext\n---\nmore\n");

        // Assert
        assert_eq!(p.body, "text\n---\nmore\n");
    }

    #[test]
    fn reads_the_blogs_usual_fields() {
        // Arrange
        let yaml = "title: MacBook Pro 2024 真实体验\ndate: 2025-02-15 10:03:03\ntags:\n  - 分享\n  - Mac\n\
                    categories:\n  - 大学生活\ndescription: x\ncover: https://example.com/a.jpg\n";

        // Act
        let m = Meta::parse(yaml);

        // Assert
        assert_eq!(
            m,
            Meta {
                title: Some("MacBook Pro 2024 真实体验".into()),
                date: Some("2025-02-15 10:03:03".into()),
                tags: vec!["分享".into(), "Mac".into()],
                categories: vec!["大学生活".into()],
                permalink: None,
            }
        );
    }

    #[test]
    fn single_values_nested_lists_and_numbers_become_names() {
        // Arrange
        let yaml = "tags: 2025\ncategories:\n  - [Diary, Life]\n  - [Diary]\n";

        // Act
        let m = Meta::parse(yaml);

        // Assert
        assert_eq!((m.tags, m.categories), (vec!["2025".to_string()], vec!["Diary".to_string(), "Life".to_string()]));
    }

    #[test]
    fn empty_values_count_as_missing() {
        // Arrange
        let yaml = "title:\ntags:\ncategories: \ndate: ''\n";

        // Act
        let m = Meta::parse(yaml);

        // Assert
        assert_eq!(m, Meta::default());
    }

    #[test]
    fn invalid_yaml_reads_as_no_fields() {
        // Act
        let m = Meta::parse("title: [unclosed");

        // Assert
        assert_eq!(m, Meta::default());
    }

    #[test]
    fn reads_a_per_post_permalink() {
        // Act
        let m = Meta::parse("permalink: about/me/\n");

        // Assert
        assert_eq!(m.permalink.as_deref(), Some("about/me/"));
    }

    #[test]
    fn slug_drops_the_extension_and_keeps_folders() {
        // Act / Assert
        assert_eq!(slug("搭建Hexo博客网站教程.md"), "搭建Hexo博客网站教程");
        assert_eq!(slug("notes/C01P01.md"), "notes/C01P01");
        assert_eq!(slug("v1.2/readme"), "v1.2/readme");
        assert_eq!(slug("a.b.markdown"), "a.b");
    }
}
