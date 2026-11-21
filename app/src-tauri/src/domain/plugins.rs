//! The blog's Hexo plugins, picked from its `package.json` the way Hexo itself loads them.

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub name: String,
    /// The version range `package.json` asks for.
    pub wanted: String,
    /// The installed version; `None` when it is not in `node_modules` (Hexo then skips it).
    pub version: Option<String>,
    pub description: Option<String>,
    /// Its source on GitHub, when the package names one.
    pub repo: Option<String>,
    /// Listed by the theme's own `package.json`, not the blog's.
    pub from_theme: bool,
}

/// Hexo 7's rule (`hexo/dist/hexo/load_plugins.js`): `hexo-…` or `@scope/hexo-…`, but not a
/// theme (`hexo-theme-…`) and not type definitions.
pub fn is_plugin_name(name: &str) -> bool {
    let bare = match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') {
            Some((_, rest)) => rest,
            None => return false,
        },
        None => name,
    };
    !name.starts_with("@types/") && bare.starts_with("hexo-") && !bare.starts_with("hexo-theme-")
}

/// The plugin names a `package.json` lists, with the range each asks for: `dependencies`, and
/// `devDependencies` too for the blog (Hexo ignores a theme's dev dependencies).
pub fn listed(package_json: &str, with_dev: bool) -> Vec<(String, String)> {
    let Ok(v) = serde_json::from_str::<Value>(package_json) else { return Vec::new() };
    let groups: &[&str] = if with_dev { &["dependencies", "devDependencies"] } else { &["dependencies"] };
    let mut out = Vec::new();
    for g in groups {
        if let Some(deps) = v[g].as_object() {
            for (name, range) in deps {
                if is_plugin_name(name) && !out.iter().any(|(n, _): &(String, String)| n == name) {
                    out.push((name.clone(), range.as_str().unwrap_or_default().to_string()));
                }
            }
        }
    }
    out
}

/// A package's GitHub page, from its `repository` (`owner/repo`, `github:owner/repo`,
/// `git+https://github.com/owner/repo.git`, `git@github.com:owner/repo.git` and the like), else
/// from its `homepage` when that is on GitHub.
pub fn github_page(manifest: &Value) -> Option<String> {
    let repository = match &manifest["repository"] {
        Value::String(s) => Some(s.as_str()),
        v => v["url"].as_str(),
    };
    repository.and_then(github_url).or_else(|| manifest["homepage"].as_str().filter(|h| h.contains("github.com")).and_then(github_url))
}

fn github_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let path = if let Some(p) = raw.strip_prefix("github:") {
        p
    } else if let Some(at) = raw.find("github.com") {
        raw[at + "github.com".len()..].trim_start_matches([':', '/'])
    } else if !raw.contains(':') && raw.matches('/').count() == 1 {
        raw
    } else {
        return None;
    };
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = path.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?.split(['#', '?']).next()?);
    (!owner.is_empty() && !repo.is_empty()).then(|| format!("https://github.com/{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_hexos_rule_for_plugin_names() {
        // Act / Assert
        for yes in ["hexo-server", "hexo-renderer-markdown-it", "@scope/hexo-x"] {
            assert!(is_plugin_name(yes), "{yes}");
        }
        for no in ["hexo", "hexo-theme-landscape", "@scope/hexo-theme-x", "@types/hexo-x", "twikoo", "markdown-it-imsize", "@scope"] {
            assert!(!is_plugin_name(no), "{no}");
        }
    }

    #[test]
    fn lists_dependencies_and_dev_dependencies_once() {
        // Arrange
        let pkg = r#"{"dependencies":{"hexo":"^7","hexo-server":"^3","twikoo":"1"},"devDependencies":{"hexo-server":"^3","hexo-x":"1.0.0"}}"#;

        // Act
        let blog = listed(pkg, true);
        let theme = listed(pkg, false);

        // Assert
        assert_eq!(blog, vec![("hexo-server".to_string(), "^3".to_string()), ("hexo-x".to_string(), "1.0.0".to_string())]);
        assert_eq!(theme, vec![("hexo-server".to_string(), "^3".to_string())]);
        assert!(listed("not json", true).is_empty());
    }

    #[test]
    fn turns_the_ways_packages_name_their_repository_into_a_github_page() {
        // Arrange
        let page = |repo: Value| github_page(&serde_json::json!({ "repository": repo }));

        // Act / Assert
        assert_eq!(page("hexojs/hexo-renderer-ejs".into()).as_deref(), Some("https://github.com/hexojs/hexo-renderer-ejs"));
        assert_eq!(page("github:a/b".into()).as_deref(), Some("https://github.com/a/b"));
        assert_eq!(page(serde_json::json!({"url": "git+https://github.com/HCLonely/hexo-bilibili-bangumi.git"})).as_deref(), Some("https://github.com/HCLonely/hexo-bilibili-bangumi"));
        assert_eq!(page(serde_json::json!({"url": "git@github.com:a/b.git"})).as_deref(), Some("https://github.com/a/b"));
        assert_eq!(page("https://github.com/grzhan/hexo-tag-aplayer#readme".into()).as_deref(), Some("https://github.com/grzhan/hexo-tag-aplayer"));
        assert_eq!(page("https://gitlab.com/a/b".into()), None);
        assert_eq!(github_page(&serde_json::json!({})), None);
        assert_eq!(github_page(&serde_json::json!({"homepage": "https://github.com/willin/hexo-wordcount"})).as_deref(), Some("https://github.com/willin/hexo-wordcount"));
        assert_eq!(github_page(&serde_json::json!({"homepage": "https://hexo.io/"})), None);
    }
}
