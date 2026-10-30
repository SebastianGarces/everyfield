---
name: ship
description: Open or merge a Phase 7 PR with exact-head CI, independent verification and the PR standard.
---

# Ship

Authors commit in their task worktree, include current main, run checks and open a PR for Sebastian.
Use the PR standard skill and template, then `evf pr open <task> --body-file <file>`. Record one
`EVF-Author: {"session":"<your Claude Code session UUID>","model":"<model id>","role":"<seat role>"}`
line in the body. Never merge your own work, push to main or force-push.

An independent verifier, a fresh Opus 5.5 high session that never shared context with the author,
exercises the branch's own portless preview and dev database. Tooling tasks need tooling checks, not application screenshots. Record actual scope,
results and external evidence on the PR, followed by this exact line with the full tested SHA:

```text
EVF-Review: {"head":"<40-character SHA>","verifier":{"session":"<verifier session UUID>","model":"claude-opus-5-5","role":"verifier"},"verdict":"approved","quality":{"verdict":"approved","principles":["laziness-protocol","minimize-reader-load","subtract-before-you-add","test-behavior-not-implementation"]}}
```

Every review comment needs a "Code quality" section naming concrete simplifications, or explaining
why none are needed. Its quality field names the principles checked, including the four shown above.
Ship refuses missing or unapproved quality and incomplete principle lists.

Independent review (D82) means: the verifier's session id differs from the author's, the review comes
from the `verifier` seat, and the verifier model is Opus (`claude-opus-*`). Ship refuses anything else
and keeps `verification.checkedAt`. Milestones stored before D82 keep the model-family rule that shipped
them. Comments are deliberate because agents share the owner's
GitHub account. These records are unsigned coordination evidence, not authenticated identities.
Use `changes_requested` instead of `approved` when verification fails. The latest record for that
head wins. A changed head needs new CI and real verification.

`evf ship <task>` requires every required GitHub check to pass on the exact PR head, an allowed
family's approval of that head and a body passing the PR standard. Missing checks refuse.
The verifier or coordinator runs it; it squash-merges with `--match-head-commit`. Never arm
GitHub auto-merge. A branch update requires fresh CI and review, except a merge-only head: when
every commit after the approved head is a clean merge of main and main changed no path the PR
changes, ship carries the approval once required CI is green on the new head and posts the proof
(`EVF-Carry:`). `tools/evf/README.md` lists the exact rule. Ship refuses anything else.
Run `evf ship` as soon as a PR is approved; do not order ships by hand or wait for another ship.
Ship waits in a machine-wide queue, merges main into a behind branch with `gh pr update-branch`,
waits for required CI on the new head and carries the approval. When main changed the PR's paths
or CI fails, it refuses with "Fresh gate needed" and the branch needs a new review.
While main's latest finished CI run is red, ship merges only the PR whose body says `Fixes #<n>`
for the open "P0: CI failed on main" issue.
Ordinary builds and P0/P1 feedback fixes use this route. P2/P3 feedback fixes get the same checks,
then wait for Sebastian's chat approval and `evf approve`. Prototypes and Wiki article PRs also
require his chat approval and `evf approve`; Wiki uses its own Opus review. Design-only PRs use
an OPS task with `"route": "design"`: `evf ship` stops after the verifier, then he approves.
Document-template PRs join the same wait. A WP part, an OPS task without the design route or a P0/P1
fix joins the class when its exact-head diff (merge base to head, all commits) touches a path in
`mergePolicy.documentTemplates` in `evf.config.json`. `evf ship` verifies it, posts the verified
status, prints the `evf approve` command and exits 0 without merging. After he approves in chat,
`evf approve <PR> --owner-approval "<his words>"` merges the exact head once an independent review
and the verified status hold. It then writes the shipped record and unlocks dependents as `evf ship` does.
Preserve these PR #13 routes; they never carry an approval. Sensitive work and paid commitments still need their scoped owner approvals.

Only evf writes canonical progress. Ship retains the CI and review references, exact head and
merge commit. Ship acknowledges milestones that pass the reviewed-milestone checks; the coordinator clears the rest with `evf shipped --clear <task>`.
A merged producer or part unlocks dependents after acknowledgement. Full package closure stays
with integration, whose verifier names fully exercised packages in `packageClosures` on the review.

WP-097 retains the owner's 2026-10-14 fast-track history. Its imported evidence has `commit`,
passing `checks: [{command, result: "passed", evidence}]`, `author: {actor, model_family}`,
`verifier: {actor, model_family, verdict: "approved", commit, evidence}` and
`owner_go_live: {actor: "Sebastian", commit, evidence}`. The commit must be on main.
`evf shipped --fast-track WP-097 --evidence <file>` records only that package. Preserve its
actual logs, independent review and owner go-live references when transferring progress.
