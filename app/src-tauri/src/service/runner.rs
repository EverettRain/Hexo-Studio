//! One Hexo command at a time, with its output, and the last few runs kept in memory.
//!
//! `clean`, `generate` and `deploy` write `db.json` and `public/` as the preview server does, so
//! the server is stopped before them and started again afterwards if it was running.

use super::preview::Preview;
use crate::domain::deploy_log::{self, Level, Problem};
use crate::domain::task::{self, Task};
use crate::infra::blog::Blog;
use crate::infra::hexo::{self, Proc, Stream};
use crate::infra::node_env::NodeEnv;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

const KEPT_RUNS: usize = 10;
const KEPT_LINES: usize = 5000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLine {
    pub stream: Stream,
    pub level: Level,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: u64,
    pub task: Task,
    pub label: String,
    pub status: RunStatus,
    /// Unix milliseconds.
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub lines: Vec<RunLine>,
    pub problems: Vec<Problem>,
    /// Shown before the output, e.g. uncommitted changes in the blog's own repository.
    pub notes: Vec<String>,
    /// The post id a `new` or `publish` made.
    pub created: Option<String>,
}

pub enum RunEvent {
    Started(Run),
    Line { run: u64, line: RunLine },
    Finished(Run),
}

type Sink = Arc<dyn Fn(RunEvent) + Send + Sync>;

struct Inner {
    next_id: u64,
    current: Option<u64>,
    proc: Option<Arc<Proc>>,
    cancelled: bool,
    /// Whether the running task stopped the preview server.
    exclusive: bool,
    runs: VecDeque<Run>,
}

pub struct Runner {
    preview: Arc<Preview>,
    sink: Sink,
    inner: Mutex<Inner>,
}

fn now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

impl Runner {
    pub fn new(preview: Arc<Preview>, sink: impl Fn(RunEvent) + Send + Sync + 'static) -> Arc<Runner> {
        Arc::new(Runner {
            preview,
            sink: Arc::new(sink),
            inner: Mutex::new(Inner { next_id: 1, current: None, proc: None, cancelled: false, exclusive: false, runs: VecDeque::new() }),
        })
    }

    pub fn runs(&self) -> Vec<Run> {
        self.inner.lock().unwrap().runs.iter().cloned().collect()
    }

    pub fn busy(&self) -> bool {
        self.inner.lock().unwrap().current.is_some()
    }

    /// Forgets the history (another project was opened); refused while a command runs.
    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.current.is_none() {
            inner.runs.clear();
        }
    }

    /// A command that needs the preview server stopped is running.
    pub fn holds_site(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.current.is_some() && inner.exclusive
    }

    fn with_run(&self, id: u64, f: impl FnOnce(&mut Run)) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(r) = inner.runs.iter_mut().find(|r| r.id == id) {
            f(r);
        }
    }

    fn line(&self, id: u64, stream: Stream, text: String) {
        let line = RunLine { stream, level: deploy_log::level(&text), text };
        self.with_run(id, |r| {
            if r.lines.len() < KEPT_LINES {
                r.lines.push(line.clone());
            }
        });
        (self.sink)(RunEvent::Line { run: id, line });
    }

    /// Starts `task` in the background and returns its run id; refused while another runs.
    /// `on_done` gets the finished run.
    pub fn start(
        self: &Arc<Self>,
        task: Task,
        blog: Blog,
        env: NodeEnv,
        notes: Vec<String>,
        on_done: impl FnOnce(Run) + Send + 'static,
    ) -> Result<u64, String> {
        let hexo_bin = blog.hexo_bin()?;
        let run = {
            let mut inner = self.inner.lock().unwrap();
            if let Some(cur) = inner.current {
                let label = inner.runs.iter().find(|r| r.id == cur).map(|r| r.label.clone()).unwrap_or_default();
                return Err(format!("正在执行「{label}」，请等它结束。"));
            }
            let id = inner.next_id;
            inner.next_id += 1;
            inner.current = Some(id);
            inner.cancelled = false;
            inner.exclusive = task.exclusive();
            let run = Run {
                id,
                label: task.label(),
                task: task.clone(),
                status: RunStatus::Running,
                started_at: now_ms(),
                ended_at: None,
                lines: Vec::new(),
                problems: Vec::new(),
                notes,
                created: None,
            };
            if inner.runs.len() >= KEPT_RUNS {
                inner.runs.pop_front();
            }
            inner.runs.push_back(run.clone());
            run
        };
        let id = run.id;
        (self.sink)(RunEvent::Started(run));
        let me = self.clone();
        std::thread::spawn(move || {
            let finished = me.execute(id, &task, &blog, &env, &hexo_bin);
            on_done(finished);
        });
        Ok(id)
    }

    fn execute(self: &Arc<Self>, id: u64, task: &Task, blog: &Blog, env: &NodeEnv, hexo_bin: &std::path::Path) -> Run {
        let resume_preview = task.exclusive() && self.preview.port_for(&blog.root).is_some();
        if task.exclusive() {
            self.preview.stop();
            if resume_preview {
                self.line(id, Stream::Out, "已停止预览服务器（它和这个命令都会写 db.json / public），结束后自动恢复。".into());
            }
        }
        let before: Vec<String> = blog.list_posts().into_iter().map(|p| p.id).collect();

        let mut status = RunStatus::Succeeded;
        for args in task.steps() {
            if self.inner.lock().unwrap().cancelled {
                status = RunStatus::Cancelled;
                break;
            }
            self.line(id, Stream::Out, format!("$ hexo {}", args.join(" ")));
            let me = Arc::downgrade(self);
            let argv: Vec<&str> = args.iter().map(String::as_str).collect();
            let spawned = hexo::spawn(&blog.root, hexo_bin, env, blog.config.timezone.as_deref(), &argv, move |stream, text| {
                if let Some(r) = me.upgrade() {
                    r.line(id, stream, text);
                }
            });
            let proc = match spawned {
                Ok(p) => Arc::new(p),
                Err(e) => {
                    self.line(id, Stream::Err, e);
                    status = RunStatus::Failed;
                    break;
                }
            };
            self.inner.lock().unwrap().proc = Some(proc.clone());
            let code = proc.wait();
            self.inner.lock().unwrap().proc = None;
            if self.inner.lock().unwrap().cancelled {
                status = RunStatus::Cancelled;
                break;
            }
            if code != Some(0) {
                self.line(
                    id,
                    Stream::Err,
                    format!("hexo {} 失败（{}）", args[0], code.map_or("被信号终止".into(), |c| format!("退出码 {c}"))),
                );
                status = RunStatus::Failed;
                break;
            }
        }

        let created = if status == RunStatus::Succeeded && matches!(task, Task::New { .. } | Task::Publish { .. }) {
            let after: Vec<String> = blog.list_posts().into_iter().map(|p| p.id).collect();
            task::created(&before, &after)
        } else {
            None
        };
        if resume_preview {
            if let Err(e) = self.preview.start(blog, env) {
                self.line(id, Stream::Err, format!("预览服务器没能恢复：{e}"));
            }
        }
        let mut inner = self.inner.lock().unwrap();
        inner.current = None;
        inner.exclusive = false;
        let run = inner.runs.iter_mut().find(|r| r.id == id).expect("run kept while running");
        run.status = status;
        run.ended_at = Some(now_ms());
        run.created = created;
        run.problems = deploy_log::diagnose(&run.lines.iter().map(|l| l.text.clone()).collect::<Vec<_>>());
        let run = run.clone();
        drop(inner);
        (self.sink)(RunEvent::Finished(run.clone()));
        run
    }

    /// Stops the running command (its whole process group); the remaining steps are skipped.
    pub fn cancel(&self) {
        let proc = {
            let mut inner = self.inner.lock().unwrap();
            if inner.current.is_none() {
                return;
            }
            inner.cancelled = true;
            inner.proc.clone()
        };
        if let Some(p) = proc {
            p.terminate();
        }
    }
}
