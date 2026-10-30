# Build progress for coordinators

The DAG defines packages and dependencies. Only evf writes `docs/build-progress.json`.
Task notes hold progress and blockers. Owners never submit manual progress patches.

1. Ship acknowledges every milestone that passes the reviewed-milestone checks. Review
   `bin/evf shipped` for records ship left unacknowledged: the merge commit, exact tested head, required CI and verifier report.
2. Acknowledge those with `bin/evf shipped --clear <task>`. Records remain outside the checkout.
   Exact replays do not advance revisions. Acknowledged producer/interface milestones unlock
   dependents, even before the generated progress projection merges.
3. The home checkout owns the ledger. Only OPS-7 commits it; plan and tooling PRs never do.
   After a plan PR merges, fast-forward the home checkout and reconcile there.
   Copy the home ledger byte for byte into one OPS-7 worktree per round. Use normal CI and review.
4. Main only receives home bytes, so the home ledger is never older than main's. To fast-forward
   past a transfer, copy the home ledger aside, restore the committed file, pull and copy it back.

Split packages ship an api part, then a ui part. The api part builds the package's contract first.
The merged api part unlocks dependents and the ui part. A merged part leaves the package
in_progress. Contract milestones shipped before this rule stay valid records. Feedback and
maintenance do not complete build packages.

Full-target WP-056/WP-057 integration verifies every closing package's behavior and gates.
Its verifier may include `"packageClosures":["WP-NNN"]` in the exact-head EVF-Review record.
Acknowledgement closes those packages only after every part is reviewed, merged and acknowledged,
direct prerequisites are done and owned acceptance cases and case actions pass their checks.
The verifier's report must explain full coverage. File presence or successful scaffold checks
never establish application acceptance.

The implement pipeline has the stages plan, implement, simplify, pr, verify, ci, ship and merged. The
implementer proves its own work (tests, 390 and 1440 px screenshots of each UI state it changed and one
`bin/evf proof add` per Done criterion it built or changed); UI work runs in its seat unless the spec has the
line `Seat: ui`. The pr stage reruns the author checks at the current head and opens or updates the PR, so a
simplifier commit never costs a round. Proof carries forward to later heads of the branch. The verifier reads
the full diff and spot-checks the proof, re-running a flow only where a proof is unmet, missing or looks wrong.
`tools/evf/README.md` has the details.

Keep media and traces outside the repository. Generate the explorer outside the checkout;
it is a read-only progress view. Preserve WP-097's owner-approved fast-track evidence.
Global kickoff and concrete spending approvals remain separate from milestone readiness.
Follow the ship skill for merge authority. G-WORKFLOW closes when W0 to W5 merge and one task
runs end to end through Phase 7. This document does not claim that closure.
