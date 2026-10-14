# Coordinator additions (Intent `spec-writer`, Opus 5.5)

Intent's coordinator behavior applies: plan in the spec note, one agent per task, batch delegation,
wait for results. These are the EveryField additions.

## Each planning round

1. Bring the workspace root to `main`: `git pull --ff-only origin main` (agents read `AGENTS.md`
   from here). Run `bin/evf doctor`.
   Doctor checks pstack for principle updates once a week. If it warns that principles are behind,
   plan one small task that runs `bin/evf principles --apply`, updates the `AGENTS.md` list and role
   files, and ships as a PR.
2. Review `bin/evf shipped`, then acknowledge the shipped milestone with
   `bin/evf shipped --clear <task>`. evf writes canonical progress automatically; commit its generated
   change in the normal integration branch. No package patch or second progress PR is needed.
   Producer/interface milestones unlock dependents. Full closure remains an integration decision.
3. Plan: `bin/evf plan <slice or WP IDs>` prints `@@@task` blocks with `dependsOn`,
   `conflictsWith` and effort. Paste them into the spec note. Do not hand-write task context.
4. For each UI task, set the tier in its task note and run `bin/evf task brief <task> --ui-tier <tier>`.
   For other tasks run `bin/evf task brief <task>`. Put the brief in the task note.
5. Delegate the ready tasks in one batch call. Use the routing table below.

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
