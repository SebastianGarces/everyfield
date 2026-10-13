---
name: ship
description: "Apply when a task is ready to merge. The author opens the PR with `evf pr open`; only the cross-model verifier merges with `evf ship`. No human review; the evf/verify status on the exact head commit is the merge bar."
---

# Ship

Every task ships as one PR, squash-merged into `main`. The PR is a record, not a review gate.

- **Author:** `evf pr open <task>` needs a passing, clean author proof for HEAD. It pushes the
  branch, opens or updates the PR with the proof table, and sets `evf/verify` to pending. Edit
  the PR body section "Rulings and shared changes" before you hand off.
- **Verifier:** `evf ship <task>` needs your passing verifier proof. It reports `evf/verify`
  success on the head commit and squash-merges. If GitHub says the branch is behind `main`, it
  updates the branch, runs the quick check as verifier and tries again. A failed quick check
  sets `evf/verify` to failure and stops.
- After the merge, `evf ship` saves a progress record (`evf shipped`), stops the stack and
  removes the task worktree. Call `ws.git.unregisterRoot` with the printed path.

Rules:

- Never merge your own work. Never push to `main` directly. Never force-push.
- Fixes after a failed verification go on the same branch and PR.
- Unfinished features merge dark behind a flag in the typed flag registry. The task that turns
  the feature on removes the flag.
