---
name: debug-with-traces
description: "Apply when a check fails or the app misbehaves. Reproduce on the task's own stack, then read the request's trace, logs and browser capture before you change code. Fix the root cause."
---

# Debug with traces

Work from evidence, not guesses. Every task has its own stack, so what you see is yours.

1. **Reproduce.** Run the failing check alone, or drive the flow in a browser on the
   task's preview URL (`bin/dev stack status`). Note the request ID from the response header
   or the failing test output.
2. **Read the request.** `bin/dev logs` prints this worktree's preview logs. Start with the first
   line that errors or takes too long.
3. **Read the browser.** Use agent-browser's `errors` and `console`, or open a Playwright
   `trace.zip` from a check run with `npx playwright show-trace <file>`.
4. **Find the cause.** Ask why until you reach the first wrong value. Apply
   `principle-fix-root-causes`: no guard that hides the symptom.
5. **Prove the fix.** Add a `BUG-` or `AC:` test if the gap could return (see `test-standard`),
   then rerun the check that failed.

Keep raw output out of your context. Read summaries first and open one trace or log at a time.
`bin/dev traces` says what to read instead until the observability package lands. Use the logs,
and say so in your report.
