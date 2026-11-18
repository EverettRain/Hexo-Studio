//! The blog's own git repository (its sources, not the deploy repository).

use super::node_env::NodeEnv;
use std::path::Path;
use std::process::{Command, Stdio};

/// How many files `git status` lists as changed or untracked; `None` when the folder is not a
/// git repository or git cannot run.
pub fn uncommitted(root: &Path, env: &NodeEnv) -> Option<usize> {
    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(root)
        .env("PATH", &env.path_var)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.trim().is_empty()).count())
}

/// The `origin` remote's address, shown with the project; `None` without one.
pub fn origin(root: &Path, path_var: &std::ffi::OsStr) -> Option<String> {
    let out = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(root)
        .env("PATH", path_var)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !url.is_empty()).then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> NodeEnv {
        NodeEnv { node: "/usr/bin/false".into(), path_var: "/usr/bin:/bin:/usr/local/bin".into() }
    }

    #[test]
    fn counts_changed_and_untracked_files() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(dir.path()).output().unwrap().status.success());
        git(&["init", "-q"]);
        std::fs::write(dir.path().join("a.md"), "a").unwrap();
        std::fs::write(dir.path().join("b.md"), "b").unwrap();

        // Act
        let n = uncommitted(dir.path(), &env());

        // Assert
        assert_eq!(n, Some(2));
    }

    #[test]
    fn reads_the_origin_remote() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(dir.path()).output().unwrap().status.success());
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", "git@github.com:someone/blog.git"]);

        // Act
        let url = origin(dir.path(), &env().path_var);

        // Assert
        assert_eq!(url.as_deref(), Some("git@github.com:someone/blog.git"));
    }

    #[test]
    fn a_folder_outside_git_gives_none() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();

        // Act / Assert
        assert_eq!(uncommitted(dir.path(), &env()), None);
        assert_eq!(origin(dir.path(), &env().path_var), None);
    }
}
