//! Running the blog's Hexo as a child process: own process group, output line by line.

use super::node_env::NodeEnv;
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stream {
    Out,
    Err,
}

/// How a process ended: its exit code, or `None` when a signal ended it.
pub type Exit = Option<i32>;

/// A running command. Hexo starts helpers of its own (git and ssh during a deploy), so the
/// whole process group is signalled, and none is left behind.
pub struct Proc {
    pid: i32,
    exit: Arc<(Mutex<Option<Exit>>, Condvar)>,
}

/// Starts `node <blog>/node_modules/.bin/hexo <args>` in the blog folder. `TZ` is the blog's
/// zone, so post addresses are dated as `domain::permalink` computes them whichever zone the
/// Mac is in. Every output line goes to `on_line`; all lines are delivered before the exit is.
pub fn spawn(
    blog_root: &Path,
    hexo_bin: &Path,
    env: &NodeEnv,
    timezone: Option<&str>,
    args: &[&str],
    on_line: impl Fn(Stream, String) + Send + Sync + 'static,
) -> Result<Proc, String> {
    let mut cmd = Command::new(&env.node);
    cmd.arg(hexo_bin)
        .args(args)
        .current_dir(blog_root)
        .env("PATH", &env.path_var)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    if let Some(tz) = timezone {
        cmd.env("TZ", tz);
    }
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 Hexo：{e}"))?;
    let on_line = Arc::new(on_line);
    let readers: Vec<_> = [
        child.stdout.take().map(|s| (Stream::Out, Box::new(s) as Box<dyn Read + Send>)),
        child.stderr.take().map(|s| (Stream::Err, Box::new(s) as Box<dyn Read + Send>)),
    ]
    .into_iter()
    .flatten()
    .map(|(stream, r)| {
        let on_line = on_line.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(r);
            let mut buf = Vec::new();
            while reader.read_until(b'\n', &mut buf).is_ok_and(|n| n > 0) {
                let line = String::from_utf8_lossy(&buf);
                on_line(stream, line.trim_end_matches(['\n', '\r']).to_string());
                buf.clear();
            }
        })
    })
    .collect();
    let pid = child.id() as i32;
    let exit = Arc::new((Mutex::new(None), Condvar::new()));
    let done = exit.clone();
    std::thread::spawn(move || {
        let status = child.wait().ok().and_then(|s| s.code());
        for r in readers {
            let _ = r.join();
        }
        *done.0.lock().unwrap() = Some(status);
        done.1.notify_all();
    });
    Ok(Proc { pid, exit })
}

/// Ends a process group left by an earlier run that did not get to stop it (killed or
/// crashed), if its leader still is a Hexo process; a reused id of anything else is left alone.
pub fn end_stale_group(pid: i32) {
    let Ok(out) = Command::new("/bin/ps").args(["-o", "command=", "-p", &pid.to_string()]).output() else { return };
    if !String::from_utf8_lossy(&out.stdout).contains("hexo") {
        return;
    }
    // SAFETY: killpg only sends signals.
    unsafe {
        libc::killpg(pid, libc::SIGTERM);
    }
    std::thread::sleep(Duration::from_millis(800));
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
}

impl Proc {
    pub fn pid(&self) -> i32 {
        self.pid
    }

    /// Waits up to `limit` for the process to end; `None` while it still runs.
    pub fn wait_timeout(&self, limit: Duration) -> Option<Exit> {
        let (lock, cv) = &*self.exit;
        let guard = cv.wait_timeout_while(lock.lock().unwrap(), limit, |e| e.is_none()).unwrap().0;
        *guard
    }

    pub fn wait(&self) -> Exit {
        let (lock, cv) = &*self.exit;
        let guard = cv.wait_while(lock.lock().unwrap(), |e| e.is_none()).unwrap();
        (*guard).unwrap_or(None)
    }

    pub fn has_exited(&self) -> bool {
        self.exit.0.lock().unwrap().is_some()
    }

    fn signal(&self, sig: i32) {
        // SAFETY: killpg only sends a signal; a group that is gone gives ESRCH, which is fine.
        unsafe {
            libc::killpg(self.pid, sig);
        }
    }

    /// Asks the group to end, then kills what is left after a grace period.
    pub fn terminate(&self) {
        self.signal(libc::SIGTERM);
        let _ = self.wait_timeout(Duration::from_secs(3));
        self.signal(libc::SIGKILL);
        let _ = self.wait_timeout(Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    /// A stand-in for Node that runs the "hexo" script with sh, so these tests need no Node.
    fn fake_env(dir: &Path) -> NodeEnv {
        let node = dir.join("node");
        std::fs::write(&node, "#!/bin/sh\nexec /bin/sh \"$@\"\n").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        NodeEnv { node, path_var: "/usr/bin:/bin".into() }
    }

    /// Linux refuses to run a file another thread's fork still holds open for writing (the
    /// test just wrote it): try again shortly. Only these tests write the programs they run.
    fn spawn_retrying(
        dir: &Path,
        bin: &Path,
        env: &NodeEnv,
        tz: Option<&str>,
        args: &[&str],
        on_line: impl Fn(Stream, String) + Send + Sync + Clone + 'static,
    ) -> Proc {
        for _ in 0..50 {
            match spawn(dir, bin, env, tz, args, on_line.clone()) {
                Err(e) if e.contains("Text file busy") => std::thread::sleep(Duration::from_millis(20)),
                other => return other.unwrap(),
            }
        }
        panic!("the test program stayed busy");
    }

    fn script(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("hexo");
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn delivers_every_line_of_both_streams_before_the_exit_code() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        let bin = script(dir.path(), "echo \"one $1\"\necho two >&2\nprintf 'no newline'\nexit 3\n");
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();

        // Act
        let p = spawn_retrying(dir.path(), &bin, &fake_env(dir.path()), None, &["arg"], move |s, l| sink.lock().unwrap().push((s, l)));
        let exit = p.wait();

        // Assert
        assert_eq!(exit, Some(3));
        let mut got = lines.lock().unwrap().clone();
        got.sort_by(|a, b| a.1.cmp(&b.1));
        assert_eq!(got, vec![(Stream::Out, "no newline".into()), (Stream::Out, "one arg".into()), (Stream::Err, "two".into())]);
    }

    #[test]
    fn runs_in_the_blog_folder_with_the_blogs_zone() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        let bin = script(dir.path(), "echo \"$TZ $(pwd)\"\n");
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();

        // Act
        let p =
            spawn_retrying(dir.path(), &bin, &fake_env(dir.path()), Some("Asia/Shanghai"), &[], move |_, l| sink.lock().unwrap().push(l));
        p.wait();

        // Assert
        let cwd = dir.path().canonicalize().unwrap();
        assert_eq!(*lines.lock().unwrap(), vec![format!("Asia/Shanghai {}", cwd.display())]);
    }

    #[test]
    fn terminate_ends_the_process_and_its_children() {
        // Arrange: the child sleeps in a subprocess of its own, as hexo's git would.
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("child.pid");
        let bin = script(dir.path(), &format!("sleep 30 &\necho $! > '{}'\nwait\n", marker.display()));
        let p = spawn_retrying(dir.path(), &bin, &fake_env(dir.path()), None, &[], |_, _| {});
        while !marker.exists() || std::fs::read_to_string(&marker).unwrap().trim().is_empty() {
            std::thread::sleep(Duration::from_millis(20));
        }
        let child: i32 = std::fs::read_to_string(&marker).unwrap().trim().parse().unwrap();

        // Act
        p.terminate();

        // Assert
        assert!(p.has_exited());
        std::thread::sleep(Duration::from_millis(100));
        // SAFETY: signal 0 only checks whether the process exists.
        let alive = unsafe { libc::kill(child, 0) } == 0 && !is_zombie(child);
        assert!(!alive, "the sleeping child survived");
    }

    #[test]
    fn a_stale_hexo_group_is_ended_and_other_processes_are_not() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        let bin = script(dir.path(), "sleep 30\n");
        let hexo = spawn_retrying(dir.path(), &bin, &fake_env(dir.path()), None, &[], |_, _| {});
        let mut other = Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(100));

        // Act
        end_stale_group(hexo.pid());
        end_stale_group(other.id() as i32);

        // Assert
        assert!(hexo.wait_timeout(Duration::from_secs(3)).is_some(), "the hexo group still runs");
        assert!(other.try_wait().unwrap().is_none(), "an unrelated process was ended");
        let _ = other.kill();
        let _ = other.wait();
    }

    fn is_zombie(pid: i32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| s.split_whitespace().nth(2) == Some("Z"))
    }
}
