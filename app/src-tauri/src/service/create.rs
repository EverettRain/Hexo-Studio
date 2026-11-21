//! Making a new blog from a template (docs/design.md, section 15): Hexo's base, the theme from
//! npm, the packages installed, a git repository. It is built in a hidden folder next to the
//! target and renamed into place only when every step worked, so a failure leaves nothing behind.

use crate::domain::template::{self, NewBlog, Template};
use crate::infra::hexo::{self, Proc};
use crate::infra::git;
use crate::infra::node_env::{self, NodeEnv};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Files,
    Theme,
    Install,
    Git,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Progress {
    /// This step has begun; the ones before it are done.
    Step { step: Step },
    Line { text: String },
}

const STARTER: [(&str, &str); 6] = [
    ("scaffolds/draft.md", include_str!("../../starter/scaffolds/draft.md")),
    ("scaffolds/page.md", include_str!("../../starter/scaffolds/page.md")),
    ("scaffolds/post.md", include_str!("../../starter/scaffolds/post.md")),
    ("source/_posts/hello-world.md", include_str!("../../starter/source/_posts/hello-world.md")),
    (".gitignore", include_str!("../../starter/gitignore")),
    ("package.json", template::PACKAGE_JSON),
];
const STARTER_CONFIG: &str = include_str!("../../starter/_config.yml");

const CANCELLED: &str = "已取消创建。";

#[derive(Default)]
pub struct Creator {
    busy: AtomicBool,
    cancelled: AtomicBool,
    proc: Mutex<Option<Arc<Proc>>>,
    /// The hidden folder being built.
    work: Mutex<Option<PathBuf>>,
}

/// Lets `busy` go however `create` ends.
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Creator {
    /// Makes the blog and returns its folder.
    pub fn create(&self, env: &NodeEnv, blog: &NewBlog, sink: &(dyn Fn(Progress) + Sync)) -> Result<PathBuf, String> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err("已经在创建一个博客了。".into());
        }
        let _busy = Busy(&self.busy);
        self.cancelled.store(false, Ordering::SeqCst);

        let template = match &blog.template {
            Some(id) => Some(template::find(id).ok_or_else(|| format!("没有这个模板：{id}"))?),
            None => None,
        };
        template::check_folder(&blog.folder)?;
        let parent = PathBuf::from(&blog.parent);
        if !parent.is_dir() {
            return Err(format!("位置不存在：{}", parent.display()));
        }
        let target = parent.join(blog.folder.trim());
        if target.exists() {
            return Err(format!("{} 已经存在，请换个文件夹名。", target.display()));
        }
        if let Some(v) = node_env::version(env).filter(|v| !template::node_ok(v)) {
            let (major, minor) = template::MIN_NODE;
            return Err(format!("新版 Hexo 需要 Node {major}.{minor} 以上，当前是 {v}。请升级 Node，或在设置里指定一个新版本的 node。"));
        }
        let npm = node_env::npm(env)?;

        let work = parent.join(format!(".{}.hexostudio-{}", blog.folder.trim(), jiff::Timestamp::now().as_millisecond()));
        std::fs::create_dir(&work).map_err(|e| format!("无法在 {} 里创建文件夹：{e}", parent.display()))?;
        *self.work.lock().unwrap() = Some(work.clone());
        let built = self.build(&work, env, &npm, template, blog, sink).and_then(|()| {
            if target.exists() {
                return Err(format!("{} 刚被别的程序建了出来，没有覆盖它。", target.display()));
            }
            std::fs::rename(&work, &target).map_err(|e| format!("无法改名为 {}：{e}", target.display()))
        });
        *self.work.lock().unwrap() = None;
        match built {
            Ok(()) => Ok(target),
            Err(e) => {
                // Holds only what this run wrote.
                let _ = std::fs::remove_dir_all(&work);
                Err(e)
            }
        }
    }

    /// Ends the running step; the next one does not start.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(p) = self.proc.lock().unwrap().clone() {
            p.terminate();
        }
    }

    /// On quitting: the creating thread may not get to clean up, so the half-built folder goes here.
    pub fn abandon(&self) {
        self.cancel();
        if let Some(work) = self.work.lock().unwrap().take() {
            let _ = std::fs::remove_dir_all(work);
        }
    }

    fn build(&self, work: &Path, env: &NodeEnv, npm: &Path, t: Option<&Template>, blog: &NewBlog, sink: &(dyn Fn(Progress) + Sync)) -> Result<(), String> {
        let write = |rel: &str, text: &str| -> Result<(), String> {
            let p = work.join(rel);
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(&p, text).map_err(|e| format!("无法写入 {rel}：{e}"))
        };

        self.step(Step::Files, sink)?;
        let zone = std::fs::read_link("/etc/localtime").ok().and_then(|l| template::zone_from_localtime(&l.to_string_lossy()));
        let theme = t.map_or(template::PLAIN_THEME, |t| t.theme);
        write("_config.yml", &template::site_config(STARTER_CONFIG, blog, theme, zone.as_deref()))?;
        for (rel, text) in STARTER {
            write(rel, text)?;
        }
        std::fs::create_dir_all(work.join("themes")).map_err(|e| e.to_string())?;

        if let Some(t) = t {
            self.theme(work, env, npm, t, sink)?;
        }

        self.step(Step::Install, sink)?;
        let mut install = Command::new(npm);
        install
            .args(["install", "--save", "--no-audit", "--no-fund"])
            .args(template::BASE_PACKAGES)
            .args(t.map_or(&template::PLAIN_PACKAGES[..], |t| t.plugins))
            .current_dir(work)
            .env("PATH", &env.path_var);
        self.run(install, "npm install", sink)?;

        self.step(Step::Git, sink)?;
        git::init(work, &env.path_var)
    }

    /// Unpacks the template's theme from npm into `themes/` and copies its defaults as the overrides file.
    fn theme(&self, work: &Path, env: &NodeEnv, npm: &Path, t: &Template, sink: &(dyn Fn(Progress) + Sync)) -> Result<(), String> {
        self.step(Step::Theme, sink)?;
        let mut pack = Command::new(npm);
        pack.args(["pack", &format!("{}@latest", t.package), "--pack-destination", "."]).current_dir(work).env("PATH", &env.path_var);
        self.run(pack, "npm pack", sink)?;
        let tarball = std::fs::read_dir(work)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == "tgz"))
            .ok_or("npm 没有下载到主题的压缩包。")?;
        let mut untar = Command::new("/usr/bin/tar");
        untar.arg("-xzf").arg(&tarball).current_dir(work);
        self.run(untar, "解压主题", sink)?;
        let _ = std::fs::remove_file(&tarball);
        let theme_dir = work.join("themes").join(t.theme);
        std::fs::rename(work.join("package"), &theme_dir).map_err(|e| format!("无法放好主题文件夹：{e}"))?;
        std::fs::copy(theme_dir.join("_config.yml"), work.join(format!("_config.{}.yml", t.theme)))
            .map_err(|e| format!("无法复制主题的默认配置：{e}"))?;
        Ok(())
    }

    fn step(&self, step: Step, sink: &(dyn Fn(Progress) + Sync)) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        sink(Progress::Step { step });
        Ok(())
    }

    /// Runs `cmd` to its end, its output to the log.
    fn run(&self, cmd: Command, label: &str, sink: &(dyn Fn(Progress) + Sync)) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let proc = Arc::new(hexo::spawn_command(cmd, label, move |_, text| {
            let _ = tx.send(text);
        })?);
        *self.proc.lock().unwrap() = Some(proc.clone());
        // A cancel that came between the step's check and the start found no process to end.
        if self.cancelled.load(Ordering::SeqCst) {
            proc.terminate();
        }
        // Lines go out from this thread, as they come, so the sink needs no 'static. Every line
        // is in before the exit is (see `spawn_command`).
        let exit = loop {
            let done = proc.wait_timeout(std::time::Duration::from_millis(100));
            for text in rx.try_iter() {
                sink(Progress::Line { text });
            }
            if let Some(exit) = done {
                break exit;
            }
        };
        *self.proc.lock().unwrap() = None;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        match exit {
            Some(0) => Ok(()),
            Some(code) => Err(format!("{label} 失败（退出码 {code}），详见日志。")),
            None => Err(format!("{label} 被中止了。")),
        }
    }
}
