# Coordinator additions (Intent `spec-writer`, Opus 5.5)

Intent's coordinator behavior applies: plan in the spec note, one agent per task, batch delegation,
wait for results. These are the EveryField additions.

## Bootstrap before the first build tasks

1. Sebastian reviews one bootstrap commit installing the trusted signed runner command, its public
   key reference and identity/review adapter, and reviewed proof plans for WP-087, WP-001 and the
   OPS wiring task. Install the reviewed bootstrap check/report driver and enable
   `verification.kind: "application"` and `applicationQualified: true` for WP-087 producer proof
   without a stack. Its report covers the selected cases, including an empty test list when no
   cases are selected; real producer gates still need checks and signed review. Keep the private
   key outside agent worktrees. This owner-reviewed commit installs the initial trust boundary;
   it does not earn a self-attested OPS proof. Close kickoff gates only after
   their owner review, configure the remote separately, then read `bin/evf doctor` readiness.
2. Import WP-097 completion on main through the bounded fast-track path in the ship skill, then start WP-087 without a stack. It delivers the stack and test scripts and minimal scaffold/CI,
   proves its reviewed producer gates with the bootstrap runner, and leaves `evf.config.json`
   to maintenance. Review and acknowledge its shipped record.
3. Run the reviewed OPS wiring task. Its root `maintenanceTasks` entry owns `evf.config.json`,
   permits `configChanges: ["stack", "checks"]`, and supplies tooling checks that exercise the new
   scripts. The OPS task installs stack/check commands, including real assertion/report checks
   for WP-001. The bootstrap application qualification remains fixed; any runner/key/proof-plan
   authority change needs a separate owner-reviewed root installation. Re-prove active S0 tasks
   after changes to reviewed configuration merge.
4. Check readiness again, then start WP-001 with the delivered stack and real assertion/report
   checks. Open gates, missing runner/key or an unreviewed proof plan still prevent execution.

## Each planning round

1. Bring the workspace root to `main`: `git pull --ff-only origin main` (agents read `AGENTS.md`
   from here). Run `bin/evf doctor`.
   Doctor checks pstack for principle updates once a week. If it warns that principles are behind,
   plan one small task that runs `bin/evf principles --apply`, updates the `AGENTS.md` list and role
   files, and ships as a PR.
2. Review `bin/evf shipped`, then acknowledge each reviewed milestone with
   `bin/evf shipped --clear <task>`. The retained acknowledged signed record unlocks dependents
   immediately, even before canonical progress is committed. evf also writes the progress projection.
   Batch all evf-generated progress changes into one reviewed `OPS-n` commit per coordinator round,
   owning only `docs/build-progress.json`. Acknowledge all milestones in one pass, then transfer once.
   Transfer the exact generated change into that task worktree
   and restore the root progress file to its committed bytes before delegating dependents. Retain
   the shipped records under the git common directory. Do not wait for the progress OPS commit to
   unlock tasks or create a separate progress commit after every acknowledgement. Finish the round's
   batch before handoff. Full package closure remains an integration decision.
3. Plan: `bin/evf plan <slice or WP IDs>` prints `@@@task` blocks with `dependsOn`,
   `conflictsWith` and effort. Paste them into the spec note. Do not hand-write task context.
4. For each UI task, set the tier in its task note and run `bin/evf task brief <task> --ui-tier <tier>`.
   For other tasks run `bin/evf task brief <task>`. Put the brief in the task note.
5. Delegate the ready tasks in one batch call. Use the routing table below.

Before a package with `case_requirements_at_start` builds, route its case additions/repairs through reviewed documentation maintenance, merge them, and refresh its reviewed root proof plan before creating the consumer worktree.

## Routing

| Task | Specialist | Provider and model | Effort |
|---|---|---|---|
| `WP-NNN`, `/contract`, `/api`, `OPS-n` | `implementor` | `codex`, `gpt-6.1-sol` | `high` |
| `/ui` | `ui-designer` | `claude-code`, `opus` | UI tier below |
| Verify a Sol task | `verifier` | `claude-code`, `opus` | `medium` |
| Verify an Opus task | `verifier` | `codex`, `gpt-6.1-sol` | `high` |

UI tiers. When unsure, pick the higher tier.

| Tier | Work | Effort |
|---|---|---|
| UI-1 Adjust | Copy, spacing, states or a fix on an existing screen | `low` |
| UI-2 Compose | A new screen or form from existing patterns and components | `medium` |
| UI-3 Design | A new pattern: data-dense views, multi-step flows, complex forms, heavy accessibility | `high` |
| UI-4 Explore | No precedent. 2 or 3 live prototypes; Sebastian picks | `high` |

Keep at most 3 Opus UI tasks running at once to protect the Claude plan. The default verifier uses a distinct provider identity and model family. A same-family capacity fallback needs an explicit reviewed operator policy before activation; never downgrade tenancy, privacy or Evry review silently.

## After an author finishes

Delegate a verifier with only the task note and the PR number. Do not forward the author's
summary. If the verifier fails the task, send it back to a new implementor with the verifier's
PR comment. The PR and branch stay the same.

## Do not

- Write product code, read diffs or read raw logs. Read `proof.json` summaries and PR state
  (`ws.pr.snapshot`).
- Build your own scheduler. Intent's dependencies, conflicts and batch delegation do that.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-never-block-on-the-human/SKILL.md`
- `.agents/skills/principle-separate-before-serializing-shared-state/SKILL.md`
- `.agents/skills/principle-sequence-verifiable-units/SKILL.md`

## Scope, gates and progress

Use the current short package brief and follow its detail links on demand. Reviewed proof plans are installed in the root before task creation/rebase; task branches cannot mint their own proof authority. Separate current producer/native/contract portions from named later adapter portions for both cases and package gates. G-RUNTIME/G-RECOVERY are closure evidence, not prerequisites that prevent their producers starting; paid usage still requires its concrete G-SPEND approval.

Only evf writes canonical progress. Package owners keep task notes current. Read
`docs/build-agent-workflow.md` for milestone acknowledgement and integration closure. Merge authority
lives in `.agents/skills/ship/SKILL.md`; application kickoff, services and spending remain separately gated.
