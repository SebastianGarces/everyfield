# Verifier additions

Verify a task in a fresh Opus 5.5 medium session that never shared context with the author (D82). evf starts you
read-only and refuses a non-Opus model.
Read the ask, the spec, the full diff and current requirements, and judge the code quality and simplicity in full (D66).
Then spot-check the author's proof instead of redoing it: read `evf proof show` and open each proof's evidence. Re-run an
author's check only where a proof is unmet, missing or looks wrong. App proof is never the author's: you capture it
yourself, as the next paragraphs say. You own the verdict.
Judge every Done criterion and every Non-goal. Then judge the ask itself, not only the spec. Extract every deliverable the
verbatim ask names (routes, pages, sections, screens, commands, files) and open the report with an "Ask coverage" table
before any criterion or check table. Mark each deliverable `delivered` or `deferred <task>`, where the task is one evf
filed. A deliverable that is missing without a filed follow-up is a blocking finding: ask for changes.

Every review of a diff that changes app code carries your own proof of the real app, not only a code read. For each
changed surface, reach it on a preview of the head as its feature map says (`docs/feature-maps/<feature>.md`), take
agent-browser screenshots at 390 and 1440 px, or a recording, and run `pnpm review-proof` (`verify-preview` step 3).
Never approve while it fails or while a changed surface has no map entry. A map entry the app contradicts is a finding.
Follow `.agents/skills/verify-preview/SKILL.md`. It runs the head on its own preview where a check needs one, captures
what you need, publishes the evidence and records the review. Tooling tasks rerun their commands as the probe.
A task that changes a path in an `evf.toml` owner class gets the same review. evf then holds it for Sebastian.
A review of a diff that touches a machine (its table, its column's values or a file its writer census lists) or a
4+ state value set pastes the Machines table `pnpm review-proof` prints into its Proof section, linking each machine's
table and its generated `docs/machines/<id>.md` chart, with the coverage report saved as `$E/<id>-coverage.txt`
(`verify-preview` 5). Never approve while `pnpm review-proof` or `node tools/ci/machines.ts --check` fails.
For a task that changes `docs/reference/wiki/`, check sources, scripture and screenshots of each draft before you approve.

Run long checks in the foreground, or keep your turn open until every background job ends.
Never end a turn to wait for a background notice: the host stops the job when the turn ends.
Follow the browser rules in `verify-preview`: one browser job at a time, agent-browser instead of
the Playwright MCP, close what you open, and stop only processes you started, by PID or process
group.

Include a "Code quality" section in every review. Judge laziness-protocol, minimize-reader-load,
subtract-before-you-add, test-behavior-not-implementation and other principles the diff touches.
Check the diff against `docs/architecture/patterns.md` and the durable rulings in
`docs/architecture/decisions.md`.
Name concrete simplifications, or explain why none are needed, and give a quality verdict.
Needless layers, copied patterns or dead code require changes even when behavior passes.

Include an "Experience" section. Use the author's recorded measurements and re-measure where they look
wrong or missing. On the production preview, record end-to-end time for every
changed read and write, optimistic updates and request counts for main actions. Simple actions
must finish under one second with no needless refetch or refresh. Reports and analytics may
exceed the budget only with a named exception. Explain when checks do not apply.

Request changes on a task that adds or changes an Evry adapter operation or catalog tool without matching eval
cases (`test-standard`), and on one that adds an entry to `tests/workflow/evry-evals-baseline.json`.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-prove-it-works/SKILL.md`
- `.agents/skills/principle-laziness-protocol/SKILL.md`
- `.agents/skills/principle-minimize-reader-load/SKILL.md`
- `.agents/skills/principle-subtract-before-you-add/SKILL.md`
- `.agents/skills/principle-test-behavior-not-implementation/SKILL.md`
