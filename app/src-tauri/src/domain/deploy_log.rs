//! Reading Hexo / git output: which lines to highlight, and known failures with what to do.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Info,
    Warn,
    Error,
}

/// How a line is shown. Hexo's logger prefixes `INFO` / `WARN` / `ERROR` / `FATAL`; git and ssh
/// write `error:`, `fatal:`, `! [rejected]` and the like.
pub fn level(line: &str) -> Level {
    let t = line.trim_start();
    let lower = t.to_ascii_lowercase();
    let error_starts = ["error", "fatal", "err!", "! [rejected]", "! [remote rejected]", "remote: error"];
    if error_starts.iter().any(|p| lower.starts_with(p))
        || lower.contains("permission denied")
        || lower.contains("cannot find module")
        || lower.contains("host key verification failed")
    {
        Level::Error
    } else if lower.starts_with("warn") || lower.starts_with("warning") || lower.starts_with("hint:") {
        Level::Warn
    } else {
        Level::Info
    }
}

/// A secret GitHub found in the pushed files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedSecret {
    /// What GitHub took it for, e.g. `Tencent Cloud Secret ID`.
    pub kind: String,
    /// Files and lines, e.g. `js/twikoo.all.min.js:1`.
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum Problem {
    /// GitHub push protection (`GH013`) refused the push: the links let the owner allow each
    /// secret, after which deploying again goes through.
    PushProtection { secrets: Vec<BlockedSecret>, unblock_urls: Vec<String> },
    /// git could not authenticate over SSH.
    SshAuth,
    /// The blog's dependencies are not installed.
    MissingModules,
    /// git has no name / email to commit with (`git config --global user.name ...`).
    GitIdentity,
}

fn remote_text(line: &str) -> &str {
    line.trim().strip_prefix("remote:").unwrap_or(line.trim()).trim()
}

fn push_protection(lines: &[&str]) -> Option<Problem> {
    if !lines.iter().any(|l| l.contains("GH013") || l.contains("PUSH PROTECTION") || l.contains("Push cannot contain secrets")) {
        return None;
    }
    let mut secrets: Vec<BlockedSecret> = Vec::new();
    let mut unblock_urls = Vec::new();
    for line in lines {
        let t = remote_text(line);
        // `—— Tencent Cloud Secret ID ———` heads each secret.
        if t.starts_with('—') {
            let kind = t.trim_matches(|c: char| c == '—' || c.is_whitespace()).to_string();
            if !kind.is_empty() {
                secrets.push(BlockedSecret { kind, paths: Vec::new() });
            }
        } else if let Some(path) = t.strip_prefix("path:") {
            if let Some(s) = secrets.last_mut() {
                s.paths.push(path.trim().to_string());
            }
        } else if t.starts_with("https://") && t.contains("/unblock-secret/") && !unblock_urls.iter().any(|u| u == t) {
            unblock_urls.push(t.to_string());
        }
    }
    Some(Problem::PushProtection { secrets, unblock_urls })
}

/// The known failures found in a run's output, each once.
pub fn diagnose(output: &[String]) -> Vec<Problem> {
    let lines: Vec<&str> = output.iter().map(String::as_str).collect();
    let mut found = Vec::new();
    if let Some(p) = push_protection(&lines) {
        found.push(p);
    }
    let has = |needles: &[&str]| lines.iter().any(|l| needles.iter().any(|n| l.contains(n)));
    if has(&[
        "Permission denied (publickey",
        "Host key verification failed",
        "sign_and_send_pubkey",
        "Could not read from remote repository",
    ]) {
        found.push(Problem::SshAuth);
    }
    if has(&["Cannot find module", "ERR_MODULE_NOT_FOUND"]) {
        found.push(Problem::MissingModules);
    }
    if has(&["unable to auto-detect email address", "Please tell me who you are"]) {
        found.push(Problem::GitIdentity);
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_string).collect()
    }

    /// GitHub's answer when push protection blocks a push, as `hexo deploy` shows it.
    const GH013: &str = "remote: error: GH013: Repository rule violations found for refs/heads/main.
remote:
remote: - GITHUB PUSH PROTECTION
remote:   —————————————————————————————————————————
remote:     Resolve the following violations before pushing again
remote:
remote:     - Push cannot contain secrets
remote:
remote:       —— Tencent Cloud Secret ID ———————————————————————————
remote:        locations:
remote:          - commit: 8d2f1c0
remote:            path: js/twikoo.all.min.js:1
remote:          - commit: 8d2f1c0
remote:            path: js/twikoo.min.js:1
remote:
remote:        (?) To push, remove secret from commit(s) or follow this URL to allow the secret.
remote:        https://github.com/EverettRain/EverettRain.github.io/security/secret-scanning/unblock-secret/2pXyZ
remote:
remote:       —— Tencent Cloud Secret Key ——————————————————————————
remote:        locations:
remote:          - commit: 8d2f1c0
remote:            path: js/twikoo.all.min.js:1
remote:
remote:        (?) To push, remove secret from commit(s) or follow this URL to allow the secret.
remote:        https://github.com/EverettRain/EverettRain.github.io/security/secret-scanning/unblock-secret/2pAbC
remote:        https://github.com/EverettRain/EverettRain.github.io/security/secret-scanning/unblock-secret/2pXyZ
To github.com:EverettRain/EverettRain.github.io.git
 ! [remote rejected] HEAD -> main (push declined due to repository rule violations)
error: failed to push some refs to 'github.com:EverettRain/EverettRain.github.io.git'";

    #[test]
    fn push_protection_gives_each_secret_its_files_and_every_unblock_link_once() {
        // Act
        let found = diagnose(&lines(GH013));

        // Assert
        assert_eq!(
            found,
            vec![Problem::PushProtection {
                secrets: vec![
                    BlockedSecret {
                        kind: "Tencent Cloud Secret ID".into(),
                        paths: vec!["js/twikoo.all.min.js:1".into(), "js/twikoo.min.js:1".into()]
                    },
                    BlockedSecret { kind: "Tencent Cloud Secret Key".into(), paths: vec!["js/twikoo.all.min.js:1".into()] },
                ],
                unblock_urls: vec![
                    "https://github.com/EverettRain/EverettRain.github.io/security/secret-scanning/unblock-secret/2pXyZ".into(),
                    "https://github.com/EverettRain/EverettRain.github.io/security/secret-scanning/unblock-secret/2pAbC".into(),
                ],
            }]
        );
    }

    #[test]
    fn push_protection_without_details_is_still_recognised() {
        // Act
        let found = diagnose(&lines("remote: error: GH013: Repository rule violations found for refs/heads/main."));

        // Assert
        assert_eq!(found, vec![Problem::PushProtection { secrets: vec![], unblock_urls: vec![] }]);
    }

    #[test]
    fn ssh_failures_are_recognised() {
        // Arrange
        let outputs = [
            "git@github.com: Permission denied (publickey).",
            "Host key verification failed.",
            "fatal: Could not read from remote repository.",
            "sign_and_send_pubkey: signing failed for ED25519 \"/Users/x/.ssh/id_ed25519\" from agent: agent refused operation",
        ];

        for out in outputs {
            // Act
            let found = diagnose(&lines(out));

            // Assert
            assert_eq!(found, vec![Problem::SshAuth], "{out}");
        }
    }

    #[test]
    fn missing_dependencies_are_recognised() {
        // Act
        let found = diagnose(&lines("Error: Cannot find module 'hexo-deployer-git'\nRequire stack:"));

        // Assert
        assert_eq!(found, vec![Problem::MissingModules]);
    }

    #[test]
    fn a_missing_git_identity_is_recognised() {
        // Act
        let found = diagnose(&lines("*** Please tell me who you are.\nfatal: unable to auto-detect email address (got 'me@mac.(none)')"));

        // Assert
        assert_eq!(found, vec![Problem::GitIdentity]);
    }

    #[test]
    fn a_clean_run_has_no_problems() {
        // Act
        let found = diagnose(&lines("INFO  Validating config\nINFO  Deploy done: git"));

        // Assert
        assert!(found.is_empty());
    }

    #[test]
    fn problems_reach_the_interface_in_camel_case() {
        // Arrange
        let p = Problem::PushProtection { secrets: vec![], unblock_urls: vec!["u".into()] };

        // Act
        let json = serde_json::to_string(&p).unwrap();

        // Assert
        assert_eq!(json, r#"{"kind":"pushProtection","secrets":[],"unblockUrls":["u"]}"#);
    }

    #[test]
    fn line_levels_follow_hexo_and_git_prefixes() {
        // Act / Assert
        assert_eq!(level("INFO  Start processing"), Level::Info);
        assert_eq!(level("WARN  No layout: index.html"), Level::Warn);
        assert_eq!(level("hint: Updates were rejected"), Level::Warn);
        assert_eq!(level("ERROR Render error"), Level::Error);
        assert_eq!(level("FATAL Something's wrong."), Level::Error);
        assert_eq!(level("error: failed to push some refs"), Level::Error);
        assert_eq!(level(" ! [remote rejected] HEAD -> main"), Level::Error);
        assert_eq!(level("remote: error: GH013: Repository rule violations"), Level::Error);
        assert_eq!(level("git@github.com: Permission denied (publickey)."), Level::Error);
        assert_eq!(level("To github.com:a/b.git"), Level::Info);
    }
}
