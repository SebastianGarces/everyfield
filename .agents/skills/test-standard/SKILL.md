---
name: test-standard
description: "Apply before you write, keep or delete a test. A test must cite an acceptance ID, an invariant or an escaped bug. Default to integration tests against real Postgres through the public operation; no tests that restate types, mock our own modules or snapshot markup."
---

# Test standard

Tests protect behavior that would cost us if it broke silently. They do not measure effort. A
large suite that nobody trusts slows every agent down, so each test must earn its place.

## Write a test only when one of these is true

1. **Acceptance.** It proves a criterion from `docs/catalog/index.json and the selected current clauses/cases`. Put the
   shared gate ID in the test name: `AC-MTG-012: zero-attendee finalization creates one evaluation task`.
   `evf verify` selects acceptance tests by these IDs (`{acGrep}`).
2. **Invariant.** It guards a rule the type system cannot hold: tenancy, permissions, privacy
   filtering, concurrency and races, idempotency, counts and denominators, date/DST math.
   Name it `INV-<area>: ...`, for example `INV-tenancy: coach cannot read another plant's people`.
3. **Escaped bug.** A bug got through once. Name it `BUG-<short-sha or PR>: ...` and reproduce the
   failure first (red), then fix (green).
4. **Combinatorial logic.** Pure logic with many input combinations: policy tables, parsers,
   scheduling. Write one table-driven test, not one test per case. Name it `INV-` or `AC-`.

## Assert behavior

Follow `.agents/skills/principle-test-behavior-not-implementation/SKILL.md`: call the subject as its
users do and assert the literal result. A test that would pass if every import returned `undefined`
is rewritten or deleted.

## Do not write

- A test that restates a TypeScript type or a Zod schema.
- A test that mocks our own modules to check wiring.
- A snapshot of markup, or an assertion on source shape (file contents, import lists).
- A test for a private helper that an acceptance test already covers.
- A test whose only purpose is a count or a coverage number.

## Pick the layer

| What you prove | Layer |
|---|---|
| Domain operation, permission, transaction, race | Integration test: real Postgres from `evf stack`, call the public operation |
| Contract shape at a boundary | Contract test in `tests/contracts/`, round trip only |
| User-visible flow from an acceptance criterion | Browser test (Playwright) against the stack's preview URL |
| Evry behavior | Eval in `tests/evals/` with recorded fixtures and a scored rubric |

Mock only what we do not own and cannot run locally (a paid provider). Use the stack's local
fakes first (mail catcher, stubbed providers).

## Keep the suite healthy

- Every test name starts with `AC-`, `INV-` or `BUG-`. A test without one is a deletion candidate.
- Each acceptance criterion needs a positive case, a denied-access case and an invalid-input or
  failure case, as the selected clauses/cases require. Cover them in as few tests as stay readable.
- A flaky test is fixed or deleted the same day. Never retry a flaky test into a pass.
- Deleting a useless test is a good change. Say why in the PR body.
