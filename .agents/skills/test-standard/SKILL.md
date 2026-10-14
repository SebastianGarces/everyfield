---
name: test-standard
description: "Apply before writing, keeping or deleting a test. Keep few behavior-focused regression tests; use broad proof outside the repository."
---

# Test standard

Verification proves the current result broadly: run the app, inspect browser captures and traces,
and use throwaway scripts. evf stores this proof outside the repository. A regression test stays in
the repository only when a silent break would cost us. Suite size is not evidence.

## Keep a test when it protects

1. Acceptance behavior from `docs/catalog/index.json` and its selected current clauses/cases.
   Mark literal case IDs in names or annotations with `AC:<case-id>`, for example
   `AC:MTG-CASE-001 AC:MTG-CASE-002 finalization creates the expected follow-up tasks`.
   `{acGrep}` selects this same form. One passing test may cover several case IDs.
2. An invariant the type system cannot enforce: tenancy, privacy, transaction races, idempotency,
   counts, denominators or date/DST math. Name it `INV-<area>: ...`, for example
   `INV-tenancy: member cannot read another plant's people`.
3. An escaped bug. Name it `BUG-<short-sha or PR>: ...`. Reproduce the failure first, then fix it.

Prefer an added row or assertion in an existing test over another test. Use table-driven tests for
combinatorial behavior. Count case IDs covered per test, never require one test per case.

## Assert behavior

Call the public operation as its users do and assert the exact observable result. Follow
`principle-test-behavior-not-implementation`. A test that passes when imports return `undefined` or a
wrong value earns no place. Do not restate types, schemas, constants or source shape; mock our own
modules; snapshot markup; test an already-covered private helper; or write tests solely for counts.

A denied-access test belongs only to a criterion with an access or privacy rule. A failure test
belongs only where the product defines a specific refusal, such as a named error, user-visible
message or partial receipt. Generic input validation gets no regression test.

## Pick the layer

- Use integration tests against real Postgres from `evf stack`, through the public operation.
- Use browser tests only for critical flows: sign-in, one meeting end to end, Evry review and approve.
  Prove other UI behavior broadly now; protect its domain behavior with integration tests.
- Use contract tests only when something outside our code consumes the shape: Evry tool schemas,
  provider webhooks or the public feedback serializer. Round trip the external boundary.
- Use Evry evals with recorded fixtures and a scored rubric when model behavior requires them.
- Workflow tooling tests use disposable repositories and fake external providers; they establish
  tooling behavior only. Mock providers we cannot run locally; prefer local fakes.

## Review the suite

Test names start with `AC:`, `INV-` or `BUG-`, or use case annotations alongside an invariant/bug name.
Every owned case must appear in at least one passing test name or annotation. Reports use the exact
`AC:<case-id>` marker. Duplicate coverage is flagged for verifier review; keep another test only
when it protects a distinct costly failure. Fix or delete flaky tests; retries do not prove a pass.
Explain deletion of useless tests in the PR body.
