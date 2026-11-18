//! The parts of a blog's `_config.yml` the app reads. Never written back.

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
        })
    }
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
    fn reads_the_keys_the_app_uses() {
        // Arrange
        let source =
            "title: Everett Rain\nurl: https://blog.example.cn/\npermalink: :year/:month/:day/:title/\ntimezone: 'Asia/Shanghai'\n\
                      new_post_name: :title.md # comment\nsource_dir: source\n\
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
