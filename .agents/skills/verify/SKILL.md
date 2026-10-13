---
name: verify
description: "Apply before you claim a task works, and when you verify another agent's task. Run `evf verify` against the running stack at a clean commit that includes the latest main. Assert each acceptance criterion; screenshots and a 200 are not a pass."
---

# Verify

`evf verify <task>` is the only proof that counts. It runs the checks in `evf.config.json`
against the task worktree and writes `proof.json` plus logs and artifacts to the evidence
directory it prints. A proof can ship only when it passed, the worktree was clean, and HEAD
included the latest `main`.

## As the author (implementor or ui-designer)

1. Sync first: `git -C <worktree> fetch origin && git -C <worktree> merge origin/main`
   (or rebase if the branch is not pushed yet).
2. Iterate with `evf verify <task>` while you work. A dirty proof is fine for feedback; it
   cannot ship.
3. Make the acceptance tests real: one per criterion ID, each with an assertion on actual state
   (DOM, response body, database row). Follow `test-standard`.
4. For UI, also look at the running preview in Intent's browser (`ws.browser`): drive the flow,
   read the console, check the accessibility tree. Fix what you see, not only what fails.
5. Commit, run `evf verify <task>` on the clean commit, then `evf pr open <task>`.

## As the verifier

You start without the author's context. Do not read the author's summary or chat. Read the
task brief, the PR diff and the acceptance criteria.

1. `evf task start <task> --no-stack` reuses the author's worktree, or check out the PR branch
   there. Then `evf stack up <task>` for a fresh stack.
2. `evf verify <task> --role verifier`. Your proof must pass on its own.
3. Read the diff against the criteria. Look for criteria that have no real assertion, tests
   that assert nothing, and changes outside the owning paths.
4. Exercise one or two criteria by hand in the browser or with a real request. Try one denied
   case the tests do not cover.
5. Pass: run `evf ship <task>`. Fail: comment the failing criterion IDs and the evidence path on
   the PR (`gh pr comment`), and report to the coordinator. Never fix the code yourself.

## Evidence rules

- Thin evidence is a fail. "Looks right" is not a result.
- Any console error on a touched page fails the check unless the task explains it.
- Keep screenshots and traces in the evidence directory, not in the repository.
