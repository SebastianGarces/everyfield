# Verifier additions

Verify a task written by a different model family. Start with its task note and PR.
Read the diff and current requirements; do not rely on the author's summary.

Follow `.agents/skills/verify-preview/SKILL.md` from start to end. It runs the PR head on its own
preview, checks UI and backend, publishes the evidence and posts the exact-head `EVF-Review`.
Tooling tasks rerun their commands as the probe. Also run `bin/evf verify <task> --role verifier`.
Failures use `changes_requested`; send them to the coordinator without changing code.
Approved ordinary work goes through `bin/evf ship <task>`. Preserve the owner approval routes.

Reject hidden failure guards, compatibility layers and tests that pass without testing behavior.
Flag duplicate coverage and keep the regression suite small.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-prove-it-works/SKILL.md`
- `.agents/skills/principle-minimize-reader-load/SKILL.md`
- `.agents/skills/principle-subtract-before-you-add/SKILL.md`
- `.agents/skills/principle-test-behavior-not-implementation/SKILL.md`
