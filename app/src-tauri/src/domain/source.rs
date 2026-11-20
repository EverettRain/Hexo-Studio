//! The blog's source repository as the source page shows it: what `git status` and `git log`
//! print, read into plain values.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    /// Both sides changed the file and git could not merge it.
    Conflicted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// Where a renamed file came from.
    pub from: Option<String>,
    pub kind: ChangeKind,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    /// The upstream branch was deleted on the remote, or never fetched.
    pub upstream_gone: bool,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<Change>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    /// Unix seconds.
    pub time: i64,
}

fn kind_of(x: char, y: char) -> ChangeKind {
    match (x, y) {
        ('?', _) => ChangeKind::Untracked,
        ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => ChangeKind::Conflicted,
        _ if x == 'R' || x == 'C' || y == 'R' || y == 'C' => ChangeKind::Renamed,
        _ if x == 'D' || y == 'D' => ChangeKind::Deleted,
        _ if x == 'A' => ChangeKind::Added,
        _ => ChangeKind::Modified,
    }
}

/// `## main...origin/main [ahead 1, behind 2]`, `## main`, `## No commits yet on main`,
/// `## HEAD (no branch)`.
fn parse_branch_line(line: &str, status: &mut Status) {
    let rest = line.trim_start_matches("## ");
    if let Some(name) = rest.strip_prefix("No commits yet on ").or_else(|| rest.strip_prefix("Initial commit on ")) {
        status.branch = Some(name.to_string());
        return;
    }
    if rest.starts_with("HEAD (no branch)") {
        return;
    }
    let (names, tracking) = match rest.split_once(" [") {
        Some((n, t)) => (n, Some(t.trim_end_matches(']'))),
        None => (rest, None),
    };
    match names.split_once("...") {
        Some((branch, upstream)) => {
            status.branch = Some(branch.to_string());
            status.upstream = Some(upstream.to_string());
        }
        None => status.branch = Some(names.to_string()),
    }
    for part in tracking.unwrap_or("").split(", ") {
        if part == "gone" {
            status.upstream_gone = true;
        } else if let Some(n) = part.strip_prefix("ahead ") {
            status.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            status.behind = n.parse().unwrap_or(0);
        }
    }
}

/// Reads `git status --porcelain=v1 -b -z`. Entries are NUL-separated, so paths with spaces or
/// non-ASCII characters arrive unquoted; a rename is followed by one more entry, its old path.
pub fn parse_status(output: &str) -> Status {
    let mut status = Status::default();
    let mut entries = output.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if entry.starts_with("## ") {
            parse_branch_line(entry, &mut status);
            continue;
        }
        let mut chars = entry.chars();
        let (Some(x), Some(y)) = (chars.next(), chars.next()) else { continue };
        let path = entry.get(3..).unwrap_or_default().to_string();
        let kind = kind_of(x, y);
        let from = if kind == ChangeKind::Renamed && (x == 'R' || x == 'C') { entries.next().map(str::to_string) } else { None };
        status.changes.push(Change { path, from, kind });
    }
    status
}

/// Reads `git log --format=%H%x1f%an%x1f%ct%x1f%s`.
pub fn parse_log(output: &str) -> Vec<Commit> {
    output
        .lines()
        .filter_map(|line| {
            let mut f = line.split('\u{1f}');
            let (hash, author, time, subject) = (f.next()?, f.next()?, f.next()?, f.next()?);
            Some(Commit { hash: hash.to_string(), author: author.to_string(), time: time.parse().ok()?, subject: subject.to_string() })
        })
        .collect()
}

/// One file of a commit, with its line counts (`None` for a binary file).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub from: Option<String>,
    pub kind: ChangeKind,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    #[serde(flatten)]
    pub commit: Commit,
    pub email: String,
    /// The message after its title line, without the blank line between them.
    pub body: String,
    pub files: Vec<FileChange>,
}

/// Format for `git show -s`: the fields `parse_commit_detail` reads. The body comes last, so
/// newlines inside it cannot be mistaken for a separator.
pub const DETAIL_FORMAT: &str = "--format=%H%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%b";

/// `git show --name-status -z`: `M\0path\0`, a rename or copy `R100\0old\0new\0`.
fn parse_name_status(output: &str) -> Vec<(ChangeKind, String, Option<String>)> {
    let mut parts = output.split('\0').filter(|p| !p.is_empty());
    let mut files = Vec::new();
    while let Some(code) = parts.next() {
        let letter = code.chars().next().unwrap_or('M');
        if letter == 'R' || letter == 'C' {
            let (Some(from), Some(to)) = (parts.next(), parts.next()) else { break };
            let kind = if letter == 'R' { ChangeKind::Renamed } else { ChangeKind::Added };
            files.push((kind, to.to_string(), Some(from.to_string())));
        } else {
            let Some(path) = parts.next() else { break };
            let kind = match letter {
                'A' => ChangeKind::Added,
                'D' => ChangeKind::Deleted,
                'U' => ChangeKind::Conflicted,
                _ => ChangeKind::Modified,
            };
            files.push((kind, path.to_string(), None));
        }
    }
    files
}

/// `git show --numstat -z`: `12\t3\tpath\0`, a rename `1\t0\t\0old\0new\0`, `-\t-\t` for binary.
fn parse_numstat(output: &str) -> std::collections::HashMap<String, (Option<u32>, Option<u32>)> {
    let mut counts = std::collections::HashMap::new();
    let mut parts = output.split('\0').filter(|p| !p.is_empty());
    while let Some(entry) = parts.next() {
        let mut f = entry.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (f.next(), f.next(), f.next()) else { continue };
        let path = if path.is_empty() {
            let (_old, Some(new)) = (parts.next(), parts.next()) else { break };
            new
        } else {
            path
        };
        counts.insert(path.to_string(), (added.parse().ok(), removed.parse().ok()));
    }
    counts
}

/// A commit from the three outputs `infra::git::commit_detail` collects.
pub fn parse_commit_detail(header: &str, name_status: &str, numstat: &str) -> Option<CommitDetail> {
    let mut f = header.splitn(6, '\u{1f}');
    let (hash, author, email, time, subject, body) = (f.next()?, f.next()?, f.next()?, f.next()?, f.next()?, f.next().unwrap_or(""));
    let counts = parse_numstat(numstat);
    let files = parse_name_status(name_status)
        .into_iter()
        .map(|(kind, path, from)| {
            let (added, removed) = counts.get(&path).copied().unwrap_or((None, None));
            FileChange { path, from, kind, added, removed }
        })
        .collect();
    Some(CommitDetail {
        commit: Commit { hash: hash.to_string(), subject: subject.to_string(), author: author.to_string(), time: time.parse().ok()? },
        email: email.to_string(),
        body: body.trim().to_string(),
        files,
    })
}

/// What a failed git command means for the person using the source page; unknown failures show
/// git's own message.
pub fn explain_failure(stderr: &str) -> String {
    let text = stderr.trim();
    if text.contains("Please tell me who you are") || text.contains("unable to auto-detect email address") {
        "git 没有设置提交者。在终端执行 git config --global user.name \"你的名字\" 和 git config --global user.email \"你的邮箱\" 后再试。".into()
    } else if text.contains("GH013") {
        format!("GitHub 推送保护（GH013）拦下了这次推送，里面可能有疑似密钥的内容。GitHub 的说明：\n{text}")
    } else if text.contains("non-fast-forward") || text.contains("fetch first") || text.contains("Not possible to fast-forward") || text.contains("diverging branches") {
        "远程有本地还没有的提交，或两边各自有新提交。先拉取（只接受快进）；两边都有新提交时需要在终端里合并。".into()
    } else if text.contains("Permission denied (publickey)") || text.contains("Could not read from remote repository") {
        format!("无法通过 SSH 登录远程仓库。在终端执行 ssh -T git@github.com 看能否登录；密钥有口令时先用 ssh-add --apple-use-keychain 存进钥匙串。\n{text}")
    } else if text.contains("Repository not found") || text.contains("Authentication failed") {
        format!("远程仓库不存在，或没有访问权限。\n{text}")
    } else if text.is_empty() {
        "git 没有给出错误信息。".into()
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_commit_detail_joins_status_and_line_counts_by_path() {
        // Arrange
        let header = "abc\u{1f}Extra.#Flame\u{1f}e@x.com\u{1f}1763400000\u{1f}标题\u{1f}第一段\n\n第二段\n";
        let status = "M\0a.md\0A\0新 文件.md\0R100\0old.md\0new.md\0D\0gone.png\0";
        let numstat = "3\t1\ta.md\0-\t-\t新 文件.md\0\0";
        let numstat = format!("{numstat}0\t0\t\0old.md\0new.md\0");

        // Act
        let d = parse_commit_detail(header, status, &numstat).unwrap();

        // Assert
        assert_eq!((d.commit.subject.as_str(), d.body.as_str(), d.email.as_str()), ("标题", "第一段\n\n第二段", "e@x.com"));
        let files: Vec<_> = d.files.iter().map(|f| (f.path.as_str(), f.kind, f.added, f.removed)).collect();
        assert_eq!(
            files,
            vec![
                ("a.md", ChangeKind::Modified, Some(3), Some(1)),
                ("新 文件.md", ChangeKind::Added, None, None),
                ("new.md", ChangeKind::Renamed, Some(0), Some(0)),
                ("gone.png", ChangeKind::Deleted, None, None),
            ]
        );
        assert_eq!(d.files[2].from.as_deref(), Some("old.md"));
    }

    #[test]
    fn a_commit_without_a_body_has_an_empty_one() {
        // Act
        let d = parse_commit_detail("abc\u{1f}n\u{1f}e\u{1f}5\u{1f}只有标题\u{1f}", "", "").unwrap();

        // Assert
        assert_eq!((d.body.as_str(), d.files.len()), ("", 0));
    }

    #[test]
    fn explains_the_failures_people_actually_hit() {
        // Act / Assert
        assert!(explain_failure("fatal: unable to auto-detect email address (got 'x@y.(none)')").contains("git config --global user.email"));
        assert!(explain_failure(" ! [rejected]        main -> main (non-fast-forward)").contains("先拉取"));
        assert!(explain_failure("git@github.com: Permission denied (publickey).").contains("ssh -T"));
        assert!(explain_failure("remote: error: GH013: Repository rule violations found").contains("GH013"));
        assert_eq!(explain_failure("fatal: something new\n"), "fatal: something new");
    }

    #[test]
    fn reads_branch_tracking_and_changes() {
        // Arrange
        let out = "## main...origin/main [ahead 2, behind 1]\0 M source/_posts/a.md\0?? .hexostudio/\0A  b.md\0 D c.md\0";

        // Act
        let s = parse_status(out);

        // Assert
        assert_eq!((s.branch.as_deref(), s.upstream.as_deref(), s.ahead, s.behind), (Some("main"), Some("origin/main"), 2, 1));
        let kinds: Vec<_> = s.changes.iter().map(|c| (c.path.as_str(), c.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                ("source/_posts/a.md", ChangeKind::Modified),
                (".hexostudio/", ChangeKind::Untracked),
                ("b.md", ChangeKind::Added),
                ("c.md", ChangeKind::Deleted),
            ]
        );
    }

    #[test]
    fn a_rename_takes_its_old_path_from_the_next_entry() {
        // Arrange
        let out = "## main\0R  new name.md\0old name.md\0 M other.md\0";

        // Act
        let s = parse_status(out);

        // Assert
        assert_eq!(s.changes.len(), 2);
        assert_eq!(s.changes[0], Change { path: "new name.md".into(), from: Some("old name.md".into()), kind: ChangeKind::Renamed });
        assert_eq!(s.changes[1].path, "other.md");
    }

    #[test]
    fn unicode_paths_arrive_unquoted() {
        // Arrange
        let out = "## main\0 M source/_posts/搭建Hexo博客网站教程.md\0";

        // Act
        let s = parse_status(out);

        // Assert
        assert_eq!(s.changes[0].path, "source/_posts/搭建Hexo博客网站教程.md");
    }

    #[test]
    fn a_branch_without_upstream_or_commits_has_no_tracking() {
        // Act
        let plain = parse_status("## feature\0");
        let fresh = parse_status("## No commits yet on main\0?? a\0");

        // Assert
        assert_eq!((plain.branch.as_deref(), plain.upstream, plain.ahead), (Some("feature"), None, 0));
        assert_eq!(fresh.branch.as_deref(), Some("main"));
        assert_eq!(fresh.changes.len(), 1);
    }

    #[test]
    fn a_deleted_upstream_is_flagged() {
        // Act
        let s = parse_status("## main...origin/main [gone]\0");

        // Assert
        assert!(s.upstream_gone);
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[test]
    fn a_detached_head_has_no_branch() {
        // Act
        let s = parse_status("## HEAD (no branch)\0");

        // Assert
        assert_eq!(s.branch, None);
    }

    #[test]
    fn unmerged_files_are_conflicts() {
        // Act
        let s = parse_status("## main\0UU a.md\0AA b.md\0DD c.md\0");

        // Assert
        assert!(s.changes.iter().all(|c| c.kind == ChangeKind::Conflicted));
    }

    #[test]
    fn reads_log_lines_and_skips_malformed_ones() {
        // Arrange
        let out = "abc123\u{1f}Extra.#Flame\u{1f}1763400000\u{1f}图片接管完成\nbroken line\n";

        // Act
        let log = parse_log(out);

        // Assert
        assert_eq!(log, vec![Commit { hash: "abc123".into(), author: "Extra.#Flame".into(), time: 1763400000, subject: "图片接管完成".into() }]);
    }
}
