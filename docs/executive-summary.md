# Executive summary

Rebuild Everyfield as a fresh, feature-preserving product using modern TypeScript tooling and simpler operational boundaries. Keep the SME church-planting Playbook and Plant Intelligence rubric authoritative. Their vision meetings, ministries, commitments, interviews, 4Cs, church phases and assessment intent are product foundations; existing implementation decisions and old engineering invariants are evidence to challenge.

The plan supplies detailed source inventories, module specifications, database/relationship dispositions, architecture decisions, a first-class Evry operating model, dependency research and a runnable-in-the-future work graph. It contains no v3 application code. Existing v2 source and local alpha work were read without changes, and no customer migration is planned.

## What the audit found

Merged main is `18fc1a505c64615fe9ef197dba0e2cd037063d31`; PR913's clean alpha checkout is exactly `2107df58885c883960422ce7e60719f0adbac0e4`. The diagnostic branch `81abfcc7fb150fdfa5fa87392052dd07da966d03` adds more accurate failed-assessment attribution. Main and alpha currently retire Evry, while the separately pinned local/historical work contains substantial implemented assistant operations. These baselines are distinguished throughout the [source manifest](evidence/source-manifest.json).

The 496 registry rows comprise 241 domain/support capability records and 255 Evry infrastructure/operation/helper contracts. Of the domain/support records, 210 are main, 14 local-only, 13 partial, three dead and one uncertain. Evry contributes 235 local-only and 20 retired records. This preserves evidence without presenting unmerged work as shipped functionality. Every record has source evidence, permission/state/validation/failure coverage, target ownership, planned acceptance and work-package links.

All 84 distinct schema declarations across the three source families are mapped, plus four replaced historical tables. The map records 209 important physical-FK source edges, including manually installed constraints and local-only retry/attachment models; declared schema and migration drift are qualified. No live database catalog was inspected. The file/callable ledgers route 2,893 main/alpha source-file records and 4,174 lexical callable records to feature or module ownership. A helper or test-file count is not product coverage.

## Proposed architecture and preservation choices

Use one framework-independent domain operation layer, one PostgreSQL database, typed contracts and explicit transaction boundaries. Next.js owns web composition. Bun/Hono is the leading API/worker candidate, while Elysia offers familiar Bun-oriented typed ergonomics and modular Next offers fewer deployment boundaries. The [ADR comparison](architecture/decisions.md) and WP-003 require the same representative auth/recovery, rollback, document and stream slice before choosing. Hosting remains undecided.

The biggest simplifications are one authorized handler shared by web/Evry, one credential owner, one mail/storage/job boundary, one assistant lifecycle, explicit short SQL transactions and no generic repository, command bus or workflow platform. The [complexity budget](architecture/complexity-budget.md) separates exhaustive evidence from architecture: two leading application deployables, an optional separate worker process, and domain folders rather than a service fleet. The86 work packages and28 adapter batches are review units that can be combined;255 historical/local tool contracts do not require255 new APIs. Preserve variant semantics through a many-to-one source-to-target crosswalk.

A separate Bun/Hono backend has genuine recurring cost: SSR incurs a client hop; auth/cookies/CSRF/proxy/stream routing need coordination; deployment, health/traces, local/CI setup and runtime compatibility have another surface. The split must earn that overhead in the representative slice. User familiarity can make Elysia cheaper to maintain, and modular Next or a hybrid can be the right outcome if the additional boundary has insufficient value.

Better Auth replaces custom credential/session plumbing. Domain grants retain actual tenancy, owner/admin/member distinctions, independent coaching, consent relationships, platform administration and object-level access. UI and Evry call the same authorized domain operations. Server actions may be thin web adapters; they must not be the only executable domain boundary. PostgreSQL outbox/jobs provide durable external effects where needed; a generic event bus, blanket CQRS or extra service fleet is not justified.

Keep workflows and history while simplifying repeated wrappers and overlapping operational paths. Attendance finalization must retain reconciliation and managed follow-up tasks. Keep separate meeting-origin 48-hour metrics, due-day semantics and 14-day actual-contact freshness; the alpha shortcut treating any completed person-linked task as contact is an explicit SME/product decision. Preserve recurrence/dependency and merge/correction integrity. Replace duplicated mail paths with one transport, suppression, idempotency and recovery boundary, available before auth recovery and invitations. Unknown provider acceptance must not become a blind resend.

Plant Intelligence keeps deterministic fact lineage, immutable rubric/reference versions, unknown evidence states, bounded grounded AI evaluation and truthful retry attribution. Model work runs outside database transactions and publishes by a guarded revision. Software changes cannot silently adjudicate rubric wording, team denominators or advanced-stage regression. The approved planter-first intent and implemented seen-or-72-hour oversight fallback are separately recorded for decision.

Evry is an operational assistant for reading, preparing and carrying out named domain work. The accepted initial policy (PD-001) allows authorized reads/drafts and requires human approval after review of an exact immutable write plan, permission rechecks, stale-plan rejection, receipts and bounded recovery/compensation. It has no pastoral judgment, prayer or biblical-counsel authority. Human ownership remains explicit; autonomous mutation classes are deferred and need a new user decision. Its 28 module adapter packages integrate incrementally with domain lanes rather than accumulating in one late parity task.

## Fresh bootstrap and delivery sequence

Bootstrap new projects from the verified, checksummed global reference candidate: 96 published Wiki articles, 21 sections and seven system templates. Keep the captured Playbook/rubric versions and canonical stable template identities. The candidate needs editorial/currentness approval; old customer content and embedding vectors are excluded. New embeddings must derive from an approved manifest and pinned model when implementation is authorized.

The [86-package build plan](plan/build-plan.md) stages a usable vertical slice before completing the full target. It freezes common contracts, then tenancy/person contracts, then attendance/follow-up/task/phase contracts, and finally rubric publication and reviewed assistant plans. The JSON prerequisite graph and Mermaid graph agree and are acyclic. Slice closure, cross-module races, tenant/privacy negatives, file/provider/browser boundaries and every feature's acceptance are release gates.

The initial estimate is 222 **human engineer-days** with four engineers, one QA and fractional SME/ops. The66-working-day figure is an assumption-based prerequisite-duration lower bound with unlimited lane capacity, computed from assumed full-time human package durations. It is not a calendar deadline or an agent-throughput estimate. A14–20 week full-target range assumes available reviewers, timely product/source/provider decisions and representative spike success; agent assistance does not eliminate these gates. Re-estimate effort and elapsed delivery after the spike and first operational slice.

| Capacity / owner | Parallel responsibility | Merge discipline |
|---|---|---|
| Engineer 1 / integrator | Contracts, auth/grants, schema baseline, cross-module integration | Own common envelopes and schema review; serialize migrations/contracts; changes trigger consumer checks |
| Engineer 2 | People, teams, meetings and task lane | Implement authorized domain operations before UI/Evry adapters; own workflow/race fixtures |
| Engineer 3 | Communication, documents, Wiki, jobs and ops lane | Own shared mail/storage/job boundaries; unblock auth mail early; reconcile provider/format evidence |
| Engineer 4 | Intelligence, phases, launch and Evry framework/adapter lane | Preserve SME lineage; pair with domain owners for each assistant adapter; no duplicate domain policy |
| QA plus fractional SME/ops | Browser/provider/file acceptance, methodology adjudication, privacy and operational rehearsal | Independent evidence and decision sign-off; capacity reserved beyond developer unit checks |

These are lanes, not four people writing every shared file concurrently. During freezes, one owner merges shared contract/schema changes; other workers use disjoint module/adaptor/test paths. Domain and assistant packages can run in parallel only after their typed interface and authorization fixtures are accepted. Integrate small slices continuously; WP-056/057 are final broad gates, not the first integration opportunity.

## Decisions before dependent implementation

The [17 open decisions](open-decisions.md) include runtime topology and hosting, reference-version approval, Evry authority, contact evidence, denominator/status semantics, retention/privacy settings and correction limits. They have owners and blocking packages. No feature removal is presumed approved. Historically deferred FRDs remain explicit backlog evidence rather than invented implemented features.

Independent reviews and [mechanical validation](evidence/validation.json) check plan consistency and source preservation. They do not certify runtime behavior: no v3 tests, live provider checks, database migration or deployment occurred. Remaining semantic proof belongs to the named future acceptance obligations; source counts do not replace it.

## Current planning priority

Complete the holistic rebuild plan and resolve its architectural/product decisions before implementation. [Five accepted user rulings](decisions/user-rulings.md) settle reviewed Evry writes, private-check-in exclusion from Evry/model context, advanced person-stage preservation, Vision-only first-time attendance and typed follow-up outcomes with contact-only freshness. They do not establish whole-plan readiness. Vertical slices describe eventual execution order and preserve the full capability target.
