//! The blog's own git repository (its sources, not the deploy repository).

use super::node_env::NodeEnv;
use crate::domain::source::{self, explain_failure, Commit, Status};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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

const LOCAL_LIMIT: Duration = Duration::from_secs(30);
const NETWORK_LIMIT: Duration = Duration::from_secs(120);

/// Runs git in `root` and returns its output; a failure carries what `explain_failure` makes of
/// git's message. Nothing can wait for input (no terminal, no password prompt), and a command
/// that outlives `limit` is ended together with the helpers it started (ssh, hooks): they hold
/// its output pipes, so ending git alone would not return.
fn run(root: &Path, env: &NodeEnv, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("PATH", &env.path_var)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("无法运行 git：{e}"))?;
    let group = child.id() as i32;
    // Both pipes are drained while waiting; a full pipe would stall git.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(s) => break Some(s),
            None if Instant::now() >= deadline => {
                // SAFETY: killpg only sends a signal; the group is the one git was started in.
                unsafe {
                    libc::killpg(group, libc::SIGKILL);
                }
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    match status {
        Some(s) if s.success() => Ok(stdout),
        Some(_) => Err(explain_failure(if stderr.trim().is_empty() { &stdout } else { &stderr })),
        None => Err(format!("git {} 超过 {} 秒没有结束，已中止。", args.first().unwrap_or(&""), limit.as_secs())),
    }
}

pub fn status(root: &Path, env: &NodeEnv) -> Result<Status, String> {
    run(root, env, &["status", "--porcelain=v1", "-b", "-z"], LOCAL_LIMIT).map(|out| source::parse_status(&out))
}

/// The newest `limit` commits of the current branch; none in a repository without commits.
pub fn log(root: &Path, env: &NodeEnv, limit: usize) -> Result<Vec<Commit>, String> {
    let has_commits = run(root, env, &["rev-parse", "--verify", "-q", "HEAD"], LOCAL_LIMIT).is_ok();
    if !has_commits {
        return Ok(Vec::new());
    }
    let n = format!("-n{limit}");
    run(root, env, &["log", &n, "--format=%H%x1f%an%x1f%ct%x1f%s"], LOCAL_LIMIT).map(|out| source::parse_log(&out))
}

/// Commits every change, untracked files included (what the blog's history has always done).
pub fn commit_all(root: &Path, env: &NodeEnv, message: &str) -> Result<(), String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("提交说明不能为空。".into());
    }
    run(root, env, &["add", "-A"], LOCAL_LIMIT)?;
    run(root, env, &["commit", "-q", "-m", message], LOCAL_LIMIT).map(drop)
}

/// Pushes the current branch; a branch without a usable upstream is pushed to `origin` and set to
/// track it.
pub fn push(root: &Path, env: &NodeEnv) -> Result<(), String> {
    let s = status(root, env)?;
    let Some(branch) = s.branch.as_deref() else {
        return Err("当前不在任何分支上（HEAD 游离），无法推送。".into());
    };
    let args: Vec<&str> = if s.upstream.is_some() && !s.upstream_gone { vec!["push"] } else { vec!["push", "-u", "origin", branch] };
    run(root, env, &args, NETWORK_LIMIT).map(drop)
}

/// Brings in the upstream's new commits without making a merge commit or touching a diverged
/// branch.
pub fn pull(root: &Path, env: &NodeEnv) -> Result<(), String> {
    run(root, env, &["pull", "--ff-only"], NETWORK_LIMIT).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::source::ChangeKind;

    fn env() -> NodeEnv {
        NodeEnv { node: "/usr/bin/false".into(), path_var: "/usr/bin:/bin:/usr/local/bin".into() }
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A repository with a committer, a first commit, and a bare `origin` it has pushed to.
    fn repo_with_origin() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let (work, bare) = (dir.path().join("work"), dir.path().join("origin.git"));
        std::fs::create_dir_all(&work).unwrap();
        git_in(bare.parent().unwrap(), &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
        git_in(&work, &["init", "-q", "-b", "main"]);
        git_in(&work, &["config", "user.name", "Tester"]);
        git_in(&work, &["config", "user.email", "tester@example.com"]);
        git_in(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        std::fs::write(work.join("a.md"), "a").unwrap();
        commit_all(&work, &env(), "第一次提交").unwrap();
        push(&work, &env()).unwrap();
        (dir, work, bare)
    }

    #[test]
    fn commit_all_takes_modified_and_untracked_files() {
        // Arrange
        let (_dir, work, _bare) = repo_with_origin();
        std::fs::write(work.join("a.md"), "changed").unwrap();
        std::fs::write(work.join("新文章.md"), "new").unwrap();

        // Act
        let before = status(&work, &env()).unwrap();
        commit_all(&work, &env(), "  写了新文章  ").unwrap();
        let after = status(&work, &env()).unwrap();
        let history = log(&work, &env(), 10).unwrap();

        // Assert
        let kinds: Vec<_> = before.changes.iter().map(|c| (c.path.as_str(), c.kind)).collect();
        assert!(kinds.contains(&("a.md", ChangeKind::Modified)) && kinds.contains(&("新文章.md", ChangeKind::Untracked)));
        assert!(after.changes.is_empty());
        assert_eq!(history[0].subject, "写了新文章");
        assert_eq!(history.len(), 2);
    }

    #[test]
    fn an_empty_message_is_refused_before_anything_is_staged() {
        // Arrange
        let (_dir, work, _bare) = repo_with_origin();
        std::fs::write(work.join("b.md"), "b").unwrap();

        // Act
        let result = commit_all(&work, &env(), "   ");

        // Assert
        assert!(result.is_err());
        assert_eq!(status(&work, &env()).unwrap().changes[0].kind, ChangeKind::Untracked);
    }

    #[test]
    fn push_sends_the_new_commits_and_clears_ahead() {
        // Arrange
        let (_dir, work, bare) = repo_with_origin();
        std::fs::write(work.join("b.md"), "b").unwrap();
        commit_all(&work, &env(), "第二次提交").unwrap();
        let ahead = status(&work, &env()).unwrap().ahead;

        // Act
        push(&work, &env()).unwrap();

        // Assert
        assert_eq!(ahead, 1);
        assert_eq!(status(&work, &env()).unwrap().ahead, 0);
        let remote_head = Command::new("git").args(["log", "-1", "--format=%s", "main"]).current_dir(&bare).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&remote_head.stdout).trim(), "第二次提交");
    }

    #[test]
    fn the_first_push_sets_the_upstream() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        let (work, bare) = (dir.path().join("work"), dir.path().join("origin.git"));
        std::fs::create_dir_all(&work).unwrap();
        git_in(dir.path(), &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
        git_in(&work, &["init", "-q", "-b", "main"]);
        git_in(&work, &["config", "user.name", "Tester"]);
        git_in(&work, &["config", "user.email", "tester@example.com"]);
        git_in(&work, &["remote", "add", "origin", bare.to_str().unwrap()]);
        std::fs::write(work.join("a.md"), "a").unwrap();
        commit_all(&work, &env(), "起步").unwrap();

        // Act
        let before = status(&work, &env()).unwrap().upstream;
        push(&work, &env()).unwrap();
        let after = status(&work, &env()).unwrap();

        // Assert
        assert_eq!(before, None);
        assert_eq!(after.upstream.as_deref(), Some("origin/main"));
    }

    #[test]
    fn pull_fast_forwards_and_refuses_a_diverged_branch() {
        // Arrange: a second clone pushes a commit
        let (dir, work, bare) = repo_with_origin();
        let other = dir.path().join("other");
        git_in(dir.path(), &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
        git_in(&other, &["config", "user.name", "Other"]);
        git_in(&other, &["config", "user.email", "other@example.com"]);
        std::fs::write(other.join("c.md"), "c").unwrap();
        commit_all(&other, &env(), "别处的提交").unwrap();
        push(&other, &env()).unwrap();
        git_in(&work, &["fetch", "-q"]);
        let behind = status(&work, &env()).unwrap().behind;

        // Act
        pull(&work, &env()).unwrap();

        // Assert: fast-forwarded
        assert_eq!(behind, 1);
        assert!(work.join("c.md").exists());

        // Arrange: now both sides have a new commit
        std::fs::write(other.join("d.md"), "d").unwrap();
        commit_all(&other, &env(), "别处又提交").unwrap();
        push(&other, &env()).unwrap();
        std::fs::write(work.join("e.md"), "e").unwrap();
        commit_all(&work, &env(), "这边也提交").unwrap();

        // Act
        let result = pull(&work, &env());

        // Assert
        assert!(result.is_err());
        assert!(!work.join("d.md").exists());
    }

    #[test]
    fn a_rejected_push_says_to_pull_first() {
        // Arrange
        let (dir, work, bare) = repo_with_origin();
        let other = dir.path().join("other");
        git_in(dir.path(), &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
        git_in(&other, &["config", "user.name", "Other"]);
        git_in(&other, &["config", "user.email", "other@example.com"]);
        std::fs::write(other.join("c.md"), "c").unwrap();
        commit_all(&other, &env(), "别处的提交").unwrap();
        push(&other, &env()).unwrap();
        std::fs::write(work.join("e.md"), "e").unwrap();
        commit_all(&work, &env(), "这边的提交").unwrap();

        // Act
        let err = push(&work, &env()).unwrap_err();

        // Assert
        assert!(err.contains("先拉取"), "{err}");
    }

    #[test]
    fn log_of_a_repository_without_commits_is_empty() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        git_in(dir.path(), &["init", "-q"]);

        // Act / Assert
        assert_eq!(log(dir.path(), &env(), 5).unwrap(), vec![]);
    }

    #[test]
    fn a_command_that_outlives_its_limit_is_ended() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        git_in(dir.path(), &["init", "-q"]);
        git_in(dir.path(), &["config", "alias.nap", "!sleep 5"]);

        // Act
        let started = Instant::now();
        let result = run(dir.path(), &env(), &["nap"], Duration::from_millis(300));

        // Assert
        assert!(result.unwrap_err().contains("超过"));
        assert!(started.elapsed() < Duration::from_secs(4));
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
