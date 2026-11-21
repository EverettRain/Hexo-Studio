//! The parts of a blog's `_config.yml` the app reads, and the config files the config page edits.

use serde::{Deserialize, Serialize};
use yaml_rust2::{Yaml, YamlLoader};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deployer {
    pub kind: String,
    pub repo: Option<String>,
    pub branch: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlogConfig {
    pub title: String,
    pub url: String,
    /// URL path the site is served under, always with leading and trailing slashes.
    pub root: String,
    pub permalink: String,
    /// IANA name; `None` means Hexo falls back to the machine's zone.
    pub timezone: Option<String>,
    pub new_post_name: String,
    pub source_dir: String,
    pub deploy: Vec<Deployer>,
    /// The `theme` folder name under `themes/`; `None` when not set.
    pub theme: Option<String>,
}

impl Default for BlogConfig {
    /// Hexo's own defaults, for keys a config leaves out.
    fn default() -> Self {
        BlogConfig {
            title: "Hexo".into(),
            url: "http://example.com".into(),
            root: "/".into(),
            permalink: ":year/:month/:day/:title/".into(),
            timezone: None,
            new_post_name: ":title.md".into(),
            source_dir: "source".into(),
            deploy: Vec::new(),
            theme: None,
        }
    }
}

fn text(y: &Yaml) -> Option<String> {
    match y {
        Yaml::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Yaml::Integer(i) => Some(i.to_string()),
        Yaml::Real(r) => Some(r.clone()),
        _ => None,
    }
}

fn deployer(y: &Yaml) -> Option<Deployer> {
    Some(Deployer { kind: text(&y["type"])?, repo: text(&y["repo"]), branch: text(&y["branch"]) })
}

fn normalized_root(root: &str) -> String {
    let inner = root.trim_matches('/');
    if inner.is_empty() {
        "/".into()
    } else {
        format!("/{inner}/")
    }
}

impl BlogConfig {
    pub fn parse(source: &str) -> Result<BlogConfig, String> {
        let docs = YamlLoader::load_from_str(source).map_err(|e| format!("_config.yml 不是有效的 YAML：{e}"))?;
        let defaults = BlogConfig::default();
        let Some(y) = docs.into_iter().next() else { return Ok(defaults) };
        let deploy = match &y["deploy"] {
            Yaml::Array(list) => list.iter().filter_map(deployer).collect(),
            Yaml::Hash(_) => deployer(&y["deploy"]).into_iter().collect(),
            _ => Vec::new(),
        };
        Ok(BlogConfig {
            title: text(&y["title"]).unwrap_or(defaults.title),
            url: text(&y["url"]).unwrap_or(defaults.url),
            root: normalized_root(&text(&y["root"]).unwrap_or(defaults.root)),
            permalink: text(&y["permalink"]).unwrap_or(defaults.permalink),
            timezone: text(&y["timezone"]),
            new_post_name: text(&y["new_post_name"]).unwrap_or(defaults.new_post_name),
            source_dir: text(&y["source_dir"]).unwrap_or(defaults.source_dir),
            deploy,
            theme: text(&y["theme"]),
        })
    }
}

/// A config file the config page reads: the site's, the theme's overrides
/// (`_config.<theme>.yml`, which Hexo merges over the theme's own), and the theme's defaults.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigFile {
    Site,
    Theme,
    /// Read only: shown for comparison; the theme folder is never written.
    ThemeDefaults,
}

/// A theme name that stays a single folder name inside `themes/`.
fn plain_name(theme: Option<&str>) -> Option<&str> {
    theme.filter(|t| !t.is_empty() && !t.starts_with('.') && !t.contains(['/', '\\']))
}

impl ConfigFile {
    /// Path from the blog root; `None` for the theme's files when the blog names no usable theme.
    pub fn path(self, theme: Option<&str>) -> Option<String> {
        match self {
            ConfigFile::Site => Some("_config.yml".into()),
            ConfigFile::Theme => plain_name(theme).map(|t| format!("_config.{t}.yml")),
            ConfigFile::ThemeDefaults => plain_name(theme).map(|t| format!("themes/{t}/_config.yml")),
        }
    }

    pub fn writable(self) -> bool {
        self != ConfigFile::ThemeDefaults
    }
}

/// A page data file directly in `source/_data` (`link.yml`, `extra_bangumis.json`…), by name.
pub fn is_data_file(name: &str) -> bool {
    !name.starts_with('.') && !name.contains(['/', '\\']) && [".yml", ".yaml", ".json"].iter().any(|ext| name.len() > ext.len() && name.ends_with(ext))
}

/// Whether a `package.json` lists `hexo` among its dependencies.
pub fn declares_hexo(package_json: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(package_json) else { return false };
    ["dependencies", "devDependencies"].iter().any(|k| v[k].get("hexo").is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_files_are_named_after_the_theme() {
        // Act
        let theme = Some("anzhiyu");

        // Assert
        assert_eq!(ConfigFile::Site.path(theme).as_deref(), Some("_config.yml"));
        assert_eq!(ConfigFile::Theme.path(theme).as_deref(), Some("_config.anzhiyu.yml"));
        assert_eq!(ConfigFile::ThemeDefaults.path(theme).as_deref(), Some("themes/anzhiyu/_config.yml"));
        assert!(ConfigFile::Theme.writable() && !ConfigFile::ThemeDefaults.writable());
    }

    #[test]
    fn data_files_are_plain_yaml_or_json_names() {
        // Act / Assert
        for ok in ["link.yml", "about.yaml", "extra_bangumis.json"] {
            assert!(is_data_file(ok), "{ok}");
        }
        for bad in ["../_config.yml", "a/b.yml", ".hidden.yml", "notes.md", ".yml", "x.json/"] {
            assert!(!is_data_file(bad), "{bad}");
        }
    }

    #[test]
    fn a_theme_name_that_leaves_its_folder_has_no_files() {
        // Act / Assert
        for bad in [None, Some(""), Some("../x"), Some("a/b"), Some(".."), Some(".hidden")] {
            assert_eq!(ConfigFile::Theme.path(bad), None, "{bad:?}");
            assert_eq!(ConfigFile::ThemeDefaults.path(bad), None, "{bad:?}");
        }
        assert_eq!(ConfigFile::Site.path(None).as_deref(), Some("_config.yml"));
    }

    #[test]
    fn reads_the_keys_the_app_uses() {
        // Arrange
        let source =
            "title: Everett Rain\nurl: https://blog.example.cn/\npermalink: :year/:month/:day/:title/\ntimezone: 'Asia/Shanghai'\n\
                      new_post_name: :title.md # comment\nsource_dir: source\ntheme: anzhiyu\n\
                      deploy:\n  type: git\n  repo: git@github.com:a/b.git\n  branch: main\n";

        // Act
        let c = BlogConfig::parse(source).unwrap();

        // Assert
        assert_eq!(
            c,
            BlogConfig {
                title: "Everett Rain".into(),
                url: "https://blog.example.cn/".into(),
                root: "/".into(),
                permalink: ":year/:month/:day/:title/".into(),
                timezone: Some("Asia/Shanghai".into()),
                new_post_name: ":title.md".into(),
                source_dir: "source".into(),
                deploy: vec![Deployer { kind: "git".into(), repo: Some("git@github.com:a/b.git".into()), branch: Some("main".into()) }],
                theme: Some("anzhiyu".into()),
            }
        );
    }

    #[test]
    fn missing_keys_take_hexo_defaults() {
        // Arrange
        let source = "title:\ntimezone:\n";

        // Act
        let c = BlogConfig::parse(source).unwrap();

        // Assert
        assert_eq!(c, BlogConfig::default());
    }

    #[test]
    fn an_empty_file_is_all_defaults() {
        // Act
        let c = BlogConfig::parse("").unwrap();

        // Assert
        assert_eq!(c, BlogConfig::default());
    }

    #[test]
    fn several_deployers_are_all_read_and_untyped_ones_skipped() {
        // Arrange
        let source = "deploy:\n  - type: git\n    repo: /tmp/a.git\n  - repo: nowhere\n  - type: rsync\n";

        // Act
        let c = BlogConfig::parse(source).unwrap();

        // Assert
        assert_eq!(
            c.deploy,
            vec![
                Deployer { kind: "git".into(), repo: Some("/tmp/a.git".into()), branch: None },
                Deployer { kind: "rsync".into(), repo: None, branch: None },
            ]
        );
    }

    #[test]
    fn root_is_normalized_to_leading_and_trailing_slashes() {
        // Arrange
        let source = "root: blog";

        // Act
        let c = BlogConfig::parse(source).unwrap();

        // Assert
        assert_eq!(c.root, "/blog/");
    }

    #[test]
    fn invalid_yaml_is_an_error() {
        // Act
        let r = BlogConfig::parse("a: [1, 2");

        // Assert
        assert!(r.is_err());
    }

    #[test]
    fn hexo_in_dependencies_or_dev_dependencies_counts() {
        // Arrange
        let deps = r#"{"dependencies": {"hexo": "^7.0.0"}}"#;
        let dev = r#"{"devDependencies": {"hexo": "^7.0.0"}}"#;
        let none = r#"{"dependencies": {"hexo-server": "^3.0.0"}}"#;

        // Act / Assert
        assert!(declares_hexo(deps));
        assert!(declares_hexo(dev));
        assert!(!declares_hexo(none));
        assert!(!declares_hexo("not json"));
    }
}
