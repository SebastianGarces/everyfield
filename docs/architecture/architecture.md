# Architecture proposal and implementation boundaries

Status: proposed for the fresh v3 build, 2026-10-03. This directory contains a plan, not a working application. No customer import, database mutation, deployment or PR is authorized by it. Preserve the SME Plant Intelligence rubric and Launch Playbook; the software mechanisms below are replaceable.

## Recommended shape

Use a TypeScript modular monolith with a Next.js frontend and a single Bun + Hono API/worker application as the leading deployment candidate. Keep PostgreSQL as the system of record and use Drizzle with a driver that supports interactive transactions. A small number of separately deployed processes does not imply independently owned microservices or distributed domain transactions. One repository, one database, one domain operation layer, one schema release owner, and one integration branch are sufficient.

Next.js provides the web shell, server rendering, public pages and small transport adapters. Business operations belong in framework-independent module code called through authenticated API contracts by both UI and Evry. Do not re-create a server-action method for every domain method plus a separately implemented agent method. Server rendering can call the API through a server client with request credentials; do not introduce an unreviewed direct database bypass just to save one hop. Within the API process, handlers and Evry tools call the same operation functions directly.

Suggested future paths (none created by this plan):

```text
apps/web/src/app/                    Next route compositions
apps/web/src/features/<module>/      feature UI and accessible interactions
apps/api/src/http/                   Hono routing/authentication/adapters
apps/api/src/worker/                 scheduled/claimed work
packages/contracts/src/<module>/    public schemas, operations, error codes
packages/domain/src/<module>/       operation handlers/policies/queries
packages/db/src/schema/             SQL schema and Drizzle definitions
packages/db/migrations/             reviewed versioned SQL
packages/reference/                approved Playbook/rubric/template/catalog manifests
packages/ui/                       shadcn additions and shared design primitives
packages/evry/                     tools, plans, conversations, evaluation fixtures
tests/contracts/ tests/integration/ tests/e2e/ tests/evals/
```

The domain modules are identity/access, organizations/oversight, people, meetings, tasks/follow-ups, teams/training, communication, notifications, Wiki/reference, documents, phases/intelligence, launch, feedback/admin and Evry. These are code ownership boundaries. Do not require a generic repository interface, a command bus, a DI container, a generalized workflow engine or a separate service for every table. Split a module further only when its independent changes and ownership justify it.

The [complexity budget](complexity-budget.md) defines minimal deployables, recurring backend costs and many-to-one operation consolidation. Inventory rows and scheduling batches are not new services, endpoints or mandatory package-manager workspaces. Historical tool aliases can map to fewer bounded target tools sharing domain handlers; every variant still has an acceptance/disposition record.

## Honest backend comparison

| Candidate | Why it fits | Real cost / uncertainty | Decision gate |
|---|---|---|---|
| Bun + Hono | Explicit HTTP API usable by UI/Evry, small routing surface, portability, clear separation from Next conventions | Two auth/cookie integration surfaces; CORS/proxy/streaming topology; Bun compatibility with database, native image/password libraries, telemetry and document libraries must be demonstrated | Preferred candidate; spike login/recovery, tenant-denied request, transaction rollback, file rendering and durable stream reconnect before freezing |
| Bun + Elysia | User already knows and likes it; cohesive typed route ergonomics and Bun focus can reduce integration work | Avoid framework schemas becoming the domain contract; check exact Hono/Elysia SDK generation and deployment compatibility; smaller team familiarity is a benefit, not a flaw | Equally valid if it wins the same representative spike or materially improves maintainability; do not reject based on unfamiliarity |
| Modular Next.js | One deploy and same-origin sessions; fastest initial operations setup; existing team experience | Easy to put authorization/domain changes back in server actions; long jobs and Evry streaming remain separate process concerns; imports can couple domain to rendering/cache lifecycle | Proportional fallback if two-service operational cost dominates; same domain/contracts packages and worker boundary remain mandatory |

Do not use an abstract performance benchmark to settle this choice. Compare one real vertical slice with recovery, transactions, denied access, documents and streaming. Keep backend-specific code under adapters so the result does not alter the methodology or capability scope. The stack verification supplied by the parent is recorded separately in the dependency plan; version choices are not inferred from this repository's lockfile.

## Public operation contract

Each operation has a stable name, request and response schema, actor policy, transaction boundary, concurrency rule, audit policy and acceptance IDs. Suggested contract shape: `people.create`, `people.recordInterview`, `meetings.finalizeAttendance`, `tasks.complete`, `followUps.recordOutcome`, `teams.recordTraining`, `communication.proposeSend`, `communication.executeSend`, `phases.declare`, `phases.transition`, `intelligence.requestAssessment`. Names denote the domain, not the HTTP framework.

An authenticated operation receives a trusted `ActorContext` with account ID, current tenant grant, independent coach assignments, platform grant when present, request ID and source (`web`, `evry`, `worker`). A caller supplies subject identifiers but cannot supply trusted tenancy or authority. The operation loads the subject inside its access scope and checks row ownership. A read result is a permission-filtered DTO, not a raw Drizzle row. List, count, export, download and Evry context builders must use the same projection policy; hidden fields cannot be reconstructed through counts, errors or notifications.

Boundary parsing uses shared Zod schemas. Internally use branded IDs and typed date concepts; do not scatter duplicate validation through every helper. Persistence still enforces real integrity constraints because trusted TypeScript cannot prevent a race, a repair script or a corrupted row. Validation errors use stable codes and safe field issues; domain failures distinguish `forbidden`, `not_found` without existence leakage, `conflict`, `stale_revision`, `invalid_transition`, `provider_unavailable`, `rate_limited` and `retryable`. Transport adapters map codes consistently. Never return stack traces or SQL details to the user.

For reads, use cursor pagination with stable ordering and bounded filters. Store a version/revision on mutable aggregates. Writes carrying `expectedRevision` fail with a visible stale-state response rather than overwriting newer changes. A request idempotency key is scoped to actor, tenant and operation; store request digest and result so a reused key with a changed payload is rejected. Per-domain uniqueness remains separate from request idempotency.

## Authentication, tenancy and privacy

Better Auth owns credentials, sessions, verification and password recovery. Domain tenancy, discovery, coaching and oversight remain explicit business grants. Do not equate a Better Auth organization membership with every EveryField association. The existing flat Owner/Admin/Member model is the default to preserve, while implementation can use normalized membership rows instead of placing three nullable tenancy pointers on the account. Enforce the currently intended single active tenancy seat at the domain/database boundary unless a product decision explicitly permits more. A coach can independently hold a seat; the scopes do not lend authority to each other.

Platform administration is a separate explicit grant. An org seat grants permitted portfolio/aggregate reads; it does not grant the plant's CRM. Plant feature sharing is consent on the relationship/feature, independent of org notification preferences. Preserve disclosed initial invitation-origin defaults, self-start disabled defaults, prior choices on reassociation, coarse sharing-off notifications, locality-only oversight addresses, private photos and person-linked histories. Access revocation must be effective on subsequent requests and worker/tool execution, including a draft approved before its actor lost access.

Invitation acceptance and registration must atomically claim the valid invitation and grant the authorized seat/association; the current accepted revoke/registration race is not a v3 requirement. Preserve non-enumerating sender results and meaningful consent for an authenticated token recipient. Token hashes, expiration, consumption and rate limits must not be bypassed by Evry. Recovery invalidates credentials/session authority and stale email-change requests according to the explicitly preserved user behavior. Never copy v2 credential hashes, session rows or customer records into v3.

Use same-origin browser routing through a reverse proxy/BFF unless the selected deployment proves cross-origin credential handling. Freeze cookie flags, trusted origins, CSRF/origin defenses, session refresh and logout behavior in the representative auth spike. CORS is not authorization. Avoid JavaScript-readable long-lived access tokens. Secret values remain in environment/secret management; documentation only names variables.

## Transactions and concurrency

The v2 Neon HTTP driver cannot support interactive transactions (`src/db/index.ts`). Its sanctioned batch/replay/unique-index patterns preserve important needs but create complex cross-feature orchestration. v3 should select a PostgreSQL pool/driver permitting read-lock-write transactions, then retain unique constraints and explicit idempotency where external effects are involved. Keep transactions short: never hold a lock while calling an AI model, email provider or object store.

| Operation | Atomic database boundary | External/recovery boundary |
|---|---|---|
| Account registration + invitation claim | token check/claim, account/seat or discovery association, person link, audit | verification/invitation mail outbox after commit |
| Person record + status/activity | validated assessment/interview/commitment, allowed status change, activity and correction snapshot | plant intelligence invalidation/outbox after commit |
| Duplicate merge | lock both tenant-scoped people, verify revisions, repoint all enumerated references, conflict resolution and merge provenance | no implicit unmerge; compensating reversal only where references remain reversible |
| Attendance finalization | attendance revision/finalized state, first-time obligation claims, evaluation task and follow-up rows | notification/dirty-signal outbox; late corrections reconcile explicitly without duplicate obligations |
| Task completion/recurrence | status event, completion attribution, successor and fresh checklist, dependency checks | notification delivery after commit; replay returns same successor |
| Template offer | canonical template-key claim and inserted items together | deleting or declining never resurrects items on a read |
| Training/location/evaluation correction | exact saved before/after values, authorized update, append-only correction record | invalidation for affected facts and notification policy |
| Assessment publication | run claim/versioned fact snapshot, validated result, insight rows, status and feedback lineage | expensive inference outside transaction; CAS publication rejects stale generation |
| Launch milestone/task link | authorized milestone and task linkage/status/audit | manual outcome recording does not auto-promote phase |
| Evry approved execution | exact approved plan digest/revisions, rechecked actor authority, domain changes + audit | same domain outbox; never double-send after uncertain provider acceptance |

Cross-module operations may share one transaction through an explicit unit-of-work argument; do not call public HTTP APIs from inside a database transaction. The orchestrating operation owns the transaction, and collaborating module functions use the same connection. Domain-specific relation guards include same-tenant composite foreign keys, one active leadership/role membership where intended, cycle-free task dependencies, single live recurrence successor and same-identity assistant approval/execution lineage.

## Jobs, events and external effects

Use a PostgreSQL outbox and job table for the actual asynchronous needs: email, notification digest/dispatch, assessment generation, document generation when needed, reference embedding and cleanup. The first implementation can be a worker process polling due rows with leases and `FOR UPDATE SKIP LOCKED`. There is no requirement for Kafka, Redis, an event-sourced database or generalized workflow DSL.

Events are committed intent records such as `meeting.attendanceFinalized` or `person.corrected`; consumers are explicit and versioned. Distinguish audit history, derived fact invalidation and delivery jobs. An outbox is justified at external boundaries and retryable cross-module side effects; do not emit an event for every field write. Tenant scope, actor/request IDs and schema version accompany every event. Payloads carry minimum necessary data; a consumer reloads permitted current state where appropriate.

Workers claim bounded batches with lease owner/expiry and attempt counter. Provider idempotency keys and verified callbacks reconcile accepted, delivered, bounced, complained, failed and unknown states; acceptance is not delivery. Unknown provider outcome must be visible and recoverable without blind retry. Failed permanent jobs enter a searchable dead-letter state with safe operator retry or reconciliation. Callback handling verifies authenticity, accepts out-of-order/duplicate events idempotently and never regresses a newer status. Shared mail dispatch consistently checks suppression, consent, recipient authority and per-provider idempotency. Bulk communication must not bypass this boundary.

Cron is a wake-up, not the source of correctness. Every schedule is evaluated against tenant-local time, last successful logical period and an idempotency key. Dispatcher/assessment budgets must expose deferred work so a long queue cannot silently starve later tenants. Reconciliation checks compare claimed job state with durable effects and safe provider evidence.

## Time, storage and reference data

Use SQL `date` for a church-local calendar day, `time` for a local wall-clock time, IANA timezone for schedule meaning, and `timestamptz` for actual instants. Preserve the current America/Chicago default only as a product default, not a fact inferred from an address. Define every metric's clock: follow-up due day meeting-day-plus-two differs from the 48-hour originating-meeting completion metric; contact freshness differs from task completion. DST nonexistent/repeated times need an explicit tested resolution policy. Date-only values must never round-trip through UTC midnight JavaScript dates. Recurrences retain their intended local day/time across DST and timezone edits; existing historical instants do not move.

Exception requiring an explicit product ruling: current planter check-in week identity is UTC Monday, not the church-local scheduling calendar. Preserve that observed identity until OD-015 resolves whether v3 changes the boundary; do not silently apply local scheduling semantics to check-in uniqueness or historical weekly strips.

Private object storage holds photos, attachments and generated documents. Keys include opaque tenant/entity identities and never rely on caller-supplied filenames for authority. Issue short-lived authorized download URLs or stream through an access-checked endpoint; exports and previews use the same policies. Store checksum, media type, size, owner scope, creation actor and generation/reference version. Use upload intents and finalization to detect orphaned/stale uploads; cleanup is an explicit job. Validate CSV/Office input size, content and limits; defend spreadsheet exports against formula injection. Required rendering/preview compatibility is demonstrated using real fixture documents in the runtime spike.

Fresh v3 bootstrap consists of approved reference content only: Playbook, exact approved rubric versions, phase/team/task/launch/document templates, Wiki sections/global articles and methodology embeddings derived from those versions. Build a signed-off manifest with source SHA-256, semantic version, stable keys, locale and licensing/ownership disposition. Idempotent upserts are keyed by canonical identity; user-deleted offered tasks are separate tenant choices and are never reseeded. The current checkout cannot reconstruct its database-resident Wiki corpus, but an existing authorized global-only snapshot is now independently verified under `docs/evidence/reference-bootstrap/`: 96 published articles,21 sections,7 templates at exact alpha revision2107. No live export is required for that starting snapshot. Editorial/currentness approval and intentional version-controlled promotion remain delivery gates. No customer tenants, contacts, communications, tasks, check-ins, assessments, coaching, sessions or histories are included.

## Environments, observability and testing

Create isolated local/test/staging/production databases and object stores. Fail closed on missing or mixed-environment configuration. Seed/reference bootstrap and destructive fixture reset are distinct commands with explicit target identity; never make application startup migrate or wipe data. SQL migrations are reviewed, versioned and tested from a fresh database; do not restamp a production ledger or copy v2's applied migration history. Reference import is a versioned release asset independent of schema migration.

Logs and traces use request/operation/job/assessment IDs with tenant-aware access and redaction. Capture latency/error/retry/queue-age metrics, auth denials, stale writes, outbox lag, suppression/provider errors and AI schema/grounding rejection reasons. AI traces must minimize sensitive input and honor retention/disclosure choices. Keep Langfuse only after a verified data-posture decision; a retained integration is not permission to export private narratives. Health endpoints expose readiness without credentials or internals. Operators need authorized inspection, requeue/reconcile and a runbook, not arbitrary SQL hidden behind an admin button.

Testing uses pure domain fixtures for methodology rules, PostgreSQL integration tests for concurrency/rollback, contract tests for request/error/authorization DTOs, browser tests for real user workflows and file/rendering checks for generated artifacts. AI evaluations compare named rubric versions, insufficient evidence, visibility restrictions, grounded diagnosis, focus limits and refusal of pastoral authority. Auth/session behavior and streaming recovery must be demonstrated in the chosen runtime. Source-shape tests can protect import boundaries but cannot establish working features. High test counts do not substitute for a feature-to-acceptance mapping or a live environment proof.

Every preserved capability needs a positive path, denial path and relevant failure/correction path. Release gates exercise invitation races, attendance retries, recurrence contention, merge rollback, revoked approvals, duplicate/out-of-order webhooks, timezone/DST scheduling, malformed imports and no-evidence intelligence. Documentation validation performed for this plan is not application testing; all v3 runtime gates remain future work.
