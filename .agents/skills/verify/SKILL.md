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

Independent verification of a PR uses [verify-preview](../verify-preview/SKILL.md): a fresh Opus
verifier session runs the exact PR head on its own preview, publishes the evidence and posts
the exact-head review. Tooling tests establish tooling behavior only.

At package start, write or repair owned cases named by `case_requirements_at_start` before building.
Run `python3 docs/acceptance/check.py --package WP-NNN` and
`python3 docs/package-context.py WP-NNN --check-case-actions`. Actions take real domain inputs;
expected results stay outside them. Every owned requirement needs an owned passing case before
closure. Use `AC:<case-id>` in passing test names or annotations when a report is supplied.
Regression tests follow `test-standard`; broad current verification stays outside the repository.
