# EveryField patterns

The coordinator owns these defaults, adopted on 2026-10-19. [Architecture decisions](decisions.md) records the owner rulings and their reasons. Requirements and acceptance cases define product outcomes. A deviation from these mechanisms needs a product reason in the PR.

## Performance

Every simple read or write finishes in under one second end to end on a production build. Reports and analytics may take longer and must say so in their PR. Count statements per HTTP request, the session lookup included. A simple write request sends at most six statements, independent of data size: the session lookup, then the write. A write on the one-statement path sends the change, its authority check and its audit row as one statement with no BEGIN or COMMIT. A write on the established path (C88) adds BEGIN, the write gate, its locked reads and COMMIT. A replay or a refused first attempt reruns the established way, and that run has its own budget. A page read sends a fixed number of statements for each page and each variant of it, however much data the page shows. Batch work with set-based statements rather than a statement inside a row loop.

## Request authentication and reads

One cached statement per request reads the session, its user and the viewer, keyed by the verified session cookie (RT-1). Better Auth's own session read runs only when that statement finds no live session (Better Auth then deletes the expired row and clears the cookie) or when the session is due for its expiry extension. Cookie cache stays off. The proxy checks cookie presence; domain code receives the verified viewer and does not resolve the session again. Prefer one short transaction per page render where practical, set-based queries and page numbers. Do not reread whole projections to answer a write.

The cached viewer names the actor. It does not prove access at the time of a later read. A read that returns tenant data puts the live check in its own statement as a predicate: the session is live, the seat in the selected plant or organization has not ended, the seat's role still permits the read and no lifecycle witness hides the account, owner or seat. The check adds no statement. When it fails, the read returns no tenant data. A stream or worker repeats the check in each statement it runs. On main, the access.writeVisibility fragment in packages/domain/src/access/session.ts covers only the lifecycle part. A shared fragment for the whole check is a follow-up (C13).

## Writes and concurrency

Include tenant and active-seat authority in the write statement. Zero changed rows means refused or not found. Normal writes need no separate authorize call or advisory lock. Use a revision column checked in the same update only where people can actually edit the same record concurrently. A pipeline move updates one row's sortable position key.

Known limit: writes for one account queue on the write gate, which locks the account row until COMMIT. This order is deliberate, not a defect. In F11, five parallel effect retries for one account waited up to 934 ms.

## Audit

Write one append-only audit row per write with tenant, actor, action, subject type and identity, occurred_at, permitted changed fields with their before/after values, and an optional request_key. Write it in the same statement as the change, using a CTE. Activity and history read this audit record instead of requiring a separate operation ledger, per-module result tables, event table and per-module history tables. The [audit contract](audit.md) still limits fields and excludes private care. Personal settings audit records the changed field names and the section revision, never their before/after values, because those values are personal.

## Safe retries

Use a request key only for actions a double submit or lost reply can repeat, such as forms and invitations. A unique tenant/request-key pair on that audit row lets a retry return the known result without writing again. Simple idempotent updates that set a value need no request key.

A native write's first attempt does not read its request key. A replay meets the stored key at its write and then reads the stored answer in one statement per key, with the request actor's live access and no transaction. A refusal whose first attempt ran on the write gate's locks, or sent no statement, is the answer; it reads the key once only when the command reached its key check. A refusal that rests on an unlocked read reads the key, then reruns the established way without reading it again. A failed statement reruns the established way.

## Side effects

Insert one job row with the change for mail and notifications. A worker sends it. Use a dependency graph only when a feature actually chains effects.

## Interface behavior

Update the screen optimistically with React optimistic state or local state. Confirm the result or roll back with a clear message. Update what changed after a successful action instead of calling router.refresh. Prefetch on intent rather than viewport visibility.

## Verification

Test the exact behavior a user sees under test-standard. One statement check covers every budget in tests/integration/writes/limits.json: real HTTP requests on the production build, the native write boundaries and every write the behavior suites run. It runs in the CI db job. Each first-run budget equals the most statements measured, so a lower count also fails until the budget comes down. A retry budget is an upper bound, because its count depends on which racing write lands first. A write above six statements needs a reason in that file, and a page that sends more statements as its data grows fails. Reviews judge code quality against these patterns and the principles, and verify the performance budget, optimistic behavior and unnecessary requests.
