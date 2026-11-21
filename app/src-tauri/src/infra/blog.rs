//! The blog folder on disk: checking it, reading its config, listing, reading and writing posts,
//! and reading and writing the config files the config page edits.

use crate::domain::config::{declares_hexo, is_data_file, BlogConfig, ConfigFile};
use crate::domain::permalink;
use crate::domain::plugins::{self, Plugin};
use crate::domain::post::{self, Meta};
use serde::Serialize;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Blog {
    pub root: PathBuf,
    pub config: BlogConfig,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PostKind {
    Post,
    Draft,
}

impl PostKind {
    fn folder(self) -> &'static str {
        match self {
            PostKind::Post => "_posts",
            PostKind::Draft => "_drafts",
        }
    }
}

/// One row of the post list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSummary {
    /// Path under the source folder, e.g. `_posts/hello.md`; identifies the post to commands.
    pub id: String,
    pub kind: PostKind,
    /// Path under `_posts` / `_drafts`, e.g. `hello.md`.
    pub file_name: String,
    pub title: Option<String>,
    pub date: Option<String>,
    pub tags: Vec<String>,
    pub categories: Vec<String>,
    /// Path of the page under the site root, e.g. `2025/11/24/hello/`; `None` when unknown.
    pub url_path: Option<String>,
    /// Unix seconds of the last change on disk.
    pub modified: i64,
}

/// A post as read for editing; `prefix + yaml + suffix + body` is the file.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostFile {
    pub summary: PostSummary,
    pub prefix: String,
    pub yaml: String,
    pub suffix: String,
    pub body: String,
    /// Identifies this content; a save names the content it replaces.
    pub fingerprint: String,
}

pub fn fingerprint(text: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Checks a folder is a Hexo blog: `_config.yml`, a `package.json` that depends on `hexo`, and
/// the source folder.
pub fn open(dir: &Path) -> Result<Blog, String> {
    let config_text =
        std::fs::read_to_string(dir.join("_config.yml")).map_err(|_| "这个文件夹里没有 _config.yml，不是 Hexo 博客。".to_string())?;
    let package =
        std::fs::read_to_string(dir.join("package.json")).map_err(|_| "这个文件夹里没有 package.json，不是 Hexo 博客。".to_string())?;
    if !declares_hexo(&package) {
        return Err("package.json 的依赖里没有 hexo，不是 Hexo 博客。".into());
    }
    let config = BlogConfig::parse(&config_text)?;
    if !dir.join(&config.source_dir).is_dir() {
        return Err(format!("找不到源文件夹 {}/。", config.source_dir));
    }
    Ok(Blog { root: dir.to_path_buf(), config })
}

impl Blog {
    pub fn source(&self) -> PathBuf {
        self.root.join(&self.config.source_dir)
    }

    /// The blog's own Hexo; never a global one or `npx`, which could download another.
    pub fn hexo_bin(&self) -> Result<PathBuf, String> {
        let bin = self.root.join("node_modules/.bin/hexo");
        if bin.exists() {
            Ok(bin)
        } else {
            Err("博客里没有安装 Hexo（找不到 node_modules/.bin/hexo）。请在博客目录执行 npm install。".into())
        }
    }

    /// The file of a post id, refusing anything outside `_posts` and `_drafts`.
    pub fn post_path(&self, id: &str) -> Result<(PostKind, PathBuf, String), String> {
        let rel = Path::new(id);
        let mut parts = rel.components();
        let kind = match parts.next() {
            Some(Component::Normal(f)) if f == "_posts" => PostKind::Post,
            Some(Component::Normal(f)) if f == "_drafts" => PostKind::Draft,
            _ => return Err(format!("不是文章：{id}")),
        };
        let inner: PathBuf = parts.collect();
        if inner.as_os_str().is_empty() || inner.components().any(|c| !matches!(c, Component::Normal(_))) {
            return Err(format!("不是文章：{id}"));
        }
        let file_name = inner.to_string_lossy().replace('\\', "/");
        Ok((kind, self.source().join(kind.folder()).join(&inner), file_name))
    }

    fn summarize(&self, kind: PostKind, file_name: &str, text: &str, meta: &std::fs::Metadata) -> PostSummary {
        let parsed = Meta::parse(post::split(text).yaml);
        let tz = permalink::blog_zone(self.config.timezone.as_deref());
        let created = meta
            .created()
            .or_else(|_| meta.modified())
            .ok()
            .and_then(|t| jiff::Timestamp::try_from(t).ok())
            .unwrap_or(jiff::Timestamp::UNIX_EPOCH);
        let slug = post::slug(file_name);
        let url_path = permalink::for_post(&parsed, &slug, &self.config.permalink, &tz, created);
        let modified = meta.modified().ok().and_then(|t| jiff::Timestamp::try_from(t).ok()).map_or(0, |t| t.as_second());
        PostSummary {
            id: format!("{}/{file_name}", kind.folder()),
            kind,
            file_name: file_name.to_string(),
            title: parsed.title,
            date: parsed.date,
            tags: parsed.tags,
            categories: parsed.categories,
            url_path,
            modified,
        }
    }

    pub fn list_posts(&self) -> Vec<PostSummary> {
        let mut out = Vec::new();
        for kind in [PostKind::Post, PostKind::Draft] {
            let base = self.source().join(kind.folder());
            let mut files = Vec::new();
            collect_markdown(&base, &mut files);
            for file in files {
                let Ok(rel) = file.strip_prefix(&base) else { continue };
                let file_name = rel.to_string_lossy().replace('\\', "/");
                let (Ok(text), Ok(meta)) = (std::fs::read_to_string(&file), std::fs::metadata(&file)) else { continue };
                out.push(self.summarize(kind, &file_name, &text, &meta));
            }
        }
        out
    }

    pub fn read_post(&self, id: &str) -> Result<PostFile, String> {
        let (kind, path, file_name) = self.post_path(id)?;
        let text = std::fs::read_to_string(&path).map_err(|e| format!("无法读取 {id}：{e}"))?;
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let parts = post::split(&text);
        Ok(PostFile {
            summary: self.summarize(kind, &file_name, &text, &meta),
            prefix: parts.prefix.into(),
            yaml: parts.yaml.into(),
            suffix: parts.suffix.into(),
            body: parts.body.into(),
            fingerprint: fingerprint(&text),
        })
    }

    /// Writes a post, unless the file no longer holds the content `expected` names (changed by
    /// another editor or git since it was read): then `Conflict`, and nothing is written.
    ///
    /// The file is rewritten in place rather than replaced, so it keeps its creation time: Hexo
    /// dates a post without a `date` by it, and a new file would move the post's address.
    pub fn write_post(&self, id: &str, text: &str, expected: &str) -> Result<WriteOutcome, String> {
        let (kind, path, file_name) = self.post_path(id)?;
        let current = std::fs::read_to_string(&path).map_err(|e| format!("无法读取 {id}：{e}"))?;
        if fingerprint(&current) != expected {
            return Ok(WriteOutcome::Conflict);
        }
        std::fs::write(&path, text).map_err(|e| format!("无法保存 {id}：{e}"))?;
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        Ok(WriteOutcome::Saved { summary: Box::new(self.summarize(kind, &file_name, text, &meta)), fingerprint: fingerprint(text) })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum WriteOutcome {
    Saved { summary: Box<PostSummary>, fingerprint: String },
    Conflict,
}

/// A config file as the config page reads it. A missing file reads as empty text, so the
/// first change creates it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigText {
    /// From the blog root.
    pub path: String,
    pub exists: bool,
    pub text: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ConfigWrite {
    Saved { fingerprint: String },
    Conflict,
}

impl Blog {
    fn config_file(&self, file: ConfigFile) -> Result<(String, PathBuf), String> {
        let rel = file.path(self.config.theme.as_deref()).ok_or_else(|| "博客的 _config.yml 没有设置可用的 theme。".to_string())?;
        let path = self.root.join(&rel);
        Ok((rel, path))
    }

    pub fn read_config(&self, file: ConfigFile) -> Result<ConfigText, String> {
        let (rel, path) = self.config_file(file)?;
        let (exists, text) = match std::fs::read_to_string(&path) {
            Ok(text) => (true, text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, String::new()),
            Err(e) => return Err(format!("无法读取 {rel}：{e}")),
        };
        Ok(ConfigText { fingerprint: fingerprint(&text), path: rel, exists, text })
    }

    /// Writes a config file unless it no longer holds what `expected` names (edited elsewhere
    /// since it was read). In place, as posts are; the theme's own defaults are never written.
    pub fn write_config(&self, file: ConfigFile, text: &str, expected: &str) -> Result<ConfigWrite, String> {
        if !file.writable() {
            return Err("主题目录里的配置只读，改动写在博客根目录的 _config.<主题>.yml 里。".into());
        }
        let current = self.read_config(file)?;
        if current.fingerprint != expected {
            return Ok(ConfigWrite::Conflict);
        }
        std::fs::write(self.root.join(&current.path), text).map_err(|e| format!("无法保存 {}：{e}", current.path))?;
        Ok(ConfigWrite::Saved { fingerprint: fingerprint(text) })
    }
}

impl Blog {
    fn data_dir(&self) -> PathBuf {
        self.source().join("_data")
    }

    /// The page data files in `source/_data`, by name.
    pub fn data_files(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.data_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| is_data_file(n))
            .collect();
        names.sort();
        names
    }

    fn data_file(&self, name: &str) -> Result<(String, PathBuf), String> {
        if !is_data_file(name) {
            return Err(format!("不是页面数据文件：{name}"));
        }
        Ok((format!("{}/_data/{name}", self.config.source_dir), self.data_dir().join(name)))
    }

    pub fn read_data(&self, name: &str) -> Result<ConfigText, String> {
        let (rel, path) = self.data_file(name)?;
        let text = std::fs::read_to_string(&path).map_err(|e| format!("无法读取 {rel}：{e}"))?;
        Ok(ConfigText { fingerprint: fingerprint(&text), path: rel, exists: true, text })
    }

    /// Writes a page data file in place unless it changed since `expected` was read.
    pub fn write_data(&self, name: &str, text: &str, expected: &str) -> Result<ConfigWrite, String> {
        let current = self.read_data(name)?;
        if current.fingerprint != expected {
            return Ok(ConfigWrite::Conflict);
        }
        std::fs::write(self.data_dir().join(name), text).map_err(|e| format!("无法保存 {}：{e}", current.path))?;
        Ok(ConfigWrite::Saved { fingerprint: fingerprint(text) })
    }

    /// The plugins Hexo loads for this blog: the blog's own, then the theme's not already listed;
    /// each in name order.
    pub fn plugins(&self) -> Vec<Plugin> {
        let read = |p: PathBuf| std::fs::read_to_string(p).unwrap_or_default();
        let theme_dir = self.config.theme.as_deref().and_then(|t| ConfigFile::ThemeDefaults.path(Some(t))).map(|p| self.root.join(p).with_file_name(""));
        let mut out: Vec<Plugin> = Vec::new();
        let mut add = |name: String, wanted: String, dirs: &[PathBuf], from_theme: bool| {
            if out.iter().any(|p| p.name == name) {
                return;
            }
            // As Node resolves it: the nearest `node_modules` holding the package.
            let manifest = dirs.iter().map(|d| d.join("node_modules").join(&name).join("package.json")).find(|p| p.is_file());
            let json: serde_json::Value = manifest.map(|p| serde_json::from_str(&read(p)).unwrap_or_default()).unwrap_or_default();
            out.push(Plugin {
                version: json["version"].as_str().map(str::to_string),
                description: json["description"].as_str().map(|d| d.trim().to_string()).filter(|d| !d.is_empty()),
                repo: plugins::github_page(&json),
                name,
                wanted,
                from_theme,
            });
        };
        for (name, wanted) in plugins::listed(&read(self.root.join("package.json")), true) {
            add(name, wanted, std::slice::from_ref(&self.root), false);
        }
        if let Some(dir) = theme_dir {
            for (name, wanted) in plugins::listed(&read(dir.join("package.json")), false) {
                add(name, wanted, &[dir.clone(), self.root.clone()], true);
            }
        }
        out
    }
}

fn collect_markdown(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        if p.is_dir() {
            collect_markdown(&p, out);
        } else if p.extension().is_some_and(|x| x == "md" || x == "markdown") {
            out.push(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blog() -> (tempfile::TempDir, Blog) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("_config.yml"), "timezone: Asia/Shanghai\npermalink: :year/:month/:day/:title/\n").unwrap();
        std::fs::write(root.join("package.json"), r#"{"dependencies":{"hexo":"^7.0.0"}}"#).unwrap();
        std::fs::create_dir_all(root.join("source/_posts/notes")).unwrap();
        std::fs::create_dir_all(root.join("source/_drafts")).unwrap();
        std::fs::write(root.join("source/_posts/a.md"), "---\ntitle: A\ndate: 2025-11-24 01:14:20\ntags:\n  - x\n---\nbody\n").unwrap();
        std::fs::write(root.join("source/_posts/notes/b.md"), "---\ntitle: B\ndate: 2025-01-02 10:00:00\n---\n").unwrap();
        std::fs::write(root.join("source/_posts/.hidden.md"), "").unwrap();
        std::fs::write(root.join("source/_posts/image.png"), "").unwrap();
        std::fs::write(root.join("source/_drafts/d.md"), "---\ntitle: D\n---\n").unwrap();
        let blog = open(root).unwrap();
        (dir, blog)
    }

    fn themed_blog() -> (tempfile::TempDir, Blog) {
        let (dir, _) = blog();
        std::fs::write(dir.path().join("_config.yml"), "theme: anzhiyu\n").unwrap();
        std::fs::create_dir_all(dir.path().join("themes/anzhiyu")).unwrap();
        std::fs::write(dir.path().join("themes/anzhiyu/_config.yml"), "nav:\n  enable: true\n").unwrap();
        let blog = open(dir.path()).unwrap();
        (dir, blog)
    }

    #[test]
    fn a_missing_theme_override_reads_empty_and_the_first_save_creates_it() {
        // Arrange
        let (dir, blog) = themed_blog();
        let before = blog.read_config(ConfigFile::Theme).unwrap();

        // Act
        let r = blog.write_config(ConfigFile::Theme, "nav:\n  enable: false\n", &before.fingerprint).unwrap();

        // Assert
        assert_eq!((before.exists, before.text.as_str(), before.path.as_str()), (false, "", "_config.anzhiyu.yml"));
        assert_eq!(r, ConfigWrite::Saved { fingerprint: fingerprint("nav:\n  enable: false\n") });
        assert_eq!(std::fs::read_to_string(dir.path().join("_config.anzhiyu.yml")).unwrap(), "nav:\n  enable: false\n");
    }

    #[test]
    fn a_config_changed_since_it_was_read_is_not_overwritten() {
        // Arrange
        let (dir, blog) = themed_blog();
        let read = blog.read_config(ConfigFile::Site).unwrap();
        std::fs::write(dir.path().join("_config.yml"), "theme: anzhiyu\ntitle: edited elsewhere\n").unwrap();

        // Act
        let r = blog.write_config(ConfigFile::Site, "theme: anzhiyu\ntitle: mine\n", &read.fingerprint).unwrap();

        // Assert
        assert_eq!(r, ConfigWrite::Conflict);
        assert!(std::fs::read_to_string(dir.path().join("_config.yml")).unwrap().contains("edited elsewhere"));
    }

    #[test]
    fn the_theme_defaults_are_read_only() {
        // Arrange
        let (dir, blog) = themed_blog();
        let read = blog.read_config(ConfigFile::ThemeDefaults).unwrap();

        // Act
        let r = blog.write_config(ConfigFile::ThemeDefaults, "nav:\n  enable: false\n", &read.fingerprint);

        // Assert
        assert!(r.is_err());
        assert_eq!(read.text, "nav:\n  enable: true\n");
        assert_eq!(std::fs::read_to_string(dir.path().join("themes/anzhiyu/_config.yml")).unwrap(), "nav:\n  enable: true\n");
    }

    #[test]
    fn without_a_theme_only_the_site_config_is_there() {
        // Arrange
        let (_dir, blog) = blog();

        // Act / Assert
        assert!(blog.read_config(ConfigFile::Site).unwrap().exists);
        assert!(blog.read_config(ConfigFile::Theme).is_err());
    }

    #[test]
    fn lists_reads_and_writes_page_data_files_only() {
        // Arrange
        let (dir, blog) = blog();
        let data = dir.path().join("source/_data");
        std::fs::create_dir_all(data.join("sub.yml")).unwrap();
        for (name, text) in [("link.yml", "- class_name: a\n"), ("extra_bangumis.json", "{}\n"), ("notes.md", ""), (".x.yml", "")] {
            std::fs::write(data.join(name), text).unwrap();
        }
        let read = blog.read_data("link.yml").unwrap();

        // Act
        let saved = blog.write_data("link.yml", "- class_name: b\n", &read.fingerprint).unwrap();
        let stale = blog.write_data("link.yml", "- class_name: c\n", &read.fingerprint).unwrap();

        // Assert
        assert_eq!(blog.data_files(), ["extra_bangumis.json", "link.yml"]);
        assert_eq!(read.path, "source/_data/link.yml");
        assert!(matches!(saved, ConfigWrite::Saved { .. }));
        assert_eq!(stale, ConfigWrite::Conflict);
        assert_eq!(std::fs::read_to_string(data.join("link.yml")).unwrap(), "- class_name: b\n");
        assert!(blog.read_data("../../_config.yml").is_err());
    }

    #[test]
    fn lists_the_plugins_hexo_loads_with_what_is_installed() {
        // Arrange
        let (dir, _) = themed_blog();
        let root = dir.path();
        std::fs::write(root.join("package.json"), r#"{"dependencies":{"hexo":"^7.0.0","hexo-server":"^3.0.0","hexo-missing":"^1","twikoo":"1"}}"#).unwrap();
        std::fs::write(root.join("themes/anzhiyu/package.json"), r#"{"dependencies":{"hexo-server":"^2","hexo-renderer-pug":"^3"}}"#).unwrap();
        for (name, manifest) in [
            ("hexo-server", r#"{"version":"3.0.0","description":"Server module of Hexo.","repository":"hexojs/hexo-server"}"#),
            ("hexo-renderer-pug", r#"{"version":"3.1.0","homepage":"https://hexo.io/"}"#),
        ] {
            std::fs::create_dir_all(root.join("node_modules").join(name)).unwrap();
            std::fs::write(root.join("node_modules").join(name).join("package.json"), manifest).unwrap();
        }
        let blog = open(root).unwrap();

        // Act
        let list = blog.plugins();

        // Assert
        let rows: Vec<_> = list.iter().map(|p| (p.name.as_str(), p.wanted.as_str(), p.version.as_deref(), p.from_theme)).collect();
        assert_eq!(
            rows,
            vec![("hexo-missing", "^1", None, false), ("hexo-server", "^3.0.0", Some("3.0.0"), false), ("hexo-renderer-pug", "^3", Some("3.1.0"), true)]
        );
        assert_eq!(list[1].repo.as_deref(), Some("https://github.com/hexojs/hexo-server"));
        assert_eq!(list[1].description.as_deref(), Some("Server module of Hexo."));
        assert_eq!(list[2].repo, None);
    }

    #[test]
    fn a_folder_without_hexo_is_refused() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("_config.yml"), "").unwrap();
        std::fs::write(dir.path().join("package.json"), "{}").unwrap();
        std::fs::create_dir(dir.path().join("source")).unwrap();

        // Act
        let r = open(dir.path());

        // Assert
        assert!(r.unwrap_err().contains("hexo"));
    }

    #[test]
    fn lists_posts_in_subfolders_and_drafts_but_not_other_files() {
        // Arrange
        let (_dir, blog) = blog();

        // Act
        let mut ids: Vec<String> = blog.list_posts().into_iter().map(|p| p.id).collect();
        ids.sort();

        // Assert
        assert_eq!(ids, ["_drafts/d.md", "_posts/a.md", "_posts/notes/b.md"]);
    }

    #[test]
    fn a_listed_post_carries_its_fields_and_address() {
        // Arrange
        let (_dir, blog) = blog();

        // Act
        let a = blog.list_posts().into_iter().find(|p| p.id == "_posts/a.md").unwrap();

        // Assert
        assert_eq!(a.title.as_deref(), Some("A"));
        assert_eq!(a.tags, ["x"]);
        assert_eq!(a.url_path.as_deref(), Some("2025/11/24/a/"));
    }

    #[test]
    fn ids_outside_the_post_folders_are_refused() {
        // Arrange
        let (_dir, blog) = blog();

        // Act / Assert
        for id in ["_posts/../../_config.yml", "about/index.md", "/etc/passwd", "_posts", "_drafts/"] {
            assert!(blog.post_path(id).is_err(), "{id}");
        }
    }

    #[test]
    fn reading_splits_the_file_and_the_parts_join_back() {
        // Arrange
        let (_dir, blog) = blog();

        // Act
        let f = blog.read_post("_posts/a.md").unwrap();

        // Assert
        assert_eq!(
            format!("{}{}{}{}", f.prefix, f.yaml, f.suffix, f.body),
            std::fs::read_to_string(blog.source().join("_posts/a.md")).unwrap()
        );
        assert_eq!(f.body, "body\n");
    }

    #[test]
    fn saving_over_the_content_that_was_read_writes_it() {
        // Arrange
        let (_dir, blog) = blog();
        let f = blog.read_post("_posts/a.md").unwrap();
        let text = "---\ntitle: A2\ndate: 2025-11-24 01:14:20\n---\nnew\n";

        // Act
        let r = blog.write_post("_posts/a.md", text, &f.fingerprint).unwrap();

        // Assert
        assert!(matches!(r, WriteOutcome::Saved { ref fingerprint, .. } if *fingerprint == super::fingerprint(text)));
        assert_eq!(std::fs::read_to_string(blog.source().join("_posts/a.md")).unwrap(), text);
    }

    #[test]
    fn saving_over_a_file_changed_elsewhere_is_a_conflict_and_writes_nothing() {
        // Arrange
        let (_dir, blog) = blog();
        let f = blog.read_post("_posts/a.md").unwrap();
        let path = blog.source().join("_posts/a.md");
        std::fs::write(&path, "changed by git").unwrap();

        // Act
        let r = blog.write_post("_posts/a.md", "mine", &f.fingerprint).unwrap();

        // Assert
        assert!(matches!(r, WriteOutcome::Conflict));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "changed by git");
    }
}
