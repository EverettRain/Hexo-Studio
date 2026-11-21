//! Taking the store's existing images into the library: those the blog refers to (flat at the
//! bucket's root today) and those the user's checklist lists. Each is read, kept as an
//! original, converted, put at `<prefix><project>/<uid>.webp`, recorded with what the checklist
//! says about it; then the blog's addresses are rewritten. Old objects stay (design 6.3).

use super::images::{self, Incoming};
use crate::domain::catalog::{self, ChecklistRow};
use crate::domain::image_key::{self, Format};
use crate::domain::image_refs::{self, Candidate, Source};
use crate::infra::blog::{Blog, PostKind};
use crate::infra::project::{self, ProjectSettings};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

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

/// The blog's text: posts oldest first, drafts, other pages and data files under `source/`,
/// then the `_config*.yml` files.
pub fn sources(blog: &Blog) -> Vec<Source> {
    let mut posts = blog.list_posts();
    posts.sort_by_key(|p| (p.kind == PostKind::Draft, p.date.clone()));
    let rel = |p: &Path| p.strip_prefix(&blog.root).unwrap_or(p).to_string_lossy().replace('\\', "/");
    let mut out: Vec<Source> = Vec::new();
    for p in posts {
        if let Ok((_, path, _)) = blog.post_path(&p.id) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                out.push(Source { file: rel(&path), title: Some(p.title.clone().unwrap_or(p.file_name.clone())), text });
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
        let is_page = r.ends_with(".md") || r.ends_with(".markdown");
        if let Ok(text) = std::fs::read_to_string(&path) {
            let title = is_page
                .then(|| crate::domain::post::Meta::parse(crate::domain::post::split(&text).yaml).title.unwrap_or_else(|| r.clone()));
            out.push(Source { file: rel(&path), title, text });
        }
    }
    let mut config_dirs = vec![blog.root.clone()];
    let mut themes: Vec<_> = std::fs::read_dir(blog.root.join("themes")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    themes.sort();
    config_dirs.extend(themes);
    for dir in config_dirs {
        for path in config_files(&dir) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                out.push(Source { file: rel(&path), title: None, text });
            }
        }
    }
    out
}

/// The `_config*.yml` files directly in `dir`. A theme's own are included (the menu icons live
/// there); the rest of a theme is code and templates, which are not touched.
fn config_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("_config") && n.to_string_lossy().ends_with(".yml")))
        .collect();
    files.sort();
    files
}

/// Which files use each library image.
/// Which files use each library image, whichever profile's store holds it.
pub fn usages(blog: &Blog, settings: &ProjectSettings) -> Result<BTreeMap<String, Vec<String>>, String> {
    Ok(image_refs::usages(&sources(blog), &settings.all_bases(), &project::load_catalog(&blog.root)?))
}

/// The active profile's store's images not in the library yet: adopting reads them from that
/// store and puts them back into it the way the profile uploads.
pub fn plan(blog: &Blog, settings: &ProjectSettings, checklist: &[ChecklistRow]) -> Result<Vec<Candidate>, String> {
    let storage = &images::active_profile(settings)?.storage;
    Ok(image_refs::adoption(&sources(blog), &storage.bases(), &project::load_catalog(&blog.root)?, checklist))
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
pub struct Failed {
    pub old_key: String,
    pub error: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Images now in the library (uids), one per old object.
    pub adopted: Vec<String>,
    pub failed: Vec<Failed>,
    /// Files whose addresses were rewritten, from the blog root.
    pub changed_files: Vec<String>,
}

fn default_description(c: &Candidate) -> String {
    match (&c.first_title, c.files.first()) {
        (Some(t), _) => format!("{t} 内图"),
        (None, Some(f)) => format!("{f} 里的图片"),
        (None, None) => String::new(),
    }
}

pub async fn run(
    blog: &Blog,
    settings: &ProjectSettings,
    backup_dir: &Path,
    checklist: &[ChecklistRow],
    today: &str,
    now: jiff::civil::DateTime,
    on_progress: impl Fn(Progress),
) -> Result<Report, String> {
    let store = images::open_store(&images::active_profile(settings)?.storage)?;
    let candidates = plan(blog, settings, checklist)?;
    let total = candidates.len();
    let mut report = Report::default();
    let mut moved: Vec<(Vec<String>, String)> = Vec::new();
    for (i, c) in candidates.iter().enumerate() {
        on_progress(Progress { done: i, total, current: c.old_key.clone() });
        let result: Result<String, String> = async {
            let bytes = store.read(&c.old_key).await?;
            let file_name = c.old_key.rsplit('/').next().unwrap_or(&c.old_key).to_string();
            let name = c
                .row
                .as_ref()
                .map(|r| r.name.clone())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| image_key::split_name(&file_name).0.to_string());
            let inc = Incoming {
                bytes,
                file_name: Some(file_name),
                format: Format::Webp,
                encoding: None,
                name: Some(name),
                description: default_description(c),
                today: today.to_string(),
                legacy_urls: c.old_urls.clone(),
                now,
            };
            let got = images::ingest(&blog.root, settings, backup_dir, inc).await?;
            // The checklist's fields, and old addresses of an image whose content was there already.
            project::update_catalog(&blog.root, |cat| {
                if let Some(img) = cat.get_mut(&got.image.id) {
                    for u in &c.old_urls {
                        if !img.legacy_urls.contains(u) {
                            img.legacy_urls.push(u.clone());
                        }
                    }
                    if let Some(row) = &c.row {
                        catalog::apply_row(img, row);
                    }
                }
                Ok(())
            })?;
            Ok(got.image.id)
        }
        .await;
        match result {
            Ok(id) => {
                let url = project::load_catalog(&blog.root)?.get(&id).map(|i| i.url.clone()).unwrap_or_default();
                moved.push((c.old_urls.clone(), url));
                report.adopted.push(id);
            }
            Err(error) => report.failed.push(Failed { old_key: c.old_key.clone(), error }),
        }
    }
    on_progress(Progress { done: total, total, current: String::new() });

    // Rewrite each file once, with every address it holds.
    let pairs: Vec<(String, String)> = moved.iter().flat_map(|(olds, new)| olds.iter().map(move |o| (o.clone(), new.clone()))).collect();
    let mut files: Vec<String> = candidates.iter().flat_map(|c| c.files.clone()).collect();
    files.sort();
    files.dedup();
    for file in files {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::blog;

    fn write(root: &Path, file: &str, text: &str) {
        let p = root.join(file);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn the_scan_covers_root_and_theme_configs_but_not_theme_code() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "_config.yml", "title: t\n");
        write(root, "_config.anzhiyu.yml", "a: 1\n");
        write(root, "package.json", r#"{"dependencies":{"hexo":"^7"}}"#);
        write(root, "source/_posts/p.md", "---\ntitle: P\n---\n");
        write(root, "themes/anzhiyu/_config.yml", "icon: x\n");
        write(root, "themes/anzhiyu/_config.dev.yml", "icon: y\n");
        write(root, "themes/anzhiyu/languages/zh-CN.yml", "k: v\n");
        write(root, "themes/anzhiyu/source/data/links.json", "{}");
        write(root, "themes/anzhiyu/node_modules/dep/_config.yml", "no: 1\n");
        let blog = blog::open(root).unwrap();

        // Act
        let files: Vec<String> = sources(&blog).into_iter().map(|s| s.file).collect();

        // Assert
        assert_eq!(
            files,
            [
                "source/_posts/p.md",
                "_config.anzhiyu.yml",
                "_config.yml",
                "themes/anzhiyu/_config.dev.yml",
                "themes/anzhiyu/_config.yml",
            ]
        );
    }
}
