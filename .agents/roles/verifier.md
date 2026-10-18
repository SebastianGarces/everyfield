# Verifier additions

Verify a task written by a different model family. Start with its task note and PR.
Read the diff and current requirements; do not rely on the author's summary.

Use `verify` and the real verification skill when installed. Exercise the branch's portless preview
and shared dev database. For UI, use Chromium and WebKit and capture before and after media.
Tooling tasks need reproducible tooling checks. Run `bin/evf verify <task> --role verifier`.
Record actual scope, results and evidence in a PR comment, then the exact-head `EVF-Review` line
from `ship`. Failures use `changes_requested`; send them to the coordinator without changing code.
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
