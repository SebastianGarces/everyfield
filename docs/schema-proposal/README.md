# Minimal schema proposal

This is a documentation proposal, not a migration or implementation plan. It starts from the three reviewed capability inventories. The current target is a comparison baseline. Only its four Better Auth tables retain their reviewed adapter shape.

Run from the repository root:

```sh
python3 docs/schema-proposal/check.py
python3 docs/schema-proposal/check.py --self-test
```

The script also works from another directory. It reads files relative to its own location. `--root` selects a fixture repository. `--proposal` checks an alternate proposal. The self-test creates temporary files and calls the public CLI. It tests valid input and each required failure: missing FK table, missing local or remote FK column, missing PK column, missing unique column, unmapped persistent capability, missing active feature, missing/scalar mixed-scope parent FK, nullable owner bypass, unconditional NULL predicates, missing closed-value CHECK and catalog drift.

## Comparison

These numbers come from `check.py`. Columns count physical column definitions, including every nullable arm of a checked union. An FK is one declared constraint, including a compound FK. JSONB counts columns, not keys or payload bytes. All tables and library-owned fields are included. Indexes, CHECKs, triggers, packaged artifacts, private object bytes and backups are not columns.

| Schema | Tables | Columns | FKs | JSONB columns |
|---|---:|---:|---:|---:|
| Current | 120 | 1873 | 435 | 64 |
| Proposal | 100 | 1251 | 410 | 11 |
| Better Auth subtotal, both schemas | 4 | 40 | 2 | 0 |

The proposal removes 20 tables, 622 columns and 25 FKs from the current target. The 11 JSONB columns hold opaque values, never SQL selection or authorization fields. Count reductions describe live database definitions; external backup artifacts and packaged definitions still retain their required facts.

Static definitions still exist in immutable packaged files. Moving a template payload out of SQL does not eliminate its fields or bytes. Examples already exist in `docs/reference/`: the task, ministry, document and mail template sources; the phase criteria; the Discovery list; and the bootstrap manifest. Geography datasets, qualification artifacts and backup inventories also retain their own versioned files. `reference_item`, `reference_version` and `reference_release` retain relational identities, locators and hashes. Backup inventories retain theirs solely in the restricted external artifact. The proposal does not create these future release or backup artifacts.

`check.py` assigns current tables to domains explicitly because the current schema has ownership scopes, not the proposal's domain labels. Execution tables move from assistant to operations. System activity moves from domain-specific tables to operations. This changes domain subtotals as well as total size.

| Domain | Current tables / columns / FKs / JSONB | Proposal tables / columns / FKs / JSONB |
|---|---|---|
| assistant | 9/154/50/12 | 3/38/14/2 |
| care | 2/25/5/2 | 3/31/6/0 |
| communication | 10/174/36/8 | 12/146/49/3 |
| documents | 5/90/27/2 | 4/47/15/1 |
| identity | 7/88/8/0 | 8/77/12/0 |
| intelligence | 7/123/33/9 | 6/96/34/1 |
| launch | 5/75/15/5 | 4/46/12/0 |
| meetings | 9/147/33/2 | 6/94/25/0 |
| operations | 7/149/22/7 | 11/179/53/2 |
| people | 11/176/35/6 | 10/123/39/2 |
| phases | 3/44/7/2 | 2/28/8/0 |
| reference | 5/58/8/2 | 5/46/16/0 |
| tasks | 9/127/39/3 | 5/75/33/0 |
| teams | 9/135/39/2 | 9/91/43/0 |
| tenancy | 12/197/40/2 | 7/78/24/0 |
| wiki | 10/111/38/0 | 5/56/27/0 |

Coverage is 494 of 494 active features and 119 of 119 persistent capabilities. There are 143 capabilities, including 24 behavior-only groups. Group A covers 81 feature IDs, B covers 85, and C covers 328. Several capabilities share features, so a feature is counted once within its group. Exclusion and consolidated-alias IDs remain covered. Catalog implementation status does not remove a feature from the check.

Coverage proves that a table names each persistent capability. It does not prove that every fact, privacy rule or transaction is implemented. Tag normalized names are the one small derived key retained for the named plant-scoped case-insensitive tag uniqueness query. A CHECK ties the key to its trimmed display name.

The checker validates both schemas' named keys and FKs, FK arity and types, unconditional referenced keys, domain assignments, replacement names, library flags and JSONB key documentation. Proposal checks also reject UUID relations without FKs, mixed-scope parent FKs without matching tenant pairs or a named source exception, nullable global owners, unconditional NULL predicates and missing literal closed-set CHECKs. Operation/effect/read-purpose/projection sets must match the current catalog. It does not execute CHECK text, constraint triggers, SQL, Better Auth, storage, providers or application acceptance tests. Independent semantic review remains required. This is a smaller candidate, not a proof that no smaller valid design exists.

## Second pass changes

| Stage | Tables | Columns | FKs | JSONB |
|---|---:|---:|---:|---:|
| First reviewed design | 104 | 1460 | 490 | 9 |
| Listed fixes 1 through 14, with the MTG-019 ruling | 100 | 1254 | 410 | 11 |
| After the additional table-by-table pass | 100 | 1251 | 410 | 11 |

The final design removes 4 tables, 209 columns and 80 FKs from the first pass, with 2 additional opaque JSONB columns. The review's 1255-column model included a legacy-response column that the coordinator rejected, leaving 1254 before the three further savings.

1. Replaced the sparse reference wrapper with `record`, and the mixed owner arms with `tenant`. Generic fields now use `*_record_id` names. Same-owner mixed children use compound FKs, with named exceptions for real source/endpoint relationships. Global work has one nonnull restricted identity to close FK bypasses.
2. MTG-019 gets no legacy-response column. `docs/START-HERE.md` defines a fresh project with no customers or migration, so those historical responses cannot exist. Removed only the legacy-response fact from CAP-B-005. MTG-019 remains covered by same-plant inviter, independent RSVP and its history; merge/inverse references remain in typed links.
3. Added literal CHECK sets for all surviving fields from fix 4. Removed stores make `job_cursor.kind` and `recovery_copy.environment` inapplicable; job kinds remain checked and recovery environment stays in the external artifact. `operation.name`, `effect.kind`, source read-purpose IDs and projections derive from the current operation catalog, excluding private-care operations. Stop-reason/channel/purpose spellings are technical closed-code choices with no added behavior. `operation.provider = 'qualified_model'` names the logical qualified route; `model_id` must pin its immutable actual vendor/model profile. Mail uses the selected `resend` route. Qualification and spending remain separate gates.
4. Added required-column CHECKs for every evidence-link purpose. Removed topology and contributor duplicates, then replaced compatibility with a typed same-program prior-version FK.
5. Moved sweep cursors to `job.checkpoint_key`, restricted backup/restore metadata outside the live database, and the one-to-one candidate plan onto `conversation`. Removed assessment copies of job retry/eligibility/claim data.
6. Derived invitation deadline from creation plus 720 hours, review expiry from publication plus 15 minutes, staging expiry from original upload plus 24 hours, and cancellation deadline from request plus 30 days. Removed stored UTC offsets on meeting/task/communication. Zone, wall time, stored instant and resolver version preserve civil-time provenance.
7. Moved attached handles into attachment-kind conversation entries, retaining object/turn identity, original upload instant, state and bound effect. Moved frozen command/document values into their two documented opaque JSONB fields; typed selection/dependency/inverse gates remain outside JSONB.
8. Keyed Launch by `plant_id`, removed duplicate child Launch IDs and replaced their parent FKs with the same plant key. Those child FKs already imply plant existence through Launch, so no duplicate direct-plant FK is needed. Optional `task.launch_id` stays as the relation selector, with a CHECK equating it to its plant when present.

The additional pass checked every remaining table against its capabilities. Three more columns could go without merging unrelated lifecycles:

- `prompt_dismissal.dismissed`: exact row presence records dismissal; undo deletes that own-context row. Revision and the existing uniqueness key remain.
- `private_calendar.id`: the existing unique, nonnull `account_id` is its UUID PK. The isolated table and private timezone/rollover state remain; no generic identity or shared history is introduced.
- `notice.utc_offset_seconds`: derive it from the scheduled wall time, zone and eligibility instant, retaining resolver provenance just as on communication/task/meeting scheduling.

Identity/admission/proof stores stay separate because their library, credential and throttling lifecycles differ. Tenant profiles and conversion lineage stay separate; endpoint consent is not ownership. People assessments/signatures retain distinct scales and human meanings. Team training versions, assignments and credit keep immutable applicability. Meeting evaluation stays separate from ordinary meetings. Tasks keep recurrence and obligations independent from completion. Phases and testimony keep their own dated semantics. Launch keeps versioned debriefs and seeded milestones. All private-care tables remain isolated. Reference releases/items/versions/activations/passages preserve serving-generation lineage. Wiki revision, editing, topology, source preference and reading lifecycles differ. Documents retain source revisions and generated bytes. Intelligence keeps immutable facts/findings and exact contributor rosters. Communication keeps exact ordered request/member/attempt truth. Assistant entries, conversations and reviews retain their different lifetimes. Remaining operations tables keep receipts, declared dependency DAGs, safe history, fair jobs, private feedback, public locator outcomes and restore witnesses. Further merges would create sparse unions, mix privacy boundaries or lose independently required history.

## Design rules used

1. Each table names the capabilities that require it. There is no table for a behavior-only helper or derived dashboard.
2. Use third normal form for current domain data. Keep immutable evidence separately when the capability requires it.
3. Give each ordinary record one UUID PK. Pure links use natural composite keys: Person tags, task prerequisites, effect dependencies and ordered mail membership. One-to-one Launch and private calendar use their existing UUID owner key, without a second surrogate.
4. Declare real FKs. Direct domain relationships use ordinary or compound FKs. Cross-domain targets use one stable `record` identity and typed subtype FKs; subtype triggers bind kind and actual owner.
5. Share records only where their shape and lifecycle match. Use one semantic event stream, one operation receipt and one mail ledger.
6. Closed states use text with CHECKs. Tags are a user-editable vocabulary. Static reference definitions are versioned files with relational identity records. The unresolved complete Person source vocabulary is called out below.
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
| One body-free `tenant` identity; separate account, plant and organization bodies. | Owner identity can be shared without merging different profiles, deletion rules or permissions. A fixed global root closes nullable compound-FK bypasses. | One sentinel row must be excluded from every application tenant query. Root-kind consistency and global-purpose restrictions still require deferred triggers. The identity is never a grant. |
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
| One mail ledger, with normalized request/order/attempt facts. | Unknown whole-batch replay needs the exact request, order, provider key and original clock. Per-member outcomes must survive later retries. | Two explicit request/membership tables. This is more structure than the current embedded manifest, but avoids hiding ordered IDs in JSON or repeating them on every attempt. |
| Merge pending upload and object metadata into `file_object`. | One generated immutable key has one pending-to-ready lifecycle and cleanup fence. | Metadata must not claim readiness until upload validation and reference finalization succeed. Replacement always makes a new object. |
| Merge own bookmark state into the existing reading row. | Both have one account/canonical-article identity and account-private lifecycle. | A bookmark-only row has zero observed progress and no completion; it does not create reading evidence. |
| Keep private calendar, weeks and corrections isolated. | Even unanswered weeks and timezone transitions are private original-author facts. | An extra dedicated calendar table. No shared event, reference, job, effect, model or export path may contain care data. |
| Keep body-free lifecycle witnesses after live roots are purged. | Restore must respect current deletions, revoked grants and credential generations, even if a stale backup contains them. | Controlled opaque historical identity keys without live-root FKs after purge. Witnesses can deny access, never grant it. |

`effect.arguments` and `generated_document.inputs` are opaque frozen JSONB values. The closed native command/template boundary validates schema version, keys, indices and values before review. The effect payload hash pins its exact canonical arguments; generated bytes and the object hash pin document output. SQL never filters or joins these arguments. Exact selections and any identities/revisions needed by SQL inverse guards remain in `evidence_link` or typed domain FKs. The tradeoff is loss of SQL per-key type/FK checking; start-time native authorization resolves each argument afresh, so a deleted UUID argument cannot block purge or confer rights.

## Ownership and integrity rule

Mixed-scope rows use one nonnull `tenant_id` FK. Account, plant and organization PKs also reference `tenant`; a trusted root trigger enforces the matching kind. A CHECK binds `kind = 'global'` exactly to the all-zero UUID; the PK allows at most one such row. Account, plant and organization root CHECKs exclude that UUID. Invitation and every context that formerly required a real owner also CHECK that `tenant_id` differs from it. Seat, affiliation and platform-grant endpoint FKs point only to those real roots, so they cannot refer to the global sentinel. It represents restricted global work, public source identities and body-free external stubs. It is not a customer workspace. Keeping its UUID nonnull makes compound FKs enforce parent existence and equal ownership in global work too. Tenant identities survive live-root purge; ordinary access still requires the live authorized root.

Every same-owner mixed child points to the parent's unconditional `(id, tenant_id)` key. Mail member/event links also include tenant in their ordered/composite keys. A copied source, entitled citation, explicit cross-owner output or historical target can legitimately have another owner. Its FK carries a named `scope_exception` in `schema.json`; a serialized deferred trigger/native boundary must lock the endpoints, validate exact kinds/rights/purpose, and refuse an unauthorized mismatch. Compound FKs do not grant current access. Parent deletion, source revocation and owner transfer need the same fresh checks.

Tenant-kind rules replace the old always-null arms. Documents and generated documents allow only account or plant owners; Launch summaries require plant. Assessments allow plant or organization, and their children inherit that exact owner through compound FKs. Planter digest coverage requires plant; oversight coverage requires organization. Seat invitations allow plant/organization, plant relationship invitations use plant, Discovery relationship invitations use account, and church-network invitations use a sending-church organization. Global mail may contain a payload only for `public_invite`; purged outcome stubs retain no payload/address and cannot dispatch. These cross-table kind rules require deferred triggers, not imaginary CHECK subqueries.

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

`record(id, kind, tenant_id)` has one row per referenceable entity, allocated with that entity's own PK. A trusted subtype insert trigger sets exact kind and actual owner; a deferred constraint trigger refuses a second subtype/body at that ID, wrong kind, or owner mismatch. Source/global/retained-body exceptions also validate owner through that trigger. Changing ownership is possible only through a reviewed domain bind that atomically updates subtype and record. Deleting a subtype leaves only its body-free identity when independent permitted history requires it; otherwise purge the identity too. A retained record can resolve historical attribution, never a body or current right. Secret credential/RSVP proofs and all care tables are excluded. Launch shares its plant's record, so a Launch consumer uses the plant UUID and verifies the live Launch row when needed.

`evidence_link` has exactly one entity consumer or event consumer and one mandatory target record. Every retained purpose has a required-column CHECK. Citation requires registered projection/read-purpose and completeness; partial citations require a cursor. Inverse moves require field path and both revision guards, with nullable prior/result endpoints preserving real absence. `article_link`, `assessment_contributor` and `training_version.compatible_prior_id` are the only homes for topology, contributor roster and training compatibility. Consumer/target kinds and purpose-specific optional fields still need the trusted writer. Composite links keep their actual endpoint FKs; no surrogate is added merely to make them a generic target.

Original human recorder/assessor/verifier and old/new correction values live in immutable create/earn/record events for their actual typed target. `person_note.author_id` additionally protects author-only editing. A shared actor becomes a scope-local opaque tombstone on account purge. No private author stream transfers to a successor. Emit genuine domain history, not merely a generic changed event. Readable task/status/stage/contact/reading dates and values stay in scalar event columns; opaque diffs are not metric truth.

## History, publication and recovery

Freeze source-bearing fields of reference/article/training/document versions, submitted debriefs, complete assessment facts/findings, reviewed effects and opaque inputs. Mutable execution state may advance without changing a published manifest's digest or arguments. A new edit creates a new version or an attributable correction under the owning resource. No-op replay returns the original receipt.

The latest effective geography row is current locality. The highest committed reference activation is the serving generation. A current assessment is the latest still-authorized complete result, ordered by durable availability and ID; pending/failed work does not erase it. A native summary reader uses the latest published whole document revision, not a later unpublished draft. Keep captured phase/as-of and previous released results separate from current phase and embargoed results.

A reviewed Launch summary always has a Meetings source-category baseline. `evidence_link` adds every actual contributing category and source. Every whole-revision read requires the current exact affiliation, `shared_findings` and the full category union. Summary publication is immediate to eligible recipients. Model-result release instead follows a genuine eligible first open or 72 elapsed hours after durable availability.

Each per-recipient transport event binds `mail_attempt`, its `mail_request`, ordered member index and actual mail target. This records refusal/unknown/acceptance even after a later safe retry changes the current mail row. Mail acceptance, sent/delivery, opens/clicks, RSVP, contact and task completion remain distinct facts. Frozen payloads are encrypted and excluded from generic history/model projections.

Deletion suspends normal access at request commit. Cancellation is strictly before 30 elapsed days and restores only independently still-valid grants. Current lifecycle and pending security mutation state gate all ordinary reads, writes, dispatch and signed issuance. Coherent live purge starts a nonresetting recovery-copy horizon of at most seven days. Keep claim generations and actual byte/cancellation outcomes. Global address suppression restoration requires fresh proof of the current self address.

Purge in dependency order with RESTRICT FKs. Clear optional current pointers and private provenance links explicitly. Delete account-private conversations, reviews, frozen argument bodies, drafts, votes, reading, proofs, avatars and care with their actual owner. Legitimate shared domain receipts may retain only minimal factual attribution. Delete revoked/copied bodies and every affected mixed organization run when a source plant becomes purge-eligible; contributor links locate the whole run, not a subtraction from old prose. Counterparty relationship history retains only body-free permitted facts. No audit, snapshot or organization ownership creates an indefinite retention exception. Scrub private mail addresses, address hashes and frozen bodies, clearing expired owner/recipient/provenance FKs. An accepted or unknown mail row can retain only body-free external locator/outcome facts and its original request key/clock. It cannot dispatch. Similarly, feedback publication clears its account, intake, category, area, title and body while retaining only the frozen published/unknown issue locator, marker, hash and outcome. Unattempted rows need no retained stub.

`lifecycle_witness` retains current body-free deletion, seat/affiliation revocation and credential-generation facts in an independently synchronized witness artifact. After a live root is removed, clear its FK and retain the opaque historical key. Delete private consumer bodies and provenance links. Independent permitted history keeps the existing body-free `record` identity without rebinding or rewriting append-only events. Never treat that identity or the witness as a live account, grant or dispatch target. The external restricted recovery artifact, outside this database, pins the encrypted inventory, object checksums, schema, LSN, key version, environment, original expiry, verification and restore receipt. It also records failed schedules and actual recovery checks, so a database restore cannot roll its own backup ledger backward. The restricted manifest records each embedded subject's original expiry. Recopy and restore take the minimum original expiry and reapply current witnesses before service opens. Key material remains outside ordinary database rows. Private-care recovery still enforces original-author access and exclusions. Provider cleanup distinguishes inaccessible bytes from physically confirmed erasure; this is not a universal physical day-37 promise.

## Current tables merged or removed

This mapping covers every current table. Reusing a name does not mean reusing its old column layout. A current table can contribute fields to several proposal resources. `schema.json.replaces` records those moves.

| Current table | Where the data lives |
|---|---|
| `auth_user` | `auth_user` |
| `auth_account` | `auth_account` |
| `auth_session` | `auth_session` |
| `auth_verification` | `auth_verification` |
| `auth_throttle` | `admission_attempt` |
| `app_account` | `account`, `lifecycle_witness` |
| `tenancy_membership` | `seat` |
| `platform_grant` | `platform_grant` |
| `access_invitation` | `invitation` |
| `account_person_link` | `person` |
| `plant` | `lifecycle_witness`, `plant`, `plant_geography` |
| `organization` | `organization` |
| `organization_network_link` | `affiliation` |
| `plant_affiliation` | `affiliation` |
| `organization_sharing_settings` | `affiliation` |
| `discovery_profile` | `discovery` |
| `discovery_association` | `affiliation` |
| `association_invitation` | `invitation` |
| `association_event` | `event` |
| `household` | `household` |
| `person` | `person` |
| `person_tag_definition` | `tag` |
| `person_tag` | `person_tag` |
| `person_skill` | `person_skill` |
| `person_4c_assessment` | `four_cs` |
| `person_interview` | `interview` |
| `person_commitment` | `commitment` |
| `person_activity` | `event`, `person_note` |
| `record_correction` | `event` |
| `person_merge` | `person_merge` |
| `ministry_team` | `team` |
| `team_role` | `team_role` |
| `team_membership` | `team_tenure` |
| `team_responsibility` | `responsibility` |
| `training_program` | `training_program` |
| `training_requirement_version` | `training_version` |
| `training_assignment_episode` | `training_assignment` |
| `training_assignment_event` | `event` |
| `training_completion` | `training_credit` |
| `meeting_location` | `venue` |
| `meeting` | `meeting`, `meeting_item` |
| `meeting_participation` | `participation` |
| `meeting_invitation` | `participation` |
| `meeting_rsvp_token` | `rsvp_proof` |
| `vision_response` | `participation` |
| `meeting_evaluation` | `meeting_evaluation` |
| `meeting_checklist_item` | `meeting_item` |
| `meeting_event` | `event` |
| `recurrence_series` | `recurrence` |
| `follow_up_obligation` | `obligation` |
| `task` | `task` |
| `task_relation` | `task` |
| `task_dependency` | `task_dependency` |
| `task_status_event` | `event` |
| `follow_up_outcome` | `contact_outcome` |
| `phase_template_offer_response` | `phase_transition` |
| `template_import_receipt` | `operation` |
| `phase_transition` | `phase_transition` |
| `plant_attestation` | `attestation` |
| `person_attestation` | `attestation` |
| `launch` | `document`, `document_revision`, `launch`, `launch_debrief` |
| `launch_event` | `event` |
| `launch_milestone` | `launch_milestone` |
| `launch_milestone_task` | `launch_milestone` |
| `launch_person_attendance` | `launch_guest` |
| `planter_checkin` | `private_week` |
| `planter_checkin_event` | `private_week_revision` |
| `reference_release` | `reference_release` |
| `reference_activation` | `reference_activation` |
| `reference_section` | `article_revision`, `reference_item`, `reference_version` |
| `wiki_article` | `reference_item` |
| `wiki_source` | `article_revision` |
| `wiki_article_version` | `article_revision` |
| `organization_wiki_article_state` | `article_editor_state` |
| `plant_wiki_source_order` | `wiki_preference` |
| `plant_wiki_source_order_entry` | `wiki_preference` |
| `wiki_read_progress` | `reading` |
| `wiki_read_event` | `event` |
| `wiki_bookmark` | `reading` |
| `wiki_article_feedback` | `reader_feedback` |
| `reference_chunk` | `passage` |
| `reference_template_version` | `reference_version` |
| `owned_documents` | `document` |
| `owned_document_revisions` | `document_revision` |
| `generated_document` | `generated_document` |
| `upload_intent` | `file_object` |
| `object_metadata` | `file_object` |
| `assessment_demand` | `assessment` |
| `intelligence_assessment_run` | `assessment` |
| `intelligence_insight` | `finding` |
| `organization_intelligence_runs` | `assessment` |
| `organization_intelligence_contributor` | `assessment_contributor` |
| `organization_intelligence_assessments` | `assessment` |
| `intelligence_feedback` | `reader_feedback` |
| `message_template` | `message_template` |
| `communication` | `communication` |
| `communication_recipient` | `communication_recipient` |
| `email_intent` | `mail` |
| `email_attempt` | `mail_attempt` |
| `provider_event_receipt` | `provider_event` |
| `communication_delivery_retry` | `communication` |
| `email_suppression` | `suppression` |
| `notification_preference` | `notification_preference` |
| `inbox_entry` | `notice` |
| `assistant_conversation` | `conversation` |
| `assistant_message` | `conversation_entry` |
| `assistant_artifact` | `conversation_entry` |
| `assistant_attachment` | `conversation_entry` |
| `assistant_plan` | `conversation` |
| `assistant_approval` | `review` |
| `operation_execution` | `operation` |
| `operation_effect` | `effect` |
| `operation_result` | `operation` |
| `product_feedback` | `feedback` |
| `feedback_publication` | `feedback_publication` |
| `command_receipt` | `operation` |
| `job` | `job` |
| `audit_event` | `event` |
| `deletion_witness` | `lifecycle_witness` |
| `recovery_manifest` | External restricted recovery artifact |

Specific removals matter:

- `organization.contact_website` has no capability and is omitted, as the inventory review required.
- Team/role `reports_to` hierarchy fields, speculative team type/phase fields and responsibility seeding timestamps do not define current product behavior. Template identity, explicit leader provenance, ordinary slots and offer decisions do.
- Household head is derived from current Person household roles. Original address and propagation choices remain in events and exact effects.
- First genuine commitment date derives from valid original signatures and lifecycle/correction history. Withdrawal does not erase acquisition; reactivation does not create another acquisition.
- Meeting attendee totals, average evaluation score, agenda duration, staffing/training percentages, milestone progress, inbox counts, digest recipient counts and dashboard metrics derive from actual owned records. Saved assessments retain their immutable typed measured values.
- Wiki source identity is the exact organization FK or global release. Sections and approved templates retain canonical identities and immutable file definitions. There is no editable source catalog or cached preferred winner.
- Redundant HTML/plain-text/current/body snapshots are omitted where canonical safe content can render them. Exact sent payloads and saved generated bytes remain frozen exceptions.
- Whole-row `created_at`/`updated_at` copies and three-column actor envelopes are removed where the dated semantic event already supplies that information. Better Auth retains its required timestamps.

New explicit stores close real needs rather than revive unsupported features: `admission_attempt` records exact rolling reservations; `prompt_dismissal` records optional own choices; `private_calendar` protects unanswered-week rollover; `training_requirement` makes obligations queryable; `plant_geography` versions placement; and normalized mail membership plus typed evidence avoids ID arrays. The named typed manifest/evidence records and opaque frozen inputs replace previously embedded facts. No new customer workflow, finance, safety, service-calendar or hierarchy product is added.

## JSONB columns and keys

These keys are also recorded in `schema.json.jsonb_keys`. All other structured facts use columns or real links. Opaque scalar before-images can be restored only after typed revision/inverse guards pass; SQL does not inspect their fields to decide eligibility. Account/photo/household/moved-row references are outside those payloads.

| Column | Documented keys | Use |
|---|---|---|
| `person_merge.before_values` | `contact_fields`; `lifecycle_values` | Whole scalar inverse before-image; no joins or permission decisions. |
| `person_merge.field_choices` | `contact_field` | Display of scalar choices; exact arguments are frozen JSONB and SQL inverse guards are typed links. |
| `assessment.model_parameters` | `temperature`; `max_output_tokens`; `seed` | Opaque provider settings pinned to the run. Typed counters own budgets. |
| `mail.frozen_payload` | `subject`; `html`; `text`; `secret` | Encrypted exact rendered bytes. Typed mail metadata owns dispatch gates. |
| `mail_attempt.provider_payload` | `request_id`; `status`; `error` | Allowlisted transport diagnostic only. Member outcomes are typed events. |
| `provider_event.safe_payload` | `diagnostic` | Allowlisted diagnostic only. Event identity, kind, time and processing are columns. |
| `conversation_entry.display_payload` | `layout`; `preview` | Presentation hints and safe preview only. Entitled sources and cursor/completeness are typed links. |
| `conversation.plan_document` | `notes`; `questions`; `answers`; `todo` | Private model-authored planning content. It cannot authorize effects. |
| `effect.arguments` | `schema_version`; `values`; `source_provenance` | Frozen native command arguments. Exact target/selection/inverse/dependency gates remain typed. |
| `generated_document.inputs` | `schema_version`; `values`; `source_provenance` | Frozen template merge inputs. Template boundary validates keys and values; SQL never joins them. |
| `event.diff` | `before`; `after` | Permitted scalar old/new audit values. Required history, targets, dates and transitions are typed. |

Native document bodies and article text are canonical safe content, not disguised reference lists. Static template and backup files contain their own documented structured definitions outside SQL. `evidence_link.value_snapshot` stores a frozen scalar citation value; it must not carry encoded IDs or a serialized nested manifest. Frozen JSONB may hold bounded native rich text and UUID arguments for boundary resolution. It cannot hide SQL ownership, effect dependencies or required inverse eligibility inside a payload.

## Capabilities that need runtime logic

A CHECK cannot prove current authority, a multi-row cycle, an external outcome or a time-dependent rule. These obligations remain explicit:

| Capabilities | Required behavior |
|---|---|
| A-001 through A-006, A-009 | Native auth proof, credential generations, rolling-window reservation locks, single-use token expiry, addressed acceptance, cooldown and atomic provisioning. Registration counts every submitted attempt, including refusals. Login/password-change/reset/email/public-invite budgets remain separate. |
| A-005 through A-010, A-013 through A-015 | Exclude the global sentinel from every tenant listing/authorization/context selector; it cannot grant a seat, invitation, affiliation or platform right. Root-kind/global-purpose triggers supplement the literal sentinel exclusion CHECKs. Protected actual Owner, one active seat, endpoint kind checks, independent consent, reviewed onboarding effects, finite deletion/cancellation and fresh current access. Invitation creation attempts use their exact workspace/address 30-day window; resend uses 60 seconds. |
| A-011, C-013 through C-016, C-034 | MIME/decoding/size checks, immutable upload finalization, readiness, authorized signed downloads, claim-aware orphan cleanup, safe DOCX parsing and explicit owner-bound copy. |
| A-017 through A-030 | Live same-plant Person locking, author-only notes, household-head and tag semantics, source vocabularies, chronological human evidence, valid commitment support, stage automation, acyclic merge, guarded exact Unmerge and frozen resumable CSV choices. |
| A-032 through A-042 | Slot/leader/seat eligibility, saved assignment roster expansion, explicit version compatibility, human-earned credit, reactivation tenure and sustained attendance plus volunteering. No inferred human judgment. |
| A-012, B-033 | Original-author private calendar serialization, timezone/DST rollover, adjacent answered-week trends, private correction and all care exclusion paths. No shared event or nudge store. |
| B-001 through B-010 | Type-specific meeting guards, agenda count, kit seeding, referral-cycle checks, valid actual occurrence, frozen roster/classification and atomic finalization with obligations/evaluation duty, even with zero attendees. |
| B-012 through B-021 | One-level hierarchy and prerequisite DAG locks, live assignee eligibility, civil-time gap/fold resolution, recurrence clamping/end date, one successor, no-op and partial receipts, waiver semantics and genuine effective contact evidence. |
| B-022 through B-026 | Nine milestones/23 task seeding and deliberate deletion preservation; nonfuture actual Launch; named guest identity; valid immutable debrief submission; full summary provenance union and current recipient grants. |
| B-028 through B-032, C-018 | Once-only creation/declaration, reason and no-op distinctions, exact manual-key semantics and independent 30-day reaffirmation ages. Advisory readiness never moves phase. |
| B-035 through B-044 | Exact rendered audience/body/attachment review, fresh consent/preferences/suppression, singleton security scopes, batch partition/order validation, nonresetting 23h55m identical-request replay, signed callbacks, monotonic event facts, provider cancellation barriers, reviewed resend and bounded digest catch-up. Stateless unsubscribe/undo proofs retain 180-day/one-hour purpose limits and protected key configuration. |
| C-001 through C-011 | Safe content grammar, exact source rights, canonical hierarchy, explicit church-before-network preference, new unranked recognition after rejoin, actual reader progress, six same-reader articles strictly above 0.80, complete derivative validation and atomic reference activation. |
| C-017 through C-025 | One consistent as-of snapshot, Unknown/false/zero distinctions, original formulas, source/policy/claim fences, three drafts and bounded provider retries/usage, valid output/citations, first-open/72-hour release and fresh organization contributor/category/geography checks. A revoked contributor withholds the obsolete whole portfolio result. |
| C-027 through C-035 | Private initiating context, request/sequence replay, retained-source filtering, exact trusted 15-minute review, immutable digest/effect manifest, dependency DAG, start-time current rights/revisions, generation-fenced execution, budgets/cancellation and no implicit reconnect execution. |
| A-044 through A-053 | Author-private feedback, verified platform triage, closed safe public serializer, frozen repository/issue reconciliation, optional prompt semantics, fair durable jobs, atomic receipt/history/material revision/outbox and independently synchronized restore witnesses. |

Here `A-007` means `CAP-A-007`, and similarly for B/C. Behavior-only capabilities reuse these facts and runtime guards; they do not create storage. Evry adapters C-036 through C-045 reuse native operations and shared review/execution. No model-authored attestation, private-care tool, pastoral judgment or autonomous durable write is introduced.

## Open questions for Sebastian

1. The product specifies a closed Person source vocabulary and explicitly requires `other` and `meeting_guest_list`, but it does not enumerate the complete set in the current chapters or target type catalog. Which complete list should be approved? The proposal keeps `source` as text and names the required closed CHECK contract. It deliberately does not invent a narrower list. This CHECK must become literal SQL before implementation.
2. Should the stable record supertype be adopted with trusted subtype triggers? I recommend it. It gives event/job dedupe the entity's actual identity and preserves permitted history through purge. The cost is trigger proof for subtype kind and owner; FK existence alone cannot prove those facts.
3. Should the explicit mail request/member normalization be adopted? I recommend it. It preserves exact ordered batch replay without JSONB IDs or duplicated request facts. Keeping the current embedded-manifest approach would be smaller only by relaxing the proposal's JSONB rule or accepting denormalization.
4. May current assessment publication be derived from the latest authorized complete result? I recommend deriving it now. It saves mutable pointer authority. A future measured history-query bottleneck could justify a pointer with one atomic publication owner.
5. Should canonical reference definitions remain packaged artifacts? I recommend retaining that permitted approach. They already change through reviewed releases. A future customer-editable definition would require typed owned rows and a separate product decision.

These questions concern approval of the documented choices before implementation. They do not request deployment, database changes, provider spending or a PR. The independent reviewer should also inspect the complete capability-to-field semantics, ownership exceptions, source-kind constraints and retention paths; the mechanical coverage result cannot substitute for that review.
