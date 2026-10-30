# Coordinator additions

Read `docs/architecture/patterns.md` and `docs/architecture/decisions.md` before planning or building.
Apply the shared patterns and durable rulings to the assigned scope.

Plan and delegate in Intent. List existing task IDs before delegation; never duplicate them.
Reserve each new OPS task and ruling number with `bin/evf id next ops|decision` before you name it.
Read the current brief and follow details on demand. Do not write product code.

1. Refresh the workspace from main without discarding anyone's work. Run `bin/evf doctor`.
2. Review `bin/evf shipped`. Ship already acknowledges reviewed milestones; clear a record ship left unacknowledged with `--clear <task>`.
   Transfer evf-generated progress into one reviewed OPS worktree per round. Retained milestones
   unlock dependents before the progress commit; restore root progress only after transfer.
3. `bin/evf plan <slice or IDs>` prints task blocks with dependencies, conflicts and effort.
   Put each brief in its task note. Repair at-start owned cases before the package builds.
4. Delegate implementation to the implementer seat (Sonnet 5.5 medium); it does UI work too, reads
   `ui-designer.md` and proves its own work. Add the line `Seat: ui` to a design-heavy spec to use the
   separate ui seat. Opus 5.5 high plans and verifies. The stages are plan, implement, simplify, pr,
   verify, ci, ship; the pr stage reruns the author checks, so a simplifier commit costs no round.
   UI tiers are adjust, compose, design or explore; explore needs 2 or 3 live prototypes and
   Sebastian's choice. Run at most 3 UI tasks at once.
5. Delegate verification to a fresh Opus 5.5 high session that never shared context with the author.
   evf ship refuses the author's own session, a non-verifier seat and a non-Opus model (D82). Give the
   task note and PR, not the author's narrative. The verifier reads the full diff and spot-checks the proof.
   Failures return to an implementor on the same branch and PR.
6. Read the verifier's actual results and PR state. Use `ship` for automatic and owner routes.

Intent owns scheduling, dependencies, discussions and watchers. Do not add another scheduler.
Global kickoff and spending gates still apply. G-WORKFLOW closes after W0 to W5 merge and a task
finishes end to end through Phase 7. Full package closure remains an integration decision.
Wiki articles keep their own Opus review, then Sebastian's chat approval and `evf approve`.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-never-block-on-the-human/SKILL.md`
- `.agents/skills/principle-separate-before-serializing-shared-state/SKILL.md`
- `.agents/skills/principle-sequence-verifiable-units/SKILL.md`
