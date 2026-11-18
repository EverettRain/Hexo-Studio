//! App-wide settings, stored as JSON in the data directory: things that belong to this Mac, not
//! to a blog (project settings live in the blog's `.hexostudio/`).

use super::paths;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    /// Unix seconds.
    pub opened_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Most recently opened first.
    pub recent: Vec<RecentProject>,
    /// A Node executable chosen by hand; otherwise it is looked for (see `node_env`).
    pub node_path: Option<String>,
    /// Where the original of every uploaded image is kept; empty means `~/Pictures/Hexo-Studio`.
    pub backup_dir: Option<String>,
}

impl Settings {
    pub fn backup_dir(&self) -> std::path::PathBuf {
        match self.backup_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            Some(d) => std::path::PathBuf::from(d),
            None => paths::home().join("Pictures/Hexo-Studio"),
        }
    }
}

const KEPT_RECENT: usize = 12;

impl Settings {
    /// Puts `path` first in the recent list.
    pub fn remember(&mut self, path: &str, now: i64) {
        self.recent.retain(|r| r.path != path);
        self.recent.insert(0, RecentProject { path: path.to_string(), opened_at: now });
        self.recent.truncate(KEPT_RECENT);
    }

    pub fn forget(&mut self, path: &str) {
        self.recent.retain(|r| r.path != path);
    }
}

/// Missing or unreadable settings fall back to the defaults rather than stopping the app.
pub fn load() -> Settings {
    std::fs::read(paths::settings_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(s: &Settings) -> Result<(), String> {
    let path = paths::settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("无法创建数据目录：{e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("无法保存设置：{e}"))
}

/// Reads, changes and saves the settings in one step.
pub fn update(change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
    let mut s = load();
    change(&mut s);
    save(&s)?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_missing_from_older_files_take_their_defaults() {
        // Arrange
        let old = r#"{"nodePath": "/opt/homebrew/bin/node"}"#;

        // Act
        let s: Settings = serde_json::from_str(old).unwrap();

        // Assert
        assert_eq!(s, Settings { node_path: Some("/opt/homebrew/bin/node".into()), ..Settings::default() });
    }

    #[test]
    fn reopening_a_project_moves_it_to_the_front_once() {
        // Arrange
        let mut s = Settings::default();
        s.remember("/a", 1);
        s.remember("/b", 2);

        // Act
        s.remember("/a", 3);

        // Assert
        assert_eq!(s.recent, vec![RecentProject { path: "/a".into(), opened_at: 3 }, RecentProject { path: "/b".into(), opened_at: 2 }]);
    }

    #[test]
    fn the_recent_list_keeps_the_newest_ones() {
        // Arrange
        let mut s = Settings::default();

        // Act
        for i in 0..(KEPT_RECENT + 3) {
            s.remember(&format!("/p{i}"), i as i64);
        }

        // Assert
        assert_eq!(s.recent.len(), KEPT_RECENT);
        assert_eq!(s.recent[0].path, format!("/p{}", KEPT_RECENT + 2));
    }

    #[test]
    fn a_forgotten_project_leaves_the_list() {
        // Arrange
        let mut s = Settings::default();
        s.remember("/a", 1);
        s.remember("/b", 2);

        // Act
        s.forget("/a");

        // Assert
        assert_eq!(s.recent.len(), 1);
        assert_eq!(s.recent[0].path, "/b");
    }
}
