# Everyfield v3: agent instructions

Everyfield v3 rebuilds v2. Packages and dependencies live in `docs/plan/dag.json`.
Current requirements and cases live in `docs/catalog/index.json`. Keep this file under 150 lines.

## Task flow

1. Read your Intent task note and role below. The coordinator plans and delegates.
2. `bin/evf task start <task>` creates the isolated worktree and prints its brief.
   Register that path with Intent. Edit and commit there, never in the workspace root.
3. Build inside the owning paths. Use the brief and linked current clauses as the contract.
4. Include current main, commit, run the task checks and `bin/evf verify <task>`.
   Prove your own work: tests, 390 and 1440 px screenshots of each UI state you changed and one
   `bin/evf proof add` per Done criterion you built or changed. Open a PR explaining the change,
   actual verification, proof, risks and follow-ups. The evf stages are plan, implement, simplify,
   pr, verify, ci, ship; the pr stage reruns the author checks, so a simplifier commit costs no round.
5. An independent verifier (a fresh Opus 5.5 medium session that never shared context with the
   author, D82) reads the full diff, spot-checks the proof with `verify-preview`, posts the exact-head
   review and runs `bin/evf ship <task>`.
   Ship requires green required GitHub CI, independent approval and a valid PR body.

A PR that changes a path in `mergePolicy.documentTemplates` waits for Sebastian: `evf ship` stops after the verifier, `evf approve` merges.

Use `bin/evf help` for commands. IDs are WP-NNN, WP-NNN/api or /ui,
FB-<n> for feedback and OPS-<n> for tooling maintenance. Reserve a new OPS-<n> or ruling
number D<n> with `bin/evf id next ops|decision`; never take the next number from main.

## Rules

- Three guards hold. Everything else is your judgment.
  1. Never use the production database. Tests and checks use the shared development database.
  2. Merge only through `bin/evf ship` or `bin/evf approve`. Never push to main or force-push.
  3. Never read or print secrets: `.env*` files, credentials or connection strings.
- Follow `.agents/skills/ship/SKILL.md` for merge authority. Preserve the owner approval routes from PR #13.
- UI work runs in the implementer seat (Sonnet 5.5 medium), which reads `.agents/roles/ui-designer.md`
  and uses the better-* skills. A design-heavy spec opts into the separate `ui` seat with the line
  `Seat: ui`. Opus 5.5 medium plans and verifies.
- Use one portless preview per worktree. No Vercel preview deployments.
- The shared development database may be wiped and reseeded. Run the repo seed and preview scripts freely.
  Timing sets run only through `bin/evf timing`, on its own quiet local database (D81).
- Follow `docs/architecture/patterns.md` and `docs/architecture/decisions.md` for shared mechanisms
  and durable rulings. Requirements describe end-state behavior.
- Prove actual behavior. Tooling checks establish tooling behavior, not application acceptance.
- Decide reversible ambiguities and record them in task notes, using `decisions`.
- Keep screenshots, traces and temporary verification scripts outside the repository.
- Encode repeated corrections in a type, lint rule or test before adding written rules.
- Every clickable element shows `cursor-pointer`: buttons, links, tabs, menu items, clickable rows, chips,
  labelled checkboxes and radios, icon buttons. `packages/ui` primitives apply it, not call sites.
  Disabled controls keep `cursor-not-allowed`.
- Every Evry adapter operation or catalog tool you add or change ships with recorded eval cases in
  `tests/evry/evals/`; the rule is in `.agents/skills/test-standard/SKILL.md`.
- Put shared workflow enforcement in evf or a skill, never a second host-specific hook.
- Preserve original reference bytes, unrelated assets and design/everyfield-ui.html (the approved brand prototype).
  The prototype changes only through an owner-approved design task whose `maintenanceTasks` entry carries
  Sebastian's verbatim quote and time in `prototypeApproval`. `evf ship` never merges it; `evf approve` does.

## Roles and skills

| Specialist | Read |
|---|---|
| spec-writer, coordinator | `.agents/roles/coordinator.md` |
| implementor | `.agents/roles/implementor.md` |
| ui-designer | `.agents/roles/ui-designer.md` |
| verifier | `.agents/roles/verifier.md` |

| Need | Read |
|---|---|
| Product contract | `docs/START-HERE.md` and selected requirement JSON |
| Task context | `docs/plan/context.md` and `docs/package-context.py` |
| Architecture | `docs/architecture/README.md` |
| Regression tests | `.agents/skills/test-standard/SKILL.md` |
| Local checks | `.agents/skills/verify/SKILL.md` |
| Verify a PR from the other family | `.agents/skills/verify-preview/SKILL.md` |
| Merge rules | `.agents/skills/ship/SKILL.md` |
| PR body standard | `.agents/skills/everyfield-pr/SKILL.md` and its template |
| PR visual examples | `.agents/skills/pr/SKILL.md` |
| Debugging | `.agents/skills/debug-with-traces/SKILL.md` |
| Decisions | `.agents/skills/decisions/SKILL.md` |
| Previews | `.agents/skills/portless-preview/SKILL.md` |
| UI quality | better-interface and the better-* suite |
| Tooling and recovery | `tools/evf/README.md` |

## Principles

Each name maps to `.agents/skills/principle-<name>/SKILL.md`. Read the principles named
by your role, then others when needed. These are verbatim upstream copies pinned by
`skills-lock.json`; put Everyfield adaptations in roles or other skills.

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


## Progress and context

Only evf writes `docs/build-progress.json`. Ship acknowledges a milestone that passes the
reviewed-milestone checks. Coordinators clear only records ship left unacknowledged, with
`bin/evf shipped --clear <task>`. Owners update task notes, not progress patches.
Read `docs/build-agent-workflow.md` for milestone and integration closure.
Generate the explorer outside the repo with
`python3 docs/render-build-explorer.py --output /tmp/everyfield-build-explorer.html`.
Run documentation checks with `python3 docs/check-all.py`.

Generate assigned context with `docs/package-context.py` from `docs/plan/context-manifest.json`.
Requirement JSON is the behavior authority; product chapters are summaries. Read original
references and approved design sections on demand. Documentation status grants no implementation
or spending approval. G-WORKFLOW closes only after W0 to W5 merge and one task completes
end to end through Phase 7.
