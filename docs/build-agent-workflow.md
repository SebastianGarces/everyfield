# Build progress for coordinators

The DAG defines packages and dependencies. evf v2 (the `evf` in `~/.cargo/bin`) runs the work, and its task records are the live
state. `evf status` and the dashboard at `http://localhost:4384` show them.

`docs/build-progress.json` froze on 2026-10-22 at PR #235, and nothing writes it now. T-290 refreshed WP-017–039, WP-071
and WP-072 by hand on 2026-11-13; other packages stay as of 2026-10-22. It stays because the explorer reads it. Do not read
it as current state, and do not edit it to record new work.

Each task runs these steps in order: plan, implement, simplify, the repo's checks, the pull request (evf pushes the branch
and opens or updates the PR), review, required GitHub CI, the owner gate where a path in an owner class applies, and
landing. The base branch's
`evf.toml` sets the roles, each role's prompt file and the owner classes. The implementer proves its own work: tests,
390 and 1440 px screenshots of each UI state it changed, and `evf proof add <n> --status met --evidence <path>` per
`verifier` criterion. The verifier is a fresh session that did not write the change. It reads the full diff, spot-checks
the proof and records its verdict with `evf review submit`.

evf lands a task when required GitHub CI is green on the exact head and the verifier approved it. A task that touches a
path in an owner class also waits for Sebastian: on the dashboard with Touch ID, or relayed in Sebastian's exact words
with `evf decide --relay-by`. The classes are `document-templates`, `landing-marketing`, `wiki`, `brand-prototype` and
`workflow-gates`.

Split packages ship an api part, then a ui part. The api part builds the package's contract first. The merged api part
unlocks dependents and the ui part, and it leaves the package in progress. Feedback and maintenance do not complete
build packages. Use a task's `--depends-on` to keep that order, because a task's dependencies are set when it is filed.

Full-target WP-056/WP-057 integration verifies every closing package's behavior and gates. Its verifier's report must
explain full coverage and name the packages it closes. A package closes only after every part is reviewed and merged,
direct prerequisites are done and owned acceptance cases and case actions pass their checks. File presence or
successful scaffold checks never establish application acceptance.

WP-097 keeps the owner's 2026-10-14 fast-track history in the frozen record, with its commit, checks, independent review
and owner go-live references. Preserve that evidence.

Keep media and traces outside the repository. Generate the explorer outside the checkout; it is a read-only view of the
frozen record, so it does not show work landed after 2026-10-22. Global kickoff and concrete spending approvals remain
separate from milestone readiness. G-WORKFLOW is the evf v2 workflow gate, and its record in
[`docs/plan/release-gates.json`](plan/release-gates.json) defines its closure. This document does not claim that closure.

## Changes to evf itself

File a change to evf as a task in the evf-v2 project (`~/dev/evf-v2`), not in this repo. That project uses the local
forge with base `main`, so a landed evf task moves evf-v2's `main`. Once `main` moves, evf installs itself. It builds
that commit, backs up `~/.cargo/bin/evf`, swaps the new binary in, restarts every evf service, including this repo's
`:4384`, and checks that each one is healthy on the new commit. If any step fails, it puts the old binary back. Nobody
runs an install step by hand. `evf --version` names the commit the binary in use was built from. A failed install shows
a notice on the dashboard. `~/dev/evf-v2/README.md` ("Self-install") gives the backups, the logs and the way to turn it
off.

Coming with evf-v2 branch `evf/t94-carry-proof` (`050dc0a`, T-94), and not in the evf in use until evf-v2 task T-1 lands
it on evf-v2 `main` and self-install deploys it: a merge or rebase of main that leaves a task's own lines alone keeps its
proofs and the owner's approval, even when main edited a line next to the task's hunk and the change id moved (T-79 lost
26 proofs that way). Checks and the review still run again. Any edit to the task's own lines voids both. `DESIGN.md`
("A carry") on that branch gives the rule. Self-install is the deploy. Nobody swaps the binary by hand.

## Tools that moved

| Need | Use |
|---|---|
| Browser runs, local preview stack, preview logs | `bin/dev` (`scripts/dev.ts`) |
| Nora's QA previews | `bin/qa` (`docs/runbooks/qa-preview.md`) |
| Wiki claim check and promotion | `bin/wiki` (`tools/wiki/README.md`) |
| Every integration test runs in CI | `node tools/ci/ci-tests.ts` |

Not ported from evf v1, and recoverable on demand from history at `19c1b540` (`git ls-tree -r 19c1b540 tools/evf`): answer
key runs, the quiet timing runner, escape, audit, public feedback, the principle updater, the migration helpers, plan,
shipped and pre-push.
