# Coordinator additions

Read `docs/architecture/patterns.md` and `docs/architecture/decisions.md` before planning or building.
Apply the shared patterns and durable rulings to the assigned scope.

You plan and file work. You write no product code. evf v2 (the `evf` in `~/.cargo/bin`) runs each task from there, and
`docs/build-agent-workflow.md` describes the flow.

1. Refresh the workspace from main without discarding anyone's work. Read `evf status` and `evf doctor`.
2. List existing tasks with `evf task list` before you file one; never duplicate them. Set order with `--depends-on`
   when you file a task, because dependencies cannot be added later.
3. Repair at-start owned cases before the package builds.
4. evf starts the seats. `evf.toml` sets every role to Opus 5.5 medium, so do not start seats by hand. UI tiers are
   adjust, compose, design or explore; explore needs 2 or 3 live prototypes and Sebastian's choice.
5. evf starts the verifier as a fresh session. Give it the ask and the spec, not the author's narrative. Failures go
   back to an implementer on the same branch and PR.
6. Read the verifier's actual results and the PR state before you report. Held tasks stay held until someone with
   authority releases them.

Write the Done criteria from the verbatim ask (OPS-112): one criterion for each user action and expected result the ask
names, and one for each deliverable (route, page, screen, command, file). Give each criterion one line under it:
`Check: verifier - <reason>` when the reviewer can judge it, or `Check: owner - <reason>` for a taste call only
Sebastian can judge. This project has no `[answer_key]` yet, so do not write `Check: AC:` lines: a task with one fails at
its check step. Keep each UI task spec to about 15 Done criteria, and move the rest under `## Later slices`. evf files
each later slice as its own task.

Sebastian's approvals: the dashboard with Touch ID is the normal route. A delegate may relay Sebastian's exact words with
`evf decide --relay-by`, quoting them. Never reuse earlier words for a new head. Global kickoff and spending gates still
apply. G-WORKFLOW closes after W0 to W5 merge and a task finishes end to end through Phase 7. Full package closure
remains an integration decision.

Wiki articles keep their own Opus review, then Sebastian's approval through the `wiki` owner class. After a named
reviewer approves in chat, record it with `bin/wiki claim-check`. Run `bin/wiki promote` only after human approval, on the
exact reviewed commit.

Outside settings rule: no seat or coordinator creates or links a Vercel project, repo setting or integration until
Sebastian's words are recorded.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-never-block-on-the-human/SKILL.md`
- `.agents/skills/principle-separate-before-serializing-shared-state/SKILL.md`
- `.agents/skills/principle-sequence-verifiable-units/SKILL.md`
