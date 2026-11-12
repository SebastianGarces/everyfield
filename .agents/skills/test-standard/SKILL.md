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
   One passing test may cover several case IDs.
2. An invariant the type system cannot enforce: tenancy, privacy, transaction races, idempotency,
   counts, denominators or date/DST math. Name it `INV-<area>: ...`, for example
   `INV-tenancy: member cannot read another plant's people`.
3. An escaped bug. Name it `BUG-<short-sha or PR>: ...`. Reproduce the failure first, then fix it.

4. The performance budget. One shared census in `tests/integration/writes/` checks every write and page
   read. `statements.test.mts` runs the HTTP requests on a production build, the native write boundaries
   and every behavior suite in `suites.json` against real Postgres, and counts the statements each named
   operation sends. It finds a new write by itself and fails when that write has no budget in
   `limits.json`. It also fails when a run exceeds its budget, when a budget is never measured and when a
   page read's count grows with its data. A new write or page read gets a `limits.json` entry at the
   recorded rule in `docs/architecture/patterns.md` (Performance; D69, D70) and a behavior test that
   exercises it, not its own statement-count test. Write a per-file count only for what the census cannot
   see, such as a read other than a page that must send the same statements at 3 and 50 rows, and assert
   the exact number.

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

- Use integration tests against real Postgres from `bin/dev stack`, through the public operation.
- A DB test seeds through the shared fixture in `tests/support/fixture.mts`: `fixture()` gives the migrated schema, a
  tenant plant and its owner, admin and member actors with live sessions; `seeds(admin)` adds plants, organizations
  and actors; `ok`, `refused` and `refusedWith` read results. Do not write a plant insert or an `ok`/`refused` of your
  own, unless creating the plant is the behavior under test.
- A DB test never sleeps, polls the clock or asserts on wall-clock time: no `setTimeout` delay or watchdog, `sleep`,
  `pg_sleep` stall, clock polling loop or `Date.now()`/`performance.now()` deadline. Control time through the row
  (`eligible_at`, `expires_at`, `created_at`) and compare with times the test set or read back from the database,
  such as a row's `created_at` or the transaction's `now()`. A race test holds a real lock and waits for the rival
  with `waitingOnLock`, which polls Postgres lock state; its `pids`, `blockedBy` and `count` options name which
  sessions must wait, so no file writes its own lock poll. `Date.now()` may only place seeded rows days away from any
  boundary. Three uses keep real time, and each says why in a comment: the production latency proof in
  `tests/integration/identity/timing.production.mts`, the `ms` field of `tests/integration/writes/counter.mjs`, and
  the 3 s wait in INV-expiry of `tests/integration/identity/invitations.test.mts`, where only elapsed time shows that
  an expiry check reads the clock after a lock wait. Any other exemption needs the owner's agreement.
- Use browser tests only for critical flows: sign-in, one meeting end to end, Evry review and approve.
  Prove other UI behavior broadly now; protect its domain behavior with integration tests.
- Use contract tests only when something outside our code consumes the shape: Evry tool schemas,
  provider webhooks or the public feedback serializer. Round trip the external boundary.
- Use Evry evals with recorded fixtures and a scored rubric when model behavior requires them.
- Every Evry capability ships with its evals. A change that adds or changes an Evry adapter operation under
  `packages/evry/src/adapters/**` (reads or commands) or a catalog tool adds or updates cases in
  `tests/evry/evals/*.cases.json`. The cases cover tool selection for natural questions and answer correctness
  against seeded fixtures. Record them on the real `EVRY_MODEL`; CI replays the recordings with no paid call (D77).
  A case names its operation with `"operation": "<name>"`. List the added or changed cases in the PR body.
  `tests/workflow/evry-evals-coverage.test.mjs`, the one coverage test, fails for an adapter operation or catalog
  tool with no case that is not in
  `tests/workflow/evry-evals-baseline.json`. The baseline only shrinks: remove an entry when its cases land,
  and never add one.
- Workflow tooling tests use disposable repositories and fake external providers; they establish
  tooling behavior only. Mock providers we cannot run locally; prefer local fakes.

## Review the suite

Test names start with `AC:`, `INV-` or `BUG-`, or use case annotations alongside an invariant/bug name.
Every owned acceptance case with real behavior must appear in at least one passing test name or
annotation. A case that only restates a type, schema or constant needs no test. Reports use the exact
`AC:<case-id>` marker. Duplicate coverage is flagged for verifier review; keep another test only
when it protects a distinct costly failure. Fix or delete flaky tests; retries do not prove a pass.
Explain deletion of useless tests in the PR body.
