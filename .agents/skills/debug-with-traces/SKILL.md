---
name: debug-with-traces
description: "Apply when a check fails or the app misbehaves. Reproduce on the task's own stack, then read the request's trace, logs and browser capture before you change code. Fix the root cause."
---

# Debug with traces

Work from evidence, not guesses. Every task has its own stack, so what you see is yours.

1. **Reproduce.** Run the failing check alone, or drive the flow in Intent's browser on the
   task's preview URL (`evf stack status <task>`). Note the request ID from the response header
   or the failing test output.
2. **Read the request.** `evf traces <task> <request-id>` prints the span tree for one request:
   handler, operation, SQL, provider calls, timings. `evf logs <task> --since 5m` prints the
   structured logs. Start with the first span that errors or takes too long.
3. **Read the browser.** Use `ws.browser` capture: `snapshot` for console, network and the
   accessibility tree; `startSession`/`captureStep` for a multi-step flow; `startTrace` and
   `stopTrace` for performance. Playwright `trace.zip` files from `evf verify` are in the
   evidence directory; open them with `npx playwright show-trace <file>`.
4. **Find the cause.** Ask why until you reach the first wrong value. Apply
   `principle-fix-root-causes`: no guard that hides the symptom.
5. **Prove the fix.** Add a `BUG-` or `AC-` test if the gap could return (see `test-standard`),
   then run `evf verify <task>`.

Keep raw output out of your context. Read summaries first and open one trace or log at a time.
If `evf traces` or `evf logs` reports that no command is configured, the observability package
has not landed yet. Use the stack's own log files and say so in your report.
