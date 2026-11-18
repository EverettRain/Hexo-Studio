//! Moving the images already in the store (flat at its root) to `<project>/<page>/<name>.webp`:
//! read each, keep the original on this Mac, convert, upload, then point the blog at the new
//! addresses. Old objects stay where they are (design section 6.3).

use super::images::{self, backup_folder, keep_original};
use crate::domain::image_key::{self, Format};
use crate::domain::image_refs::{self, Move, Source};
use crate::domain::post;
use crate::domain::storage::Storage;
use crate::infra::blog::{Blog, PostKind};
use crate::infra::project::{self, ProjectSettings};
use serde::Serialize;
use std::path::Path;

/// Every address form the store's objects may be written with.
fn bases(storage: &Storage) -> Vec<String> {
    let mut b = vec![storage.public_base()];
    if let Storage::AliyunOss { bucket, area, path, custom_url } = storage {
        if !custom_url.trim().is_empty() {
            let bare = Storage::AliyunOss { bucket: bucket.clone(), area: area.clone(), path: path.clone(), custom_url: String::new() };
            b.push(bare.public_base());
        }
    }
    b
}

fn text_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if e.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if p.is_dir() {
            text_files(&p, out);
        } else if p.extension().is_some_and(|x| ["md", "markdown", "yml", "yaml", "json"].contains(&x.to_string_lossy().as_ref())) {
            out.push(p);
        }
    }
}

/// The blog's text in the order images are given a page: posts oldest first (an image belongs
/// to the post that first used it), then drafts, other pages, data files and configs.
fn sources(blog: &Blog) -> Vec<Source> {
    let mut posts = blog.list_posts();
    posts.sort_by_key(|p| (p.kind == PostKind::Draft, p.date.clone()));
    let mut out: Vec<Source> = Vec::new();
    let rel = |p: &Path| p.strip_prefix(&blog.root).unwrap_or(p).to_string_lossy().replace('\\', "/");
    for p in posts {
        if let Ok((_, path, file)) = blog.post_path(&p.id) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                out.push(Source { file: rel(&path), page: Some(post::slug(&file)), text });
            }
        }
    }
    let mut files = Vec::new();
    text_files(&blog.source(), &mut files);
    files.sort();
    for path in files {
        let r = path.strip_prefix(blog.source()).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        if r.starts_with("_posts/") || r.starts_with("_drafts/") {
            continue;
        }
        let page = (r.ends_with(".md") || r.ends_with(".markdown")).then(|| {
            let slug = post::slug(&r);
            slug.strip_suffix("/index").map(str::to_string).unwrap_or(slug)
        });
        if let Ok(text) = std::fs::read_to_string(&path) {
            out.push(Source { file: rel(&path), page, text });
        }
    }
    let mut configs: Vec<_> = std::fs::read_dir(&blog.root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("_config") && n.to_string_lossy().ends_with(".yml")))
        .collect();
    configs.sort();
    for path in configs {
        if let Ok(text) = std::fs::read_to_string(&path) {
            out.push(Source { file: rel(&path), page: None, text });
        }
    }
    out
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedMove {
    pub old_url: String,
    pub old_key: String,
    pub new_key: String,
    pub format: Format,
    pub files: Vec<String>,
}

pub fn plan(blog: &Blog, settings: &ProjectSettings) -> Result<Vec<Move>, String> {
    let storage = settings.storage.as_ref().ok_or("还没有设置图片存储。")?;
    let project = project::project_name(&blog.root, settings);
    Ok(image_refs::plan(&sources(blog), &bases(storage), &storage.prefix(), &project))
}

pub fn view(m: &Move) -> PlannedMove {
    PlannedMove {
        old_url: m.old_urls[0].clone(),
        old_key: m.old_key.clone(),
        new_key: m.new_key.clone(),
        format: m.format,
        files: m.files.clone(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub old_key: String,
    pub new_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failed {
    pub old_key: String,
    pub error: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub moved: Vec<Moved>,
    pub failed: Vec<Failed>,
    /// Files whose addresses were rewritten, from the blog root.
    pub changed_files: Vec<String>,
}

/// Moves every planned image; one that fails keeps its old address everywhere.
pub async fn run(blog: &Blog, settings: &ProjectSettings, backup_dir: &Path, on_progress: impl Fn(Progress)) -> Result<Report, String> {
    let storage = settings.storage.clone().ok_or("还没有设置图片存储。")?;
    let store = images::open_store(settings)?;
    let project = project::project_name(&blog.root, settings);
    let moves = plan(blog, settings)?;
    let total = moves.len();
    let mut report = Report::default();
    // Old key → new address, for the images that moved.
    let mut moved_to: Vec<(String, String)> = Vec::new();
    for (i, m) in moves.iter().enumerate() {
        on_progress(Progress { done: i, total, current: m.old_key.clone() });
        let result: Result<String, String> = async {
            let bytes = store.read(&m.old_key).await?;
            let name = m.old_key.rsplit('/').next().unwrap_or(&m.old_key);
            let (stem, ext) = image_key::split_name(name);
            // The page is the new key's folder below the project.
            let page = m
                .new_key
                .trim_start_matches(&storage.prefix())
                .split_once('/')
                .map(|(_, rest)| rest)
                .and_then(|r| r.rsplit_once('/'))
                .map(|(p, _)| p)
                .unwrap_or(image_refs::SITE_PAGE);
            keep_original(&backup_folder(backup_dir, &project, page), stem, &ext, &bytes)?;
            let (body, out_ext) = images::convert(bytes, &ext, m.format, settings).await?;
            let key = images::put_free(&store, &m.new_key, body, &out_ext).await?;
            Ok(storage.public_url(&key))
        }
        .await;
        match result {
            Ok(new_url) => {
                moved_to.push((m.old_key.clone(), new_url.clone()));
                report.moved.push(Moved { old_key: m.old_key.clone(), new_url });
            }
            Err(error) => report.failed.push(Failed { old_key: m.old_key.clone(), error }),
        }
    }
    on_progress(Progress { done: total, total, current: String::new() });

    // Rewrite each file once, with every image it refers to.
    let mut files: Vec<String> = moves.iter().flat_map(|m| m.files.clone()).collect();
    files.sort();
    files.dedup();
    for file in files {
        let pairs: Vec<(String, String)> = moves
            .iter()
            .filter(|m| m.files.contains(&file))
            .filter_map(|m| {
                moved_to.iter().find(|(k, _)| *k == m.old_key).map(|(_, new)| m.old_urls.iter().map(move |u| (u.clone(), new.clone())))
            })
            .flatten()
            .collect();
        if pairs.is_empty() {
            continue;
        }
        let path = blog.root.join(&file);
        let text = std::fs::read_to_string(&path).map_err(|e| format!("无法读取 {file}：{e}"))?;
        let out = image_refs::rewrite(&text, &pairs);
        if out != text {
            // In place, as the editor saves: files keep their creation time (see `blog::write_post`).
            std::fs::write(&path, out).map_err(|e| format!("无法写入 {file}：{e}"))?;
            report.changed_files.push(file);
        }
    }
    Ok(report)
}
