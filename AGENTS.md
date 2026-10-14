# EveryField v3: agent instructions

EveryField v3 is a rebuild of EveryField v2. The plan is in `docs/`. Work is organized as work
packages in `docs/plan/dag.json`, with current clauses and cases indexed by `docs/catalog/index.json`.
Claude and Codex agents both read this file. Keep it under 150 lines (`bin/evf doctor` checks).

## How work flows

Intent coordinators plan and delegate. Each implementation task uses its own worktree and
reviewed proof plan. Current authorization and prerequisite gates apply before execution.
Merge policy and review requirements live in `.agents/skills/ship/SKILL.md`.

1. `bin/evf task start <task>`: worktree, stack and your task brief. Read the brief first.
2. Build inside your owning paths. Tests follow the `test-standard` skill.
3. `bin/evf verify <task>` on a clean commit that includes the latest `main`.
4. `bin/evf pr open <task>`. A verifier runs `bin/evf verify <task> --role verifier`, then `bin/evf ship <task>`.

Task IDs: `WP-NNN`, or `WP-NNN/contract`, `WP-NNN/api`, `WP-NNN/ui` when a package splits.
`OPS-<n>` is reviewed tooling maintenance. Feedback routing lives in `.agents/roles/feedback-desk.md`.
Run `bin/evf help` for every command.

## Hard rules

- Follow `.agents/skills/ship/SKILL.md` for Git safety and merge authority.
- Your shell starts in the workspace root. Task work happens in `.worktrees/<task>`; use the path
  `evf` prints or `git -C`. Never commit task work in the workspace root.
- All UI work belongs to the `ui-designer` specialist on Opus 5.5.
- Name the proof kind and scope. Tooling checks establish tooling behavior; application acceptance needs the reviewed runner, selected case/gate portions and real applicable layers.
- Rule reversible ambiguities yourself and record them (skill `decisions`). Do not wait.
- Keep evidence, screenshots and traces out of the repository. `evf` stores them under the git common dir.
- Do not install a second copy of a rule in a host-specific hook or config. Put it in `evf` or a skill.

## Your role

Read the file for your specialist before you start:

| Intent specialist | File |
|---|---|
| `spec-writer` (Coordinator) | `.agents/roles/coordinator.md` |
| `implementor` | `.agents/roles/implementor.md` |
| `ui-designer` | `.agents/roles/ui-designer.md` |
| `verifier` | `.agents/roles/verifier.md` |

## Where to look

| Need | Read |
|---|---|
| Your package scope, clauses, cases, aliases and paths | `docs/plan/context.md` and `docs/package-context.py` |
| Full obligations of one criterion | `docs/catalog/index.json` and selected package detail pages |
| Architecture, contracts, transactions, tenancy | `docs/architecture/README.md` |
| Feature behavior | `docs/product/` (only the current sections selected by your packet) |
| Current approved product contract | `docs/START-HERE.md` and selected current clauses |
| What v2 taught us | `docs/lessons.md` |
| When to write a test | skill `test-standard` |
| Proving a task works | skill `verify` |
| Opening and merging PRs | skill `ship` |
| Debugging with traces, logs and the browser | skill `debug-with-traces` |
| Recording a ruling | skill `decisions` |
| Local previews | skill `portless-preview` |
| UI quality | skill `better-interface` and the `better-*` suite |
| Workflow config | `evf.config.json` |

Skills live in `.agents/skills/`. `.claude/skills` links to the same folder.

## Principles

This is the only always-loaded copy. Each line is a file at `.agents/skills/principle-<name>/SKILL.md`.
They are verbatim upstream copies (`skills-lock.json`): never edit them; put EveryField rules in a role
file or skill. Your role file names the ones to read in full at the start. Open others when they apply.

- `attack-the-premise`: Two fixes with one premise failed? Question the premise, not the fix.
- `boundary-discipline`: Guards at system boundaries; trust internal types; pure business logic.
- `build-the-lever`: Build the script, codemod or skill that does or proves the work.
- `encode-lessons-in-structure`: A repeated correction becomes a lint, check or script, not more text.
- `exhaust-the-design-space`: No precedent: build 2-3 prototypes and compare.
- `experience-first`: User delight over implementation convenience.
- `explain-the-number`: Name what limits a measured number before you trust it.
- `fix-root-causes`: Reproduce, ask why, fix at the cause; no silencing guards.
- `foundational-thinking`: Get the data structures right first.
- `guard-the-context-window`: Keep summaries in context; bulk goes to files and subagents.
- `laziness-protocol`: Smallest change that works; bias toward deletion.
- `make-operations-idempotent`: Same end state after crashes and retries.
- `migrate-callers-then-delete-legacy-apis`: No compatibility layers inside the codebase.
- `minimize-reader-load`: Fewer layers and less hidden state.
- `model-the-domain`: Encode the domain in structure, not scattered conditionals.
- `never-block-on-the-human`: Decide reversible things; present the result.
- `outcome-oriented-execution`: Converge on the target design; no throwaway intermediate states.
- `prove-it-works`: Verify the real artifact, not a proxy or a self-report.
- `redesign-from-first-principles`: Integrate a requirement as if it were there from day one.
- `separate-before-serializing-shared-state`: Remove shared writers before adding locks.
- `sequence-verifiable-units`: Small steps, each ending in a checked state.
- `subtract-before-you-add`: Remove dead weight first.
- `test-behavior-not-implementation`: Call code as users do; assert the exact result.
- `type-system-discipline`: Illegal states unrepresentable; parse at boundaries.

## Build progress

`docs/plan/dag.json` defines packages and dependencies. Only `evf` writes `docs/build-progress.json`,
automatically on ship and coordinator acknowledgement. Agents update task notes, not package patches.
Reviewed producer/interface milestones unlock dependents; full package closure stays at integration.
Read `docs/build-agent-workflow.md` for coordinator duties. Explorer generation is a separate view.

## Current documentation context
Read docs/START-HERE.md and generate the assigned package context from docs/plan/context-manifest.json using docs/package-context.py. Current product chapters, catalogs and target schema directly define behavior; do not reconstruct a prior decision chronology or require v2. Read original reference passages and approved design sections on demand. This repository has no superseded-material archive. External evidence is an investigation path, not a package prerequisite. Preserve original reference bytes, unrelated assets, and design/everyfield-ui.html. Documentation status is separate from implementation authorization and evidence.

Read `tools/evf/README.md` for runner setup, proof and recovery boundaries. G-WORKFLOW remains open.
