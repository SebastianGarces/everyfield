# EveryField v3 — whole-plan decision agenda

Review addendum, 2026-10-03. **Purpose: complete the rebuild plan and its consequential decisions before implementation. There is no urgency to begin building.** This agenda supersedes the earlier review's prioritization around unblocking a narrow first slice. The earlier source findings remain evidence where still applicable; its sequencing recommendation is not the user's current direction.

The user wants to use the experience of building v2 to choose the full product and architecture deliberately. We should settle the target, semantics, authority and operational design together, then construct an executable build plan. “It can wait until a later slice” is not a disposition. A capability can be deliberately excluded or scheduled later only through an explicit scope decision; implementation order does not excuse leaving its behavior undefined.

The substantive appendices were prepared by the same independent Astra high reviewers for product, architecture and cross-module semantics. This is a planning review, not implementation or runtime certification. No application code, database activity, deployment, application-provider inference or external upload occurred. Only separate review documents are delivered; existing plan documents and the concurrent explorer/worker files are not edited by this review.

**Disposition: a sound foundation, but not yet a complete, proportionate implementation-ready plan. No-go for beginning implementation in its current state; continue the whole-plan discussion and reconciliation.** This is not a rejection of the product or SME methodology. The issues below are concrete gaps the planning work can resolve. Future runtime uncertainty can remain only with an explicitly selected design, test protocol, owner and fallback; product meaning cannot remain an unnamed coding choice.

| Priority | Required outcome | Consequence for the plan |
|---|---|---|
| High — methodology and scope | Approve cohorts, temporal evidence and measured/attested/unknown semantics for every lens and phase criterion; dispose of intended-only capabilities explicitly. | Prevent a complete-looking UI from asserting unsupported facts or quietly replacing the Playbook. See the interaction appendix's full criterion and lens matrices. |
| High — authority and lifecycle | Settle field-level coach/oversight access, personal history after ownership transfer, correction/merge consequences and auth/domain failure behavior; preserve all five accepted rulings. | Determines entity relationships, projections, operations and irreversible effects before contracts are divided among agents. |
| High — consistency and execution | Specify attendance/task atomicity, material-source watermark, assessment request/publication identity, worker fencing and shared-writer ownership; repair their DAG dependencies. | Prevent valid-looking independent modules from losing effects, publishing stale assessments or conflicting during integration. |
| Worthwhile correction — architecture and cost | Select a modular topology and one runtime/client/job path on actual requirements; bound model and operating costs with approved assumptions. | Prefer the smallest coherent design. Next plus worker is the proportional default; separate Bun remains a fair choice, with Elysia familiarity a meaningful factor. |
| Worthwhile correction — reference and delivery lifecycle | Specify reference/corpus release and rollback, private artifacts, bootstrap/support/recovery, full acceptance ownership and auditable explorer updates. | Makes the whole target operable and progress claims reviewable without creating a generic platform. |
| Optional polish | Consolidate duplicate prose, improve navigation and refine visual presentation after the semantic contracts agree. | Does not block planning signoff unless it hides a real contradiction. More package IDs, diagram detail or green counters do not resolve the items above. |

The smallest useful **first discussion** is full-target scope and authority, domain/history ownership, and methodology evidence. It is not a shortcut to build approval: the later architecture, operational and verification groups must also be closed before implementation. Engineering defaults should be reviewed in coherent bundles; the user and SMEs should spend their attention on consequential rights, meanings and tradeoffs.

## Accepted foundation — do not reopen or mistake for implemented work

The parent supplied the user's explicit acceptance of these five rulings. They are now recorded in [the canonical user-rulings register](/Users/sebastian/dev/everyfield_v3/docs/decisions/user-rulings.md) as PD-001–005:

| Accepted ruling | What it resolves | What it does not silently decide |
|---|---|---|
| Evry can read/draft; durable writes require exact human review | Initial authority policy, including the need for a trusted reviewed execution path | Delegated autonomy, new actor scopes, indefinite approvals, disclosure of otherwise restricted data or additional inferred effects |
| Private check-ins are excluded from Evry initially; native planter history remains | The current assistant/private-care channel boundary | Coach/network access, historical authorship after ownership transfer, deletion/retention, or any future opt-in |
| A new interview or commitment does not automatically demote an advanced person | The erroneous regression behavior in v2 must not be reproduced | Every possible advancement, commitment-type interpretation, witness requirement or human judgment |
| First-time vision attendance depends only on prior vision attendance | An unrelated ministry/team meeting cannot remove first-vision status | All consequences of backdated attendance, corrections, deletion, merge, rescheduling or historical metric restatement |
| Contacted, attempted/no contact, administrative completion and no longer needed are distinct; only confirmed contact refreshes actual-contact freshness | Task completion cannot manufacture contact evidence; waivers are not successful contact | Every denominator, time window and label in follow-up performance, or how corrections restate a previous measurement |

These rulings outrank any older pending wording. They are **accepted product decisions**, not implemented capabilities, passing tests or a reason to advance explorer completion. During this review the concurrent documentation worker published the canonical rulings, marked OD-003/004/017 accepted, added OD-018 for first-time Vision attendance, and repaired the private-check-in row in `docs/evry-design.md`. I verified those visible document updates; that does not certify every downstream acceptance mapping or runtime behavior. The SME Playbook, reviewed Plant Intelligence rubric, human 4Cs/interviews/commitments, vision meetings and ministry preparation remain foundations. This is a fresh project with no customer-data or migration-ledger import.

## How to use the agenda

Read the whole architectural and product picture before walking through individual choices. Then discuss coherent groups in the order below. A recommendation is a proposed answer; it is not approved because it appears in a table. Confidence describes how strongly the available evidence supports it, not whether the user has consented.

Keep two separate statuses for each item:

- **Decision:** accepted user ruling, preserved approved baseline, recommended engineering design, unresolved product/SME choice, or conditional choice awaiting named evidence.
- **Verification:** source-inspected, specification-defined, future test specified, implemented, or verified at a named artifact revision. Only the first three are possible in this documentation task.

For each unresolved question, the appendices supply its evidence, recommended answer, alternative, consequences and dependencies. Related rows can be discussed together, but should retain separate dispositions when they affect different rights or meanings. A source-code behavior can be a defect; a source comment can be unimplemented; a library's documented feature can still require integration proof. None is automatically a user-approved product answer.

## Recommended discussion order across the full target

| Discussion group | Decisions to settle together | Why this order matters |
|---|---|---|
| 1. Product boundary and authority | Full-target capability dispositions, actor types, one-seat/coaching model, administrative ownership versus pastor identity, platform support powers, relationship consent, precise sensitive-field access, public/global content boundary | Determines which operations may exist, which data can cross boundaries and what the architecture must enforce. Avoid designing a generic tenant service and discovering incompatible privacy later. |
| 2. Domain identity and lifecycle | Account↔Person linkage, invitations and onboarding, households, recruitment stages, human records, commitment types/witnesses, retirement/deletion, merge, correction reasons/history, ownership handover and retention | These identities and histories are shared by meetings, teams, tasks, documents, communications and AI. They must agree before modules are divided among build agents. |
| 3. Operational workflows and time | Vision attendance/finalization/corrections, follow-up obligations and outcomes, task ownership/dependencies/recurrence, RSVP authority, ministry roles/training, template offers, launch milestones and outcomes, LocalDate/Instant/timezone/DST policies | A local operation often changes another module's evidence. Specify the transaction, downstream work and correction consequences together. |
| 4. Methodology and measurement | All eight lenses and all seven phase criteria, committed-adult cohort, denominators, historical eligibility, continuity evidence, attestation sources/freshness, actual-contact versus task metrics, eight ministry areas versus ten operational templates | Preserving rubric text is insufficient when data cannot support the claim. Choose measured/attested/unknown honestly without replacing the SME benchmark. |
| 5. Reference and AI systems | Approved content/editorial lifecycle, corpus generations and rollback, fact snapshots and publication freshness, grounding/retry limits, oversight concern pairing/release, private-care separation, Evry operation coverage, approvals/recovery, conversation retention and model data posture | Defines the information the judge and assistant may see and the meaning of their outputs. These are two distinct systems sharing approved facts and operations, not one unrestricted agent. |
| 6. Software and operations architecture | Deployment topology and runtime, Better Auth/domain transaction boundary, SQL/entity design, public contracts, jobs/outbox/fencing, storage and rendering, observability, environment/bootstrap/admin lifecycle, hosting/capacity/cost, disaster recovery | Select the mechanism against the complete product requirements and v2 failures. Do not let a framework pick the domain model or copy every old table to avoid making a design choice. |
| 7. Verification and build organization | Cross-module acceptance, source-to-target mappings, methodology fixture approval, negative/race/failure tests, UI accessibility and actual artifacts, package ownership/integration, canonical status evidence and explorer regeneration, release/recovery rehearsal | Turns agreed intent into a build that agents can execute without inventing policy or competing over shared files. This planning work precedes implementation; its tests are not falsely reported as run. |

The order is for discussion, not a waterfall coding schedule. Cross-links in the appendices identify where a later architectural result might require revisiting an earlier proposed mechanism. Accepted methodology or privacy is not changed merely to accommodate a library limitation.

## What the fuller v2 review changes

The initial audit was strong at enumerating operations, tables and source surfaces. The whole-plan review exposes a more consequential distinction: **a named capability is not necessarily a valid measurement or coherent workflow**.

- “Committed adults” needs an approved adult/cohort definition and actual supporting data. Existing commitment rows alone do not establish adult eligibility or the intended treatment of retired, inactive, repeated, backdated or seat-linked people.
- A leadership signal described as 60 days of uninterrupted attendance and serving needs temporal evidence for that continuity. Contact creation age, lifetime attendance count and present membership are different facts. Software must not manufacture readiness or spiritual qualification from them.
- Some named phase criteria are currently untracked; others use proxies that do not establish the condition, such as total launch attendance for “guest data entered.” Every criterion needs an explicit measurement, human attestation, or honest unknown state. The phase remains a human declaration, not an automatic gate.
- The approved first-vision and contact-outcome rulings change multiple consumers: attendance classification, obligation generation, completion history, contact freshness, PI facts, dashboards, exports and assistant explanations. Updating only a form or decision row would leave the product inconsistent.
- Private-care access is also a channel/purpose restriction. An actor's native access does not by itself authorize sending the same data to a model. The now-accepted exclusion must apply to histories, summaries, traces and indirect reads as well as named tools.

The interaction appendix traces these findings to actual source and specifies the full criterion/lens coverage. They are reasons to improve the plan before implementation, not reasons to abandon the SME methodology or to rush into a spike.

## Architectural lessons that should shape the whole design

The v2 lessons in `docs/lessons.md` are useful but should be translated into a small number of concrete boundaries:

| V2 failure or complexity | Proposed whole-design response | Important limit |
|---|---|---|
| Business rules and permissions scattered through server actions and duplicated assistant effects | One authorized domain operation per real use case, shared by UI and Evry; thin transport adapters | A giant generic dispatcher is not required. Distinct operation semantics should remain readable. |
| Non-interactive transaction constraints and best-effort event callbacks create partial changes | Short interactive SQL transactions for facts/history/critical obligations; outbox only for durable asynchronous/external work | Provider calls and model inference stay outside SQL locks. An outbox does not justify delaying the source watermark needed for freshness. |
| Flat nullable account/tenant pointers blur independent grants | Explicit tenancy, coaching, association, consent and platform authority with scoped DTOs | Normalized membership does not silently authorize multiworkspace access or coach writes. |
| Generic task completion stands in for actual contact | A typed contact/outcome record and source-linked follow-up obligation | Task closure, success within 48 hours and actual contact freshness remain different claims. |
| Current labels infer historical or human facts | Versioned evidence with explicit measured/attested/unknown semantics and approved cohorts | Do not introduce new spiritual judgments or silently weaken criteria to fit existing columns. |
| Read-time seeding and template display names cause resurrection or duplication | Stable versioned reference keys and explicit, idempotent offer/initialization commands | User deletions/declines are durable choices, not missing seed data. |
| Corrections/merge can lose or misattribute downstream evidence | Operation-specific history and a complete reference registry extended with each new consumer | No universal unmerge or email undo; immutable history must still respect retention and privacy. |
| Process-local jobs, unknown mail outcomes and expiring claims | One durable scheduling/effect mechanism with claim fencing, business idempotency and visible reconciliation | A lease does not guarantee only one external computation; provider guarantees and budget consequences remain explicit. |
| DB-only content and ordinal embedding upserts drift | Approved reference releases, immutable article/corpus generations, deliberate activation and rollback | Editorial approval, canonical identity and historical citations are independent of successful syntax compilation. |
| Duplicated Eve/application histories and broad tool parity | One app-owned conversation/run/proposal/receipt model and a bounded model-facing catalog over domain operations | Preserving capabilities does not require copying 255 contracts, fourteen storage tables or a historical runtime framework. |
| Broad shared paths and proxy completion signals undermine parallel work | Disjoint domain ownership, one owner for truly shared schema/registry/UI state, integration evidence and deterministic explorer publication | Package count, source ownership, file existence and agent self-report are not completion proof. |

The architecture appendix recommends a concrete topology and alternatives against these requirements. It separates choices that can be made from inspected facts from compatibility, performance, recovery and provider claims that still require future empirical proof. No such empirical work is performed here.

## Reconciliation status and plan inconsistencies

The active documentation worker owns canonical plan edits. This addendum does not edit those files. The first two items have visible documentation repairs in the latest inspected snapshot; remaining propagation and future tests must still be checked. The other items remain design/evidence work unless separately resolved.

1. **Accepted rulings now recorded:** `docs/decisions/user-rulings.md` and the revised OD register reflect the five decisions. Finish/verify their consistent propagation through all linked contracts, capabilities, acceptance records and the explorer. Preserve historical source behavior as evidence rather than rewriting history.
2. **Private-care tool-table contradiction repaired in prose:** `docs/evry-design.md`, Plant Intelligence row and accepted private-care boundary, now exclude check-ins and their history from Evry. Preserve this channel/purpose distinction in every generated catalog, indirect projection and future test; no runtime proof is implied.
3. Separate known source defects from future corrections: mixed strained/struggling nudges, missing-week behavior, unsupported metric proxies and incomplete criteria must not be described as already working merely because a test path or comment is listed.
4. Resolve actual cross-module ownership before declaring the DAG executable: attendance/obligation/task transaction, incremental merge-reference coverage, removal/handover effects, synchronous material-source revisions, and shared Evry registry/UI integration.
5. Make assessment active leases, logical requests, retry identity and immutable publication identity distinct. Quiet plants must still receive time-based reassessment; stale claim owners must not publish; stale data must not appear current because an outbox is delayed.
6. Make auth account creation versus domain acceptance atomicity honest. Document the selected supported transaction or resumable unprivileged registration protocol, then specify the failure/race proof. Better Auth ownership alone does not establish the joint transaction.
7. Make reference release, content/corpus activation and rollback one coherent lifecycle, including historical citations, reading progress and tenant overrides.
8. Correct source-precedence wording: C12 cadence is already ruled; the 72-hour oversight fallback has reviewed rubric provenance. Any new policy change must be identified as such.
9. Replace “17 questions” as a completeness claim with a central crosswalk covering the embedded questions, architecture choices and interaction decisions in this agenda. The existing inventory counts remain useful evidence, not semantic certification.
10. Keep accepted decision state separate from implementation/test state. Explorer updates must cite actual artifacts and checks, be published safely during work, and show stale evidence honestly.

## Explorer and parallel-agent workflow are part of the plan

The user requires every future build agent to update progress throughout its work, tied to actual artifacts and tests. A static HTML file cannot monitor the filesystem or establish correctness on its own. Preserve `everyfield-build-explorer.html` as the single-file user artifact, but settle its evidence pipeline before assigning builders:

1. Keep plan topology separate from execution evidence. Give each work package one owned status record or append-only evidence fragment, rather than having all agents edit the HTML or one shared JSON file.
2. Record artifact paths/revisions, linked acceptance IDs, exact check command/environment, outcome/log location, unresolved failures, decision dependencies and reviewer/integration revision. Use synthetic/redacted evidence. Distinguish not-run, failed, passed and explicitly waived checks.
3. Require updates when work starts, meaningful artifacts change, checks fail/pass, a blocker is discovered and review is requested. Continuous updating does not mean an unattended promise that the HTML somehow observes work.
4. Use one validator/publisher to aggregate records, reject invalid or contradictory claims and regenerate the standalone HTML deterministically with atomic replacement. Shared schema, central registries and the common assistant UI also need a single owner; independent domain folders remain independently editable.
5. Treat `ready_for_review` as an agent assertion and `verified` as inspected integrated evidence. Changes to relevant inputs make proof stale until rerun. Dependencies and approved contract versions must match. Keep failed attempts in history rather than replacing them with a green final label.
6. Show last generation time, evidence revision, accepted/open decisions separately from build status, and stale/unverified state. A local read-only watcher could refresh the same artifact if explicitly chosen; a saved standalone copy is still a dated snapshot.
7. Plan workflow tests for simultaneous worker fragments, unknown IDs, missing/failed checks, invalidated artifact hashes, duplicate shared ownership and standalone HTML output. None is implemented or claimed passing by this review.

This review does not inspect or modify the concurrent worker's final HTML. Its purpose here is to define the contract against which that workflow can later be reviewed. Any board integration must have one canonical direction of status authority, not a competing source of completion truth.

## What “planning complete” should mean before the build

Planning cannot prove a runtime that does not exist. It can eliminate avoidable ambiguity and precommit to how unavoidable uncertainty will be handled. The final plan should satisfy all of the following:

- **Full-target disposition:** each capability has an accepted target behavior or explicit approved exclusion/replacement. Historical implementations, partial requirements and wanted outcomes are not conflated. No unresolved need is hidden by renaming it “later.”
- **Decisions recorded:** every product/SME choice in the agenda has an owner and accepted answer, or is explicitly identified as still open and preventing planning signoff. Engineering recommendations are reviewed as a coherent architecture rather than sent to the user as dozens of arbitrary implementation trivia votes.
- **Coherent contracts:** each consequential command names actor/data-use policy, subject scope, state transition, transaction, revision/idempotency, history and correction behavior, external effects and failure result. Cross-module consumers agree on those meanings.
- **Grounded methodology:** all eight lenses and seven phase criteria have approved definitions, populations, clocks, evidence sources and unknown behavior. Manual attestations are distinguished from measurements; software limitations do not invent a different rubric.
- **Data and privacy lifecycle:** logical identities, constraints, relationship consent, sensitive-field projections, retention, retirement/deletion, ownership transfer, private artifacts, conversation/history access and support authority are settled together.
- **Reference lifecycle:** a named editorial owner approves the candidate release and version precedence; templates, mappings, links and content/currentness are reviewed; future promotion, derived corpus generation and rollback are specified.
- **Architecture selected with explicit contingencies:** choose the recommended topology/libraries/provider assumptions from the complete requirements. For any integration fact that cannot be established without future code, record the exact hypothesis, test, pass condition, fallback, cost of reversal and responsible owner. A conditional architecture choice is acceptable only if the user knowingly accepts that remaining uncertainty; it is not a verified fact.
- **Operational commitments:** capacity, spend ceiling, latency/recovery expectations, external data posture, environments, bootstrap/admin access, backup/restore and deployment/rollback responsibilities have concrete accepted values or remain visibly unresolved. Do not invent provider account settings or commercial terms.
- **Verification design:** acceptance examples cover ordinary, denied, stale, concurrent, correction, retry, partial and unknown-result paths across actual workflows. The 52 source-suite mapping gaps and 48 inherited Evry evaluation gaps identified in `docs/modules/README.md` have owned dispositions and planned proofs. Count checks do not replace semantic examples.
- **Executable delivery plan:** revise the work graph only after the above choices. Inputs/outputs and shared owners make each package executable; per-slice integration is planned, and final regression/release gates are explicit. Estimates remain assumptions, not pressure to start.
- **Auditable progress:** define canonical per-package evidence records, validated aggregation and a single publisher for the standalone explorer. Every future agent updates progress during work; accepted decisions do not automatically mark application packages complete.

The outcome of this review is therefore **a comprehensive decision agenda for completing the plan**, not a “go build now” recommendation. The parent can walk through the groups with the user, reconcile the resulting decisions, then request a final whole-plan consistency review before implementation is authorized.

## Detailed decision and evidence appendices

The following appendices retain the reviewers' concrete recommendations and alternatives. Their IDs are discussion/cross-reference labels, not new runtime modules, services, tables or work packages. Overlap is deliberate where a product meaning, architectural mechanism and cross-module consequence require different evidence; one accepted decision should be cross-linked rather than counted as three approvals.

- [Product and open-question agenda](astra-holistic-product-agenda.md): current wording/provenance, recommended answers, alternatives, confidence, dependencies, accepted rulings and the open-question crosswalk.
- [Architecture and operations agenda](astra-holistic-architecture-agenda.md): topology/library choices, data and authority boundaries, concurrency, AI, references, capacity/cost assumptions and thirteen future acceptance protocols.
- [Cross-module and methodology agenda](astra-holistic-interaction-agenda.md): concrete counterexamples, all phase criteria and lenses, measurement definitions, correction interactions and complete workflow fixtures.

The [earlier implementation-readiness review](astra-implementation-readiness-review.md) remains historical evidence. This addendum supersedes its narrow-first-slice sequencing advice and marks the now-repaired private-check-in contradiction accordingly. Neither report is authority to modify the canonical plan or start implementation.
