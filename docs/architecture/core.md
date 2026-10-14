# Core architecture

EveryField is one modular Next.js application with TypeScript, Better Auth, PostgreSQL on Neon, private Tigris objects, Resend mail and approved model adapters. Native UI, server entry points and Evry use the same scoped domain behavior. There is no separate backend, customer migration or universal workflow platform. The [adopted schema](../schema/target.json) is the reviewed starting design; builders may change it through reviewed migrations.

## Boundaries and ownership

The plan fixes behavior, privacy, transactions and proof obligations. Internal function names, types, signatures and file layouts belong to the builder. The [package plan](../plan/build-plan.md) assigns ownership and prerequisite interfaces.

Construct actor and acting context on the server from real authentication, one exact account or tenant, current grants and purpose. Caller IDs and expected revisions are inputs, never trusted authority. Account identity, CRM Person, ministry title, seat, Discovery relationship and affiliation are distinct. One account has at most one active seat. Platform grants are bounded permissions, never a private-data wildcard.

Authenticated-self Discovery access requires no tenant seat and grants none. It reaches only eligible own preplant documents, approved global Wiki and Discovery behavior. Conversations remain private to the original account, including when their acting context is a plant or organization. That context grants neither conversation ownership nor credential/private-care access.

The body-free `tenant` identifies account, plant, organization or the sole restricted global context. Separate `account`, `plant` and `organization` bodies retain their own rules. `record` binds each registered subtype's actual UUID, kind and owner through trusted constraints. A retained body-free identity grants no access. The global sentinel never appears as an application tenant or grants a seat. Plant child FKs include the plant owner; mixed-owner child FKs include the tenant owner. Organization kind and bilateral endpoints are checked separately. A sending church's network relationship grants no inherited plant access.

## Transaction boundary

Meaningful domain changes recheck live authority, lifecycle, expected revisions and request digest inside a short PostgreSQL transaction. Locks follow a stable order. Current facts, required history in `event`, receipt in `operation`, trigger-driven material revisions, and required local notice or durable `effect`, `job` and `mail` intent commit together. Failure of any required write rolls everything back. Collaborating domain behavior shares the transaction; provider/model calls run outside locks.

Exact replay returns the original receipt without repeating effects. Changed input under the same request key conflicts. Domain uniqueness still protects invitations, obligations, recurrence slots and assignments independently of request retry keys. Atomic meeting finalization includes its follow-up and evaluation duties; task recurrence includes exactly one successor and fresh one-level child tasks. Required local consequences cannot be postponed to an outbox merely for convenience.

Better Auth owns credential/session changes in its supported adapter boundary. Credentials may exist before atomic domain acceptance; that identity stays unprivileged until acceptance completes. The app appends a truthful security event after a successful auth call, without claiming credential-plus-domain atomicity. Private-care changes use only original-author history and never central audit or intelligence revision triggers.

Every durable Evry change requires review of exact effects and approval by its initiator, followed by fresh rights and revision checks. Approved reads and drafts need no blanket write grant. Reconnect cannot implicitly execute a proposal. Partial and unknown external outcomes remain truthful in their receipts.

## Execution, dates and projections

PostgreSQL `job` records hold ordinary durable work. Finite leases, monotonically increasing claim generations, bounded retries and current-source publication fences prevent stale workers completing work. Unknown provider acceptance requires reconciliation with the original key and evidence. [Execution](execution.md) defines the closed kinds and uniqueness recipes. Encrypted backups and restricted restore are a before-customer-data gate; build work relies on native seven-day Neon and Tigris history.

Date-only deadlines use the plant-local day. Timed appointments retain the chosen instant, confirmed IANA zone and gap/fold resolution. Follow-up due dates use meeting local date plus two calendar days; performance measures use 48 elapsed hours from the actual origin instant. Future calendar changes are previewed and replanned with stable recurrence identities; historical evidence does not move.

Global reference versions and activation history are immutable. Organization Wiki access requires current source entitlement on every body, history, citation and file path. Plant source precedence is sending churches in explicit order, then networks, then global. One eligible actual reader must complete all six canonical Discovery articles strictly above 80 percent; readers cannot pool partial progress. Plant creation enters Phase 1 independently.

Every read/list/count/search/export/render/stream/download/model context applies current authority and a purpose-specific projection. Raw rows and protected contributor manifests never become transport output. Shared persistent private response caches are disabled initially. [Security](security.md), [audit](audit.md), [assessment](assessment.md) and [recovery](recovery.md) define the remaining boundaries.

## Operation inventory and shared boundary rules

The [operation inventory](../catalog/operations.json) names capabilities for native/Evry parity, their producers, callers, affected records, side effects and cases. It does not define function signatures. Requirements and cases retain operation-specific behavioral restrictions. Parameter names, internal types, result layouts, error-code names, adapter symbols and locking mechanics belong to builders. Closed validated inputs must reject unsupported or forbidden choices, keep explicit clears distinct from omission where behavior requires it, and never accept caller-provided authority or model-minted proofs. Incomplete drafts may remain incomplete until review.

The shared error envelope provides a safe outcome code and details, a correlation identifier and truthful retry eligibility. Denials reveal no forbidden record existence. Unknown external acceptance, publication or delivery is a durable outcome requiring reconciliation, never an asserted failure or permission to retry blindly. Concrete transport fields and error variants are builder choices.

The transaction and Evry review rules above apply once to all durable domain operations. Review binds the initiating account and acting context, exact targets and changes, current revisions and grants, exclusions, induced consequences, outbound bytes and audience, file contents and format, dates and confirmed timezone choices, and expiry. A changed review-sensitive fact supersedes approval. A conversational yes is draft intent; only trusted UI approval authorizes execution. Native passive viewing does not require fabricated approval.

Authorized pure reads have no durable domain effects and do not initiate model generation. Actor-private Evry conversation, attachment, draft, proposal, run and receipt protocols grant no domain authority and never advance intelligence inputs. Domain effects require a separately approved owning-domain operation. Trusted internal producers and jobs remain unavailable as model or arbitrary HTTP executors. Model tools expose bounded authorized reads and candidate preparation, with no approval, command executor, arbitrary code, SQL, network or filesystem capability. Tool grouping and dispatch implementation belong to builders.

These are design contracts. Documentation checks do not establish application, SQL, trigger, auth, provider or restore acceptance.
