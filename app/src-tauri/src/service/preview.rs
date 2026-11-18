//! The preview server: `hexo server --draft` on a free local port, started on demand and
//! stopped before commands that write `db.json` / `public/` and when the app quits.

use crate::infra::blog::Blog;
use crate::infra::hexo::{self, Proc, Stream};
use crate::infra::node_env::NodeEnv;
use crate::infra::project;
use serde::Serialize;
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum PreviewState {
    Stopped,
    Starting,
    Running { port: u16 },
    Failed { message: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub stream: Stream,
    pub text: String,
}

pub enum PreviewEvent {
    State(PreviewState),
    Log(LogLine),
}

type Sink = Arc<dyn Fn(PreviewEvent) + Send + Sync>;

const LOG_LINES: usize = 1000;
/// The first start reads every post and renders the theme; a large blog takes a while.
const START_LIMIT: Duration = Duration::from_secs(120);

struct Inner {
    state: PreviewState,
    proc: Option<Arc<Proc>>,
    root: Option<PathBuf>,
    /// Bumped by each start and stop, so a process that ends after being replaced or stopped
    /// on purpose is not reported as a failure.
    generation: u64,
    log: VecDeque<LogLine>,
}

pub struct Preview {
    sink: Sink,
    inner: Mutex<Inner>,
    /// Starts and stops one at a time; state reads do not wait for them.
    ops: Mutex<()>,
}

/// The running server's process group, so the next run of the app can end it if this one never
/// got to (see `infra::hexo::end_stale_group`).
fn pid_file(root: &std::path::Path) -> PathBuf {
    project::local_dir(root).join("preview.pid")
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| format!("找不到空闲端口：{e}"))
}

impl Preview {
    pub fn new(sink: impl Fn(PreviewEvent) + Send + Sync + 'static) -> Arc<Preview> {
        Arc::new(Preview {
            sink: Arc::new(sink),
            inner: Mutex::new(Inner { state: PreviewState::Stopped, proc: None, root: None, generation: 0, log: VecDeque::new() }),
            ops: Mutex::new(()),
        })
    }

    pub fn state(&self) -> PreviewState {
        self.inner.lock().unwrap().state.clone()
    }

    pub fn log(&self) -> Vec<LogLine> {
        self.inner.lock().unwrap().log.iter().cloned().collect()
    }

    /// The port while serving `root`.
    pub fn port_for(&self, root: &std::path::Path) -> Option<u16> {
        let inner = self.inner.lock().unwrap();
        match inner.state {
            PreviewState::Running { port } if inner.root.as_deref() == Some(root) => Some(port),
            _ => None,
        }
    }

    fn set_state(&self, inner: &mut Inner, state: PreviewState) {
        inner.state = state.clone();
        (self.sink)(PreviewEvent::State(state));
    }

    fn push_log(&self, line: LogLine) {
        let mut inner = self.inner.lock().unwrap();
        if inner.log.len() >= LOG_LINES {
            inner.log.pop_front();
        }
        inner.log.push_back(line.clone());
        drop(inner);
        (self.sink)(PreviewEvent::Log(line));
    }

    /// Starts serving `blog` (stopping a server for another blog first) and waits until it
    /// answers. Already serving it: returns at once.
    pub fn start(self: &Arc<Self>, blog: &Blog, env: &NodeEnv) -> Result<u16, String> {
        let _op = self.ops.lock().unwrap();
        if let Some(port) = self.port_for(&blog.root) {
            return Ok(port);
        }
        self.stop_now();
        let bin = blog.hexo_bin()?;
        let port = free_port()?;
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            inner.generation += 1;
            inner.log.clear();
            inner.root = Some(blog.root.clone());
            self.set_state(&mut inner, PreviewState::Starting);
            inner.generation
        };
        let me = Arc::downgrade(self);
        let port_arg = port.to_string();
        let spawned = hexo::spawn(
            &blog.root,
            &bin,
            env,
            blog.config.timezone.as_deref(),
            &["server", "--draft", "-i", "127.0.0.1", "-p", &port_arg],
            move |stream, text| {
                if let Some(p) = me.upgrade() {
                    p.push_log(LogLine { stream, text });
                }
            },
        );
        let proc = match spawned {
            Ok(p) => Arc::new(p),
            Err(e) => {
                let mut inner = self.inner.lock().unwrap();
                self.set_state(&mut inner, PreviewState::Failed { message: e.clone() });
                return Err(e);
            }
        };
        self.inner.lock().unwrap().proc = Some(proc.clone());
        let pid_file = pid_file(&blog.root);
        let _ = pid_file.parent().map(std::fs::create_dir_all);
        let _ = std::fs::write(&pid_file, proc.pid().to_string());
        self.watch_exit(proc.clone(), generation);

        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let deadline = Instant::now() + START_LIMIT;
        loop {
            if proc.has_exited() {
                return Err(self.failure_message());
            }
            if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
                let mut inner = self.inner.lock().unwrap();
                if inner.generation == generation {
                    self.set_state(&mut inner, PreviewState::Running { port });
                }
                return Ok(port);
            }
            if Instant::now() > deadline {
                self.stop_now();
                let message = "预览服务器启动超时。".to_string();
                let mut inner = self.inner.lock().unwrap();
                self.set_state(&mut inner, PreviewState::Failed { message: message.clone() });
                return Err(message);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// Marks the server failed if it ends without being asked to.
    fn watch_exit(self: &Arc<Self>, proc: Arc<Proc>, generation: u64) {
        let me = Arc::downgrade(self);
        std::thread::spawn(move || {
            let code = proc.wait();
            let Some(p) = me.upgrade() else { return };
            let mut inner = p.inner.lock().unwrap();
            if inner.generation != generation {
                return;
            }
            inner.proc = None;
            let tail: Vec<String> = inner.log.iter().rev().take(6).rev().map(|l| l.text.clone()).collect();
            let code = code.map_or("被信号终止".to_string(), |c| format!("退出码 {c}"));
            let message =
                format!("预览服务器已退出（{code}）。{}", if tail.is_empty() { String::new() } else { format!("\n{}", tail.join("\n")) });
            p.set_state(&mut inner, PreviewState::Failed { message });
        });
    }

    fn failure_message(&self) -> String {
        // The exit watcher sets the message; give it a moment when the exit was just seen.
        for _ in 0..20 {
            if let PreviewState::Failed { message } = self.state() {
                return message;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        "预览服务器启动失败。".into()
    }

    fn stop_now(&self) {
        let (proc, root) = {
            let mut inner = self.inner.lock().unwrap();
            inner.generation += 1;
            let proc = inner.proc.take();
            if inner.state != PreviewState::Stopped {
                self.set_state(&mut inner, PreviewState::Stopped);
            }
            (proc, inner.root.clone())
        };
        if let Some(p) = proc {
            p.terminate();
            if let Some(root) = root {
                let _ = std::fs::remove_file(pid_file(&root));
            }
        }
    }

    /// Ends a server an earlier run of the app left for this blog (killed or crashed before it
    /// could stop it), as recorded in the blog's `.hexostudio/local/preview.pid`.
    pub fn end_stale(root: &std::path::Path) {
        let file = pid_file(root);
        if let Some(pid) = std::fs::read_to_string(&file).ok().and_then(|s| s.trim().parse().ok()) {
            hexo::end_stale_group(pid);
        }
        let _ = std::fs::remove_file(file);
    }

    pub fn stop(&self) {
        let _op = self.ops.lock().unwrap();
        self.stop_now();
    }
}

/// What a preview page returned: enough to tell whether it changed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageProbe {
    pub status: u16,
    /// Hex, as JavaScript numbers cannot hold 64 bits.
    pub hash: String,
}

/// Only ever a page of the local preview server, whatever `path` holds.
fn page_url(port: u16, path: &str) -> Result<url::Url, String> {
    let mut u = url::Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|e| e.to_string())?;
    u.set_path(path);
    Ok(u)
}

pub async fn probe(client: &reqwest::Client, port: u16, path: &str) -> Result<PageProbe, String> {
    let resp = client.get(page_url(port, path)?).send().await.map_err(|e| format!("无法访问预览服务器：{e}"))?;
    let status = resp.status().as_u16();
    let body = resp.bytes().await.map_err(|e| e.to_string())?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    body.hash(&mut h);
    Ok(PageProbe { status, hash: format!("{:016x}", h.finish()) })
}

/// Hexo re-renders a page some time after its file is saved. Polls the page until it differs
/// from `before` (what it was before the save) and is found, for at most `limit`; returns the
/// last result. A save that moves the post (a new date) has no `before`, and its new address
/// answers 404 until Hexo has read the file again.
pub async fn await_change(
    client: &reqwest::Client,
    port: u16,
    path: &str,
    before: Option<PageProbe>,
    limit: Duration,
) -> Result<PageProbe, String> {
    let deadline = Instant::now() + limit;
    loop {
        let now = probe(client, port, path).await?;
        if (before.as_ref() != Some(&now) && now.status != 404) || Instant::now() >= deadline {
            return Ok(now);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_urls_are_percent_encoded_and_stay_on_the_preview_server() {
        // Act
        let u = page_url(4000, "/2025/02/01/搭建Hexo博客网站教程/").unwrap();
        let away = page_url(4000, "//example.com/x").unwrap();

        // Assert
        assert_eq!(
            u.as_str(),
            "http://127.0.0.1:4000/2025/02/01/%E6%90%AD%E5%BB%BAHexo%E5%8D%9A%E5%AE%A2%E7%BD%91%E7%AB%99%E6%95%99%E7%A8%8B/"
        );
        assert_eq!(away.host_str(), Some("127.0.0.1"));
    }
}
