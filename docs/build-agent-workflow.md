# Build progress for coordinators

The DAG defines packages and dependencies. evf v2 (the `evf` in `~/.cargo/bin`) runs the work, and its task records are the live
state. `evf status` and the dashboard at `http://localhost:4384` show them.

`docs/build-progress.json` stopped updating at the evf v2 cutover in November 2026, and nothing writes it now. It stays as
the frozen record of what evf v1 shipped, because the explorer reads it. Do not read it as current state, and do not edit
it to record new work.

Each task runs plan, implement, simplify, the repo's checks, verify, a pull request and landing. The base branch's
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
frozen record, so it does not show work landed since the cutover. Global kickoff and concrete spending approvals remain
separate from milestone readiness. G-WORKFLOW closes when W0 to W5 merge and one task runs end to end through Phase 7.
This document does not claim that closure.

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
