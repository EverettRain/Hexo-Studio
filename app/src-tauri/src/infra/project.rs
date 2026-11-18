//! The app's own folder inside a blog, `.hexostudio/`, like `.vscode/`: project settings that
//! may be committed, and `local/` for this Mac's state, which its own `.gitignore` keeps out of
//! git (the blog's `.gitignore` is left alone).

use crate::domain::catalog::Catalog;
use crate::domain::image_key::Format;
use crate::domain::storage::Storage;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DIR: &str = ".hexostudio";
const IGNORE: &str = "# Written by Hexo-Studio: this Mac's state stays out of git.\nlocal/\n";

pub fn dir(root: &Path) -> PathBuf {
    root.join(DIR)
}

pub fn local_dir(root: &Path) -> PathBuf {
    dir(root).join("local")
}

/// Creates the folder on opening a blog; an existing `.gitignore` there is kept as it is.
pub fn prepare(root: &Path) -> Result<(), String> {
    let local = local_dir(root);
    std::fs::create_dir_all(&local).map_err(|e| format!("无法创建 {DIR}/：{e}"))?;
    let ignore = dir(root).join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, IGNORE).map_err(|e| format!("无法写入 {DIR}/.gitignore：{e}"))?;
    }
    Ok(())
}

/// How a new image is written into a post: the theme's `{% image %}` tag (what this blog's posts
/// use) or plain Markdown. The editor writes and reads the markup; this only remembers the choice.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InsertStyle {
    #[default]
    Image,
    Markdown,
}

/// How images are uploaded for this blog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UploadSettings {
    pub format: Format,
    pub style: InsertStyle,
    /// WebP quality, 1–100.
    pub quality: u8,
    /// Longest edge of an uploaded WebP, in pixels; larger images are scaled down.
    pub max_edge: u32,
}

impl Default for UploadSettings {
    fn default() -> Self {
        UploadSettings { format: Format::Webp, style: InsertStyle::Image, quality: 82, max_edge: 2560 }
    }
}

/// `.hexostudio/settings.json`: settings that belong to the blog and may be committed with it.
/// Secrets never go here (see `keychain`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSettings {
    /// The project's name in image paths; empty means the folder's name.
    pub name: Option<String>,
    pub storage: Option<Storage>,
    pub upload: UploadSettings,
}

fn settings_path(root: &Path) -> PathBuf {
    dir(root).join("settings.json")
}

/// Missing settings are the defaults; a file that cannot be read is an error, so a save never
/// replaces settings the user wrote by hand with defaults.
pub fn load_settings(root: &Path) -> Result<ProjectSettings, String> {
    match std::fs::read(settings_path(root)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{DIR}/settings.json 格式有误：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ProjectSettings::default()),
        Err(e) => Err(format!("无法读取 {DIR}/settings.json：{e}")),
    }
}

pub fn save_settings(root: &Path, s: &ProjectSettings) -> Result<(), String> {
    prepare(root)?;
    let mut body = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    body.push('\n');
    std::fs::write(settings_path(root), body).map_err(|e| format!("无法保存 {DIR}/settings.json：{e}"))
}

fn catalog_path(root: &Path) -> PathBuf {
    dir(root).join("images.json")
}

/// Serializes changes to `images.json`: uploads run side by side, each adding a record.
fn catalog_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(Default::default)
}

/// The image library; none yet is an empty one, a file that cannot be read is an error.
pub fn load_catalog(root: &Path) -> Result<Catalog, String> {
    match std::fs::read(catalog_path(root)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{DIR}/images.json 格式有误：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Catalog::default()),
        Err(e) => Err(format!("无法读取 {DIR}/images.json：{e}")),
    }
}

/// Reads, changes and writes the library in one step, one change at a time.
pub fn update_catalog<T>(root: &Path, change: impl FnOnce(&mut Catalog) -> Result<T, String>) -> Result<T, String> {
    let _held = catalog_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut c = load_catalog(root)?;
    let out = change(&mut c)?;
    prepare(root)?;
    let mut body = serde_json::to_string_pretty(&c).map_err(|e| e.to_string())?;
    body.push('\n');
    let path = catalog_path(root);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("无法保存 {DIR}/images.json：{e}"))?;
    Ok(out)
}

/// This Mac's last check of each image (uid → result); not part of the blog.
pub fn load_checks<T: serde::de::DeserializeOwned + Default>(root: &Path) -> T {
    std::fs::read(local_dir(root).join("image-checks.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_checks<T: Serialize>(root: &Path, checks: &T) -> Result<(), String> {
    prepare(root)?;
    let body = serde_json::to_vec_pretty(checks).map_err(|e| e.to_string())?;
    std::fs::write(local_dir(root).join("image-checks.json"), body).map_err(|e| format!("无法保存检查结果：{e}"))
}

/// The name image paths use for this blog.
pub fn project_name(root: &Path, s: &ProjectSettings) -> String {
    match s.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "blog".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_to_webp_and_the_folder_name() {
        // Arrange
        let root = tempfile::tempdir().unwrap();
        let blog = root.path().join("EverettBlog");
        std::fs::create_dir(&blog).unwrap();

        // Act
        let s = load_settings(&blog).unwrap();

        // Assert
        assert_eq!(s.upload.format, Format::Webp);
        assert_eq!(project_name(&blog, &s), "EverettBlog");
    }

    #[test]
    fn saved_settings_read_back_and_a_set_name_wins() {
        // Arrange
        let root = tempfile::tempdir().unwrap();
        let s = ProjectSettings { name: Some(" MyBlog ".into()), ..ProjectSettings::default() };

        // Act
        save_settings(root.path(), &s).unwrap();
        let back = load_settings(root.path()).unwrap();

        // Assert
        assert_eq!(back, s);
        assert_eq!(project_name(root.path(), &back), "MyBlog");
    }

    #[test]
    fn library_changes_made_side_by_side_all_land() {
        // Arrange
        let root = tempfile::tempdir().unwrap();
        let image = |id: &str| crate::domain::catalog::Image {
            id: id.into(),
            name: id.into(),
            description: String::new(),
            ok: None,
            key: format!("B/{id}.webp"),
            url: format!("https://c/B/{id}.webp"),
            uploaded_at: String::new(),
            mirrors: vec![],
            format: Format::Webp,
            bytes: 0,
            width: 0,
            height: 0,
            original: Default::default(),
            legacy_urls: vec![],
        };

        // Act
        std::thread::scope(|s| {
            for i in 0..8 {
                let root = root.path();
                let img = image(&format!("id{i}"));
                s.spawn(move || update_catalog(root, |c| Ok(c.add(img))).unwrap());
            }
        });

        // Assert
        assert_eq!(load_catalog(root.path()).unwrap().images.len(), 8);
    }

    #[test]
    fn settings_saved_before_the_insert_style_existed_use_the_image_tag() {
        // Arrange
        let root = tempfile::tempdir().unwrap();
        prepare(root.path()).unwrap();
        std::fs::write(dir(root.path()).join("settings.json"), r#"{"upload":{"format":"original","quality":70,"maxEdge":1600}}"#).unwrap();

        // Act
        let s = load_settings(root.path()).unwrap();

        // Assert
        assert_eq!(s.upload.style, InsertStyle::Image);
        assert_eq!(s.upload.format, Format::Original);
    }

    #[test]
    fn a_broken_settings_file_is_an_error_not_defaults() {
        // Arrange
        let root = tempfile::tempdir().unwrap();
        prepare(root.path()).unwrap();
        std::fs::write(dir(root.path()).join("settings.json"), "{ not json").unwrap();

        // Act
        let r = load_settings(root.path());

        // Assert
        assert!(r.is_err());
    }

    #[test]
    fn prepares_the_folder_with_local_state_ignored() {
        // Arrange
        let root = tempfile::tempdir().unwrap();

        // Act
        prepare(root.path()).unwrap();

        // Assert
        assert!(local_dir(root.path()).is_dir());
        let ignore = std::fs::read_to_string(dir(root.path()).join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l == "local/"));
    }

    #[test]
    fn an_edited_gitignore_is_kept() {
        // Arrange
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir(root.path())).unwrap();
        std::fs::write(dir(root.path()).join(".gitignore"), "local/\ncache/\n").unwrap();

        // Act
        prepare(root.path()).unwrap();

        // Assert
        assert_eq!(std::fs::read_to_string(dir(root.path()).join(".gitignore")).unwrap(), "local/\ncache/\n");
    }

    #[test]
    fn git_leaves_local_state_out() {
        // Arrange
        let root = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| std::process::Command::new("git").args(args).current_dir(root.path()).output().unwrap();
        git(&["init", "-q"]);
        prepare(root.path()).unwrap();
        std::fs::write(local_dir(root.path()).join("preview.pid"), "1").unwrap();

        // Act
        let out = git(&["status", "--porcelain", "--untracked-files=all"]);

        // Assert
        let listed = String::from_utf8_lossy(&out.stdout).into_owned();
        assert!(listed.contains(".hexostudio/.gitignore"), "{listed}");
        assert!(!listed.contains("preview.pid"), "{listed}");
    }
}
