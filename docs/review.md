# Independent rebuild-plan review

The documentation passes independent review after reconciliation. All ten findings raised during review are resolved in the actual files. No remaining documentation blocker was found. Future implementation still needs the named user/SME decisions and runtime acceptance gates; this review does not authorize implementation or certify a working v3 application.

Reviewed on 2026-10-03 with the requested Sol6.1 xhigh worker. Only this file and [the review evidence](../audits/review.json) were written. Main, alpha, historical/local Git objects and packaged reference evidence were read without application, database or provider actions.

## Verified coverage and consistency

| Independent check | Final result |
|---|---|
| Capability registry | 496 records: 241 domain/support and 255 Evry contracts; unique IDs; every record has target/spec/acceptance/package links. These are audit records, not 496 shipped features. |
| Database union | 84 distinct current-source tables plus four historical tables = 88 mapped records. Local-only failed retries and attachments are included; every table has a disposition and feature link. |
| Acceptance registry | 720 unique feature-scoped obligations; shared labels remain metadata. These are planned proof obligations, not executed test results. |
| Build graph | 86 packages, 272 prerequisite edges; acyclic; valid merge order; Mermaid and JSON agree. |
| Slice sequencing | All six explicit cumulative slice lists are dependency-closed. Early settings/People/ops foundations and an Evry read/write slice precede full assistant integration. |
| Estimate calculation | 222 engineer-days; 66 working days on the unrestricted weighted prerequisite path. The 14–20 week range is conditional on staffing, reviews and decisions. |
| Evidence preservation | All 1,956 main and 2,004 alpha captured file hashes match; pinned checkout heads and dirty statuses are unchanged. |
| Local links and identifiers | Zero broken Markdown links, unknown table IDs, package back-reference gaps, duplicate feature/table/acceptance IDs or missing acceptance bindings. |

The packaged reference payload independently matches SHA-256 `7933b93d693b73b3d8768aa2f7e2ad91fa665b6ec23127cb8b4856466d936f59`: 96 published global articles, 21 sections and seven system templates; no tenant article rows. The available snapshot resolves corpus acquisition. Editorial/currentness approval and regenerated versioned embeddings remain future gates.

## Findings and implemented documentation corrections

| Finding | Final correction |
|---|---|
| IR-001: table aliases and missed local declaration | Canonical exact IDs, separate operational notes, and the real local-only `communication_failed_retries` table reconcile the entire source union. |
| IR-002: repeated acceptance IDs | Unique parameterized records preserve each feature while keeping shared gate labels explicit. |
| IR-003: old credential internals promoted as target APIs | Public auth operations are normalized; Better Auth owns session/password mechanics; source helpers remain historical evidence. |
| IR-004: mailbox recovery before shared mail delivery | The early jobs package supplies transactional transport/templates/suppression/idempotency and is mapped to auth/invitation delivery. |
| IR-005: competing Evry ownership/freeze definitions | One domain/assistant ownership tree, one root freeze procedure and an explicit advisory-to-actual package crosswalk. |
| IR-006: one late all-feature assistant adapter task | Shared kernels plus 28 combinable module read/write review batches, an early assistant vertical slice, and a revised resource estimate. |
| IR-007: discoverability of seen-or-72-hour release | OD-016 identifies current behavior, preserved SME intent, owner and blocking packages. |
| IR-008: manual self-FKs described as absent | Declarations versus migration effects are distinguished; no live catalog claim is made. |
| IR-009: non-runnable slice package lists | Explicit cumulative machine-readable lists cover every prerequisite across all six slices. |
| IR-010: inventory mistaken for architecture | A complexity budget allows shared patterns, many-to-one aliases and combined delivery batches; recurring backend costs and human effort/duration assumptions are explicit. |


The [review JSON](../audits/review.json) preserves initial evidence, severity, corrections, final check results and hashes of the reviewed core artifacts. The initial findings are review history, not unresolved defects in the delivered plan.

## Substantive assessment and future gates

The architecture is implementable at the documented module boundaries: one PostgreSQL system of record, interactive transactions for real cross-record consistency, selective outbox/jobs for external effects, a small public contract boundary, and one domain operation layer shared by UI and Evry. It compares the user's leading Bun/Hono direction with Elysia and modular Next honestly and defers the final runtime choice to representative evidence. Re-estimation after the spike and first slice remains necessary, especially for assistant evaluation and reviewer capacity. The [complexity budget](architecture/complexity-budget.md) is a necessary constraint on that implementation: 86 work packages are delivery units, 28 adapter batches can share code and merge by domain, and 255 source contracts do not require 255 new model tools or APIs. A smaller bounded operation catalog may map source variants many-to-one, while explicit permissions, data completeness, history and failure fixtures preserve each useful behavior. Creating a bespoke registry/executor/package for each row would fail this review intent.

Methodology authority is preserved. The plan distinguishes the Playbook, active approved rubric, historical comments, later rulings, executable drift and alpha behavior. Human 4Cs/interview/commitment judgments remain human-owned; no-evidence and limited-visibility states remain explicit. The explicit contact-evidence decision protects the user-approved 14-day actual-contact intent from treating an administrative task as contact. The seen-or-72-hour fallback is an explicit decision rather than a silently changed threshold.

Privacy and authority are concrete: independent tenancy/coaching/oversight grants; consent distinct from notification preferences; private files and histories; filtered counts/exports/tools; fresh permissions at worker/execution time; exact immutable approval; stale revision/idempotency checks; and visible partial/unknown results. Evry's reviewed-write default is proposed, autonomy remains a user decision, and no pastoral judgment, prayer or biblical-counsel authority is delegated.

The separate backend must earn its recurring SSR hop, credential/CSRF/proxy/stream coordination, deployment, local/CI setup, compatibility and observability costs in the runtime spike. Elysia familiarity can lower maintenance cost; modular Next or a hybrid may be the proportional outcome. Shared operations, types and durable jobs alone do not require a separately deployed HTTP API. The 66-day figure sums assumed full-time human durations on the unrestricted prerequisite path; 222 human engineer-days is total effort. Neither estimates autonomous-agent throughput or removes SME/review/integration waits.

Future acceptance must observe every preserved capability's positive, denied, stale, failure and relevant correction/recovery paths. PostgreSQL races, real browser/file behavior, provider acceptance uncertainty, private upload cleanup, stream recovery, model grounding and retention posture need owned-environment proof. A source export, broad module ownership, high test count or semantic judge score cannot establish those outcomes.

No v3 implementation, migration, customer import, deployment or PR occurred. Source-defined database coverage is not a live catalog certification. Dependency versions are parent/root official-source evidence. The reference snapshot's checksum and global-only scope are verified; editorial review is still open. These are explicit future gates, not grounds to rewrite the preserved methodology or remove functionality.
