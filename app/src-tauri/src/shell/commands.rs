//! Tauri commands the interface calls.

use crate::domain::config::Deployer;
use crate::domain::image_key::Format;
use crate::domain::storage::Storage;
use crate::domain::task::Task;
use crate::domain::{permalink, post};
use crate::infra::blog::{self, Blog, PostFile, PostSummary, WriteOutcome};
use crate::infra::node_env::{self, NodeEnv};
use crate::infra::project::UploadSettings;
use crate::infra::{git, keychain, paths, project, settings};
use crate::service::images::{self, Uploaded};
use crate::service::migration;
use crate::service::preview::{self, LogLine, PageProbe, Preview, PreviewState};
use crate::service::runner::{Run as RunRecord, Runner};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt as _;

/// The project (blog folder) open in the window; one at a time.
#[derive(Default)]
pub struct Workspace {
    project: Mutex<Option<PathBuf>>,
}

type Ws<'a> = State<'a, Workspace>;
type Prev<'a> = State<'a, Arc<Preview>>;
type Run<'a> = State<'a, Arc<Runner>>;

/// Runs blocking work (files, processes) off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn project_root(ws: &Workspace) -> Result<PathBuf, String> {
    ws.project.lock().unwrap().clone().ok_or_else(|| "没有打开项目。".to_string())
}

fn current_blog(ws: &Workspace) -> Result<Blog, String> {
    blog::open(&project_root(ws)?)
}

fn current_node() -> Result<NodeEnv, String> {
    node_env::resolve(settings::load().node_path.as_deref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_dir: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo { version: app.package_info().version.to_string(), data_dir: paths::data_dir().display().to_string() }
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

// ---- projects -----------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCard {
    path: String,
    /// The blog's `title`, else the folder name.
    name: String,
    /// The `origin` remote, e.g. its GitHub repository.
    remote: Option<String>,
    /// Unix seconds.
    opened_at: i64,
    /// Why it cannot be opened now (moved, deleted, no longer a Hexo blog).
    error: Option<String>,
}

fn folder_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

#[tauri::command]
pub async fn recent_projects() -> Result<Vec<ProjectCard>, String> {
    blocking(|| {
        let path_var = current_node().map(|e| e.path_var).unwrap_or_else(|_| "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".into());
        Ok(settings::load()
            .recent
            .into_iter()
            .map(|r| {
                let path = PathBuf::from(&r.path);
                let opened = blog::open(&path);
                ProjectCard {
                    name: opened.as_ref().map(|b| b.config.title.clone()).unwrap_or_else(|_| folder_name(&path)),
                    remote: opened.as_ref().ok().and_then(|_| git::origin(&path, &path_var)),
                    error: opened.err(),
                    opened_at: r.opened_at,
                    path: r.path,
                }
            })
            .collect())
    })
    .await
}

/// Opens a blog folder as the project: checks it, ends a preview server an earlier run left
/// for it, prepares `.hexostudio/` and puts it first in the recent list.
#[tauri::command]
pub async fn open_project(ws: Ws<'_>, preview: Prev<'_>, runner: Run<'_>, path: String) -> Result<BlogStatus, String> {
    if runner.busy() {
        return Err("还有命令在执行，结束后再切换项目。".into());
    }
    let preview = preview.inner().clone();
    let root = PathBuf::from(&path);
    let root2 = root.clone();
    blocking(move || {
        blog::open(&root2)?;
        preview.stop();
        Preview::end_stale(&root2);
        project::prepare(&root2)?;
        settings::update(|s| s.remember(&path, jiff::Timestamp::now().as_second()))?;
        Ok(())
    })
    .await?;
    runner.clear();
    *ws.project.lock().unwrap() = Some(root.clone());
    blocking(move || Ok(status(Some(&root)))).await
}

/// Back to the welcome page.
#[tauri::command]
pub async fn close_project(ws: Ws<'_>, preview: Prev<'_>, runner: Run<'_>) -> Result<(), String> {
    if runner.busy() {
        return Err("还有命令在执行，结束后再关闭项目。".into());
    }
    let preview = preview.inner().clone();
    blocking(move || {
        preview.stop();
        Ok(())
    })
    .await?;
    *ws.project.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub fn forget_project(path: String) -> Result<(), String> {
    settings::update(|s| s.forget(&path)).map(|_| ())
}

// ---- the open project ---------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    title: String,
    url: String,
    root: String,
    permalink: String,
    timezone: Option<String>,
    deploy: Vec<DeployerView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployerView {
    kind: String,
    repo: Option<String>,
    branch: Option<String>,
}

impl From<&Deployer> for DeployerView {
    fn from(d: &Deployer) -> Self {
        DeployerView { kind: d.kind.clone(), repo: d.repo.clone(), branch: d.branch.clone() }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    /// Chosen in settings, else empty.
    manual: Option<String>,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

/// The open project and the tools to run it; `dir` is empty on the welcome page.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlogStatus {
    dir: Option<String>,
    /// Why the folder is no longer usable as a blog.
    error: Option<String>,
    config: Option<ConfigView>,
    /// Hexo is not installed in the blog (`node_modules/.bin/hexo`).
    hexo_error: Option<String>,
    remote: Option<String>,
    node: NodeView,
}

fn status(root: Option<&Path>) -> BlogStatus {
    let s = settings::load();
    let env = node_env::resolve(s.node_path.as_deref());
    let node = match &env {
        Ok(env) => NodeView {
            manual: s.node_path.clone(),
            path: Some(env.node.display().to_string()),
            version: node_env::version(env),
            error: None,
        },
        Err(e) => NodeView { manual: s.node_path.clone(), path: None, version: None, error: Some(e.clone()) },
    };
    let opened = root.map(blog::open);
    let (config, error, hexo_error) = match &opened {
        Some(Ok(b)) => (
            Some(ConfigView {
                title: b.config.title.clone(),
                url: b.config.url.clone(),
                root: b.config.root.clone(),
                permalink: b.config.permalink.clone(),
                timezone: b.config.timezone.clone(),
                deploy: b.config.deploy.iter().map(DeployerView::from).collect(),
            }),
            None,
            b.hexo_bin().err(),
        ),
        Some(Err(e)) => (None, Some(e.clone()), None),
        None => (None, None, None),
    };
    let remote = match (root, &env) {
        (Some(r), Ok(env)) => git::origin(r, &env.path_var),
        _ => None,
    };
    BlogStatus { dir: root.map(|r| r.display().to_string()), error, config, hexo_error, remote, node }
}

#[tauri::command]
pub async fn blog_status(ws: Ws<'_>) -> Result<BlogStatus, String> {
    let root = ws.project.lock().unwrap().clone();
    blocking(move || Ok(status(root.as_deref()))).await
}

/// `None` or empty: look for Node again.
#[tauri::command]
pub async fn set_node_path(ws: Ws<'_>, path: Option<String>) -> Result<BlogStatus, String> {
    let root = ws.project.lock().unwrap().clone();
    blocking(move || {
        let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        settings::update(|s| s.node_path = path)?;
        Ok(status(root.as_deref()))
    })
    .await
}

#[tauri::command]
pub async fn list_posts(ws: Ws<'_>) -> Result<Vec<PostSummary>, String> {
    let blog = current_blog(&ws)?;
    blocking(move || Ok(blog.list_posts())).await
}

#[tauri::command]
pub async fn read_post(ws: Ws<'_>, id: String) -> Result<PostFile, String> {
    let blog = current_blog(&ws)?;
    blocking(move || blog.read_post(&id)).await
}

#[tauri::command]
pub async fn write_post(ws: Ws<'_>, id: String, text: String, expected: String) -> Result<WriteOutcome, String> {
    let blog = current_blog(&ws)?;
    blocking(move || blog.write_post(&id, &text, &expected)).await
}

#[tauri::command]
pub fn reveal_post(app: AppHandle, ws: Ws<'_>, id: String) -> Result<(), String> {
    let (_, path, _) = current_blog(&ws)?.post_path(&id)?;
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_project(app: AppHandle, ws: Ws<'_>) -> Result<(), String> {
    app.opener().reveal_item_in_dir(project_root(&ws)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_post_externally(app: AppHandle, ws: Ws<'_>, id: String) -> Result<(), String> {
    let (_, path, _) = current_blog(&ws)?.post_path(&id)?;
    app.opener().open_path(path.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

// ---- preview ------------------------------------------------------------------------------

#[tauri::command]
pub async fn preview_start(ws: Ws<'_>, preview: Prev<'_>, runner: Run<'_>) -> Result<u16, String> {
    if runner.holds_site() {
        return Err("正在执行清理 / 生成 / 部署，预览服务器会在它结束后自动恢复。".into());
    }
    let blog = current_blog(&ws)?;
    let preview = preview.inner().clone();
    blocking(move || preview.start(&blog, &current_node()?)).await
}

#[tauri::command]
pub async fn preview_stop(preview: Prev<'_>) -> Result<(), String> {
    let preview = preview.inner().clone();
    blocking(move || {
        preview.stop();
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn preview_state(preview: Prev<'_>) -> PreviewState {
    preview.state()
}

#[tauri::command]
pub fn preview_log(preview: Prev<'_>) -> Vec<LogLine> {
    preview.log()
}

fn running_port(preview: &Preview) -> Result<u16, String> {
    match preview.state() {
        PreviewState::Running { port } => Ok(port),
        _ => Err("预览服务器没有在运行。".into()),
    }
}

fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(10)).no_proxy().build().expect("HTTP client"))
}

/// What a preview page holds now, to compare with after a save.
#[tauri::command]
pub async fn preview_probe(preview: Prev<'_>, path: String) -> Result<PageProbe, String> {
    let port = running_port(&preview)?;
    preview::probe(http(), port, &path).await
}

/// Waits (up to 5 s) for a preview page to differ from `before`, i.e. for Hexo to re-render it.
#[tauri::command]
pub async fn preview_await_change(preview: Prev<'_>, path: String, before: Option<PageProbe>) -> Result<PageProbe, String> {
    let port = running_port(&preview)?;
    preview::await_change(http(), port, &path, before, Duration::from_secs(5)).await
}

// ---- commands -----------------------------------------------------------------------------

/// Files changed in the blog's own repository, to mention before deploying; `None` outside git.
#[tauri::command]
pub async fn blog_git_changes(ws: Ws<'_>) -> Result<Option<usize>, String> {
    let blog = current_blog(&ws)?;
    blocking(move || Ok(git::uncommitted(&blog.root, &current_node()?))).await
}

fn start_task(runner: &Arc<Runner>, blog: Blog, task: Task, on_done: impl FnOnce(RunRecord) + Send + 'static) -> Result<u64, String> {
    let env = current_node()?;
    let mut notes = Vec::new();
    if matches!(task, Task::Deploy) {
        if let Some(n) = git::uncommitted(&blog.root, &env).filter(|n| *n > 0) {
            notes.push(format!("博客源码仓库有 {n} 个文件的改动还没有提交（只是提醒，不影响部署）。"));
        }
    }
    runner.start(task, blog, env, notes, on_done)
}

/// Starts a command; its output arrives as `run-line` events and the end as `run-finished`.
#[tauri::command]
pub async fn run_task(ws: Ws<'_>, runner: Run<'_>, task: Task) -> Result<u64, String> {
    let blog = current_blog(&ws)?;
    let runner = runner.inner().clone();
    blocking(move || start_task(&runner, blog, task, |_| {})).await
}

/// Runs a command to its end (new post, publish draft) and returns the finished run.
#[tauri::command]
pub async fn run_task_and_wait(ws: Ws<'_>, runner: Run<'_>, task: Task) -> Result<RunRecord, String> {
    let blog = current_blog(&ws)?;
    let runner = runner.inner().clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    blocking(move || start_task(&runner, blog, task, move |run| drop(tx.send(run)))).await?;
    rx.await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_run(runner: Run<'_>) {
    runner.cancel();
}

#[tauri::command]
pub fn list_runs(runner: Run<'_>) -> Vec<RunRecord> {
    runner.runs()
}

/// Opens a link in the browser: GitHub pages (push protection's unblock links) and the preview.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://github.com/") || url.starts_with("http://127.0.0.1:")) {
        return Err(format!("不打开这个地址：{url}"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---- images -------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSettingsView {
    /// The name image paths use now.
    project_name: String,
    /// Set by hand in `.hexostudio/settings.json`; empty means the folder name.
    name: Option<String>,
    storage: Option<Storage>,
    upload: UploadSettings,
    /// The AccessKey ID in the keychain for this store (the secret is never sent back).
    access_key_id: Option<String>,
    backup_dir: String,
}

fn image_settings_view(root: &Path) -> Result<ImageSettingsView, String> {
    let s = project::load_settings(root)?;
    let access_key_id = match &s.storage {
        Some(st) => keychain::load(&st.credential_account())?.map(|c| c.access_key_id),
        None => None,
    };
    Ok(ImageSettingsView {
        project_name: project::project_name(root, &s),
        name: s.name.clone(),
        storage: s.storage.clone(),
        upload: s.upload.clone(),
        access_key_id,
        backup_dir: settings::load().backup_dir().display().to_string(),
    })
}

#[tauri::command]
pub async fn image_settings(ws: Ws<'_>) -> Result<ImageSettingsView, String> {
    let root = project_root(&ws)?;
    blocking(move || image_settings_view(&root)).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSettingsInput {
    name: Option<String>,
    storage: Option<Storage>,
    upload: UploadSettings,
    /// Both given: replace the keychain entry; secret empty: keep the saved one.
    access_key_id: Option<String>,
    access_key_secret: Option<String>,
    backup_dir: Option<String>,
}

#[tauri::command]
pub async fn save_image_settings(ws: Ws<'_>, input: ImageSettingsInput) -> Result<ImageSettingsView, String> {
    let root = project_root(&ws)?;
    blocking(move || {
        if let Some(st) = &input.storage {
            st.validate()?;
        }
        let quality = input.upload.quality.clamp(1, 100);
        let upload = UploadSettings { quality, ..input.upload };
        let mut s = project::load_settings(&root)?;
        s.name = input.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
        s.storage = input.storage;
        s.upload = upload;
        if let Some(st) = &s.storage {
            let account = st.credential_account();
            let id = input.access_key_id.map(|v| v.trim().to_string()).unwrap_or_default();
            let secret = input.access_key_secret.map(|v| v.trim().to_string()).unwrap_or_default();
            match (id.is_empty(), secret.is_empty()) {
                (false, false) => keychain::save(&account, &keychain::Credentials { access_key_id: id, access_key_secret: secret })?,
                (false, true) => match keychain::load(&account)? {
                    Some(c) if c.access_key_id == id => {}
                    _ => return Err("换了 AccessKey ID，请同时填写对应的 Secret。".into()),
                },
                (true, _) => keychain::delete(&account)?,
            }
        }
        project::save_settings(&root, &s)?;
        let backup = input.backup_dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
        settings::update(|g| g.backup_dir = backup)?;
        image_settings_view(&root)
    })
    .await
}

/// Asks the store about a missing object: proves the bucket and keys work without writing.
#[tauri::command]
pub async fn check_storage(ws: Ws<'_>) -> Result<(), String> {
    let root = project_root(&ws)?;
    let s = blocking(move || project::load_settings(&root)).await?;
    images::open_store(&s)?.check().await
}

async fn upload_for(ws: &Workspace, post_id: &str, file_name: Option<String>, bytes: Vec<u8>, format: Format) -> Result<Uploaded, String> {
    let blog = current_blog(ws)?;
    let (_, _, file) = blog.post_path(post_id)?;
    let root = blog.root.clone();
    let s = project::load_settings(&root)?;
    let tz = permalink::blog_zone(blog.config.timezone.as_deref());
    let now = jiff::Timestamp::now().to_zoned_datetime(tz).datetime();
    let req = images::Upload { page: post::slug(&file), file_name, bytes, format };
    images::upload(&root, &s, &settings::load().backup_dir(), req, now).await
}

/// Uploads a file from disk (dropped on the editor or chosen in a dialog).
#[tauri::command]
pub async fn upload_image_file(ws: Ws<'_>, post_id: String, path: String, format: Format) -> Result<Uploaded, String> {
    let file = PathBuf::from(&path);
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned());
    let bytes = blocking(move || std::fs::read(&file).map_err(|e| format!("无法读取 {path}：{e}"))).await?;
    upload_for(&ws, &post_id, name, bytes, format).await
}

/// Uploads pasted image bytes, sent as the raw request body; the post, an optional file name
/// and the format come in headers (`x-post`, `x-name`, percent-encoded; `x-format`).
#[tauri::command]
pub async fn upload_image_bytes(ws: Ws<'_>, request: tauri::ipc::Request<'_>) -> Result<Uploaded, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("没有收到图片数据。".into()) };
    let header = |name: &str| -> Option<String> {
        let raw = request.headers().get(name)?.to_str().ok()?;
        Some(url::form_urlencoded::parse(format!("v={raw}").as_bytes()).next()?.1.into_owned())
    };
    let post_id = header("x-post").ok_or("缺少文章。")?;
    let format = match header("x-format").as_deref() {
        Some("original") => Format::Original,
        _ => Format::Webp,
    };
    upload_for(&ws, &post_id, header("x-name").filter(|n| !n.is_empty()), bytes.clone(), format).await
}

/// What migrating the old images would do; nothing is changed.
#[tauri::command]
pub async fn migration_plan(ws: Ws<'_>) -> Result<Vec<migration::PlannedMove>, String> {
    let blog = current_blog(&ws)?;
    blocking(move || {
        let s = project::load_settings(&blog.root)?;
        Ok(migration::plan(&blog, &s)?.iter().map(migration::view).collect())
    })
    .await
}

/// Migrates the old images (as `migration_plan` lists them); progress arrives as
/// `migration-progress` events.
#[tauri::command]
pub async fn run_migration(app: AppHandle, ws: Ws<'_>, runner: Run<'_>) -> Result<migration::Report, String> {
    if runner.busy() {
        return Err("还有命令在执行，结束后再迁移。".into());
    }
    let blog = current_blog(&ws)?;
    let s = project::load_settings(&blog.root)?;
    migration::run(&blog, &s, &settings::load().backup_dir(), |p| {
        let _ = app.emit("migration-progress", p);
    })
    .await
}
