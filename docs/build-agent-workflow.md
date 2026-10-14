# Build progress for coordinators

`docs/plan/dag.json` defines package IDs, dependencies, outputs and gates. The only progress record is
`docs/build-progress.json`. Only evf writes it. Task notes hold work in progress and blockers; package
owners submit no progress patches and never rewrite canonical JSON.

## Review shipped milestones

1. Run `bin/evf shipped` and review the task outcome, merge commit, signed author/verifier evidence,
   proven case/gate portions and deferred owners.
2. Run `bin/evf shipped --clear <task>` to acknowledge the reviewed record. evf updates canonical
   progress automatically and retains proof provenance. Exact replays do not advance revisions.
3. Commit the generated progress change on the integration branch. No second progress task or
   package patch is needed. Feedback and maintenance records do not change build package status.

A reviewed producer/interface milestone unlocks dependent packages. Split packages expose their
contract first, or API when no contract part exists. Full package closure is unnecessary for startup,
so a later adapter can implement an early producer's deferred runtime portions.

## Integration closure

A merged part keeps the package `in_progress`. The integration owner reviews all parts, outputs, acceptance gates, integration rules and deferred
portions. Install a reviewed full-target integration plan with `packageClosures`, an array of
`{packageId, gateIndexes}` entries covering every closing package gate. Its selected cases must cover
every closing package, with passing integration portions and no deferral. Acknowledging that shipped
integration record closes the listed packages only after all merged parts are acknowledged.
Direct prerequisites must be canonically `done` for closure, even though milestones suffice to start.
Named passed acceptance evidence and substantive reviewed commits are required. File presence,
scaffold checks, estimates and browser-local changes never establish completion.

Keep evidence, screenshots and traces in evf's git-common evidence directory. Progress changes do not
invalidate policy fingerprints. Explorer generation is a separate view, not a completion gate or a
second integration patch. Its maintenance belongs to the documentation integration task.

Global action gates apply to all application packages. Runtime/recovery gates require producer
output at closure; concrete spending remains separately gated. Merge authority lives only in
`.agents/skills/ship/SKILL.md`. This progress workflow grants no application kickoff or external setup.
