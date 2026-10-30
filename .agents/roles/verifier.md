# Verifier additions

Verify a task in a fresh Opus 5.5 high session that never shared context with the author (D82).
Start with its task note and PR. Your EVF-Review line records your session id, model and the
verifier role; evf ship refuses the author's session, another seat and a non-Opus model.
Read the full diff and current requirements and judge the code quality in full (D66).
Then spot-check the proof instead of redoing it: read `bin/evf proof show <task>` and open each
proof's evidence. Re-run a flow only where a proof is unmet, missing or looks wrong. When only a
screenshot is missing, capture it and record it with `bin/evf proof add`; do not request changes for that
alone. Proof from an earlier head of the branch carries forward, so a later round re-proves only what it
changed. You own the approve or `changes_requested` verdict.
Before you judge an evf task, read its full ask and spec with `bin/evf task spec <task> --show`.
The session-start context can shorten them. Judge every Done criterion and every Non-goal.

Follow `.agents/skills/verify-preview/SKILL.md`. It runs the PR head on its own preview where a
check needs one, captures what is missing, publishes the evidence and posts the exact-head `EVF-Review`.
Tooling tasks rerun their commands as the probe. Also run `bin/evf verify <task> --role verifier`.
An OPS task's scope is the `maintenanceTasks` entry committed at the PR head. Review that entry
with the diff. Never register a task in the home checkout's `evf.config.json`.
Failures use `changes_requested`; send them to the coordinator without changing code.
Approved ordinary work goes through `bin/evf ship <task>`. Preserve the owner approval routes.

Run long checks in the foreground, or keep your turn open until every background job ends.
Never end a turn to wait for a background notice: the host stops the job when the turn ends.
Follow the browser rules in `verify-preview`: one browser job at a time, agent-browser instead of
the Playwright MCP, close what you open, and stop only processes you started, by PID or process
group. Link flow videos in your PR comment.

Include a "Code quality" section in every review. Judge laziness-protocol, minimize-reader-load,
subtract-before-you-add, test-behavior-not-implementation and other principles the diff touches.
Check the diff against `docs/architecture/patterns.md` and the durable rulings in
`docs/architecture/decisions.md`.
Name concrete simplifications, or explain why none are needed, and give a quality verdict.
Needless layers, copied patterns or dead code require changes_requested even when behavior passes.
The EVF-Review quality field records that verdict and the principles checked; ship enforces it.

Include an "Experience" section. Use the author's recorded measurements and re-measure where they look
wrong or missing. On the production preview, record end-to-end time for every
changed read and write, optimistic updates and request counts for main actions. Simple actions
must finish under one second with no needless refetch or refresh. Reports and analytics may
exceed the budget only with the matching PR exception. Explain when checks do not apply.
The required EVF-Review experience field records the verdict and budget; ship enforces it.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-prove-it-works/SKILL.md`
- `.agents/skills/principle-laziness-protocol/SKILL.md`
- `.agents/skills/principle-minimize-reader-load/SKILL.md`
- `.agents/skills/principle-subtract-before-you-add/SKILL.md`
- `.agents/skills/principle-test-behavior-not-implementation/SKILL.md`
