//! Tauri commands the interface calls.

use crate::domain::catalog::{self, ChecklistRow, Image, Mirror};
use crate::domain::config::Deployer;
use crate::domain::image_key::Format;
use crate::domain::permalink;
use crate::domain::storage::Storage;
use crate::domain::task::Task;
use crate::infra::blog::{self, Blog, PostFile, PostSummary, WriteOutcome};
use crate::infra::node_env::{self, NodeEnv};
use crate::infra::project::UploadSettings;
use crate::infra::{git, keychain, paths, project, settings};
use crate::service::adopt;
use crate::service::images;
use crate::service::preview::{self, LogLine, PageProbe, Preview, PreviewState};
use crate::service::runner::{Run as RunRecord, Runner};
use serde::Serialize;
use std::collections::BTreeMap;
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

fn today_and_now(blog: &Blog) -> (String, jiff::civil::DateTime) {
    let now = jiff::Timestamp::now().to_zoned_datetime(permalink::blog_zone(blog.config.timezone.as_deref())).datetime();
    (now.date().to_string(), now)
}

/// Takes an image into the library. From a post (`post_id`), its default description names the
/// post, and the caller inserts its address there.
async fn ingest_for(
    ws: &Workspace,
    post_id: Option<&str>,
    file_name: Option<String>,
    bytes: Vec<u8>,
    format: Format,
) -> Result<images::Ingested, String> {
    let blog = current_blog(ws)?;
    let description = match post_id {
        Some(id) => {
            let title = blog.read_post(id).ok().and_then(|f| f.summary.title).unwrap_or_else(|| id.to_string());
            format!("{title} 内图")
        }
        None => String::new(),
    };
    let s = project::load_settings(&blog.root)?;
    let (today, now) = today_and_now(&blog);
    let inc = images::Incoming { bytes, file_name, format, name: None, description, today, legacy_urls: Vec::new(), now };
    images::ingest(&blog.root, &s, &settings::load().backup_dir(), inc).await
}

/// Takes a file from disk into the library (dropped on the editor, chosen in a dialog, or
/// added on the image page).
#[tauri::command]
pub async fn upload_image_file(ws: Ws<'_>, post_id: Option<String>, path: String, format: Format) -> Result<images::Ingested, String> {
    let file = PathBuf::from(&path);
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned());
    let bytes = blocking(move || std::fs::read(&file).map_err(|e| format!("无法读取 {path}：{e}"))).await?;
    ingest_for(&ws, post_id.as_deref(), name, bytes, format).await
}

/// Takes pasted image bytes into the library, sent as the raw request body; the post, an
/// optional file name and the format come in headers (`x-post`, `x-name`, percent-encoded;
/// `x-format`).
#[tauri::command]
pub async fn upload_image_bytes(ws: Ws<'_>, request: tauri::ipc::Request<'_>) -> Result<images::Ingested, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("没有收到图片数据。".into()) };
    let header = |name: &str| -> Option<String> {
        let raw = request.headers().get(name)?.to_str().ok()?;
        Some(url::form_urlencoded::parse(format!("v={raw}").as_bytes()).next()?.1.into_owned())
    };
    let format = match header("x-format").as_deref() {
        Some("original") => Format::Original,
        _ => Format::Webp,
    };
    let post = header("x-post").filter(|p| !p.is_empty());
    ingest_for(&ws, post.as_deref(), header("x-name").filter(|n| !n.is_empty()), bytes.clone(), format).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageView {
    #[serde(flatten)]
    image: Image,
    /// Files that use it, from the blog root.
    used_by: Vec<String>,
    check: Option<images::Check>,
    /// The original kept on this Mac, when it is still there.
    backup_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryView {
    images: Vec<ImageView>,
    /// Images of the store the blog uses that are not in the library yet.
    unadopted: usize,
    /// Post titles by file, for showing where images are used.
    titles: BTreeMap<String, String>,
    /// Query that makes the store send a small version, for thumbnails (Aliyun's image
    /// processing); `None` when the store has none.
    thumb_query: Option<String>,
}

/// The library with each image's pages, last check and kept original.
#[tauri::command]
pub async fn image_library(ws: Ws<'_>) -> Result<LibraryView, String> {
    let blog = current_blog(&ws)?;
    blocking(move || {
        let s = project::load_settings(&blog.root)?;
        let catalog = project::load_catalog(&blog.root)?;
        let used = adopt::usages(&blog, &s)?;
        let unadopted = if s.storage.is_some() { adopt::plan(&blog, &s, &[])?.len() } else { 0 };
        let checks: BTreeMap<String, images::Check> = project::load_checks(&blog.root);
        let backup_dir = settings::load().backup_dir();
        let titles = adopt::sources(&blog).into_iter().filter_map(|src| src.title.map(|t| (src.file, t))).collect();
        let images = catalog
            .images
            .into_iter()
            .map(|image| {
                let backup = backup_dir.join(&image.original.backup);
                ImageView {
                    used_by: used.get(&image.id).cloned().unwrap_or_default(),
                    check: checks.get(&image.id).cloned(),
                    backup_path: (!image.original.backup.is_empty() && backup.is_file()).then(|| backup.display().to_string()),
                    image,
                }
            })
            .collect();
        let thumb_query = matches!(s.storage, Some(Storage::AliyunOss { .. })).then(|| "x-oss-process=image/resize,w_480".to_string());
        Ok(LibraryView { images, unadopted, titles, thumb_query })
    })
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePatch {
    name: String,
    description: String,
    ok: Option<bool>,
    mirrors: Vec<Mirror>,
}

/// Changes the hand-kept fields of an image.
#[tauri::command]
pub async fn update_image(ws: Ws<'_>, id: String, patch: ImagePatch) -> Result<Image, String> {
    let root = project_root(&ws)?;
    blocking(move || {
        project::update_catalog(&root, |c| {
            let img = c.get_mut(&id).ok_or("图片库里没有这张图。")?;
            img.name = patch.name.trim().to_string();
            img.description = patch.description.trim().to_string();
            img.ok = patch.ok;
            img.mirrors = patch.mirrors.into_iter().filter(|m| !m.url.trim().is_empty()).collect();
            Ok(img.clone())
        })
    })
    .await
}

/// Deletes an image no page uses: the object and the record; the original stays on this Mac.
#[tauri::command]
pub async fn delete_image(ws: Ws<'_>, id: String) -> Result<(), String> {
    let blog = current_blog(&ws)?;
    let s = project::load_settings(&blog.root)?;
    let (blog2, s2, id2) = (blog.clone(), s.clone(), id.clone());
    let used = blocking(move || Ok(adopt::usages(&blog2, &s2)?.remove(&id2).unwrap_or_default())).await?;
    if !used.is_empty() {
        return Err(format!("这张图还在 {} 个文件里使用，不能删除：{}", used.len(), used.join("、")));
    }
    images::delete(&blog.root, &s, &id).await
}

/// Checks every image (object in the store, public address answers); results are kept on this
/// Mac and progress arrives as `image-check-progress` events.
#[tauri::command]
pub async fn check_images(app: AppHandle, ws: Ws<'_>) -> Result<BTreeMap<String, images::Check>, String> {
    let blog = current_blog(&ws)?;
    let s = project::load_settings(&blog.root)?;
    let store = images::open_store(&s)?;
    let catalog = project::load_catalog(&blog.root)?;
    let mut checks: BTreeMap<String, images::Check> = project::load_checks(&blog.root);
    let now = jiff::Timestamp::now().as_second();
    let total = catalog.images.len();
    for (i, img) in catalog.images.iter().enumerate() {
        let _ = app.emit("image-check-progress", (i, total));
        checks.insert(img.id.clone(), images::check(&store, public_http(), img, now).await);
    }
    let _ = app.emit("image-check-progress", (total, total));
    checks.retain(|id, _| catalog.get(id).is_some());
    project::save_checks(&blog.root, &checks)?;
    Ok(checks)
}

/// Reaches public image addresses (unlike `http()`, through the system's usual network path).
fn public_http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(20)).build().expect("HTTP client"))
}

#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

fn read_checklist(path: Option<String>) -> Result<Vec<ChecklistRow>, String> {
    match path {
        Some(p) => catalog::parse_checklist(&std::fs::read_to_string(&p).map_err(|e| format!("无法读取清单 {p}：{e}"))?),
        None => Ok(Vec::new()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateView {
    old_key: String,
    old_url: String,
    files: Vec<String>,
    /// The checklist's name for it, when a checklist was given.
    name: Option<String>,
    description: Option<String>,
}

/// What adopting would take in; nothing changes. With a checklist CSV, its rows join the list.
#[tauri::command]
pub async fn adoption_plan(ws: Ws<'_>, checklist: Option<String>) -> Result<Vec<CandidateView>, String> {
    let blog = current_blog(&ws)?;
    blocking(move || {
        let rows = read_checklist(checklist)?;
        let s = project::load_settings(&blog.root)?;
        Ok(adopt::plan(&blog, &s, &rows)?
            .into_iter()
            .map(|c| CandidateView {
                old_url: c.old_urls[0].clone(),
                name: c.row.as_ref().map(|r| r.name.clone()),
                description: c.row.as_ref().map(|r| r.description.clone()),
                old_key: c.old_key,
                files: c.files,
            })
            .collect())
    })
    .await
}

/// Adopts the store's images into the library; progress arrives as `adoption-progress`.
#[tauri::command]
pub async fn run_adoption(app: AppHandle, ws: Ws<'_>, runner: Run<'_>, checklist: Option<String>) -> Result<adopt::Report, String> {
    if runner.busy() {
        return Err("还有命令在执行，结束后再接管。".into());
    }
    let blog = current_blog(&ws)?;
    let rows = read_checklist(checklist)?;
    let s = project::load_settings(&blog.root)?;
    let (today, now) = today_and_now(&blog);
    adopt::run(&blog, &s, &settings::load().backup_dir(), &rows, &today, now, |p| {
        let _ = app.emit("adoption-progress", p);
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    updated: usize,
    /// Checklist rows that match no image in the library (adopt them to bring them in).
    unmatched: Vec<String>,
}

/// Copies a checklist's hand-kept fields into the library images it names.
#[tauri::command]
pub async fn import_checklist(ws: Ws<'_>, path: String) -> Result<ImportReport, String> {
    let root = project_root(&ws)?;
    blocking(move || {
        let rows = read_checklist(Some(path))?;
        project::update_catalog(&root, |c| {
            let mut report = ImportReport { updated: 0, unmatched: Vec::new() };
            for row in &rows {
                let id = c.by_url(&row.url).map(|i| i.id.clone());
                match id.and_then(|id| c.get_mut(&id)) {
                    Some(img) => {
                        catalog::apply_row(img, row);
                        report.updated += 1;
                    }
                    None => report.unmatched.push(row.url.clone()),
                }
            }
            Ok(report)
        })
    })
    .await
}

/// Writes the library as a checklist CSV.
#[tauri::command]
pub async fn export_checklist(ws: Ws<'_>, path: String) -> Result<(), String> {
    let blog = current_blog(&ws)?;
    blocking(move || {
        let s = project::load_settings(&blog.root)?;
        let used = adopt::usages(&blog, &s)?;
        let csv = catalog::export_checklist(&project::load_catalog(&blog.root)?, |id| used.get(id).cloned().unwrap_or_default());
        std::fs::write(&path, csv).map_err(|e| format!("无法写入 {path}：{e}"))
    })
    .await
}
