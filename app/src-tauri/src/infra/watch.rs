//! Changes made to the blog's posts from outside the app (another editor, git), as they happen.

use super::blog::{self, fingerprint};
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebouncedEventBatch, Debouncer};
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostChange {
    pub id: String,
    /// What the file holds now; `None` when it is gone.
    pub fingerprint: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostsChanged {
    pub changes: Vec<PostChange>,
    /// Events were missed: anything may have changed.
    pub rescan: bool,
}

/// Watching `source/` until dropped.
pub type Watch = Debouncer<RecommendedWatcher>;

/// Our own saves come back here too; the page tells them apart by fingerprint.
const SETTLE: Duration = Duration::from_millis(300);

pub fn posts(root: &Path, on_change: impl Fn(PostsChanged) + Send + 'static) -> Result<Watch, String> {
    // Events carry real paths (`/private/var/...`), so the folder is compared as one too.
    let source = std::fs::canonicalize(root.join("source")).map_err(|e| format!("无法监听 source/：{e}"))?;
    let watched = source.clone();
    let mut debouncer = new_debouncer(SETTLE, move |result: notify_debouncer_mini::DebounceEventResult| {
        let batch = match result {
            Ok(DebouncedEventBatch::Events(events)) => events,
            // Missed events, an error, or a kind of batch added later: read everything again.
            _ => return on_change(PostsChanged { changes: Vec::new(), rescan: true }),
        };
        if !batch.iter().any(|e| blog::in_post_folders(&source, &e.path)) {
            return;
        }
        let mut changes: Vec<PostChange> = batch
            .iter()
            .filter_map(|e| blog::post_id(&source, &e.path).map(|id| (id, &e.path)))
            .map(|(id, path)| PostChange { fingerprint: std::fs::read_to_string(path).ok().map(|t| fingerprint(&t)), id })
            .collect();
        changes.sort_by(|a, b| a.id.cmp(&b.id));
        changes.dedup_by(|a, b| a.id == b.id);
        on_change(PostsChanged { changes, rescan: false });
    })
    .map_err(|e| format!("无法监听文章目录：{e}"))?;
    debouncer.watcher().watch(&watched, RecursiveMode::Recursive).map_err(|e| format!("无法监听文章目录：{e}"))?;
    Ok(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_post_changed_outside_is_reported_with_its_new_content() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("source/_posts")).unwrap();
        std::fs::write(dir.path().join("source/_posts/a.md"), "one").unwrap();
        let (tx, rx) = mpsc::channel();
        let _watch = posts(dir.path(), move |c| {
            let _ = tx.send(c);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(200));

        // Act
        std::fs::write(dir.path().join("source/_posts/a.md"), "two").unwrap();
        std::fs::write(dir.path().join("source/_data.yml"), "x").unwrap();

        // Assert
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let change = loop {
            let c = rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())).expect("no change reported");
            if let Some(ch) = c.changes.into_iter().find(|ch| ch.id == "_posts/a.md") {
                break ch;
            }
        };
        assert_eq!(change.fingerprint, Some(fingerprint("two")));
    }
}
