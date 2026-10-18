---
name: ship
description: Open or merge a Phase 7 PR with exact-head CI, different-model verification and the PR standard.
---

# Ship

Authors commit in their task worktree, include current main, run checks and open a PR for Sebastian.
Use the PR standard skill and template, then `evf pr open <task> --body-file <file>`. Record one `EVF-Author: openai` or `anthropic`
line in the body, based on the actual author model family. Never merge your own work, push to
main or force-push.

A different-model verifier independently exercises the branch's own portless preview and dev
database. Tooling tasks need tooling checks, not application screenshots. Record actual scope,
results and external evidence on the PR, followed by this exact line with the full tested SHA:

```text
EVF-Review: {"head":"<40-character SHA>","verifierFamily":"anthropic","verdict":"approved"}
```

Use the verifier's actual family. Comments are deliberate because agents share the owner's
GitHub account. These records are unsigned coordination evidence, not authenticated identities.
Use `changes_requested` instead of `approved` when verification fails. The latest record for that
head wins. A changed head needs new CI and real verification.

`evf ship <task>` requires every required GitHub check to pass on the exact PR head, a different
family's approval of that head and a body passing the PR standard. Missing checks refuse.
The verifier or coordinator runs it; it squash-merges with `--match-head-commit`. Never arm
GitHub auto-merge. A branch update requires fresh CI and review.
Ordinary builds and P0/P1 feedback fixes use this route. P2/P3 feedback fixes get the same checks,
then wait for Sebastian's chat approval and `evf approve`. Prototypes and Wiki article PRs also
require his chat approval and `evf approve`; Wiki uses its own Opus review. Preserve these PR #13
routes. Sensitive work and paid commitments still need their scoped owner approvals.

Only evf writes canonical progress. Ship retains the CI and review references, exact head and
merge commit. The coordinator acknowledges milestones with `evf shipped --clear <task>`.
A merged producer or part unlocks dependents after acknowledgement. Full package closure stays
with integration, whose verifier names fully exercised packages in `packageClosures` on the review.

WP-097 retains the owner's 2026-10-14 fast-track history. Its imported evidence has `commit`,
passing `checks: [{command, result: "passed", evidence}]`, `author: {actor, model_family}`,
`verifier: {actor, model_family, verdict: "approved", commit, evidence}` and
`owner_go_live: {actor: "Sebastian", commit, evidence}`. The commit must be on main.
`evf shipped --fast-track WP-097 --evidence <file>` records only that package. Preserve its
actual logs, independent review and owner go-live references when transferring progress.
