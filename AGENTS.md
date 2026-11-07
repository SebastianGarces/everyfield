# Everyfield v3: agent instructions

Everyfield v3 rebuilds v2. Packages and dependencies live in `docs/plan/dag.json`.
Current requirements and cases live in `docs/catalog/index.json`. Keep this file under 150 lines.

## Task flow

evf v2 (the `evf` in `~/.cargo/bin`) runs the work: `evf.toml` holds this repo's roles and owner classes, and the store and
dashboard live outside the checkout. `bin/` here holds product tools only.

1. A seat starts in its own worktree with a brief that holds the full ask and spec. Your role's prompt comes from
   `.agents/role-prompts/`. Use the brief and linked current clauses as the contract.
2. Build inside the scope. Commit. Do not push or open a PR: evf runs the checks, the PR, the review and the landing.
3. Prove your own work: tests, 390 and 1440 px screenshots of each UI state you changed and one
   `evf proof add <n> --status met --evidence <path>` per `verifier` criterion, after your last commit.
4. Close with `evf run done --status passed --summary-file <file>`. Your summary becomes the what and why of the PR.
5. A fresh Opus 5.5 medium session that never shared context with the author (D82) reads the full diff, spot-checks the
   proof with `verify-preview` and records `evf review submit --verdict approved|changes --report-file <file>`.
6. evf lands the exact head once required GitHub CI is green and the review approved it.

A path in an `evf.toml` owner class also waits for Sebastian. The classes are `document-templates`, `landing-marketing`,
`wiki`, `brand-prototype` and `workflow-gates`. Decide reversible things yourself and record them with
`evf rule "<what>" --why "<why>" --revert "<how>"`. Ask with `evf ask owner` when only Sebastian can settle it.

evf numbers tasks T-<n>. WP-NNN, FB-<n> and OPS-<n> stay as labels and in history.

## Rules

- Three guards hold. Everything else is your judgment.
  1. Never use the production database. Tests and checks use the shared development database.
  2. Only evf lands work. Never push to main, force-push or merge by hand.
  3. Never read or print secrets: `.env*` files, credentials or connection strings.
- UI work runs in the implementer seat and reads `.agents/roles/ui-designer.md` and the better-* skills. Opus 5.5 medium
  plans and verifies.
- Use one portless preview per worktree (`bin/dev stack up`). No Vercel preview deployments, except `bin/qa` for Nora's
  QA previews (`docs/runbooks/qa-preview.md`).
- The shared development database may be wiped and reseeded. Run the repo seed and preview scripts freely.
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
- Put shared workflow rules in `evf.toml`, a role prompt or a skill, never a second host-specific hook.
- Preserve original reference bytes, unrelated assets and design/everyfield-ui.html (the approved brand prototype).
  The prototype changes only through a task Sebastian approves through its owner class.

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
| Workflow, progress and merge rules | `docs/build-agent-workflow.md` |
| PR visual examples | `.agents/skills/pr/SKILL.md` |
| Debugging | `.agents/skills/debug-with-traces/SKILL.md` |
| Decisions | `.agents/skills/decisions/SKILL.md` |
| Previews | `.agents/skills/portless-preview/SKILL.md` |
| UI quality | better-interface and the better-* suite |
| Browser runs, preview stack, logs | `bin/dev help` |
| QA previews | `docs/runbooks/qa-preview.md` |

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

`docs/build-progress.json` stopped updating at the evf v2 cutover. evf v2's task records are the live state.
Read `docs/build-agent-workflow.md` for milestone and integration closure.
Generate the explorer outside the repo with
`python3 docs/render-build-explorer.py --output /tmp/everyfield-build-explorer.html`.
Run documentation checks with `python3 docs/check-all.py`.

Generate assigned context with `docs/package-context.py` from `docs/plan/context-manifest.json`.
Requirement JSON is the behavior authority; product chapters are summaries. Read original
references and approved design sections on demand. Documentation status grants no implementation
or spending approval. G-WORKFLOW closes only after W0 to W5 merge and one task completes
end to end through Phase 7.
