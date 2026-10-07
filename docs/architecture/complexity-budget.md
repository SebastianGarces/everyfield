# Keep the rebuild proportional

The exhaustive audit is larger than the recommended software architecture. **496 evidence records, 255 Evry records, 86 work packages and 28 assistant adapter batches are traceability and review units. They are not required services, libraries, endpoints, tool names or runtime abstractions.** Preserving a legacy capability means preserving its useful behavior and safety/history semantics, with a recorded disposition; it does not require copying every historical contract one-for-one.

## Minimal operational shape

The leading separate-backend option has two application deployables: Next.js web and one Bun API application. A durable worker can run alongside the API where hosting permits or as a third process from the same code/artifact when isolation is needed. All domain ownership groups share one PostgreSQL database and one schema release owner. Private object storage and the selected mail/model providers are supporting services. No module gets an independent database, queue broker or microservice by default.

The modular Next option has the web/API deployable plus a durable worker where the host requires one. An embedded Hono/Elysia route adapter is also viable. These options keep the same domain handlers, contracts and database integrity, so the runtime spike does not require a second domain implementation.

Start with these concrete implementation boundaries:

- Domain functions and permission-filtered reads, grouped into cohesive source folders. A folder is not a separately published package or service.
- Thin HTTP and assistant adapters that share those functions and validation. Server-action wrappers exist only where web integration needs them.
- One maintained credential/session owner; explicit, readable domain grants and object policies.
- One private-artifact boundary, one mail dispatch/reconciliation boundary and one durable job/outbox mechanism, reused by actual workflows.
- One durable assistant conversation/run owner, exact reviewed plans and command-specific recovery. No generic workflow engine or mirrored conversation database.

The suggested `packages/*` paths express ownership, not a mandatory package-manager workspace per domain. Combine adjacent domain folders or UI forms when their changes/authority are cohesive. Introduce a new abstraction only after at least two actual consumers demonstrate the same stable contract, and keep a plain function when it is clearer.

## Collapse operation aliases without losing behavior

The implementation contract freeze produces a many-to-one crosswalk from every source feature/operation to target behavior. Record `direct`, `alias`, `internal-support`, `replaced-mechanism` or `needs-decision`, plus target operation, variant/discriminator, permission and acceptance IDs. Do not use an unbounded generic mutation/search operation to reduce endpoint count.

| Legacy surface family | Proportional target | Preservation gate |
|---|---|---|
| UI action, service helper and Evry preparation for the same person change | One authorized `people.update` handler; separate UI/tool presentations | Protected fields, explicit clears, revisions, actor/object denial and exact history remain exercised |
| Read list/count/group variants | Shared scoped query functions and a bounded documented query contract; a few model tools can select approved variants | Cursor/order/entity-count semantics, field minimization and relationship predicates remain explicit; no SQL-from-model |
| Credential/token/cookie helpers | Better Auth adapter internals and a small product auth interface | Registration/recovery/revocation/redirect/rate behavior preserved; helpers do not become assistant tools |
| Selected, one and all notification-read commands | One handler can share code with a typed selection variant; UI/tool names may stay distinct where clarity helps | Selected maximum/dedup, actor-owned IDs and all-versus-selected semantics remain different fixtures |
| Bulk send, nonopener resend and failed-recipient retry | One transport and durable dispatch ledger; workflow-specific preparation rules remain | Proven failure versus unknown state, frozen retry content, consent/suppression and provider safety window cannot be collapsed |
| Meeting-invite recipe and its individual commands | Explicit small orchestration of create meeting → add guests → reviewed send using shared handlers | Dependency outputs, partial receipts, safe retry and no duplicate send; no standalone workflow engine |
| Old Eve/JeV duplicated persistence and runtime wrappers | One chosen assistant lifecycle plus retained audit/context capability | Reconnect/cancel/replay, exact approval, revocation, attachments and failure/correction proof |

Source aliases can remain compatibility labels in evidence while the new tool/API surface is smaller. UI actions and assistant tools can intentionally expose different affordances over the same handler; their implementations must not duplicate the business rule. Export variants and private fields cannot disappear merely because a simpler read tool is preferred.

## Work packages are scheduling batches

WP-059..086 divide fourteen domain groups into read and reviewed-write acceptance batches. They do not require 28 installed adapters or packages. A domain owner may implement each pair together using one registration pattern and fixtures, or merge adjacent pairs when the interface and review scope are manageable. Keep IDs/backreferences to demonstrate what passed. Separate reads and effects in authorization/evaluation even when they share a source file.

Likewise, the 86-package graph is a proposed review schedule, not a fixed implementation bureaucracy. Combine same-owner adjacent packages if inputs, outputs and acceptance remain reviewable; preserve the prerequisite and feature-to-gate crosswalk. Split a package only after actual complexity demands it. The work graph is larger because it accounts for hidden behavior, correction paths and local capabilities that a generic MVP would omit.

The 66-working-day value is an **assumption-based, unlimited-capacity prerequisite-duration estimate**: sum the assumed full-time human engineer-day duration along the longest dependent chain. Total effort is separately 222 human engineer-days. Neither number measures autonomous agent throughput. Four human engineers plus QA and fractional SME/ops cannot attain unlimited lane capacity; reviews, model/provider decisions and operational gates require human availability. Agent-assisted parallel coding may alter effort but is not assumed to remove SME authority, integration work or elapsed waits. Re-estimate after a measured slice.

## Genuine separate-backend costs and selection rule

Bun/Hono adds a server-client hop for SSR, a second runtime/toolchain compatibility surface, API contract/version coordination, proxy/cookie/CSRF and stream-routing configuration, coordinated deploys, separate health/traces/logs and more local/CI/environment setup. The team also maintains credentials propagation and failure handling across the web/API boundary. These are recurring costs even if the API framework itself is small.

The split earns those costs only if independently run streams/workers, clearer operation ownership or deployment/runtime flexibility provide observed value. Elysia may reduce route/type integration effort given the user's experience; modular Next may be the cheaper maintainable choice. WP-003 compares equivalent behavior and maintenance burden, not synthetic throughput or framework preference. If a separate API does not earn its boundary, choose modular Next or a hybrid and retain the framework-independent operation/worker design.

## Complexity acceptance gate

Before C0/runtime freeze and after the first operational slice, the reviewer checks: no duplicated domain handlers; no table-per-service design; no wholesale recreation of 255 tool contracts; no generic repository/command/DI/workflow framework; one mail/storage/job/assistant owner; a smaller explicit target operation crosswalk; and documented recurring cost for each deployable. A proposed simplification must point to the same source feature and future acceptance so endpoint reduction cannot hide capability loss.
