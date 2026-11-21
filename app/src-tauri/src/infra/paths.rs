//! Where Hexo-Studio keeps its files, and its small log.

use std::path::PathBuf;

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn home() -> PathBuf {
    env_dir("HOME").unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// Settings and logs. `HEXO_STUDIO_HOME` moves it (tests and trial runs).
pub fn data_dir() -> PathBuf {
    if let Some(p) = env_dir("HEXO_STUDIO_HOME") {
        return p;
    }
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/Hexo-Studio")
    } else {
        env_dir("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local/share")).join("hexo-studio")
    }
}

/// Writes JSON through a temporary file, so a crash never leaves half a file.
pub fn write_json(path: &std::path::Path, value: &impl serde::Serialize) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| e.to_string())
}

fn log_path() -> PathBuf {
    data_dir().join("logs").join("studio.log")
}

/// Appends one line to the log; the file is rotated at 256 KB, keeping one older file.
pub fn log(message: &str) {
    use std::io::Write;
    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 256 * 1024) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let stamp = jiff::Timestamp::now().round(jiff::Unit::Second).unwrap_or(jiff::Timestamp::UNIX_EPOCH);
        let _ = writeln!(f, "[{stamp}] {message}");
    }
}
