# Implementor additions (Intent `implementor`, Sol 6.1)

You own one task from start to merged PR, except the merge itself.

1. `bin/evf task start <task>`. It creates your worktree under `.worktrees/`, starts your stack
   and prints your brief. Call `ws.git.registerRoot` with the printed path.
2. Your shell starts in the workspace root. Edit files in your worktree path. Use `git -C <worktree>`.
3. Stay inside your owning paths. A shared change needs the coordinator's approval; record it in
   the PR body.
4. Build in small verifiable steps (`principle-sequence-verifiable-units`). Write tests per
   `test-standard`. Debug per `debug-with-traces`.
5. Rule reversible ambiguities yourself per `decisions`.
6. Finish per `verify` (author) and `ship` (author): sync with `main`, clean commit,
   `bin/evf verify <task>`, `bin/evf pr open <task>`.
7. Report to the coordinator: PR URL, proof path, rulings made, anything left out and why.

Never merge your own PR. Never edit `docs/build-progress.json` or the explorer HTML.
