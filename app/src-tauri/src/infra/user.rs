//! The person using the app (docs/design.md, section 16): a folder of their own in the data
//! directory with their profile, avatar and preferences. One user for now; `app.json` names
//! which folder is theirs, so more can be added later without moving anything.

use super::{image_encode, paths};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Held while the preferences are read, changed and written, so two changes do not lose one.
pub static LOCK: Mutex<()> = Mutex::new(());
/// Held while the first user is made, so two early calls do not make two.
static CREATING: Mutex<()> = Mutex::new(());

const APP_FILE: &str = "app.json";
const PROFILE_FILE: &str = "profile.json";
const AVATAR_FILE: &str = "avatar.png";
/// App-wide settings from before users; their content is the start of the first user's preferences.
const LEGACY_SETTINGS: &str = "settings.json";
const AVATAR_EDGE: u32 = 256;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AppFile {
    current_user: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
}

/// The current user's folder, made (with what earlier versions saved) on first use.
pub fn current_dir() -> Result<PathBuf, String> {
    current_dir_in(&paths::data_dir(), system_name)
}

fn current_dir_in(data: &Path, default_name: impl FnOnce() -> String) -> Result<PathBuf, String> {
    let _held = CREATING.lock().unwrap_or_else(|e| e.into_inner());
    let app: AppFile = read_json(&data.join(APP_FILE)).unwrap_or_default();
    if let Some(dir) = app.current_user.map(|id| data.join("users").join(id)).filter(|d| d.is_dir()) {
        return Ok(dir);
    }
    let id = format!("u{:x}", jiff::Timestamp::now().as_millisecond());
    let dir = data.join("users").join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建用户文件夹：{e}"))?;
    paths::write_json(&dir.join(PROFILE_FILE), &Profile { name: default_name() })?;
    let legacy = data.join(LEGACY_SETTINGS);
    if legacy.is_file() {
        std::fs::copy(&legacy, dir.join("preferences.json")).map_err(|e| format!("无法迁移旧设置：{e}"))?;
        // Kept beside, renamed, so nothing reads it again and nothing is lost.
        let _ = std::fs::rename(&legacy, data.join("settings.migrated.json"));
    }
    paths::write_json(&data.join(APP_FILE), &AppFile { current_user: Some(id) })?;
    Ok(dir)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

/// The Mac account's full name (`id -F`), else its short name.
fn system_name() -> String {
    std::process::Command::new("/usr/bin/id")
        .arg("-F")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "我".into())
}

pub fn profile() -> Result<Profile, String> {
    let dir = current_dir()?;
    Ok(read_json(&dir.join(PROFILE_FILE)).unwrap_or_else(|| Profile { name: system_name() }))
}

pub fn set_name(name: &str) -> Result<Profile, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名字不能为空。".into());
    }
    let profile = Profile { name: name.to_string() };
    paths::write_json(&current_dir()?.join(PROFILE_FILE), &profile)?;
    Ok(profile)
}

/// The avatar as PNG; `None` without one.
pub fn avatar() -> Option<Vec<u8>> {
    std::fs::read(current_dir().ok()?.join(AVATAR_FILE)).ok()
}

/// Takes the middle square of the picture at `path`, small.
pub fn set_avatar(path: &Path) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let png = image_encode::square_png(&bytes, &ext, AVATAR_EDGE)?;
    std::fs::write(current_dir()?.join(AVATAR_FILE), png).map_err(|e| format!("无法保存头像：{e}"))
}

pub fn clear_avatar() -> Result<(), String> {
    match std::fs::remove_file(current_dir()?.join(AVATAR_FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("无法移除头像：{e}")),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_user_takes_over_the_old_settings() {
        // Arrange
        let data = tempfile::tempdir().unwrap();
        let old = r#"{"recent":[{"path":"/blog","openedAt":1}],"nodePath":"/n"}"#;
        std::fs::write(data.path().join(LEGACY_SETTINGS), old).unwrap();

        // Act
        let dir = current_dir_in(data.path(), || "Everett".into()).unwrap();

        // Assert
        assert_eq!(std::fs::read_to_string(dir.join("preferences.json")).unwrap(), old);
        assert_eq!(read_json::<Profile>(&dir.join(PROFILE_FILE)), Some(Profile { name: "Everett".into() }));
        assert!(!data.path().join(LEGACY_SETTINGS).exists());
        assert!(data.path().join("settings.migrated.json").is_file());
    }

    #[test]
    fn later_calls_find_the_same_user() {
        // Arrange
        let data = tempfile::tempdir().unwrap();
        let first = current_dir_in(data.path(), || "A".into()).unwrap();

        // Act
        let again = current_dir_in(data.path(), || panic!("a second user was made")).unwrap();

        // Assert
        assert_eq!(first, again);
        assert_eq!(std::fs::read_dir(data.path().join("users")).unwrap().count(), 1);
    }

    #[test]
    fn a_first_run_without_old_settings_starts_empty() {
        // Arrange
        let data = tempfile::tempdir().unwrap();

        // Act
        let dir = current_dir_in(data.path(), || "A".into()).unwrap();

        // Assert
        assert!(!dir.join("preferences.json").exists());
        assert!(!data.path().join("settings.migrated.json").exists());
    }
}
