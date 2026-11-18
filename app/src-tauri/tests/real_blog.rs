//! Runs against a real Hexo blog: `HEXO_STUDIO_TEST_BLOG=<a copy of the blog> cargo test --test real_blog -- --nocapture`.
//! Without the variable every test returns at once. Point it at a copy: the tests write posts.

use hexo_studio_lib::domain::deploy_log::Problem;
use hexo_studio_lib::domain::task::Task;
use hexo_studio_lib::infra::{blog, node_env};
use hexo_studio_lib::service::preview::{self, Preview, PreviewState};
use hexo_studio_lib::service::runner::{Run, RunStatus, Runner};
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn blog_dir() -> Option<PathBuf> {
    std::env::var_os("HEXO_STUDIO_TEST_BLOG").map(PathBuf::from)
}

#[test]
fn addresses_of_early_morning_posts_use_the_blogs_zone() {
    let Some(dir) = blog_dir() else { return };
    // Arrange
    let b = blog::open(&dir).unwrap();

    // Act
    let posts = b.list_posts();

    // Assert
    let p = posts.iter().find(|p| p.id == "_posts/pointer-security.md").expect("pointer-security.md");
    assert_eq!(p.url_path.as_deref(), Some("2025/11/24/pointer-security/"));
    println!("{} posts and drafts listed", posts.len());
}

#[tokio::test(flavor = "current_thread")]
async fn preview_serves_posts_drafts_and_follows_saves() {
    let Some(dir) = blog_dir() else { return };
    // Arrange
    let b = blog::open(&dir).unwrap();
    let env = node_env::resolve(None).unwrap();
    let preview = Preview::new(|_| {});
    hexo_studio_lib::infra::install_tls();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let started = Instant::now();

    // Act: start
    let p2 = preview.clone();
    let b2 = b.clone();
    let port = tokio::task::spawn_blocking(move || p2.start(&b2, &env)).await.unwrap().expect("preview starts");
    println!("hexo server ready in {:?} on port {port}", started.elapsed());

    // Assert: every post and draft address the app computes is served by Hexo.
    let posts = b.list_posts();
    let mut missing = Vec::new();
    for p in &posts {
        let path = format!("{}{}", b.config.root, p.url_path.as_deref().unwrap());
        let r = preview::probe(&client, port, &path).await.unwrap();
        if r.status != 200 {
            missing.push((p.id.clone(), path, r.status));
        }
    }
    assert!(missing.is_empty(), "not served: {missing:?}");

    // Assert: a page reads the same twice when nothing changed (no per-request content).
    let target = posts.iter().find(|p| p.id == "_posts/hello-world.md").unwrap();
    let path = format!("{}{}", b.config.root, target.url_path.as_deref().unwrap());
    let first = preview::probe(&client, port, &path).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let second = preview::probe(&client, port, &path).await.unwrap();
    assert_eq!(first, second, "the page changes between requests");

    // Act: save an edit and wait for the re-render.
    let file = b.read_post(&target.id).unwrap();
    let text = format!("{}{}{}{}\n\nEdited by the real_blog test.\n", file.prefix, file.yaml, file.suffix, file.body);
    b.write_post(&target.id, &text, &file.fingerprint).unwrap();
    let saved = Instant::now();
    let after = preview::await_change(&client, port, &path, Some(first.clone()), Duration::from_secs(5)).await.unwrap();
    println!("re-rendered {:?} after the save", saved.elapsed());

    // Assert
    assert_ne!(after, first, "no change seen within 5 s");

    // Act: stop
    tokio::task::spawn_blocking({
        let p = preview.clone();
        move || p.stop()
    })
    .await
    .unwrap();

    // Assert
    assert_eq!(preview.state(), PreviewState::Stopped);
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "port still open after stop");
}

/// Refuses to deploy anywhere but a local folder: these tests must never push to a real site.
fn local_deploy_repo(b: &blog::Blog) -> PathBuf {
    let repo = b.config.deploy.first().and_then(|d| d.repo.clone()).expect("deploy.repo");
    assert!(repo.starts_with('/') && !repo.contains('@') && !repo.contains("://"), "deploy.repo must be a local bare repository: {repo}");
    PathBuf::from(repo)
}

fn deployed_files(repo: &std::path::Path) -> String {
    let out = std::process::Command::new("git").args(["ls-tree", "-r", "--name-only", "main"]).current_dir(repo).output().unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn run_to_end(runner: &std::sync::Arc<Runner>, task: Task, b: &blog::Blog) -> Run {
    let (tx, rx) = std::sync::mpsc::channel();
    runner.start(task, b.clone(), node_env::resolve(None).unwrap(), vec![], move |r| tx.send(r).unwrap()).unwrap();
    rx.recv_timeout(Duration::from_secs(300)).expect("run finishes")
}

#[test]
fn deploy_pauses_the_preview_pushes_and_reads_push_protection() {
    let Some(dir) = blog_dir() else { return };
    // Arrange
    let b = blog::open(&dir).unwrap();
    let repo = local_deploy_repo(&b);
    let _ = std::fs::remove_file(repo.join("block"));
    let preview = Preview::new(|_| {});
    preview.start(&b, &node_env::resolve(None).unwrap()).unwrap();
    let runner = Runner::new(preview.clone(), |_| {});

    // Act
    let started = Instant::now();
    let ok = run_to_end(&runner, Task::Deploy, &b);
    println!("deploy took {:?}", started.elapsed());

    // Assert: pushed, the preview was paused and is back.
    let tail: Vec<&str> = ok.lines.iter().rev().take(15).map(|l| l.text.as_str()).collect();
    assert_eq!(ok.status, RunStatus::Succeeded, "{tail:?}");
    assert!(ok.lines.iter().any(|l| l.text.contains("已停止预览服务器")));
    assert!(deployed_files(&repo).contains("2025/11/24/pointer-security/index.html"));
    assert!(matches!(preview.state(), PreviewState::Running { .. }));

    // Arrange: GitHub refuses the next push.
    std::fs::write(repo.join("block"), "").unwrap();
    let post = b.source().join("_posts/hello-world.md");
    let original = std::fs::read_to_string(&post).unwrap();
    std::fs::write(&post, format!("{original}\nChanged so the next deploy has something to push.\n")).unwrap();

    // Act
    let blocked = run_to_end(&runner, Task::Deploy, &b);
    std::fs::write(&post, original).unwrap();
    let _ = std::fs::remove_file(repo.join("block"));
    preview.stop();

    // Assert
    assert_eq!(blocked.status, RunStatus::Failed);
    assert!(
        blocked.problems.iter().any(|p| matches!(p, Problem::PushProtection { unblock_urls, .. } if unblock_urls.iter().any(|u| u.ends_with("/unblock-secret/TEST-ONLY")))),
        "{:?}",
        blocked.problems
    );
}

#[test]
fn new_and_publish_report_the_post_they_made() {
    let Some(dir) = blog_dir() else { return };
    // Arrange
    let b = blog::open(&dir).unwrap();
    let runner = Runner::new(Preview::new(|_| {}), |_| {});

    // Act
    let made = run_to_end(&runner, Task::New { title: "Hexo Studio 测试草稿".into(), draft: true }, &b);
    let draft = made.created.clone().expect("new draft id");
    let slug = draft.trim_start_matches("_drafts/").trim_end_matches(".md").to_string();
    let published = run_to_end(&runner, Task::Publish { slug }, &b);

    // Assert
    let post = published.created.clone().expect("published post id");
    let file = b.source().join(&post);
    let text = std::fs::read_to_string(&file).unwrap();
    std::fs::remove_file(&file).unwrap();
    assert_eq!(draft, "_drafts/Hexo-Studio-测试草稿.md");
    assert_eq!(post, "_posts/Hexo-Studio-测试草稿.md");
    assert!(text.contains("title: Hexo Studio 测试草稿") && text.contains("date: "), "{text}");
}

/// Plans (does not run) adopting the blog's real images, with the user's checklist when
/// `HEXO_STUDIO_TEST_CHECKLIST` names it; reads nothing from the store.
#[test]
fn adoption_covers_every_image_of_the_bucket_in_the_blog_and_the_checklist() {
    let Some(dir) = blog_dir() else { return };
    // Arrange
    let b = blog::open(&dir).unwrap();
    let storage = hexo_studio_lib::domain::storage::Storage::AliyunOss {
        bucket: "hexo-image-storage".into(),
        area: "oss-cn-shanghai".into(),
        path: String::new(),
        custom_url: String::new(),
    };
    let profile = hexo_studio_lib::infra::project::Profile { id: "oss".into(), name: "oss".into(), storage, upload: Default::default() };
    let settings =
        hexo_studio_lib::infra::project::ProjectSettings { name: Some("EverettBlog".into()), profiles: vec![profile], active: None };
    let rows = std::env::var("HEXO_STUDIO_TEST_CHECKLIST")
        .ok()
        .map(|p| hexo_studio_lib::domain::catalog::parse_checklist(&std::fs::read_to_string(p).unwrap()).unwrap())
        .unwrap_or_default();

    // Act
    let plan = hexo_studio_lib::service::adopt::plan(&b, &settings, &rows).unwrap();

    // Assert: as many images as distinct bucket addresses a plain search finds, plus the
    // checklist's; every checklist row lands on a candidate.
    let host = "hexo-image-storage.oss-cn-shanghai.aliyuncs.com/";
    let key_of = |part: &str| -> String { part.chars().take_while(|c| !c.is_whitespace() && !"()\"'<>[]{},|`?#".contains(*c)).collect() };
    let mut distinct = std::collections::BTreeSet::new();
    let mut search = |p: &std::path::Path| {
        let text = std::fs::read_to_string(p).unwrap_or_default();
        for part in text.split(host).skip(1) {
            distinct.insert(key_of(part));
        }
    };
    fn walk(d: &std::path::Path, f: &mut dyn FnMut(&std::path::Path)) {
        for e in std::fs::read_dir(d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, f);
            } else if p.extension().is_some_and(|x| ["md", "yml", "yaml", "json"].contains(&x.to_string_lossy().as_ref())) {
                f(&p);
            }
        }
    }
    walk(&b.source(), &mut search);
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.starts_with("_config") && n.ends_with(".yml") {
            search(&e.path());
        }
    }
    let in_blog = distinct.len();
    for r in &rows {
        if let Some(part) = r.url.split(host).nth(1) {
            distinct.insert(key_of(part));
        }
    }
    let with_row = plan.iter().filter(|c| c.row.is_some()).count();
    println!(
        "{} images: {} in the blog, {} more only in the checklist; {} with checklist fields",
        plan.len(),
        in_blog,
        distinct.len() - in_blog,
        with_row
    );
    assert_eq!(plan.len(), distinct.len());
    assert_eq!(with_row, rows.len());
}
