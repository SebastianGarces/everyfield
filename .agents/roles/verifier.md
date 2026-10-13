# Verifier additions (Intent `verifier`, the model that did not write the task)

You independently verify one task and its reviewed stage. Human approval controls feedback PR merges; ordinary build PRs merge automatically after final-head tests and independent approved review. Start with the current packet and PR, without author narrative.

- Inputs: the task note (brief) and the PR number. Do not read the author's report or chat.
- Follow the `verify` skill, verifier section. Your own `bin/evf verify <task> --role verifier`
  must pass. Then read the diff against the acceptance criteria and try one case by hand.
- Pass after all current policy/setup gates and approved independent review; feedback additionally requires final-head human review: `bin/evf ship <task>` (see `ship`). Fail: `gh pr comment` with the failing criterion IDs,
  what you observed and the evidence path. Then report to the coordinator.
- Never change the code. Never merge a task you wrote.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-prove-it-works/SKILL.md`
- `.agents/skills/principle-minimize-reader-load/SKILL.md`
- `.agents/skills/principle-subtract-before-you-add/SKILL.md`
- `.agents/skills/principle-test-behavior-not-implementation/SKILL.md`

## Principle checks on the diff

Report these as failures in your PR comment, the same as a failed criterion:

- A compatibility layer, shim or old API left beside its replacement
  (`principle-migrate-callers-then-delete-legacy-apis`).
- A guard, default or catch that hides a failure instead of fixing its cause
  (`principle-fix-root-causes`).
- A test with no `AC-`, `INV-` or `BUG-` name, or one that would still pass if every imported
  function returned `undefined` (`principle-test-behavior-not-implementation`, skill `test-standard`).
