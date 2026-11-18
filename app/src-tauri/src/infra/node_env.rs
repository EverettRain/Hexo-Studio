//! Finding Node, and the `PATH` Hexo runs with.
//!
//! An app started from Finder or the Dock gets launchd's minimal `PATH`, without the folders
//! nvm, fnm, Volta or Homebrew add in the user's shell profile. In order: the executable chosen
//! in settings; the `PATH` of the user's login shell (read once per run); common install places.

use super::paths;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct NodeEnv {
    pub node: PathBuf,
    /// `PATH` for Hexo and what it starts (git, ssh): Node's folder first.
    pub path_var: OsString,
}

const MARK: &str = "__HEXO_STUDIO_PATH__";
/// Where `git`, `ssh` and the shells live on every Mac, kept at the end of `PATH`.
const SYSTEM_DIRS: [&str; 4] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/// Runs the login shell interactively (`-lic`) so both `.zprofile` and `.zshrc` are read, as in
/// Terminal. Output around the markers (banners, prompts) is ignored; a shell that hangs is
/// given up after a few seconds.
fn read_login_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let script = format!("printf '%s%s%s' '{MARK}' \"$PATH\" '{MARK}'");
    let mut child =
        Command::new(&shell).args(["-lic", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                paths::log(&format!("读取登录 shell（{shell}）的 PATH 超时"));
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    between_marks(&out)
}

fn between_marks(out: &str) -> Option<String> {
    let start = out.find(MARK)? + MARK.len();
    let len = out[start..].find(MARK)?;
    Some(out[start..start + len].to_string()).filter(|p| !p.is_empty())
}

fn login_path() -> Option<&'static str> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE.get_or_init(read_login_path).as_deref()
}

/// `v18.20.4`, `v22.1.0`, ... the highest version, by number.
fn newest_version<'a>(names: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let key = |n: &str| -> Vec<u64> { n.trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    names.into_iter().max_by_key(|n| key(n))
}

fn fallback_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        home.join(".volta/bin"),
        home.join(".local/share/fnm/aliases/default/bin"),
    ];
    let nvm = home.join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm) {
        let names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        if let Some(v) = newest_version(names.iter().map(String::as_str)) {
            dirs.push(nvm.join(v).join("bin"));
        }
    }
    dirs
}

/// The folders to search and to hand on as `PATH`, in order, without repeats.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let login = login_path().map(|p| std::env::split_paths(p).collect::<Vec<_>>()).unwrap_or_default();
    let inherited = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    for d in login.into_iter().chain(fallback_dirs(&paths::home())).chain(inherited).chain(SYSTEM_DIRS.map(PathBuf::from)) {
        if !d.as_os_str().is_empty() && !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Finds Node: the chosen executable when one is set (an error if it is not usable), else the
/// first `node` along the search folders.
pub fn resolve(manual: Option<&str>) -> Result<NodeEnv, String> {
    let mut dirs = search_dirs();
    let node = match manual.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => {
            let p = PathBuf::from(m);
            if !is_executable(&p) {
                return Err(format!("设置里指定的 Node 不可执行：{m}"));
            }
            p
        }
        None => dirs
            .iter()
            .map(|d| d.join("node"))
            .find(|p| is_executable(p))
            .ok_or_else(|| "找不到 Node。请安装 Node.js，或在设置里指定 node 可执行文件的位置。".to_string())?,
    };
    if let Some(dir) = node.parent() {
        dirs.retain(|d| d != dir);
        dirs.insert(0, dir.to_path_buf());
    }
    let path_var = std::env::join_paths(&dirs).map_err(|e| e.to_string())?;
    Ok(NodeEnv { node, path_var })
}

/// `node --version`, e.g. `v22.11.0`.
pub fn version(env: &NodeEnv) -> Option<String> {
    let out = Command::new(&env.node).arg("--version").env("PATH", &env.path_var).stdin(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_between_the_marks_is_taken_and_shell_noise_ignored() {
        // Arrange
        let out = format!("Welcome!\n{MARK}/opt/homebrew/bin:/usr/bin{MARK}\nbye");

        // Act
        let p = between_marks(&out);

        // Assert
        assert_eq!(p.as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
    }

    #[test]
    fn missing_or_empty_marks_give_nothing() {
        // Act / Assert
        assert_eq!(between_marks("no marks"), None);
        assert_eq!(between_marks(&format!("{MARK}{MARK}")), None);
    }

    #[test]
    fn the_newest_nvm_version_compares_numbers_not_text() {
        // Arrange
        let names = ["v9.11.2", "v18.20.4", "v18.3.0", "v22.1.0", "v100.0.0"];

        // Act
        let newest = newest_version(names);

        // Assert
        assert_eq!(newest, Some("v100.0.0"));
    }

    #[test]
    fn a_manual_node_that_is_not_executable_is_an_error() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("node");
        std::fs::write(&file, "").unwrap();

        // Act
        let r = resolve(Some(file.to_str().unwrap()));

        // Assert
        assert!(r.is_err());
    }

    #[test]
    fn a_manual_node_comes_first_on_the_path() {
        // Arrange
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("node");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Act
        let env = resolve(Some(file.to_str().unwrap())).unwrap();

        // Assert
        assert_eq!(env.node, file);
        assert_eq!(std::env::split_paths(&env.path_var).next().as_deref(), Some(dir.path()));
        assert!(std::env::split_paths(&env.path_var).any(|d| d == Path::new("/usr/bin")));
    }
}
