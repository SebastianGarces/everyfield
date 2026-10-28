//! `git worktree list --porcelain`, polled slowly: head SHAs for the detail panel.

use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Worktree {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
}

pub fn parse(text: &str) -> Vec<Worktree> {
    let mut out = Vec::new();
    let mut current: Option<Worktree> = None;
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(w) = current.take() {
                out.push(w);
            }
            current = Some(Worktree {
                path: path.to_string(),
                ..Default::default()
            });
            continue;
        }
        let Some(w) = current.as_mut() else { continue };
        if let Some(head) = line.strip_prefix("HEAD ") {
            w.head = head.to_string();
        } else if let Some(branch) = line.strip_prefix("branch ") {
            w.branch = Some(
                branch
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch)
                    .to_string(),
            );
        }
    }
    if let Some(w) = current {
        out.push(w);
    }
    out
}

/// Lists the worktrees of the repository that owns `git_dir` (the common dir next to the store).
pub fn list(git_dir: &Path) -> Vec<Worktree> {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(git_dir)
        .args(["worktree", "list", "--porcelain"])
        .output();
    match output {
        Ok(o) if o.status.success() => parse(&String::from_utf8_lossy(&o.stdout)),
        _ => Vec::new(),
    }
}

pub fn head_for<'a>(worktrees: &'a [Worktree], path: &str) -> Option<&'a Worktree> {
    let wanted = path.trim_end_matches('/');
    worktrees
        .iter()
        .find(|w| w.path.trim_end_matches('/') == wanted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_blocks() {
        let text = "worktree /Users/s/dev/everyfield_v3\nHEAD c04b820e955f974f035ed5e0d33232c44e4ef520\nbranch refs/heads/main\n\nworktree /private/tmp/x\nHEAD e804f34b850e119bd92dd004874e5fff731670e5\ndetached\nprunable gitdir file points to non-existent location\n\nworktree /Users/s/dev/everyfield_v3/.worktrees/ops-61\nHEAD 9b19c516aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/task/ops-61\n";
        let list = parse(text);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].branch, None);
        let wt = head_for(&list, "/Users/s/dev/everyfield_v3/.worktrees/ops-61/").unwrap();
        assert_eq!(wt.branch.as_deref(), Some("task/ops-61"));
        assert!(wt.head.starts_with("9b19c516"));
    }
}
