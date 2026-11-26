//! The user's preferences (`users/<id>/preferences.json`): everything that belongs to the
//! person using the app rather than to a blog (project settings live in the blog's
//! `.hexostudio/`). Kept on this Mac only.

use super::{paths, user};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    /// Unix seconds.
    pub opened_at: i64,
}

/// Light, dark, or as macOS is set.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    System,
    Light,
    Dark,
}

/// What only the interface reads and writes; saved whole.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiPreferences {
    pub mode: Mode,
    /// The interface's theme by id (`default`, ...). Text rather than a closed list, so a theme
    /// this version does not know (written by a newer one) falls back to the default in the
    /// interface instead of making the whole file unreadable.
    pub theme: String,
    /// The editor's preview column, as a share of the editor's width; `None` until it is dragged.
    pub preview_share: Option<f32>,
    /// The editor's preview draws the Markdown as it is typed instead of the theme's page.
    pub instant_preview: bool,
    /// The values the interface kept in the WebView's storage before preferences existed have
    /// been brought over.
    pub web_storage_migrated: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    /// Most recently opened first.
    pub recent: Vec<RecentProject>,
    /// A Node executable chosen by hand; otherwise it is looked for (see `node_env`).
    pub node_path: Option<String>,
    /// Where the original of every uploaded image is kept; empty means `~/Pictures/Hexo-Studio`.
    pub backup_dir: Option<String>,
    pub ui: UiPreferences,
}

impl Preferences {
    pub fn backup_dir(&self) -> std::path::PathBuf {
        match self.backup_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            Some(d) => std::path::PathBuf::from(d),
            None => paths::home().join("Pictures/Hexo-Studio"),
        }
    }
}

const KEPT_RECENT: usize = 12;

impl Preferences {
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

const FILE: &str = "preferences.json";

/// Missing or unreadable preferences fall back to the defaults rather than stopping the app.
pub fn load() -> Preferences {
    user::current_dir().ok().and_then(|d| std::fs::read(d.join(FILE)).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(p: &Preferences) -> Result<(), String> {
    paths::write_json(&user::current_dir()?.join(FILE), p).map_err(|e| format!("无法保存偏好：{e}"))
}

/// Reads, changes and saves the preferences in one step.
pub fn update(change: impl FnOnce(&mut Preferences)) -> Result<Preferences, String> {
    let _held = user::LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut p = load();
    change(&mut p);
    save(&p)?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_missing_from_older_files_take_their_defaults() {
        // Arrange
        let old = r#"{"nodePath": "/opt/homebrew/bin/node"}"#;

        // Act
        let s: Preferences = serde_json::from_str(old).unwrap();

        // Assert
        assert_eq!(s, Preferences { node_path: Some("/opt/homebrew/bin/node".into()), ..Preferences::default() });
    }

    #[test]
    fn a_settings_file_from_before_users_reads_as_preferences() {
        // Arrange
        let old = r#"{"recent":[{"path":"/b","openedAt":5}],"nodePath":null,"backupDir":"/x"}"#;

        // Act
        let p: Preferences = serde_json::from_str(old).unwrap();

        // Assert
        assert_eq!(p.recent, vec![RecentProject { path: "/b".into(), opened_at: 5 }]);
        assert_eq!(p.backup_dir.as_deref(), Some("/x"));
        assert_eq!(p.ui, UiPreferences::default());
    }

    #[test]
    fn an_unknown_theme_keeps_the_rest_readable() {
        // Arrange
        let saved = r#"{"recent":[{"path":"/b","openedAt":5}],"ui":{"mode":"dark","theme":"from-a-newer-version"}}"#;

        // Act
        let p: Preferences = serde_json::from_str(saved).unwrap();

        // Assert
        assert_eq!(p.recent.len(), 1);
        assert_eq!(p.ui.mode, Mode::Dark);
        assert_eq!(p.ui.theme, "from-a-newer-version");
    }

    #[test]
    fn reopening_a_project_moves_it_to_the_front_once() {
        // Arrange
        let mut s = Preferences::default();
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
        let mut s = Preferences::default();

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
        let mut s = Preferences::default();
        s.remember("/a", 1);
        s.remember("/b", 2);

        // Act
        s.forget("/a");

        // Assert
        assert_eq!(s.recent.len(), 1);
        assert_eq!(s.recent[0].path, "/b");
    }
}
