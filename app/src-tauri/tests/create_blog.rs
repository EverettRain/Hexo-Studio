//! Making a real blog from each template and a plain one, with the network (npm registry):
//! `HEXO_STUDIO_TEST_CREATE=1 cargo test --test create_blog -- --nocapture`. Skipped without the
//! variable. Checks that the result opens as a blog and that Hexo generates it with the theme.

use hexo_studio_lib::domain::template::{NewBlog, PLAIN_THEME, TEMPLATES};
use hexo_studio_lib::infra::{blog, node_env};
use hexo_studio_lib::service::create::{Creator, Progress, Step};
use std::process::Command;
use std::sync::Mutex;

#[test]
fn each_template_makes_a_blog_hexo_generates() {
    if std::env::var("HEXO_STUDIO_TEST_CREATE").is_err() {
        eprintln!("skipped: set HEXO_STUDIO_TEST_CREATE=1");
        return;
    }
    let env = node_env::resolve(None).unwrap();
    let choices = TEMPLATES.iter().map(|t| (Some(t.id), t.theme, true)).chain([(None, PLAIN_THEME, false)]);
    for (id, theme, own_theme) in choices {
        // Arrange
        let parent = tempfile::tempdir().unwrap();
        let input = NewBlog { template: id.map(Into::into), parent: parent.path().display().to_string(), folder: "新博客".into(), title: "测试博客".into(), author: "tester".into() };
        let steps = Mutex::new(Vec::new());
        let sink = |p: Progress| {
            if let Progress::Step { step } = p {
                steps.lock().unwrap().push(step);
            }
        };

        // Act
        let root = Creator::default().create(&env, &input, &sink).unwrap();

        // Assert
        let expected: &[Step] = if own_theme { &[Step::Files, Step::Theme, Step::Install, Step::Git] } else { &[Step::Files, Step::Install, Step::Git] };
        assert_eq!(*steps.lock().unwrap(), expected);
        let opened = blog::open(&root).unwrap();
        assert_eq!(opened.config.title, "测试博客");
        assert_eq!(opened.config.theme.as_deref(), Some(theme));
        assert_eq!(root.join(format!("_config.{theme}.yml")).is_file(), own_theme);
        assert!(root.join(".git").is_dir());
        let leftovers: Vec<_> = std::fs::read_dir(parent.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers, ["新博客"]);
        let out = Command::new(&env.node).arg(opened.hexo_bin().unwrap()).arg("generate").current_dir(&root).env("PATH", &env.path_var).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let index = std::fs::read_to_string(root.join("public/index.html")).unwrap();
        assert!(index.contains("测试博客"));
        // Without a usable theme Hexo writes no layout around the content.
        assert!(index.contains("<html"), "{theme} did not lay out the page");
    }
}

#[test]
fn a_cancelled_blog_leaves_nothing_behind() {
    if std::env::var("HEXO_STUDIO_TEST_CREATE").is_err() {
        return;
    }
    // Arrange
    let env = node_env::resolve(None).unwrap();
    let parent = tempfile::tempdir().unwrap();
    let input = NewBlog { template: Some(TEMPLATES[0].id.into()), parent: parent.path().display().to_string(), folder: "b".into(), title: "t".into(), author: String::new() };
    let creator = Creator::default();

    // Act
    let result = std::thread::scope(|s| {
        let sink = |p: Progress| {
            if matches!(p, Progress::Step { step: Step::Install }) {
                s.spawn(|| creator.cancel());
            }
        };
        creator.create(&env, &input, &sink)
    });

    // Assert
    assert!(result.is_err());
    assert_eq!(std::fs::read_dir(parent.path()).unwrap().count(), 0);
}
