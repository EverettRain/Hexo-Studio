//! Tauri commands the interface calls.

use crate::domain::catalog::{self, ChecklistRow, Image, Mirror};
use crate::domain::config::{ConfigFile, Deployer};
use crate::domain::image_key::Format;
use crate::domain::permalink;
use crate::domain::source::{Commit, CommitDetail, Status as SourceStatus};
use crate::domain::storage::Storage;
use crate::domain::task::Task;
use crate::domain::template::{self, Credits, NewBlog, Template};
use crate::infra::blog::{self, Blog, ConfigText, ConfigWrite, PostFile, PostSummary, WriteOutcome};
use crate::infra::node_env::{self, NodeEnv};
use crate::infra::project::{Profile, ProjectSettings, UploadSettings};
use crate::infra::store::Store;
use crate::infra::{git, keychain, paths, project, settings};
use crate::service::adopt;
use crate::service::create::{Creator, Progress};
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

// ---- new blogs -----------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBlogForm {
    templates: Vec<Template>,
    /// Shown with plain Hexo.
    hexo: Credits,
    /// Where the last opened blog is, else the home folder.
    parent: String,
    /// git's `user.name`, empty without one.
    author: String,
}

#[tauri::command]
pub async fn new_blog_form() -> Result<NewBlogForm, String> {
    blocking(|| {
        let parent = settings::load()
            .recent
            .first()
            .and_then(|r| Path::new(&r.path).parent().filter(|p| p.is_dir()).map(Path::to_path_buf))
            .unwrap_or_else(paths::home);
        let path_var = current_node().map(|e| e.path_var).unwrap_or_else(|_| "/usr/bin:/bin".into());
        Ok(NewBlogForm { templates: template::TEMPLATES.to_vec(), hexo: template::HEXO_CREDITS, parent: parent.display().to_string(), author: git::user_name(&path_var).unwrap_or_default() })
    })
    .await
}

/// Makes a blog from a template, reporting each step and line as `create-progress`; returns its
/// folder, which the page then opens as a project.
#[tauri::command]
pub async fn create_blog(app: AppHandle, creator: State<'_, Arc<Creator>>, blog: NewBlog) -> Result<String, String> {
    let creator = creator.inner().clone();
    blocking(move || {
        let env = current_node()?;
        let sink = move |p: Progress| {
            let _ = app.emit("create-progress", p);
        };
        creator.create(&env, &blog, &sink).map(|p| p.display().to_string())
    })
    .await
}

#[tauri::command]
pub fn cancel_create(creator: State<'_, Arc<Creator>>) {
    let creator = creator.inner().clone();
    // Ending the process group waits a few seconds at most; not on the main thread.
    std::thread::spawn(move || creator.cancel());
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

/// Stops and starts the server again: Hexo reads its config files only when it starts.
#[tauri::command]
pub async fn preview_restart(ws: Ws<'_>, preview: Prev<'_>, runner: Run<'_>) -> Result<u16, String> {
    if runner.holds_site() {
        return Err("正在执行清理 / 生成 / 部署，预览服务器会在它结束后自动恢复。".into());
    }
    let blog = current_blog(&ws)?;
    let preview = preview.inner().clone();
    blocking(move || {
        preview.stop();
        preview.start(&blog, &current_node()?)
    })
    .await
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

// ---- config -------------------------------------------------------------------------------

#[tauri::command]
pub async fn config_read(ws: Ws<'_>, file: ConfigFile) -> Result<ConfigText, String> {
    let blog = current_blog(&ws)?;
    blocking(move || blog.read_config(file)).await
}

/// The page data files in `source/_data`.
#[tauri::command]
pub async fn data_files(ws: Ws<'_>) -> Result<Vec<String>, String> {
    let blog = current_blog(&ws)?;
    blocking(move || Ok(blog.data_files())).await
}

#[tauri::command]
pub async fn data_read(ws: Ws<'_>, name: String) -> Result<ConfigText, String> {
    let blog = current_blog(&ws)?;
    blocking(move || blog.read_data(&name)).await
}

#[tauri::command]
pub async fn data_write(ws: Ws<'_>, name: String, text: String, expected: String) -> Result<ConfigWrite, String> {
    let blog = current_blog(&ws)?;
    blocking(move || blog.write_data(&name, &text, &expected)).await
}

/// The Hexo plugins the blog installs, as Hexo picks them from `package.json`.
#[tauri::command]
pub async fn list_plugins(ws: Ws<'_>) -> Result<Vec<crate::domain::plugins::Plugin>, String> {
    let blog = current_blog(&ws)?;
    blocking(move || Ok(blog.plugins())).await
}

/// Writes a config file unless it changed on disk since `expected` was read.
#[tauri::command]
pub async fn config_write(ws: Ws<'_>, file: ConfigFile, text: String, expected: String) -> Result<ConfigWrite, String> {
    let blog = current_blog(&ws)?;
    blocking(move || blog.write_config(file, &text, &expected)).await
}

// ---- source repository --------------------------------------------------------------------

/// Commits per page of the history.
const SOURCE_PAGE: usize = 30;

/// git only needs a `PATH`: a blog on a Mac without Node still has a repository to commit.
fn git_path() -> std::ffi::OsString {
    current_node().map(|e| e.path_var).unwrap_or_else(|_| "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".into())
}

/// The blog's own git repository: branch, how it stands against its remote, changed files.
#[tauri::command]
pub async fn source_status(ws: Ws<'_>) -> Result<SourceStatus, String> {
    let root = project_root(&ws)?;
    blocking(move || git::status(&root, &git_path())).await
}

/// One page of the history, newest first, after the `skip` commits already shown.
#[tauri::command]
pub async fn source_commits(ws: Ws<'_>, skip: usize) -> Result<Vec<Commit>, String> {
    let root = project_root(&ws)?;
    blocking(move || git::log(&root, &git_path(), skip, SOURCE_PAGE)).await
}

#[tauri::command]
pub async fn source_commit_detail(ws: Ws<'_>, hash: String) -> Result<CommitDetail, String> {
    let root = project_root(&ws)?;
    blocking(move || git::commit_detail(&root, &git_path(), &hash)).await
}

/// Commits every change under `title` and an optional `body`.
#[tauri::command]
pub async fn source_commit(ws: Ws<'_>, title: String, body: String) -> Result<(), String> {
    let root = project_root(&ws)?;
    blocking(move || git::commit_all(&root, &git_path(), &title, &body)).await
}

#[tauri::command]
pub async fn source_push(ws: Ws<'_>) -> Result<(), String> {
    let root = project_root(&ws)?;
    blocking(move || git::push(&root, &git_path())).await
}

#[tauri::command]
pub async fn source_pull(ws: Ws<'_>) -> Result<(), String> {
    let root = project_root(&ws)?;
    blocking(move || git::pull(&root, &git_path())).await
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

/// Opens a link in the browser: GitHub pages (push protection's unblock links, plugins' sources),
/// plugins' npm pages, the preview, and the sites of Hexo and the templates.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://github.com/") || url.starts_with("https://www.npmjs.com/package/") || url.starts_with("http://127.0.0.1:") || template::is_credit_link(&url)) {
        return Err(format!("不打开这个地址：{url}"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---- images -------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    #[serde(flatten)]
    profile: Profile,
    /// The AccessKey ID in the keychain for this store (the secret is never sent back).
    access_key_id: Option<String>,
    /// Library images whose addresses are in this store.
    images: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageView {
    /// The name image paths use now.
    project_name: String,
    /// Set by hand; empty means the folder name.
    name: Option<String>,
    profiles: Vec<ProfileView>,
    /// The profile new images go to.
    active: Option<String>,
    /// Where originals are kept on this Mac (for every profile and blog).
    backup_dir: String,
}

fn storage_view(root: &Path) -> Result<StorageView, String> {
    let s = project::load_settings(root)?;
    let catalog = project::load_catalog(root)?;
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for img in &catalog.images {
        if let Some(p) = s.profile_for_url(&img.url) {
            *counts.entry(p.id.as_str()).or_default() += 1;
        }
    }
    let profiles = s
        .profiles
        .iter()
        .map(|p| {
            Ok(ProfileView {
                access_key_id: keychain::load(&p.storage.credential_account())?.map(|c| c.access_key_id),
                images: counts.get(p.id.as_str()).copied().unwrap_or(0),
                profile: p.clone(),
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(StorageView {
        project_name: project::project_name(root, &s),
        name: s.name.clone(),
        profiles,
        active: s.active_profile().map(|p| p.id.clone()),
        backup_dir: settings::load().backup_dir().display().to_string(),
    })
}

#[tauri::command]
pub async fn storage_profiles(ws: Ws<'_>) -> Result<StorageView, String> {
    let root = project_root(&ws)?;
    blocking(move || storage_view(&root)).await
}

/// Keys typed into a profile's form: both given replace the keychain entry; the secret empty
/// keeps the saved one (for the same ID); the ID empty removes it.
fn save_keys(account: &str, id: Option<String>, secret: Option<String>) -> Result<(), String> {
    let id = id.map(|v| v.trim().to_string()).unwrap_or_default();
    let secret = secret.map(|v| v.trim().to_string()).unwrap_or_default();
    match (id.is_empty(), secret.is_empty()) {
        (false, false) => keychain::save(account, &keychain::Credentials { access_key_id: id, access_key_secret: secret }),
        (false, true) => match keychain::load(account)? {
            Some(c) if c.access_key_id == id => Ok(()),
            _ => Err("换了 AccessKey ID，请同时填写对应的 Secret。".into()),
        },
        (true, _) => keychain::delete(account),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    /// `None` creates a profile.
    id: Option<String>,
    name: String,
    storage: Storage,
    upload: UploadSettings,
    access_key_id: Option<String>,
    access_key_secret: Option<String>,
}

/// A new id: unique among the blog's profiles, short enough to read in `settings.json`.
fn new_profile_id(s: &ProjectSettings) -> String {
    let base = format!("{:x}", jiff::Timestamp::now().as_millisecond());
    let mut id = base.clone();
    let mut n = 1;
    while s.profile(&id).is_some() {
        n += 1;
        id = format!("{base}-{n}");
    }
    id
}

/// Creates or changes a profile; the first one becomes the active one.
#[tauri::command]
pub async fn save_profile(ws: Ws<'_>, input: ProfileInput) -> Result<StorageView, String> {
    let root = project_root(&ws)?;
    blocking(move || {
        input.storage.validate()?;
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err("给这套配置起个名字。".into());
        }
        let upload = UploadSettings { quality: input.upload.quality.clamp(1, 100), ..input.upload };
        let mut s = project::load_settings(&root)?;
        save_keys(&input.storage.credential_account(), input.access_key_id, input.access_key_secret)?;
        let id = match input.id {
            Some(id) => {
                let p = s.profiles.iter_mut().find(|p| p.id == id).ok_or("这套配置已经不在了。")?;
                *p = Profile { id: id.clone(), name, storage: input.storage, upload };
                id
            }
            None => {
                let id = new_profile_id(&s);
                s.profiles.push(Profile { id: id.clone(), name, storage: input.storage, upload });
                id
            }
        };
        if s.active.as_deref().and_then(|a| s.profile(a)).is_none() {
            s.active = Some(id);
        }
        project::save_settings(&root, &s)?;
        storage_view(&root)
    })
    .await
}

/// Removes a profile. Its images stay where they are and keep working on the site; without a
/// profile for their store they can no longer be checked or deleted from here. The keys go
/// when no other profile uses the same store.
#[tauri::command]
pub async fn delete_profile(ws: Ws<'_>, id: String) -> Result<StorageView, String> {
    let root = project_root(&ws)?;
    blocking(move || {
        let mut s = project::load_settings(&root)?;
        let removed = s.profile(&id).cloned().ok_or("这套配置已经不在了。")?;
        s.profiles.retain(|p| p.id != id);
        let account = removed.storage.credential_account();
        if !s.profiles.iter().any(|p| p.storage.credential_account() == account) {
            keychain::delete(&account)?;
        }
        if s.active.as_deref() == Some(id.as_str()) {
            s.active = s.profiles.first().map(|p| p.id.clone());
        }
        project::save_settings(&root, &s)?;
        storage_view(&root)
    })
    .await
}

/// Makes a profile the one new images go to.
#[tauri::command]
pub async fn activate_profile(ws: Ws<'_>, id: String) -> Result<StorageView, String> {
    let root = project_root(&ws)?;
    blocking(move || {
        let mut s = project::load_settings(&root)?;
        s.profile(&id).ok_or("这套配置已经不在了。")?;
        s.active = Some(id);
        project::save_settings(&root, &s)?;
        storage_view(&root)
    })
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySettingsInput {
    name: Option<String>,
    backup_dir: Option<String>,
}

/// What every profile shares: the project's name in image paths, and the originals' folder.
#[tauri::command]
pub async fn save_library_settings(ws: Ws<'_>, input: LibrarySettingsInput) -> Result<StorageView, String> {
    let root = project_root(&ws)?;
    blocking(move || {
        let mut s = project::load_settings(&root)?;
        s.name = input.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
        project::save_settings(&root, &s)?;
        let backup = input.backup_dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
        settings::update(|g| g.backup_dir = backup)?;
        storage_view(&root)
    })
    .await
}

/// Asks a store about a missing object, with the form's values before they are saved: proves
/// the bucket and keys work without writing. An empty secret uses the saved one.
#[tauri::command]
pub async fn check_storage(storage: Storage, access_key_id: Option<String>, access_key_secret: Option<String>) -> Result<(), String> {
    storage.validate()?;
    let id = access_key_id.map(|v| v.trim().to_string()).unwrap_or_default();
    let secret = access_key_secret.map(|v| v.trim().to_string()).unwrap_or_default();
    let creds = if !id.is_empty() && !secret.is_empty() {
        keychain::Credentials { access_key_id: id, access_key_secret: secret }
    } else {
        let saved = keychain::load(&storage.credential_account())?.ok_or("填写 AccessKey ID 和 Secret 后再测试。")?;
        if !id.is_empty() && saved.access_key_id != id {
            return Err("换了 AccessKey ID，请同时填写对应的 Secret。".into());
        }
        saved
    };
    Store::open(&storage, &creds)?.check().await
}

fn today_and_now(blog: &Blog) -> (String, jiff::civil::DateTime) {
    let now = jiff::Timestamp::now().to_zoned_datetime(permalink::blog_zone(blog.config.timezone.as_deref())).datetime();
    (now.date().to_string(), now)
}

/// A header of a raw-body image request (percent-encoded text); `None` when missing or empty.
fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    let raw = request.headers().get(name)?.to_str().ok()?;
    let v = url::form_urlencoded::parse(format!("v={raw}").as_bytes()).next()?.1.into_owned();
    (!v.is_empty()).then_some(v)
}

/// `x-format` (`webp` / `original`), `x-quality` and `x-max-edge`; the profile's where missing.
fn conversion(request: &tauri::ipc::Request<'_>, upload: &UploadSettings) -> (Format, images::Encoding) {
    let format = match header(request, "x-format").as_deref() {
        Some("original") => Format::Original,
        Some(_) => Format::Webp,
        None => upload.format,
    };
    let encoding = images::Encoding {
        quality: header(request, "x-quality").and_then(|q| q.parse().ok()).unwrap_or(upload.quality),
        max_edge: header(request, "x-max-edge").and_then(|m| m.parse().ok()).unwrap_or(upload.max_edge),
    };
    (format, encoding)
}

fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("没有收到图片数据。".into()),
    }
}

const IMAGE_FILES: [&str; 12] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "svg"];

/// An image file dropped on the window or chosen in a dialog, as bytes for the import panel.
#[tauri::command]
pub async fn read_image_file(path: String) -> Result<tauri::ipc::Response, String> {
    let ext = Path::new(&path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !IMAGE_FILES.contains(&ext.as_str()) {
        return Err(format!("不是图片文件：{path}"));
    }
    let bytes = blocking(move || std::fs::read(&path).map_err(|e| format!("无法读取 {path}：{e}"))).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// How an image would be uploaded, without uploading it: the raw body is the image; headers
/// `x-file` (its file name), `x-format`, `x-quality`, `x-max-edge`.
#[tauri::command]
pub async fn prepare_image(ws: Ws<'_>, request: tauri::ipc::Request<'_>) -> Result<images::Prepared, String> {
    let root = project_root(&ws)?;
    let s = project::load_settings(&root)?;
    let upload = s.active_profile().map(|p| p.upload.clone()).unwrap_or_default();
    let (format, encoding) = conversion(&request, &upload);
    images::prepare(&root, raw_body(&request)?.clone(), header(&request, "x-file").as_deref(), format, encoding).await
}

/// Takes an image into the library, sent as the raw request body. Headers (percent-encoded):
/// `x-file` its file name (none for a screenshot, named by the time), `x-name` and
/// `x-description` the record's, `x-post` the post it is for (its default description names
/// it), and the conversion as `prepare_image` reads it.
#[tauri::command]
pub async fn upload_image_bytes(ws: Ws<'_>, request: tauri::ipc::Request<'_>) -> Result<images::Ingested, String> {
    let blog = current_blog(&ws)?;
    let s = project::load_settings(&blog.root)?;
    let upload = s.active_profile().map(|p| p.upload.clone()).unwrap_or_default();
    let (format, encoding) = conversion(&request, &upload);
    let description = header(&request, "x-description").unwrap_or_else(|| match header(&request, "x-post") {
        Some(id) => format!("{} 内图", blog.read_post(&id).ok().and_then(|f| f.summary.title).unwrap_or(id)),
        None => String::new(),
    });
    let (today, now) = today_and_now(&blog);
    let inc = images::Incoming {
        bytes: raw_body(&request)?.clone(),
        file_name: header(&request, "x-file"),
        format,
        encoding: Some(encoding),
        name: header(&request, "x-name"),
        description,
        today,
        legacy_urls: Vec::new(),
        now,
    };
    images::ingest(&blog.root, &s, &settings::load().backup_dir(), inc).await
}

/// Makes a WebP quality and longest edge the active profile's defaults (from the import panel).
#[tauri::command]
pub async fn set_upload_encoding(ws: Ws<'_>, quality: u8, max_edge: u32) -> Result<StorageView, String> {
    let root = project_root(&ws)?;
    blocking(move || {
        let mut s = project::load_settings(&root)?;
        let id = s.active_profile().map(|p| p.id.clone()).ok_or("还没有图片存储配置：在图片页新建一套。")?;
        let p = s.profiles.iter_mut().find(|p| p.id == id).expect("the active profile is one of them");
        p.upload.quality = quality.clamp(1, 100);
        p.upload.max_edge = max_edge;
        project::save_settings(&root, &s)?;
        storage_view(&root)
    })
    .await
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
    /// A small version for thumbnails (scaled by the store when it can), else the image.
    thumb: String,
    /// The profile whose store holds it; `None` when no profile does any more.
    profile: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryView {
    images: Vec<ImageView>,
    /// Images of the store the blog uses that are not in the library yet.
    unadopted: usize,
    /// Post titles by file, for showing where images are used.
    titles: BTreeMap<String, String>,
}

/// The library with each image's pages, last check and kept original.
#[tauri::command]
pub async fn image_library(ws: Ws<'_>) -> Result<LibraryView, String> {
    let blog = current_blog(&ws)?;
    blocking(move || {
        let s = project::load_settings(&blog.root)?;
        let catalog = project::load_catalog(&blog.root)?;
        let used = adopt::usages(&blog, &s)?;
        let unadopted = if s.active_profile().is_some() { adopt::plan(&blog, &s, &[])?.len() } else { 0 };
        let checks: BTreeMap<String, images::Check> = project::load_checks(&blog.root);
        let backup_dir = settings::load().backup_dir();
        let titles = adopt::sources(&blog).into_iter().filter_map(|src| src.title.map(|t| (src.file, t))).collect();
        let images = catalog
            .images
            .into_iter()
            .map(|image| {
                let backup = backup_dir.join(&image.original.backup);
                let profile = s.profile_for_url(&image.url);
                let thumb = match profile.and_then(|p| p.storage.thumb_query()) {
                    Some(q) => format!("{}{}{q}", image.url, if image.url.contains('?') { '&' } else { '?' }),
                    None => image.url.clone(),
                };
                ImageView {
                    thumb,
                    profile: profile.map(|p| p.id.clone()),
                    used_by: used.get(&image.id).cloned().unwrap_or_default(),
                    check: checks.get(&image.id).cloned(),
                    backup_path: (!image.original.backup.is_empty() && backup.is_file()).then(|| backup.display().to_string()),
                    image,
                }
            })
            .collect();
        Ok(LibraryView { images, unadopted, titles })
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
    let catalog = project::load_catalog(&blog.root)?;
    let mut checks: BTreeMap<String, images::Check> = project::load_checks(&blog.root);
    let now = jiff::Timestamp::now().as_second();
    let total = catalog.images.len();
    // Each image is checked in the store of its own profile; stores are opened once each.
    let mut stores: BTreeMap<String, Result<Store, String>> = BTreeMap::new();
    for (i, img) in catalog.images.iter().enumerate() {
        let _ = app.emit("image-check-progress", (i, total));
        let check = match s.profile_for_url(&img.url) {
            None => images::Check { at: now, ok: false, message: "没有哪套存储配置包含这张图的地址".into() },
            Some(p) => match stores.entry(p.id.clone()).or_insert_with(|| images::open_store(&p.storage)) {
                Ok(store) => images::check(store, public_http(), img, now).await,
                Err(e) => images::Check { at: now, ok: false, message: e.clone() },
            },
        };
        checks.insert(img.id.clone(), check);
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
