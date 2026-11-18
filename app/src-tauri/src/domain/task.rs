//! The Hexo commands the app runs, and what each needs.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Task {
    Clean,
    Generate,
    /// The blog's usual release: `hexo clean && hexo generate && hexo deploy`.
    Deploy,
    New {
        title: String,
        draft: bool,
    },
    /// Moves a draft to `_posts` and dates it; `slug` is its path under `_drafts` without `.md`.
    Publish {
        slug: String,
    },
}

impl Task {
    /// The `hexo` invocations, run in order until one fails. Layouts are always named, so a
    /// title such as `draft` is not taken for one; `--` keeps a title starting with `-` from being
    /// read as an option.
    pub fn steps(&self) -> Vec<Vec<String>> {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        match self {
            Task::Clean => vec![s(&["clean"])],
            Task::Generate => vec![s(&["generate"])],
            Task::Deploy => vec![s(&["clean"]), s(&["generate"]), s(&["deploy"])],
            Task::New { title, draft } => vec![s(&["new", if *draft { "draft" } else { "post" }, "--", title])],
            Task::Publish { slug } => vec![s(&["publish", "post", "--", slug])],
        }
    }

    /// Writes `db.json` / `public/`, which the preview server also writes: the server has to
    /// stop first.
    pub fn exclusive(&self) -> bool {
        matches!(self, Task::Clean | Task::Generate | Task::Deploy)
    }

    pub fn label(&self) -> String {
        match self {
            Task::Clean => "清理".into(),
            Task::Generate => "生成".into(),
            Task::Deploy => "部署".into(),
            Task::New { title, draft: false } => format!("新建文章「{title}」"),
            Task::New { title, draft: true } => format!("新建草稿「{title}」"),
            Task::Publish { slug } => format!("发布草稿「{slug}」"),
        }
    }
}

/// The post a `new` or `publish` made: the one id that was not there before.
pub fn created(before: &[String], after: &[String]) -> Option<String> {
    let mut new = after.iter().filter(|id| !before.contains(id));
    match (new.next(), new.next()) {
        (Some(id), None) => Some(id.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_is_clean_generate_deploy_in_order() {
        // Act
        let steps = Task::Deploy.steps();

        // Assert
        assert_eq!(steps, vec![vec!["clean"], vec!["generate"], vec!["deploy"]]);
    }

    #[test]
    fn new_names_the_layout_and_protects_the_title() {
        // Arrange
        let post = Task::New { title: "draft".into(), draft: false };
        let draft = Task::New { title: "-v 新文章".into(), draft: true };

        // Act / Assert
        assert_eq!(post.steps(), vec![vec!["new", "post", "--", "draft"]]);
        assert_eq!(draft.steps(), vec![vec!["new", "draft", "--", "-v 新文章"]]);
    }

    #[test]
    fn publish_moves_the_draft_into_posts() {
        // Act
        let steps = Task::Publish { slug: "nuaa-web-navigation".into() }.steps();

        // Assert
        assert_eq!(steps, vec![vec!["publish", "post", "--", "nuaa-web-navigation"]]);
    }

    #[test]
    fn only_commands_that_write_the_site_need_the_preview_stopped() {
        // Act / Assert
        assert!(Task::Clean.exclusive());
        assert!(Task::Generate.exclusive());
        assert!(Task::Deploy.exclusive());
        assert!(!Task::New { title: "a".into(), draft: true }.exclusive());
        assert!(!Task::Publish { slug: "a".into() }.exclusive());
    }

    #[test]
    fn tasks_read_from_the_interface_by_kind() {
        // Act
        let t: Task = serde_json::from_str(r#"{"kind":"new","title":"标题","draft":true}"#).unwrap();

        // Assert
        assert_eq!(t, Task::New { title: "标题".into(), draft: true });
        assert_eq!(t.label(), "新建草稿「标题」");
    }

    #[test]
    fn the_created_post_is_the_single_new_id() {
        // Arrange
        let before = vec!["_drafts/a.md".to_string(), "_posts/b.md".to_string()];
        let published = vec!["_posts/a.md".to_string(), "_posts/b.md".to_string()];
        let nothing = before.clone();
        let two = vec!["_posts/x.md".to_string(), "_posts/y.md".to_string()];

        // Act / Assert
        assert_eq!(created(&before, &published).as_deref(), Some("_posts/a.md"));
        assert_eq!(created(&before, &nothing), None);
        assert_eq!(created(&before, &two), None);
    }
}
