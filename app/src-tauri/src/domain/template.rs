//! What a new blog is made of: the base `hexo init` lays down, and a theme on top.

use serde::{Deserialize, Serialize};

/// A blog to start from: Hexo's base plus one theme.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// The folder under `themes/` and the `theme` of `_config.yml`.
    pub theme: &'static str,
    /// The theme on npm, unpacked into `themes/<theme>/`.
    pub package: &'static str,
    /// Plugins the theme needs installed in the blog (its renderers).
    pub plugins: &'static [&'static str],
    pub homepage: &'static str,
}

pub const TEMPLATES: [Template; 1] = [Template {
    id: "anzhiyu",
    name: "安知鱼 anzhiyu",
    description: "卡片式设计的中文主题，自带文章目录、侧栏卡片、评论与搜索等，配置页对它有专门的分组。",
    theme: "anzhiyu",
    package: "hexo-theme-anzhiyu",
    plugins: &["hexo-renderer-pug", "hexo-renderer-stylus"],
    homepage: "https://docs.anheyu.com/",
}];

pub fn find(id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.id == id)
}

/// hexo-starter's packages without its landscape theme and EJS renderer, which only landscape uses.
pub const BASE_PACKAGES: [&str; 7] = [
    "hexo",
    "hexo-generator-archive",
    "hexo-generator-category",
    "hexo-generator-index",
    "hexo-generator-tag",
    "hexo-renderer-marked",
    "hexo-server",
];

/// A blog without a template is what `hexo init` makes: the base with hexo-starter's own theme,
/// landscape, and the renderers it needs.
pub const PLAIN_THEME: &str = "landscape";
pub const PLAIN_PACKAGES: [&str; 3] = ["hexo-renderer-ejs", "hexo-renderer-stylus", "hexo-theme-landscape"];

/// The lowest Node the Hexo that `npm install hexo` gives today runs on (Hexo 8's `engines`).
pub const MIN_NODE: (u64, u64) = (20, 19);

/// `v22.13.1` is new enough; an unreadable version is let through (npm will say).
pub fn node_ok(version: &str) -> bool {
    let mut parts = version.trim().trim_start_matches('v').split('.').map(|p| p.parse::<u64>());
    match (parts.next(), parts.next()) {
        (Some(Ok(major)), Some(Ok(minor))) => (major, minor) >= MIN_NODE,
        _ => true,
    }
}

/// What the new blog's form asks for.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBlog {
    /// `None` makes a plain Hexo blog.
    pub template: Option<String>,
    /// The folder the blog's folder goes in.
    pub parent: String,
    /// The blog's own folder name.
    pub folder: String,
    pub title: String,
    pub author: String,
}

/// A name that stays one ordinary folder inside `parent`.
pub fn check_folder(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("请填写文件夹名。".into());
    }
    if name.starts_with('.') || name.contains(['/', ':', '\\']) {
        return Err("文件夹名不能以 . 开头，也不能包含 / : \\。".into());
    }
    Ok(())
}

/// The starter's `_config.yml` with this blog's lines: only these keys change, the rest stays as
/// Hexo writes it. Values are written as JSON strings, which YAML reads as double-quoted.
pub fn site_config(starter: &str, blog: &NewBlog, theme: &str, timezone: Option<&str>) -> String {
    let quote = |s: &str| serde_json::to_string(s.trim()).unwrap_or_default();
    let values = [
        ("title", quote(&blog.title)),
        ("author", quote(&blog.author)),
        ("language", "zh-CN".to_string()),
        ("timezone", timezone.map(quote).unwrap_or_else(|| "''".into())),
        ("theme", theme.to_string()),
    ];
    let mut out: String = starter
        .lines()
        .map(|line| {
            let key = line.split(':').next().unwrap_or("");
            match values.iter().find(|(k, _)| *k == key) {
                Some((k, v)) => format!("{k}: {v}"),
                None => line.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if starter.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// hexo-starter's `package.json` before its packages are installed. The `hexo` key is how
/// hexo-cli knows a blog folder; Hexo fills in its version when it first runs.
pub const PACKAGE_JSON: &str = r#"{
  "name": "hexo-site",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "hexo generate",
    "clean": "hexo clean",
    "deploy": "hexo deploy",
    "server": "hexo server"
  },
  "hexo": {
    "version": ""
  }
}
"#;

/// `/var/db/timezone/zoneinfo/Asia/Taipei` (where `/etc/localtime` points) → `Asia/Taipei`.
pub fn zone_from_localtime(link: &str) -> Option<String> {
    let (_, zone) = link.split_once("zoneinfo/")?;
    (!zone.is_empty()).then(|| zone.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blog(title: &str, author: &str) -> NewBlog {
        NewBlog { template: Some("anzhiyu".into()), parent: "/tmp".into(), folder: "b".into(), title: title.into(), author: author.into() }
    }

    #[test]
    fn site_config_sets_only_the_blogs_own_lines() {
        // Arrange
        let starter = "# Site\ntitle: Hexo\nsubtitle: ''\nauthor: John Doe\nlanguage: en\ntimezone: ''\n\n## Themes\ntheme: landscape\n";

        // Act
        let out = site_config(starter, &blog("我的 \"博客\"", "Everett"), "anzhiyu", Some("Asia/Taipei"));

        // Assert
        assert_eq!(
            out,
            "# Site\ntitle: \"我的 \\\"博客\\\"\"\nsubtitle: ''\nauthor: \"Everett\"\nlanguage: zh-CN\ntimezone: \"Asia/Taipei\"\n\n## Themes\ntheme: anzhiyu\n"
        );
    }

    #[test]
    fn site_config_keeps_the_starter_readable_by_hexo() {
        // Arrange
        let starter = include_str!("../../starter/_config.yml");

        // Act
        let out = site_config(starter, &blog("标题: 带冒号", ""), "anzhiyu", None);
        let doc = &yaml_rust2::YamlLoader::load_from_str(&out).unwrap()[0];

        // Assert
        assert_eq!(doc["title"].as_str(), Some("标题: 带冒号"));
        assert_eq!(doc["theme"].as_str(), Some("anzhiyu"));
        assert_eq!(doc["timezone"].as_str(), Some(""));
        assert_eq!(doc["permalink"].as_str(), Some(":year/:month/:day/:title/"));
        assert_eq!(out.lines().count(), starter.lines().count());
    }

    #[test]
    fn package_json_is_a_hexo_folder_without_packages() {
        // Act
        let pkg: serde_json::Value = serde_json::from_str(PACKAGE_JSON).unwrap();

        // Assert
        assert!(pkg["hexo"].is_object());
        assert!(pkg.get("dependencies").is_none());
    }

    #[test]
    fn node_ok_compares_against_the_lowest_version() {
        // Arrange
        let (major, minor) = MIN_NODE;

        // Act / Assert
        assert!(node_ok(&format!("v{major}.{minor}.0")));
        assert!(node_ok(&format!("v{}.0.0", major + 1)));
        assert!(!node_ok(&format!("v{major}.{}.9", minor - 1)));
        assert!(!node_ok(&format!("v{}.99.0", major - 1)));
        assert!(node_ok("weird"));
    }

    #[test]
    fn check_folder_takes_one_plain_name() {
        // Act / Assert
        assert!(check_folder("my-blog").is_ok());
        assert!(check_folder("我的博客").is_ok());
        assert!(check_folder(" ").is_err());
        assert!(check_folder(".hidden").is_err());
        assert!(check_folder("a/b").is_err());
        assert!(check_folder("..").is_err());
    }

    #[test]
    fn zone_from_localtime_takes_the_part_after_zoneinfo() {
        // Act / Assert
        assert_eq!(zone_from_localtime("/var/db/timezone/zoneinfo/Asia/Taipei").as_deref(), Some("Asia/Taipei"));
        assert_eq!(zone_from_localtime("/usr/share/zoneinfo/UTC").as_deref(), Some("UTC"));
        assert_eq!(zone_from_localtime("/etc/other"), None);
    }

    #[test]
    fn every_template_is_found_by_its_id() {
        // Act / Assert
        for t in TEMPLATES {
            assert_eq!(find(t.id).map(|f| f.theme), Some(t.theme));
        }
        assert!(find("nope").is_none());
    }
}
