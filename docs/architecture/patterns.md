# EveryField patterns

The coordinator owns these defaults, adopted on 2026-10-19. [Architecture decisions](decisions.md) records the owner rulings and their reasons. Requirements and acceptance cases define product outcomes. A deviation from these mechanisms needs a product reason in the PR.

## Performance

Every simple read or write finishes in under one second end to end on a production build. Reports and analytics may take longer and must say so in their PR. A simple write uses a fixed number of statements, about four to six including BEGIN and COMMIT, independent of data size. Page reads use a fixed number of queries independent of page size. Batch work with set-based statements rather than a statement inside a row loop.

## Request authentication and reads

Use one cached session lookup and one cached viewer lookup per request. Cookie cache stays off. The proxy checks cookie presence; domain code receives the verified viewer and does not resolve the session again. Prefer one short transaction per page render where practical, set-based queries and page numbers. Do not reread whole projections to answer a write.

## Writes and concurrency

Include tenant and active-seat authority in the write statement. Zero changed rows means refused or not found. Normal writes need no separate authorize call or advisory lock. Use a revision column checked in the same update only where people can actually edit the same record concurrently. A pipeline move updates one row's sortable position key.

## Audit

Write one append-only audit row per write with tenant, actor, action, subject type and identity, occurred_at, permitted changed fields with their before/after values, and an optional request_key. Write it in the same statement as the change, using a CTE. Activity and history read this audit record instead of requiring a separate operation ledger, per-module result tables, event table and per-module history tables. The [audit contract](audit.md) still limits fields and excludes private care. Personal settings audit records the changed field names and the section revision, never their before/after values, because those values are personal.

## Safe retries

Use a request key only for actions a double submit or lost reply can repeat, such as forms and invitations. A unique tenant/request-key pair on that audit row lets a retry return the known result without writing again. Simple idempotent updates that set a value need no request key.

## Side effects

Insert one job row with the change for mail and notifications. A worker sends it. Use a dependency graph only when a feature actually chains effects.

## Interface behavior

Update the screen optimistically with React optimistic state or local state. Confirm the result or roll back with a clear message. Update what changed after a successful action instead of calling router.refresh. Prefetch on intent rather than viewport visibility.

## Verification

Test the exact behavior a user sees under test-standard. Each module has a statement-count check for each write and page read. Reviews judge code quality against these patterns and the principles, and verify the performance budget, optimistic behavior and unnecessary requests.
