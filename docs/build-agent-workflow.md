# Build progress for coordinators

The DAG defines packages and dependencies. Only evf writes `docs/build-progress.json`.
Task notes hold progress and blockers. Owners never submit manual progress patches.

1. Review `bin/evf shipped`: the merge commit, exact tested head, required CI and verifier report.
2. Acknowledge with `bin/evf shipped --clear <task>`. Records remain outside the checkout.
   Exact replays do not advance revisions. Acknowledged producer/interface milestones unlock
   dependents, even before the generated progress projection merges.
3. Transfer evf's exact generated progress into one reviewed OPS worktree per coordinator round.
   Restore the root's committed progress after transfer. Use the normal CI and review flow.

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

Keep media and traces outside the repository. Generate the explorer outside the checkout;
it is a read-only progress view. Preserve WP-097's owner-approved fast-track evidence.
Global kickoff and concrete spending approvals remain separate from milestone readiness.
Follow the ship skill for merge authority. G-WORKFLOW closes when W0 to W5 merge and one task
runs end to end through Phase 7. This document does not claim that closure.
