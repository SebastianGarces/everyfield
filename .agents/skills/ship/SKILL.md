---
name: ship
description: Open or merge a Phase 7 PR with exact-head CI, independent verification and the PR standard.
---

# Ship

Authors commit in their task worktree, include current main, run checks and open a PR for Sebastian.
Use the PR standard skill and template, then `evf pr open <task> --body-file <file>`. Record one
`EVF-Author: {"session":"<your Claude Code session UUID>","model":"<model id>","role":"<seat role>"}`
line in the body. Never merge your own work, push to main or force-push.

An independent verifier, a fresh Opus 5.5 medium session that never shared context with the author,
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
`body_only` (OPS-113) approves the code and the experience and adds a `"body"` list of exact-text items, each
`{"present": "<text>", "why": "<reason>"}` or `{"absent": "<text>", "why": "<reason>"}`. Use it only when every
open finding is a PR body fix that can be checked that way. evf's body stage fixes the body at the same head with
no round and no new verify, and ship accepts the review as the code approval only when its quality and experience
verdicts are approved and the current GitHub body meets every item; it names the first unmet item otherwise. The
body must not change during the merge checks. A `body_only` review carries over merge-only commits like
`approved` (EVF-Carry), and the items are checked on the merged head's body; a code commit needs a new verify.
A failed verify at a head already reviewed costs no round. `tools/evf/README.md` lists decisions D-a to D-e.

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
`mergePolicy.documentTemplates` in `evf.config.json` (the built-in default in `tools/evf/policy.ts` applies when the key is absent). `evf ship` verifies it, posts the verified
status, prints the `evf approve` command and exits 0 without merging. After he approves in chat,
`evf approve <PR> --owner-approval "<his words>"` merges the exact head once an independent review
and the verified status hold. A held PR behind main first takes a clean merge of main with no path overlap, which his
words cover (OPS-146); an overlap, a conflict or a red main refuses. It then writes the shipped record and unlocks dependents as `evf ship` does.
Landing and marketing PRs (OPS-111) join the same wait in their own owner-path class: the exact-head diff touches a
path in `mergePolicy.ownerPaths` (built-in default in `tools/evf/policy.ts`: the landing page, the access, oversight, privacy and terms pages,
`apps/web/src/marketing/` and `apps/web/src/styles/marketing.css`). It is classified like the document-template
class, from the base branch's config, and doubt holds the PR. `evf ship` posts the verified status, names up to five
matched paths and prints `bin/evf approve <PR> --owner-approval "<his words>" --head <sha>`; approve refuses
without `--head`. A PR in both classes is held once, and the message names both.
All merges go through one function (`mergePullRequest`, `tools/evf/merge.ts`). On the exact head it merges, it
holds a document-template or owner-path class PR without his recorded approval, and treats any doubt about a class
as the class. It refuses to merge from evf code that differs from the base branch or has uncommitted changes: update
the home checkout to current main and rerun. `evf ship` and `evf drive` make the same stale-code check at their
start, so a stale ship posts no status, updates no branch and merges nothing, and a stale drive launches no seat.
During a drive, its ship stage runs on current base code, so a long drive never merges on old rules.
Sebastian can also approve an ordinary-route PR (one that `evf ship` merges by itself) for one head (OPS-121).
After his OK in chat, run `bin/evf approve <PR> --owner-approval "<his words>" --head <current head>`. It posts
an `EVF-Owner:` line (`{"head":"<40 hex>","quote":"<his words>","at":"<ISO time>"}`) and an `approvals` row (gate
`owner`), then merges through `evf ship` when the verifier approval and required CI hold. From then on every merge
needs a head that the latest `EVF-Owner` line covers: the approved head, or a head that the `EVF-Carry` rule
(`carryProof`) reaches from it. Only a clean merge of main on paths the PR does not change keeps his approval. Any
other commit voids it, and ship, approve and the drive refuse with "Sebastian's owner approval is void". The
refusal names the approved head, the carry reason, each later commit (short SHA and subject, oldest first) and the
`evf approve ... --head <current head>` command. Ask him again; never re-record his old words for a new head.
The drive's ci stage is green only when every required check passed on the exact PR head, the rule ship uses.
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
