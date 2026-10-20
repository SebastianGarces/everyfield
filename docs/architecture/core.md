# Core architecture

Native UI, server entry points and Evry use the same scoped domain behavior. The [package plan](../plan/build-plan.md) assigns producers and prerequisite interfaces. There is no customer migration. The [schema catalog](../schema/target.json) describes the current implementation and may evolve through reviewed migrations that preserve the behavior below. Default implementation choices belong to [EveryField patterns](intent://local/note/df294729-367b-493b-9faf-654cf6b25b62).

## Boundaries and ownership

These contracts define product behavior, privacy and proof obligations. Builders choose internal APIs, types, transactions, storage and file layouts using the current patterns. A different mechanism must preserve the same observable outcomes.

Derive actor and acting context from real authentication, one exact account or tenant, current grants and purpose. Caller-provided IDs and reviewed state never establish authority. Account identity, CRM Person, ministry title, seat, Discovery relationship and affiliation remain distinct. One account has at most one active seat. Platform grants are bounded permissions, never a private-data wildcard.

Authenticated-self Discovery access requires no tenant seat and grants none. It reaches only eligible own preplant documents, approved global Wiki and Discovery behavior. Conversations remain private to the original account, including when their acting context is a plant or organization. That context grants neither conversation ownership nor credential/private-care access.

Account, plant and organization ownership remain distinct. Every subject and child record belongs to its actual owner; a missing or nullable owner cannot bypass isolation. An identity retained after deletion grants no access. Restricted global references grant no application tenancy or seat. Organization kind and each bilateral endpoint must match the requested relationship. A sending church's network relationship grants no inherited plant access.

## Transaction boundary

Meaningful domain changes recheck live authority, lifecycle and any reviewed facts that can change the outcome. Required current facts, history, audit and local consequences succeed or fail together. Failure of any required write rolls everything back. Required external work remains recoverable after a crash. Provider or model latency must not prevent concurrent authorized work.

Exact replay returns the original recorded outcome without repeating effects. A retry identity cannot be reused for different input. Invitations, obligations, recurrence slots and assignments remain unique independently of retries. Atomic meeting finalization includes required follow-up and evaluation duties; task recurrence creates exactly one successor and fresh one-level child tasks. Background work cannot hide a missing required local consequence.

Better Auth owns credential/session changes in its supported adapter boundary. Credentials may exist before atomic domain acceptance; that identity stays unprivileged until acceptance completes. The app appends a truthful security event after a successful auth call, without claiming credential-plus-domain atomicity. Private-care changes use only original-author history and never central audit or intelligence revision triggers.

Every durable Evry change requires review of exact effects and approval by its initiator, followed by fresh rights and revision checks. Approved reads and drafts need no blanket write grant. Reconnect cannot implicitly execute a proposal. Partial and unknown external outcomes remain truthful in their receipts.

## Execution, dates and projections

Background work survives interruption, has bounded attempts and cannot publish after cancellation, loss of execution ownership or a relevant source change. Unknown provider acceptance requires reconciliation using the original attempt and actual evidence. [Execution](execution.md) defines the required work and failure behavior. Encrypted backups and restricted restore are a before-customer-data gate; build work relies on the approved seven-day recovery history.

Date-only deadlines use the plant-local day. Timed appointments retain the chosen instant, confirmed IANA zone and gap/fold resolution. Follow-up due dates use meeting local date plus two calendar days; performance measures use 48 elapsed hours from the actual origin instant. Future calendar changes are previewed and replanned with stable recurrence identities; historical evidence does not move.

Global reference versions and activation history are immutable. Organization Wiki access requires current source entitlement on every body, history, citation and file path. Plant source precedence is sending churches in explicit order, then networks, then global. One eligible actual reader must complete all six canonical Discovery articles strictly above 80 percent; readers cannot pool partial progress. Plant creation enters Phase 1 independently.

List totals, counts and group buckets come from the authorized database query, never from returned pages or selected rows; a deliberately unmeasured count is null, and an unavailable read returns unavailable, never zero.

Every read/list/count/search/export/render/stream/download/model context applies current authority and a purpose-specific projection. Raw rows and protected contributor manifests never become transport output. Shared persistent private response caches are disabled initially. [Security](security.md), [audit](audit.md), [assessment](assessment.md) and [recovery](recovery.md) define the remaining boundaries.

Simple reads and writes complete in under one second end to end on a production build. Reports and analytics may take longer with disclosed expectations. Actions update the visible state optimistically and confirm or clearly roll back on failure. Avoid needless requests.

## Operation inventory and shared boundary rules

The [operation inventory](../catalog/operations.json) names capabilities for native/Evry parity, their producers, callers, affected records, side effects and cases. It does not define function signatures. Requirements and cases retain operation-specific behavioral restrictions. Parameter names, internal types, result layouts, error-code names, adapter symbols and locking mechanics belong to builders. Closed validated inputs must reject unsupported or forbidden choices, keep explicit clears distinct from omission where behavior requires it, and never accept caller-provided authority or model-minted proofs. Incomplete drafts may remain incomplete until review.

The shared error envelope provides a safe outcome code and details, a correlation identifier and truthful retry eligibility. Denials reveal no forbidden record existence. Unknown external acceptance, publication or delivery is a durable outcome requiring reconciliation, never an asserted failure or permission to retry blindly. Concrete transport fields and error variants are builder choices.

The consistency and Evry review rules above apply to all durable domain operations. Review binds the initiating account and acting context, exact targets and changes, current grants and relevant source state, exclusions, induced consequences, outbound bytes and audience, file contents and format, dates, confirmed timezone choices and expiry. A changed review-sensitive fact supersedes approval. A conversational yes is draft intent; only trusted UI approval authorizes execution. Native passive viewing does not require fabricated approval.

Authorized pure reads have no durable domain effects and do not initiate model generation. Actor-private Evry conversation, attachment, draft, proposal, run and receipt protocols grant no domain authority and never advance intelligence inputs. Domain effects require a separately approved owning-domain operation. Trusted internal producers and jobs remain unavailable as model or arbitrary HTTP executors. Model tools expose bounded authorized reads and candidate preparation, with no approval, command executor, arbitrary code, SQL, network or filesystem capability. Tool grouping and dispatch implementation belong to builders.

These are design contracts. Documentation checks do not establish application, SQL, trigger, auth, provider or restore acceptance.

## Organization Person and residency foundation

ADR-001 allows a Person to belong to an exact plant or organization while preserving existing plant-only consumer rules. Organization stages and programs remain separate from recruitment. The reviewed [Person inventory](person-references.json) covers invitation, pipeline, enrollment and resident-link lifecycle, merge and inverse behavior. S0 producers prove ownership, concurrency and privacy boundaries before later consumers. See [REQ-MUL-001 through REQ-MUL-017](../product/people.md#multiplication-pathway-contract).