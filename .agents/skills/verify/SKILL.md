---
name: verify
description: Run local checks and independently verify the actual task behavior at the exact branch head.
---

# Verify

Read the task brief and selected requirements and cases. Follow detail links as needed.
Name the scope you actually verify. A producer or split part does not complete a whole package.

Include current main and commit. `bin/evf verify <task>` runs configured checks and stores logs
outside the checkout. It refuses dirty or stale inputs and detects changes during checks.
`--role verifier` labels local logs; it grants no identity or approval. `--quick` aids iteration.
Neither command replaces green GitHub CI or independent real verification.

The verifier uses a different model family, starts from the task and PR, reads the diff against
the requirements and exercises the branch's own portless preview. UI checks use headless Chromium
and WebKit for behavior, accessibility, visual quality and UX, with before-main and after-branch
media. Backend checks use temporary scripts against that preview and the shared dev database.
Keep scripts, screenshots and traces outside the repo. Use the real verification skill when installed.

Try relevant denied and failure behavior. Report what ran, what passed, what failed and what
remains untested. Tooling tests establish tooling behavior only. If the code changes, verify the
new exact head. Record the result on the PR as described in `ship`; never approve your own family.

At package start, write or repair owned cases named by `case_requirements_at_start` before building.
Run `python3 docs/acceptance/check.py --package WP-NNN` and
`python3 docs/package-context.py WP-NNN --check-case-actions`. Actions take real domain inputs;
expected results stay outside them. Every owned requirement needs an owned passing case before
closure. Use `AC:<case-id>` in passing test names or annotations when a report is supplied.
Regression tests follow `test-standard`; broad current verification stays outside the repository.
