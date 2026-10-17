# Adopted target schema

[target.json](target.json) is the only schema authority. Sebastian adopted this reviewed starting design on 2026-10-14. Builders may change it later through a reviewed migration. Application implementation is not authorized by this documentation change.

The schema has 120 tables, 1409 columns, 488 declared FKs and 13 JSONB columns. These are counts of definitions, including compound FKs as one constraint. They exclude indexes, triggers, packaged artifacts and external backups.

Run documentation/tooling checks from the repository root:

```sh
python3 docs/schema/check.py
python3 docs/schema/check.py --self-test
python3 docs/schema/check-architecture.py
python3 docs/schema/check-person-references.py
python3 docs/schema/render-docs.py --check
python3 docs/schema/render-diagram.py
python3 docs/package-context.py --check-manifest
```

[schema-diagram.html](schema-diagram.html) is an offline ERD generated from this authority. [relations.md](relations.md) lists its exact relations. [design-rules.md](design-rules.md) retains the adopted privacy, history and ownership rules. Capability inventories are under `capabilities/`.

The checker validates structural keys, FK existence/arity/types, unconditional referenced keys, owner pairs and named exceptions, UUID relations, literal closed sets, NULL guards, JSONB key documentation, catalog coverage, producer packages and Person registrations. It does not execute SQL, triggers, Better Auth, authorization races, storage, providers or application acceptance. Independent semantic review remains required.

## Accepted rulings

| ID | Ruling |
|---|---|
| SCHEMA-ADOPT-1 | Adopt the seven v2 recruitment sources plus the v3 meeting guest value as the literal Person source CHECK and `ApprovedRecruitmentSource` enum. The field and type contracts agree. Sebastian may change this reviewed starting list through review. |
| SCHEMA-ADOPT-2 | Adopt `record` with the actual subtype PK and owner. Trusted insert/deferred triggers validate exact subtype kind, owner and uniqueness. Retained body-free identities confer no access. |
| SCHEMA-ADOPT-3 | Adopt `mail_request` and ordered `mail_request_member`; keep exact request replay, membership, provider key and original clock relational. |
| SCHEMA-ADOPT-4 | Derive current assessment publication from the latest still-authorized complete result, ordered by durable availability and ID. No mutable publication pointer. |
| SCHEMA-ADOPT-5 | Canonical reference definitions remain packaged reviewed release artifacts. Customer editing would require a separate reviewed product change and typed owned rows. |

Person source literals are `personal_referral`, `social_media`, `vision_meeting`, `website`, `event`, `partner_church`, `meeting_guest_list`, `other`. The coordinator ruled this list from `~/dev/everyfield_v2/src/db/schema/people.ts:35-43` (`personSources`), plus `docs/product/people.md:90` for the `other` default and `docs/product/meetings-follow-up.md:200` for `meeting_guest_list`. `people.createPerson` and CSV input use `ApprovedRecruitmentSource`. Bootstrap/seat linking establishes identity rather than recruitment evidence. This explicit adoption uses v2 as reference evidence; it does not make v2 a package prerequisite.

## Producer derivation

Each replaced table inherits the union of producer packages from its previous target tables. `legacy_table_producers` retains only that ownership evidence, not a second schema. `producer_derivation` records the source of every table assignment. Every table has a producer, including WP-004 for baseline SQL/trigger proof. Feature selectors derive from capability inventories, rather than stale previous table names.

| New table | Ownership basis and ruling | Producers |
|---|---|---|
| `identity_proof` | Application-owned email-change/cancellation proof splits from account/auth and deletion facts; password reset remains library-owned. | WP-004, WP-005, WP-010, WP-050, WP-057 |
| `training_requirement` | Required work splits from the existing immutable training version. | WP-004, WP-019 |
| `private_calendar` | Original-author rollover splits from private check-in facts; no generic record or shared event identity. | WP-004, WP-039 |
| `article_link` | Typed topology splits from immutable Wiki article revision facts. | WP-004, WP-033, WP-035 |
| `assessment_fact` | Typed immutable facts split from plant/organization assessment snapshots; WP-040 owns fact capture. Add WP-040 for the explicit deterministic fact-capture producer. | WP-004, WP-038, WP-040, WP-042, WP-043, WP-044, WP-047 |
| `mail_request` | Exact request/replay clock splits from the shared mail intent/attempt ledger. | WP-004, WP-028, WP-031 |
| `mail_request_member` | Exact ordered membership splits from the shared mail intent/attempt ledger. | WP-004, WP-028, WP-031 |
| `digest_coverage` | Recipient digest coverage splits from inbox notification production. | WP-004, WP-030 |
| `effect_dependency` | Relational dependency DAG splits from reviewed effect manifests. | WP-004, WP-053 |
| `prompt_dismissal` | Own-context optional prompt choice splits from feedback production. | WP-004, WP-049 |
| `evidence_link` | Selections, citations, provenance and inverse guards split from the named previous consumer manifests; original consumers retain their writer responsibilities. | WP-004, WP-015, WP-019, WP-021, WP-022, WP-024, WP-027, WP-028, WP-029, WP-030, WP-031, WP-033, WP-035, WP-038, WP-042, WP-043, WP-045, WP-046, WP-047, WP-050, WP-051, WP-053, WP-057 |
| `tenant` | Stable body-free ownership is shared by root and deletion producers; no independent access grant. | WP-004, WP-005, WP-007, WP-010, WP-050, WP-057 |
| `record` | Referenceable subtype writers must bind their own actual identity and owner; inherit the union of those writers, with WP-004 owning trigger/DDL proof. | WP-002, WP-003, WP-004, WP-005, WP-006, WP-007, WP-008, WP-009, WP-010, WP-011, WP-012, WP-013, WP-014, WP-015, WP-016, WP-017, WP-018, WP-019, WP-020, WP-021, WP-022, WP-023, WP-024, WP-026, WP-027, WP-028, WP-029, WP-030, WP-031, WP-032, WP-033, WP-034, WP-035, WP-036, WP-037, WP-038, WP-039, WP-040, WP-041, WP-042, WP-043, WP-044, WP-045, WP-046, WP-047, WP-048, WP-049, WP-050, WP-051, WP-053, WP-054, WP-057, WP-098, WP-099 |
| `early_access_request` | WP-097 owns the applied early access migration 0001 request table; no product scaffold or tenant prerequisite. Field shape follows the approved E3 contract and receipt shape follows E4. | WP-097 |
| `early_access_attempt` | WP-097 owns the applied migration 0001 limiter table, without an invented primary key. | WP-097 |
| `schema_migration` | WP-097 installs the migration runner ledger with its physical text primary key. | WP-097 |
| `sending_goal` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-098 |
| `pipeline_stage` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-098 |
| `pipeline_person` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-098 |
| `pipeline_stage_move` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-098 |
| `leadership_conversation` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-098 |
| `development_program` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-099 |
| `development_program_version` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-099 |
| `development_stage` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-099 |
| `development_milestone` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-099 |
| `development_reading` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-099 |
| `development_enrollment` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-099 |
| `enrollment_milestone` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-099 |
| `assignment_feedback` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-099 |
| `residency_link` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-008 |
| `pipeline_sharing` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-007 |
| `enrollment_plan` | Accepted ADR-001: baseline SQL is WP-004; named domain producer owns behavior. | WP-004, WP-099 |
| `organization_person_removal` | WP-011 owns removal and WP-050 synchronizes body-free witnesses into recovery; WP-004 installs the baseline. | WP-004, WP-011, WP-050 |

`assessment_fact` also adds WP-040, which owns deterministic fact capture. Its remaining producers inherit the replaced assessment stores. Original-author care excludes generic record/history movement. The Person registry is rebuilt from all adopted Person FKs; generic person-kind record references and frozen opaque inputs are separately registered as immutable evidence.

## Previous target to adopted tables

This mapping is generated from `replaces`; Fix 2 uses it to align architecture, registries and acceptance. It is a migration guide for documentation, not a customer data migration.

| Previous target table | Adopted tables or disposition |
|---|---|
| `access_invitation` | `invitation` |
| `account_person_link` | `person` |
| `app_account` | `account`, `lifecycle_witness` |
| `assessment_demand` | `assessment` |
| `assistant_approval` | `review` |
| `assistant_artifact` | `conversation_entry` |
| `assistant_attachment` | `conversation_entry` |
| `assistant_conversation` | `conversation` |
| `assistant_message` | `conversation_entry` |
| `assistant_plan` | `conversation` |
| `association_event` | `event` |
| `association_invitation` | `invitation` |
| `audit_event` | `event` |
| `auth_account` | `auth_account` |
| `auth_session` | `auth_session` |
| `auth_throttle` | `admission_attempt` |
| `auth_user` | `auth_user` |
| `auth_verification` | `auth_verification` |
| `command_receipt` | `operation` |
| `communication` | `communication` |
| `communication_delivery_retry` | `communication` |
| `communication_recipient` | `communication_recipient` |
| `deletion_witness` | `lifecycle_witness` |
| `discovery_association` | `affiliation` |
| `discovery_profile` | `discovery` |
| `email_attempt` | `mail_attempt` |
| `email_intent` | `mail` |
| `email_suppression` | `suppression` |
| `feedback_publication` | `feedback_publication` |
| `follow_up_obligation` | `obligation` |
| `follow_up_outcome` | `contact_outcome` |
| `generated_document` | `generated_document` |
| `household` | `household` |
| `inbox_entry` | `notice` |
| `intelligence_assessment_run` | `assessment` |
| `intelligence_feedback` | `reader_feedback` |
| `intelligence_insight` | `finding` |
| `job` | `job` |
| `launch` | `document`, `document_revision`, `launch`, `launch_debrief` |
| `launch_event` | `event` |
| `launch_milestone` | `launch_milestone` |
| `launch_milestone_task` | `launch_milestone` |
| `launch_person_attendance` | `launch_guest` |
| `meeting` | `meeting`, `meeting_item` |
| `meeting_checklist_item` | `meeting_item` |
| `meeting_evaluation` | `meeting_evaluation` |
| `meeting_event` | `event` |
| `meeting_invitation` | `participation` |
| `meeting_location` | `venue` |
| `meeting_participation` | `participation` |
| `meeting_rsvp_token` | `rsvp_proof` |
| `message_template` | `message_template` |
| `ministry_team` | `team` |
| `notification_preference` | `notification_preference` |
| `object_metadata` | `file_object` |
| `operation_effect` | `effect` |
| `operation_execution` | `operation` |
| `operation_result` | `operation` |
| `organization` | `organization` |
| `organization_intelligence_assessments` | `assessment` |
| `organization_intelligence_contributor` | `assessment_contributor` |
| `organization_intelligence_runs` | `assessment` |
| `organization_network_link` | `affiliation` |
| `organization_sharing_settings` | `affiliation` |
| `organization_wiki_article_state` | `article_editor_state` |
| `owned_document_revisions` | `document_revision` |
| `owned_documents` | `document` |
| `person` | `person` |
| `person_4c_assessment` | `four_cs` |
| `person_activity` | `event`, `person_note` |
| `person_attestation` | `attestation` |
| `person_commitment` | `commitment` |
| `person_interview` | `interview` |
| `person_merge` | `person_merge` |
| `person_skill` | `person_skill` |
| `person_tag` | `person_tag` |
| `person_tag_definition` | `tag` |
| `phase_template_offer_response` | `phase_transition` |
| `phase_transition` | `phase_transition` |
| `plant` | `lifecycle_witness`, `plant`, `plant_geography` |
| `plant_affiliation` | `affiliation` |
| `plant_attestation` | `attestation` |
| `plant_wiki_source_order` | `wiki_preference` |
| `plant_wiki_source_order_entry` | `wiki_preference` |
| `planter_checkin` | `private_week` |
| `planter_checkin_event` | `private_week_revision` |
| `platform_grant` | `platform_grant` |
| `product_feedback` | `feedback` |
| `provider_event_receipt` | `provider_event` |
| `record_correction` | `event` |
| `recovery_manifest` | Encrypted restricted external backup/restore artifact, outside the live application database. |
| `recurrence_series` | `recurrence` |
| `reference_activation` | `reference_activation` |
| `reference_chunk` | `passage` |
| `reference_release` | `reference_release` |
| `reference_section` | `article_revision`, `reference_item`, `reference_version` |
| `reference_template_version` | `reference_version` |
| `task` | `task` |
| `task_dependency` | `task_dependency` |
| `task_relation` | `task` |
| `task_status_event` | `event` |
| `team_membership` | `team_tenure` |
| `team_responsibility` | `responsibility` |
| `team_role` | `team_role` |
| `template_import_receipt` | `operation` |
| `tenancy_membership` | `seat` |
| `training_assignment_episode` | `training_assignment` |
| `training_assignment_event` | `event` |
| `training_completion` | `training_credit` |
| `training_program` | `training_program` |
| `training_requirement_version` | `training_version` |
| `upload_intent` | `file_object` |
| `vision_response` | `participation` |
| `wiki_article` | `reference_item` |
| `wiki_article_feedback` | `reader_feedback` |
| `wiki_article_version` | `article_revision` |
| `wiki_bookmark` | `reading` |
| `wiki_read_event` | `event` |
| `wiki_read_progress` | `reading` |
| `wiki_source` | `article_revision` |

## Coverage

Capability inventories cover 291 feature IDs and 124 persistent capabilities. Coverage proves a documented mapping; it does not establish runtime behavior.

## Design rules used
1. Each table names the capabilities that require it. There is no table for a behavior-only helper or derived dashboard.
2. Use third normal form for current domain data. Keep immutable evidence separately when the capability requires it.
3. Give each ordinary record one UUID PK. Pure links use natural composite keys: Person tags, task prerequisites, effect dependencies and ordered mail membership. One-to-one Launch and private calendar use their existing UUID owner key, without a second surrogate.
4. Declare real FKs. Direct domain relationships use ordinary or compound FKs. Cross-domain targets use one stable `record` identity and typed subtype FKs; subtype triggers bind kind and actual owner.
5. Share records only where their shape and lifecycle match. Use one semantic event stream, one operation receipt and one mail ledger.
6. Closed states use text with CHECKs. Tags are a user-editable vocabulary. Static reference definitions are versioned files with relational identity records. The adopted Person source vocabulary is a literal CHECK.
7. Keep one current row and event history for mutable facts. Preserve immutable training versions, article revisions, document revisions, submitted debriefs and assessment evidence.
8. JSONB is limited to whole opaque snapshots, provider payloads, presentation/planning content and audit diffs. Selections, standings, SQL inverse guards and permission gates have typed columns or links. Opaque command arguments and document merge inputs follow the approved second-pass ruling below.
9. Every tenant-owned row carries its exact owner identity. Mixed-scope rows use nonnull `tenant_id`; ordinary plant rows retain `plant_id`. Compound FKs enforce same-owner children. The sole global identity represents restricted work and grants no application access.
10. Derive counts, averages, urgency, readiness, acquisition dates, directory results and current publication choices. Store rebuildable passage vectors because retrieval needs them, with exact source and generation provenance.
11. Keep timestamps for actual occurrence, chronological reads, deadlines, leases, publication, corrections or adapter requirements. Concurrency uses row revisions. There is no blanket `updated_at` copy.
12. Every consolidation below states its cost. Sparse typed unions count every physical column.

## Major decisions
| Decision | Reason | What it gives up |
|---|---|---|
| Keep four Better Auth tables; one `account` owns application authority. | Credentials have one library owner. Pending registration remains unprivileged and resumable. Native security proofs never enter Evry. | No alternative auth store. Adapter compatibility still needs pinned-version tests. |
| One `invitation` with checked purposes; one `affiliation` per exact pair. | Seat and relationship invitations share the same addressed-token lifecycle. Relationship consent travels with its exact pair and survives a rejoin. | Sparse endpoint columns and kind validation. Recognition episodes come from dated events, not replacement relationship rows. |
| One body-free `tenant` identity; separate account, plant and organization bodies. | Owner identity can be shared without merging different profiles, deletion rules or permissions. A fixed global root closes nullable compound-FK bypasses. | One sentinel row must be excluded from every application tenant query. Root-kind consistency still requires deferred triggers; row-local global mail/job restrictions use literal CHECKs. The identity is never a grant. |
| Store profile locality in `plant_geography`. | Region selection and locality corrections need exact as-of history. One latest effective row supplies the current profile. | Profile reads join the geography ledger. No separate current city/state/country cache is stored on `plant`. |
| Put the current account link and household role on `person`. | Each Person has one current household and at most one linked account. History belongs to events. | No extra mutable link table. Verified linking, head uniqueness and merge rules need serialized checks. |
| Keep human interviews, four Cs and signatures as distinct resources. | Their fields, dates, privacy and evidence meanings differ. Current commitment is independent from signature rows. | More tables than an unconstrained person-evidence bag. Models still cannot supply these facts. |
| One `event` for semantic history, correction and safe audit. | The envelope, actor, occurrence, revision and target shape are shared. Domain writers keep their own event semantics. | More nullable event fields and indexed joins. It is not a generic audit browser. Private care is excluded. |
| One `operation` and typed `effect` manifest for native and Evry work. | Registration, imports, bulk changes, receipts and approved assistant effects need exact replay and truthful partial outcomes. Opaque arguments live on the effect; dependencies and inverse witnesses stay relational. | Per-key argument validation moves to the closed command boundary. There is no general workflow or compensation engine. |
| One `record` supertype and purpose-checked `evidence_link`. | Each entity uses its own PK as the generic identity. Job/event uniqueness now dedupes the actual subject, and permitted body-free history keeps its identity after subtype purge. | SQL FKs alone cannot prove subtype kind. Trusted insert/deferred triggers bind exact kind and owner. Generic identities grant no read or write rights. |
| One shared `attestation` resource. | CAP-B-030 and CAP-C-018 name the same facts. CAP-A-041 uses the same dated human testimony shape. | Nullable person/period/statement fields. Key-specific meaning and expiry remain producer rules. |
| Preserve training versions, requirements, saved assignments and earned credit. | Applicability is a saved decision. Membership edits cannot relabel credit or quietly change a denominator. | More typed rows than requirement JSON. `training_version.compatible_prior_id` has a compound same-program FK; compatibility is explicit and never inferred transitively. |
| One participation row; one typed meeting-item list. | Guest, inviter, RSVP, presence and optional response card share a meeting/Person identity. Agenda and kit entries share stable ordered editable rows. | Sparse fields and Vision-only guards. RSVP, attendance, response and roster denominator still have separate meanings. |
| Task relations sit directly on `task`. | A task has at most one optional allowed relation. Checklist children are ordinary one-level Tasks. | Nullable FK arms on each task. Cycle and parent-shape checks need locks. |
| Keep generated obligations independent from Tasks. | Deletion, waiver, recurrence and assignment edits must not erase source identity or fabricate success. | One extra stable resource. Contact freshness still comes only from typed human outcomes. |
| Version debrief forms; use owned document revisions for published summaries. | An incomplete new draft must not erase a valid submission. A summary is separately reviewed whole-text publication. | Form versions and provenance joins. No automatic reflection publication or model redaction promise. |
| One plant/organization assessment lifecycle; typed immutable facts and findings. | Demand and completion share one assessment shape; `job` alone owns retry, eligibility and claims. Different rubrics and contributor rules stay explicit. | More fact/link rows than snapshot JSON, and stricter target-kind checks. No raw person judgments enter model-purpose evidence. |
| One account-owned `reader_feedback` resource. | Article helpfulness and finding usefulness share an own-choice lifecycle. Typed target/rating CHECKs distinguish them. | Nullable target/context fields. Comments follow private account deletion; feedback is not automatic model training. |
| One mail ledger, with normalized request/order/attempt facts. | Unknown whole-batch replay needs the exact request, order, provider key and original clock. Per-member outcomes must survive later retries. | Two explicit request/membership tables. This is more structure than the previous embedded manifest, but avoids hiding ordered IDs in JSON or repeating them on every attempt. |
| Merge pending upload and object metadata into `file_object`. | One generated immutable key has one pending-to-ready lifecycle and cleanup fence. | Metadata must not claim readiness until upload validation and reference finalization succeed. Replacement always makes a new object. |
| Merge own bookmark state into the existing reading row. | Both have one account/canonical-article identity and account-private lifecycle. | A bookmark-only row has zero observed progress and no completion; it does not create reading evidence. |
| Keep private calendar, weeks and corrections isolated. | Even unanswered weeks and timezone transitions are private original-author facts. | An extra dedicated calendar table. No shared event, reference, job, effect, model or export path may contain care data. |
| Keep body-free lifecycle witnesses after live roots are purged. | Restore must respect current deletions, revoked seats/affiliations and pending, cancelled or completed deletion, even if a stale backup contains them. | Controlled opaque historical identity keys without live-root FKs after purge. Witnesses can deny access, never grant it. |

`effect.arguments` and `generated_document.inputs` are opaque frozen JSONB values. The closed native command/template boundary validates schema version, keys, indices and values before review. The effect payload hash pins its exact canonical arguments; generated bytes and the object hash pin document output. SQL never filters or joins these arguments. Exact selections and any identities/revisions needed by SQL inverse guards remain in `evidence_link` or typed domain FKs. The tradeoff is loss of SQL per-key type/FK checking; start-time native authorization resolves each argument afresh, so a deleted UUID argument cannot block purge or confer rights.

## Ownership and integrity rule
Mixed-scope rows use one nonnull `tenant_id` FK. Account, plant and organization PKs also reference `tenant`; a trusted root trigger enforces the matching kind. A CHECK binds `kind = 'global'` exactly to the all-zero UUID; the PK allows at most one such row. Account, plant and organization root CHECKs exclude that UUID. Invitation and every context that formerly required a real owner also CHECK that `tenant_id` differs from it. Seat, affiliation and platform-grant endpoint FKs point only to those real roots, so they cannot refer to the global sentinel. It represents restricted global work, public source identities and body-free external stubs. It is not a customer workspace. Keeping its UUID nonnull makes compound FKs enforce parent existence and equal ownership in global work too. Tenant identities survive live-root purge; ordinary access still requires the live authorized root.

A root's `id` is its owner alias. The checker applies the same-owner rule to its outgoing FKs to owned bodies, including account avatars. FKs targeting roots identify owners or actors and retain the endpoint and current-grant rules below.

Every same-owner mixed child points to the parent's unconditional `(id, tenant_id)` key. Plant, organization and account children pair their corresponding owner aliases, including private feedback publication and organization editor state. Mail member/event links also include tenant in their ordered/composite keys. A copied source, entitled citation, explicit cross-owner output or historical target can legitimately have another owner. Its FK carries a named `scope_exception` in `target.json`; a serialized deferred trigger/native boundary must lock the endpoints, validate exact kinds/rights/purpose, and refuse an unauthorized mismatch. Compound FKs do not grant current access. Parent deletion, source revocation and owner transfer need the same fresh checks.

Tenant-kind rules replace the old always-null arms. Documents and generated documents allow only account or plant owners; Launch summaries require plant. Assessments allow plant or organization, and their children inherit that exact owner through compound FKs. Planter digest coverage requires plant; oversight coverage requires organization. Seat invitations allow plant/organization, plant relationship invitations use plant, Discovery relationship invitations use account, and church-network invitations use a sending-church organization. Global mail may contain a payload only for `public_invite`; purged outcome stubs retain no payload/address and cannot dispatch. A literal mail CHECK enforces that global payload rule, and a job CHECK limits global work to mail, reference generation, feedback publication, object cleanup and lifecycle purge. The named global `job` producer rule permits mail work only for the exact public-invite send or body-free reconciliation subject; ordinary tenant mail never becomes global. The remaining cross-table kind rules require deferred triggers, not CHECK subqueries. Wiki/reference owner-kind triggers permit only organization/global tenants; global packaged versions must bind both their release and item to the global identity. Serving activation accepts only complete approved global releases.

`reader_feedback.account_id` is its private owner; optional plant/organization context must match the entitled target. Conversations and all descendant entries, plans, reviews and attached handles remain private to `conversation.owner_id`, including in plant/organization contexts. Only that initiator can approve its review. A tenant context is not an ownership transfer. Reading and prompt dismissal are account-owned; context plant IDs confer no rights. Private weeks require their original author and original plant, and have no generic record identity.

The remaining source/endpoint exceptions are explicit:

- Actors, assignees, recipients and readers in shared tenant rows use account FKs, then current exact grants and eligibility checks.
- Seat/affiliation columns are endpoints, not owner triples. The seat record owner is its plant/organization endpoint; the affiliation record owner is its subject plant/account/sending-church endpoint. The receiving organization remains a separate consent endpoint. Invitation acceptance validates their exact endpoint pair under locks; no nullable endpoint composite may bypass the invitation's real scalar FK.
- Global reference versions and entitled organization article revisions keep source ownership. Published state, exact release/version and current rights must match; a source FK is not consent.
- A staged upload binds only through its approved native effect. Its original upload instant survives claims/retries; `file_object.claim_generation` plus state CAS fences cleanup/binding. Purpose, MIME, size, digest and exact destination owner must match.
- Account-to-plant document copy and explicitly reviewed generation preserve source hash/revision lineage without authorizing the source or inheriting its owner.
- An organization assessment contributor uses `organization_id` for the receiving assessment/record identity, and `plant_id` for its released source assessment. Exact affiliation recognition, category grants and sharing/source revisions gate the whole result.
- Signed provider callbacks and global address suppression use their restricted external identity/proof boundary. Private feedback publication may retain only the permitted global issue locator after intake purge.
- Body-free witnesses retain historical deny keys when live pointers are cleared. They can never select a live resource or grant authority.

`record(id, kind, tenant_id)` has one row per referenceable entity, allocated with that entity's own PK. The literal CHECK `kind not in ('account','plant','organization') or tenant_id = id` binds root record ownership to its own ID. A trusted subtype insert trigger sets exact kind and actual owner; a deferred constraint trigger refuses a second subtype/body at that ID, wrong kind, or owner mismatch. Source/global/retained-body exceptions also validate owner through that trigger. Changing ownership is possible only through a reviewed domain bind that atomically updates subtype and record. Deleting a subtype leaves only its body-free identity when independent permitted history requires it; otherwise purge the identity too. A retained record can resolve historical attribution, never a body or current right. Secret credential/RSVP proofs and all care tables are excluded. Launch shares its plant's record, so a Launch consumer uses the plant UUID and verifies the live Launch row when needed.

`evidence_link` has exactly one entity consumer or event consumer and one mandatory target record. Every retained purpose has a required-column CHECK. Citation requires registered projection/read-purpose and completeness; partial citations require a cursor. Inverse moves require field path and both revision guards, with nullable prior/result endpoints preserving real absence. `article_link`, `assessment_contributor` and `training_version.compatible_prior_id` are the only homes for topology, contributor roster and training compatibility. Consumer/target kinds and purpose-specific optional fields still need the trusted writer. Composite links keep their actual endpoint FKs; no surrogate is added merely to make them a generic target.

Original human recorder/assessor/verifier and old/new correction values live in immutable create/earn/record events for their actual typed target. `person_note.author_id` additionally protects author-only editing. A shared actor becomes a scope-local opaque tombstone on account purge. No private author stream transfers to a successor. Emit genuine domain history, not merely a generic changed event. Readable task/status/stage/contact/reading dates and values stay in scalar event columns; opaque diffs are not metric truth.

## History, publication and recovery
Freeze source-bearing fields of reference/article/training/document versions, submitted debriefs, complete assessment facts/findings, reviewed effects and opaque inputs. Mutable execution state may advance without changing a published manifest's digest or arguments. A new edit creates a new version or an attributable correction under the owning resource. No-op replay returns the original receipt.

The latest effective geography row is current locality. The highest committed reference activation is the serving generation. A current assessment is the latest still-authorized complete result, ordered by durable availability and ID; pending/failed work does not erase it. A native summary reader uses the latest published whole document revision, not a later unpublished draft. Keep captured phase/as-of and previous released results separate from current phase and embargoed results.

A reviewed Launch summary always has a Meetings source-category baseline. `evidence_link` adds every actual contributing category and source. Every whole-revision read requires the current exact affiliation, `shared_findings` and the full category union. Summary publication is immediate to eligible recipients. Model-result release instead follows a genuine eligible first open or 72 elapsed hours after durable availability.

Each per-recipient transport event binds `mail_attempt`, its `mail_request`, ordered member index and actual mail target. This records refusal/unknown/acceptance even after a later safe retry changes the current mail row. Mail acceptance, sent/delivery, opens/clicks, RSVP, contact and task completion remain distinct facts. Frozen payloads are encrypted and excluded from generic history/model projections.

Deletion suspends normal access at request commit. Cancellation is strictly before 30 elapsed days and restores only independently still-valid grants. Current lifecycle and Better Auth live session revocation gate all ordinary reads, writes, dispatch and signed issuance. Coherent live purge starts a nonresetting recovery-copy horizon of at most seven days. Keep claim generations and actual byte/cancellation outcomes. Global address suppression restoration requires fresh proof of the current self address.

Purge in dependency order with RESTRICT FKs. Clear optional live revision links and private provenance explicitly; current assessment selection is derived, never a mutable pointer. Delete account-private conversations, reviews, frozen argument bodies, drafts, votes, reading, proofs, avatars and care with their actual owner. Legitimate shared domain receipts may retain only minimal factual attribution. Delete revoked/copied bodies and every affected mixed organization run when a source plant becomes purge-eligible; contributor links locate the whole run, not a subtraction from old prose. Counterparty relationship history retains only body-free permitted facts. No audit, snapshot or organization ownership creates an indefinite retention exception. Scrub private mail addresses, address hashes and frozen bodies, clearing expired owner/recipient/provenance FKs. An accepted or unknown mail row can retain only body-free external locator/outcome facts and its original request key/clock. It cannot dispatch. Similarly, feedback publication clears its account, intake, category, area, title and body while retaining only the frozen published/unknown issue locator, marker, hash and outcome. Unattempted rows need no retained stub.

`lifecycle_witness` retains current body-free pending, cancelled and completed deletion plus seat/affiliation revocation facts. Immutable request/deadline and cancellation/purge timestamps are checked in the schema. During the build, use native seven-day Neon/Tigris history and surviving current witnesses. Before customer data, configure the independently synchronized witness artifact, encrypted daily DB-plus-byte copies and restricted backup host under G-RECOVERY. After a live root is removed, clear its FK and retain the opaque historical key. Delete private consumer bodies and provenance links. Independent permitted history keeps the existing body-free `record` identity without rebinding or rewriting append-only events. Never treat that identity or the witness as a live account, grant or dispatch target. The external restricted recovery artifact, outside this database, pins the encrypted inventory, object checksums, schema, LSN, key version, environment, original expiry, verification and restore receipt. It also records failed schedules and actual recovery checks, so a database restore cannot roll its own backup ledger backward. The restricted manifest records each embedded subject's original expiry. Recopy and restore take the minimum original expiry and reapply current witnesses before service opens. Key material remains outside ordinary database rows. Private-care recovery still enforces original-author access and exclusions. Provider cleanup distinguishes inaccessible bytes from physically confirmed erasure; this is not a universal physical day-37 promise.

## Capabilities that need runtime logic
A CHECK cannot prove current authority, a multi-row cycle, an external outcome or a time-dependent rule. These obligations remain explicit:

| Capabilities | Required behavior |
|---|---|
| A-001 through A-006, A-009 | Native auth proof, built-in session revocation, rolling-window reservation locks, single-use token expiry, addressed acceptance, cooldown and atomic provisioning. Registration counts every submitted attempt, including refusals. Login/password-change/reset/email/public-invite budgets remain separate. |
| A-005 through A-010, A-013 through A-015 | Exclude the global sentinel from every tenant listing/authorization/context selector; it cannot grant a seat, invitation, affiliation or platform right. Root-kind and remaining global-purpose triggers supplement the literal sentinel exclusion, mail payload and job kind CHECKs. Protected actual Owner, one active seat, endpoint kind checks, independent consent, reviewed onboarding effects, finite deletion/cancellation and fresh current access. Invitation creation attempts use their exact workspace/address 30-day window; resend uses 60 seconds. |
| A-011, C-013 through C-016, C-034 | MIME/decoding/size checks, immutable upload finalization, readiness, authorized signed downloads, claim-aware orphan cleanup, safe DOCX parsing and explicit owner-bound copy. |
| A-017 through A-030 | Live same-plant Person locking, author-only notes, household-head and tag semantics, source vocabularies, chronological human evidence, valid commitment support, stage automation, acyclic merge, guarded exact Unmerge and frozen resumable CSV choices. |
| A-032 through A-042 | Slot/leader/seat eligibility, saved assignment roster expansion, explicit version compatibility, human-earned credit, reactivation tenure and sustained attendance plus volunteering. No inferred human judgment. |
| A-012, B-033 | Original-author private calendar serialization, timezone/DST rollover, adjacent answered-week trends, private correction and all care exclusion paths. No shared event or nudge store. |
| B-001 through B-010 | Type-specific meeting guards, agenda count, kit seeding, referral-cycle checks, valid actual occurrence, frozen roster/classification and atomic finalization with obligations/evaluation duty, even with zero attendees. |
| B-012 through B-021 | One-level hierarchy and prerequisite DAG locks, live assignee eligibility, civil-time gap/fold resolution, recurrence clamping/end date, one successor, no-op and partial receipts, waiver semantics and genuine effective contact evidence. |
| B-022 through B-026 | Nine milestones/23 task seeding and deliberate deletion preservation; nonfuture actual Launch; named guest identity; valid immutable debrief submission; full summary provenance union and current recipient grants. |
| B-028 through B-032, C-018 | Once-only creation/declaration, reason and no-op distinctions, exact manual-key semantics and independent 30-day reaffirmation ages. Advisory readiness never moves phase. |
| B-035 through B-044 | Exact rendered audience/body/attachment review, fresh consent/preferences/suppression, singleton security scopes, batch partition/order validation, nonresetting 23h55m identical-request replay, signed callbacks, monotonic event facts, provider cancellation barriers, reviewed resend and bounded digest catch-up. Stateless unsubscribe/undo proofs retain 180-day/one-hour purpose limits and protected key configuration. |
| C-001 through C-011 | Safe content grammar, exact source rights, canonical hierarchy, Current Wiki source ordering enforces current affiliation recognition/sharing and church-before-network preference, new unranked recognition after rejoin, actual reader progress, six same-reader articles strictly above 0.80, complete derivative validation and atomic reference activation. |
| C-017 through C-025 | One consistent as-of snapshot, Unknown/false/zero distinctions, original formulas, source/policy/claim fences, three drafts and bounded provider retries/usage, valid output/citations, first-open/72-hour release and fresh organization contributor/category/geography checks. A revoked contributor withholds the obsolete whole portfolio result. |
| C-027 through C-035 | Private initiating context, request/sequence replay, retained-source filtering, exact trusted 15-minute review, immutable digest/effect manifest, dependency DAG, start-time current rights/revisions, generation-fenced execution, budgets/cancellation and no implicit reconnect execution. |
| A-044 through A-053 | Author-private feedback, verified platform triage, closed safe public serializer, frozen repository/issue reconciliation, optional prompt semantics, bounded durable jobs, with fairness/alert tuning deferred to measured load, atomic receipt/history/material revision/outbox and independently synchronized restore witnesses. |

Here `A-007` means `CAP-A-007`, and similarly for B/C. Behavior-only capabilities reuse these facts and runtime guards; they do not create storage. Evry adapters C-036 through C-045 reuse native operations and shared review/execution. No model-authored attestation, private-care tool, pastoral judgment or autonomous durable write is introduced.

## Named scope exceptions
Each name identifies one exact FK. The checker requires this list whenever `target.json` declares a `scope_exception`. These relationships retain the stated serialized boundary or transitive FK/CHECK proof; an exception never grants access.

- `account(id) -> record(id)`: Root identity FK uses id as owner; record CHECK kind not in ('account','plant','organization') or tenant_id = id enforces equal ownership, and the trusted subtype trigger validates the exact root kind.
- `plant(id) -> record(id)`: Root identity FK uses id as owner; record CHECK kind not in ('account','plant','organization') or tenant_id = id enforces equal ownership, and the trusted subtype trigger validates the exact root kind.
- `organization(id) -> record(id)`: Root identity FK uses id as owner; record CHECK kind not in ('account','plant','organization') or tenant_id = id enforces equal ownership, and the trusted subtype trigger validates the exact root kind.
- `identity_proof(deletion_subject_id) -> lifecycle_witness(id)`: Cancellation proof names the exact deletion witness; addressed proof boundary locks the witness and validates requester, subject, purpose, original deadline and current cancellation authority.
- `discovery(conversion_operation_id) -> operation(id)`: Conversion creates a plant from the own-account context; validate account owner, original conversion receipt and resulting plant atomically.
- `seat(invitation_id) -> invitation(id)`: Invitation owner is an endpoint, not always the plant. Serialized acceptance validates exact endpoints and tenant kind; consent cannot be inherited.
- `seat(id) -> record(id)`: Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable.
- `affiliation(invitation_id) -> invitation(id)`: Invitation owner is an endpoint, not always the plant. Serialized acceptance validates exact endpoints and tenant kind; consent cannot be inherited.
- `affiliation(recognition_operation_id) -> operation(id)`: Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership.
- `affiliation(id) -> record(id)`: Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable.
- `person_merge(operation_id) -> operation(id)`: Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership.
- `person_merge(reversed_operation_id) -> operation(id)`: Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership.
- `training_version(compatible_prior_id, program_id) -> training_version(id, program_id)`: Same-program compound FK fixes compatibility to program_id; both versions inherit the same plant through their compound program FK. No cross-plant version is possible.
- `training_requirement(article_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `training_requirement(source_revision_id) -> article_revision(id)`: Pinned training article source may be global or an entitled organization revision; native assignment validates canonical article, published state and current exact source rights.
- `training_assignment(version_id, program_id) -> training_version(id, program_id)`: Same-program compound FK fixes the version to program_id; assignment and version inherit the same plant through their compound program FK. No cross-plant assignment is possible.
- `training_assignment(selection_operation_id) -> operation(id)`: Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership.
- `task(launch_id) -> launch(plant_id)`: Launch uses plant_id as its primary key; task CHECK launch_id = plant_id enforces the same plant whenever this optional relation exists.
- `task(import_operation_id) -> operation(id)`: Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership.
- `phase_transition(operation_id) -> operation(id)`: Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership.
- `reference_version(item_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `reference_version(release_id) -> reference_release(id)`: Packaged reference versions are global-only; trusted subtype trigger binds the record to the global tenant and validates that both release and item are global approved definitions.
- `reference_version(id) -> record(id)`: Packaged reference versions are global-only; trusted subtype trigger binds the record to the global tenant and validates that both release and item are global approved definitions.
- `reference_activation(id) -> record(id)`: Serving reference activation is global-only; trusted activation boundary verifies a complete approved global release and binds its record to the global tenant.
- `reference_activation(release_id) -> reference_release(id)`: Serving reference activation is global-only; trusted activation boundary verifies a complete approved global release and binds its record to the global tenant.
- `article_revision(article_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `article_revision(upstream_revision_id) -> article_revision(id)`: Entitled upstream content may belong to global or another organization source; publication validates source rights, canonical article identity and immutable lineage.
- `article_revision(parent_article_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `article_revision(section_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `article_editor_state(article_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `article_editor_state(based_on_upstream_id) -> article_revision(id)`: Inherited upstream revision is a cross-owner source; editing validates exact source rights, canonical article identity and published lineage.
- `article_link(target_article_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `wiki_preference(recognition_operation_id) -> operation(id)`: Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership.
- `reading(article_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `reading(last_revision_id) -> article_revision(id)`: Private account reading refers to global or entitled organization content; read boundary validates canonical article, exact plant context and current source rights.
- `reading(completed_revision_id) -> article_revision(id)`: Private completion evidence pins an entitled published source revision; completion boundary validates canonical article and exact reader/source rights.
- `document(copied_from_revision_id) -> document_revision(id)`: Explicit account-to-plant copy may cite a differently owned source; validate source rights and immutable hash without transferring ownership.
- `generated_document(generation_operation_id) -> operation(id)`: The initiating operation can use an account conversation context while generating an explicitly reviewed plant-owned output; authorize exact output owner at execution.
- `assessment_contributor(recognition_operation_id) -> operation(id)`: Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership.
- `assessment_contributor(plant_assessment_id, plant_id) -> assessment(id, tenant_id)`: Organization contributor intentionally pins another-owner plant result; the compound plant FK plus exact pair affiliation, recognition, release and category grants constrain eligibility.
- `assessment_contributor(geography_id, plant_id) -> plant_geography(id, plant_id)`: Organization contributor pins the source plant geography at assessment time; compound plant FK enforces source identity, and serialized portfolio boundary validates exact relationship and grants.
- `reader_feedback(assessment_id) -> assessment(id)`: Feedback is account-private with an entitled plant/organization target; exact optional context must match assessment owner.
- `reader_feedback(finding_id) -> finding(id)`: Account-private vote may target an entitled finding; validate target and current exact context.
- `reader_feedback(article_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `reader_feedback(article_revision_id) -> article_revision(id)`: Account-private feedback targets an entitled global or organization article revision; feedback boundary validates canonical article, exact source organization and current plant-context rights.
- `plant_geography(region_item_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `message_template(source_item_id) -> reference_item(id)`: Canonical item is a global or entitled organization source identity; serialized boundary validates item kind, canonical identity and exact current source rights, without transferring ownership.
- `communication(review_id) -> review(id)`: Initiating account conversation context may differ from the plant output. Exact native operation validates actor, plant authority, review and target ownership.
- `provider_event(mail_id) -> mail(id)`: Signed external event may refer to mail in any tenant; restrict callback processing to its exact provider/message identity.
- `suppression(clear_operation_id) -> operation(id)`: Global address suppression recovery uses authenticated current self-address proof, not tenant ownership.
- `notice(source_record_id) -> record(id)`: Own inbox context may refer to an exact entitled source in another tenant; no inherited grant.
- `effect(target_record_id) -> record(id)`: Reviewed targets can be global sources or an explicitly different output owner; exact command authorizes owner and kind.
- `effect(source_record_id) -> record(id)`: Entitled source may be public/global or another explicitly authorized owner; source is not a grant.
- `effect(result_record_id) -> record(id)`: Reviewed effect output may acquire its explicit domain owner; validated before bind.
- `event(target_record_id) -> record(id)`: Immutable history may target retained body-free identities, or an authorized cross-owner consequence; validate actual target kind/owner at write.
- `job(subject_record_id) -> record(id)`: Restricted global purge/cleanup sweep may process an explicitly authorized other-owner subject; producer validates purpose/owner.
- `feedback_publication(effect_id) -> effect(id)`: Restricted public publication can use its own global effect, independently of private intake ownership; clear private linkage on purge.
- `feedback_publication(id) -> record(id)`: Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable.
- `lifecycle_witness(seat_id) -> seat(id)`: Body-free revocation witness identifies a seat endpoint; synchronized witness writer validates exact seat kind and original identity before clearing live linkage on purge.
- `lifecycle_witness(affiliation_id) -> affiliation(id)`: Body-free revocation witness identifies a relationship endpoint; synchronized witness writer validates exact affiliation identity and permitted counterparty before clearing live linkage on purge.
- `lifecycle_witness(id) -> record(id)`: Subtype trigger binds actual record owner for a global/public or retained body-free variant whose live root pointer is nullable.
- `evidence_link(target_record_id) -> record(id)`: Entitled source/selected record can have a different actual owner; validate purpose, source rights, exact grant and kind.
- `evidence_link(prior_record_id) -> record(id)`: Exact inverse prior endpoint can be cross-owner only where the reviewed native command permits; lock and validate before inverse.
- `evidence_link(resulting_record_id) -> record(id)`: Exact inverse result endpoint can be cross-owner only where the reviewed native command permits; lock and validate before inverse.

## Additional scope exceptions

- `pipeline_person(responsible_seat_id) -> seat(id)`: Current eligible duty seat belongs to the exact organization. Serialized boundary checks seat tenant/kind and current authority; the relation grants no broader access.
- `pipeline_stage_move(actor_id) -> account(id)`: Account identity is an attribution or explicitly accepted resident endpoint, not an organization seat. Revalidate exact link and consent; purge private originals and retain minimal scope-local attribution on account removal.
- `leadership_conversation(staff_account_id) -> account(id)`: Account identity is an attribution or explicitly accepted resident endpoint, not an organization seat. Revalidate exact link and consent; purge private originals and retain minimal scope-local attribution on account removal.
- `development_program(director_seat_id) -> seat(id)`: Current eligible duty seat belongs to the exact organization. Serialized boundary checks seat tenant/kind and current authority; the relation grants no broader access.
- `development_reading(article_id) -> reference_item(id)`: Reading source may be global or an entitled organization revision. Recheck canonical article identity, published state and current source rights at every read; the pointer grants no library access.
- `development_reading(source_revision_id) -> article_revision(id)`: Reading source may be global or an entitled organization revision. Recheck canonical article identity, published state and current source rights at every read; the pointer grants no library access.
- `enrollment_milestone(completed_by) -> account(id)`: Account identity is an attribution or explicitly accepted resident endpoint, not an organization seat. Revalidate exact link and consent; purge private originals and retain minimal scope-local attribution on account removal.
- `enrollment_milestone(confirmed_by) -> account(id)`: Account identity is an attribution or explicitly accepted resident endpoint, not an organization seat. Revalidate exact link and consent; purge private originals and retain minimal scope-local attribution on account removal.
- `assignment_feedback(author_id) -> account(id)`: Account identity is an attribution or explicitly accepted resident endpoint, not an organization seat. Revalidate exact link and consent; purge private originals and retain minimal scope-local attribution on account removal.
- `residency_link(account_id) -> account(id)`: Account identity is an attribution or explicitly accepted resident endpoint, not an organization seat. Revalidate exact link and consent; purge private originals and retain minimal scope-local attribution on account removal.
- `residency_link(affiliation_id) -> affiliation(id)`: The current exact account/organization affiliation must match the accepted link endpoints; it never authorizes general account or organization reads.
- `pipeline_sharing(relationship_id) -> affiliation(id)`: The affiliation must name this sending church and exact current sending network; no inherited or transitive sharing.
- `pipeline_sharing(changed_by) -> account(id)`: Account identity is an attribution or explicitly accepted resident endpoint, not an organization seat. Revalidate exact link and consent; purge private originals and retain minimal scope-local attribution on account removal.

## Architecture alignment amendments

Fix 2 records these small gap fixes to the adopted starting schema. They do not authorize application implementation.

| ID | Change |
|---|---|
| FIX2-AUTH | Use Better Auth built-in password-change/reset revocation; remove credential-generation fence columns and witness kind. |
| FIX2-LIFECYCLE | Represent immutable deletion deadline, pending hold, successful cancellation and completed live purge with nullable timestamps and literal state-shape CHECKs. |
| FIX2-AUDIT | Unify platform audit with event while preserving domain kind; nullable action has a literal closed CHECK and bounded audit diff. |
| FIX2-JOB | Add document_render to job.kind for the already required durable render handler; restricted backup/expiry remain outside ordinary job dispatch. |
| E1-ACCESS-REQUEST | Align WP-097 with applied E4 migration 0001 and its runner: early_access_request with validated data/frozen mail payload and nullable receipt fields, keyless early_access_attempt limiter facts, and schema_migration with its text key. Strict retention cutoffs and the approved E3 field/phase contract apply; no tenant or product tables are consumed. |
| ADR001-CONTRACT | Owner-approved organization Person lifecycle, consented seatless residency and stage 1/2 pipeline/program records; stages 3/4 deferred. |

The architecture and Person checks compare documentation identifiers and registries with this authority. They do not execute database triggers, auth or restore. Material revisions come from intelligence-owned database triggers on assessment input tables, proved against the input builder. Before customer data, G-RECOVERY adds encrypted daily copies, witness synchronization and the restricted backup host; build recovery uses native seven-day Neon/Tigris history.
