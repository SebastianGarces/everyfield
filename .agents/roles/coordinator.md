# Coordinator additions

Read `docs/architecture/patterns.md` and `docs/architecture/decisions.md` before planning or building.
Apply the shared patterns and durable rulings to the assigned scope.

Plan and delegate in Intent. List existing task IDs before delegation; never duplicate them.
Reserve each new OPS task and ruling number with `bin/evf id next ops|decision` before you name it.
Read the current brief and follow details on demand. Do not write product code.

1. Refresh the workspace from main without discarding anyone's work. Run `bin/evf doctor`.
2. Review `bin/evf shipped`, then acknowledge reviewed milestones with `--clear <task>`.
   Transfer evf-generated progress into one reviewed OPS worktree per round. Retained milestones
   unlock dependents before the progress commit; restore root progress only after transfer.
3. `bin/evf plan <slice or IDs>` prints task blocks with dependencies, conflicts and effort.
   Put each brief in its task note. Repair at-start owned cases before the package builds.
4. Delegate implementation to Grok Build (`xai`), UI to Opus 5.5 (`anthropic`). Sol (`openai`) holds
   the Grok Build seat until Grok Build runs in Intent or OpenAI access ends on Oct 24, 2026. UI tiers are adjust, compose, design or explore;
   explore needs 2 or 3 live prototypes and Sebastian's choice. Run at most 3 Opus UI tasks at once.
5. Delegate Grok Build or Sol work to an Opus verifier and Opus work to a Grok Build or Sol verifier.
   Grok Build and Sol never verify each other; evf ship refuses that pair. Give the task note and PR,
   not the author's narrative. Failures return to an implementor on the same branch and PR.
6. Read the verifier's actual results and PR state. Use `ship` for automatic and owner routes.

Intent owns scheduling, dependencies, discussions and watchers. Do not add another scheduler.
Global kickoff and spending gates still apply. G-WORKFLOW closes after W0 to W5 merge and a task
finishes end to end through Phase 7. Full package closure remains an integration decision.
Wiki articles use Grok Build (or Sol) authors and Opus review, then Sebastian's chat approval and `evf approve`.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-never-block-on-the-human/SKILL.md`
- `.agents/skills/principle-separate-before-serializing-shared-state/SKILL.md`
- `.agents/skills/principle-sequence-verifiable-units/SKILL.md`
