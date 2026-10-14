# Minimal schema proposal

This is a documentation proposal, not a migration or implementation plan. It starts from the three reviewed capability inventories. The current target is a comparison baseline. Only its four Better Auth tables retain their reviewed adapter shape.

Run from the repository root:

```sh
python3 docs/schema-proposal/check.py
python3 docs/schema-proposal/check.py --self-test
```

The script also works from another directory. It reads files relative to its own location. `--root` selects a fixture repository. `--proposal` checks an alternate proposal. The self-test creates temporary files and calls the public CLI. It tests valid input and each required failure: missing FK table, missing local or remote FK column, missing PK column, missing unique column, unmapped persistent capability, and missing active feature.

## Comparison

These numbers come from `check.py`. Columns count physical column definitions, including every nullable arm of a checked union. An FK is one declared constraint, including a compound FK. JSONB counts columns, not keys or payload bytes. All tables and library-owned fields are included. Indexes, CHECKs, triggers, packaged artifacts, private object bytes and backups are not columns.

| Schema | Tables | Columns | FKs | JSONB columns |
|---|---:|---:|---:|---:|
| Current | 120 | 1873 | 435 | 64 |
| Proposal | 104 | 1460 | 490 | 9 |
| Better Auth subtotal, both schemas | 4 | 40 | 2 | 0 |

The proposal removes 16 tables and 413 columns. It adds 55 FKs. Explicit ordered mail membership, typed training requirements, snapshot facts and checked evidence targets account for part of that increase. The nine JSONB columns do not hide searchable operational fields.

Static definitions still exist in immutable packaged files. Moving a template payload out of SQL does not eliminate its fields or bytes. Examples already exist in `docs/reference/`: the task, ministry, document and mail template sources; the phase criteria; the Discovery list; and the bootstrap manifest. Geography datasets, qualification artifacts and backup inventories also retain their own versioned files. `reference_item`, `reference_version`, `reference_release` and `recovery_copy` retain their identities, locators and hashes. The proposal does not create these future release or backup artifacts.

`check.py` assigns current tables to domains explicitly because the current schema has ownership scopes, not the proposal's domain labels. Execution tables move from assistant to operations. System activity moves from domain-specific tables to operations. This changes domain subtotals as well as total size.

| Domain | Current tables / columns / FKs / JSONB | Proposal tables / columns / FKs / JSONB |
|---|---|---|
| assistant | 9 / 154 / 50 / 12 | 5 / 60 / 27 / 2 |
| care | 2 / 25 / 5 / 2 | 3 / 32 / 6 / 0 |
| communication | 10 / 174 / 36 / 8 | 12 / 160 / 50 / 3 |
| documents | 5 / 90 / 27 / 2 | 4 / 54 / 19 / 0 |
| identity | 7 / 88 / 8 / 0 | 8 / 77 / 9 / 0 |
| intelligence | 7 / 123 / 33 / 9 | 6 / 105 / 34 / 1 |
| launch | 5 / 75 / 15 / 5 | 4 / 50 / 12 / 0 |
| meetings | 9 / 147 / 33 / 2 | 6 / 95 / 20 / 0 |
| operations | 7 / 149 / 22 / 7 | 14 / 329 / 163 / 1 |
| people | 11 / 176 / 35 / 6 | 10 / 123 / 30 / 2 |
| phases | 3 / 44 / 7 / 2 | 2 / 28 / 6 / 0 |
| reference | 5 / 58 / 8 / 2 | 5 / 46 / 11 / 0 |
| tasks | 9 / 127 / 39 / 3 | 5 / 76 / 29 / 0 |
| teams | 9 / 135 / 39 / 2 | 9 / 90 / 33 / 0 |
| tenancy | 12 / 197 / 40 / 2 | 6 / 79 / 18 / 0 |
| wiki | 10 / 111 / 38 / 0 | 5 / 56 / 23 / 0 |

Coverage is 494 of 494 active features and 119 of 119 persistent capabilities. There are 143 capabilities, including 24 behavior-only groups. Group A covers 81 feature IDs, B covers 85, and C covers 328. Several capabilities share features, so a feature is counted once within its group. Exclusion and consolidated-alias IDs remain covered. Catalog implementation status does not remove a feature from the check.

Coverage proves that a table names each persistent capability. It does not prove that every fact, privacy rule or transaction is implemented. Tag normalized names are the one small derived key retained for the named plant-scoped case-insensitive tag uniqueness query. A CHECK ties the key to its trimmed display name.

The checker validates both schemas' named keys and FKs, FK arity and types, unconditional referenced keys, domain assignments, replacement names, library flags and JSONB key documentation. It does not execute CHECK text, constraint triggers, SQL, Better Auth, storage, providers or application acceptance tests. Independent semantic review remains required. This is a smaller candidate, not a proof that no smaller valid design exists.

## Design rules used

1. Each table names the capabilities that require it. There is no table for a behavior-only helper or derived dashboard.
2. Use third normal form for current domain data. Keep immutable evidence separately when the capability requires it.
3. Give each ordinary record one UUID PK. Pure links use natural composite keys: Person tags, task prerequisites, effect dependencies and ordered mail membership.
4. Declare real FKs. Direct domain relationships use ordinary or compound FKs. Cross-domain targets use an exclusive checked FK union.
5. Share records only where their shape and lifecycle match. Use one semantic event stream, one operation receipt and one mail ledger.
6. Closed states use text with CHECKs. Tags are a user-editable vocabulary. Static reference definitions are versioned files with relational identity records. The unresolved complete Person source vocabulary is called out below.
7. Keep one current row and event history for mutable facts. Preserve immutable training versions, article revisions, document revisions, submitted debriefs and assessment evidence.
8. JSONB is limited to whole opaque snapshots, provider payloads, presentation/planning content and audit diffs. IDs, selections, standings and permission gates have typed columns or links.
9. Every tenant-owned row carries its plant or organization ID. Compound plant FKs enforce the common child shape. The owner rule below covers mixed scopes and source-entitled references.
10. Derive counts, averages, urgency, readiness, acquisition dates, directory results and current publication choices. Store rebuildable passage vectors because retrieval needs them, with exact source and generation provenance.
11. Keep timestamps for actual occurrence, chronological reads, deadlines, leases, publication, corrections or adapter requirements. Concurrency uses row revisions. There is no blanket `updated_at` copy.
12. Every consolidation below states its cost. Sparse typed unions count every physical column.

## Major decisions

| Decision | Reason | What it gives up |
|---|---|---|
| Keep four Better Auth tables; one `account` owns application authority. | Credentials have one library owner. Pending registration remains unprivileged and resumable. Native security proofs never enter Evry. | No alternative auth store. Adapter compatibility still needs pinned-version tests. |
| One `invitation` with checked purposes; one `affiliation` per exact pair. | Seat and relationship invitations share the same addressed-token lifecycle. Relationship consent travels with its exact pair and survives a rejoin. | Sparse endpoint columns and kind validation. Recognition episodes come from dated events, not replacement relationship rows. |
| Keep plant and organization roots separate. | Plants have phase/setup facts and finite Owner deletion. Organizations have typed contact profiles and no public deletion command. | Some repeated profile fields. A generic tenant profile would weaken these distinctions. |
| Store profile locality in `plant_geography`. | Region selection and locality corrections need exact as-of history. One latest effective row supplies the current profile. | Profile reads join the geography ledger. No separate current city/state/country cache is stored on `plant`. |
| Put the current account link and household role on `person`. | Each Person has one current household and at most one linked account. History belongs to events. | No extra mutable link table. Verified linking, head uniqueness and merge rules need serialized checks. |
| Keep human interviews, four Cs and signatures as distinct resources. | Their fields, dates, privacy and evidence meanings differ. Current commitment is independent from signature rows. | More tables than an unconstrained person-evidence bag. Models still cannot supply these facts. |
| One `event` for semantic history, correction and safe audit. | The envelope, actor, occurrence, revision and target shape are shared. Domain writers keep their own event semantics. | More nullable event fields and indexed joins. It is not a generic audit browser. Private care is excluded. |
| One `operation` and typed `effect` manifest for native and Evry work. | Registration, imports, bulk changes, receipts and approved assistant effects need exact replay and truthful partial outcomes. | More explicit argument and dependency rows. There is no general workflow or compensation engine. |
| One checked `record_reference` union and `evidence_link`. | Events, jobs, citations, grants, exact selections and inverse witnesses can share enforced references. All targets are real FK arms. | A wide sparse row and one extra join. Extending the union requires schema review. It is not the Person consumer registry or a permission system. |
| One shared `attestation` resource. | CAP-B-030 and CAP-C-018 name the same facts. CAP-A-041 uses the same dated human testimony shape. | Nullable person/period/statement fields. Key-specific meaning and expiry remain producer rules. |
| Preserve training versions, requirements, saved assignments and earned credit. | Applicability is a saved decision. Membership edits cannot relabel credit or quietly change a denominator. | More typed rows than requirement JSON. Explicit compatibility links replace inferred transitive compatibility. |
| One participation row; one typed meeting-item list. | Guest, inviter, RSVP, presence and optional response card share a meeting/Person identity. Agenda and kit entries share stable ordered editable rows. | Sparse fields and Vision-only guards. RSVP, attendance, response and roster denominator still have separate meanings. |
| Task relations sit directly on `task`. | A task has at most one optional allowed relation. Checklist children are ordinary one-level Tasks. | Nullable FK arms on each task. Cycle and parent-shape checks need locks. |
| Keep generated obligations independent from Tasks. | Deletion, waiver, recurrence and assignment edits must not erase source identity or fabricate success. | One extra stable resource. Contact freshness still comes only from typed human outcomes. |
| Version debrief forms; use owned document revisions for published summaries. | An incomplete new draft must not erase a valid submission. A summary is separately reviewed whole-text publication. | Form versions and provenance joins. No automatic reflection publication or model redaction promise. |
| One plant/organization assessment lifecycle; typed immutable facts and findings. | Demand, claims, attempts and completion share one execution shape. Different rubrics and contributor rules stay explicit. | More fact/link rows than snapshot JSON, and stricter target-kind checks. No raw person judgments enter model-purpose evidence. |
| One account-owned `reader_feedback` resource. | Article helpfulness and finding usefulness share an own-choice lifecycle. Typed target/rating CHECKs distinguish them. | Nullable target/context fields. Comments follow private account deletion; feedback is not automatic model training. |
| One mail ledger, with normalized request/order/attempt facts. | Unknown whole-batch replay needs the exact request, order, provider key and original clock. Per-member outcomes must survive later retries. | Two explicit request/membership tables. This is more structure than the current embedded manifest, but avoids hiding ordered IDs in JSON or repeating them on every attempt. |
| Merge pending upload and object metadata into `file_object`. | One generated immutable key has one pending-to-ready lifecycle and cleanup fence. | Metadata must not claim readiness until upload validation and reference finalization succeed. Replacement always makes a new object. |
| Merge own bookmark state into the existing reading row. | Both have one account/canonical-article identity and account-private lifecycle. | A bookmark-only row has zero observed progress and no completion; it does not create reading evidence. |
| Keep private calendar, weeks and corrections isolated. | Even unanswered weeks and timezone transitions are private original-author facts. | An extra dedicated calendar table. No shared event, reference, job, effect, model or export path may contain care data. |
| Keep body-free lifecycle witnesses after live roots are purged. | Restore must respect current deletions, revoked grants and credential generations, even if a stale backup contains them. | Controlled opaque historical identity keys without live-root FKs after purge. Witnesses can deny access, never grant it. |

`frozen_input` shares the named-value shape of exact effect arguments and generated-document merge inputs. It has typed value columns and exclusive consumer FKs. It does not accept executable arbitrary argument schemas. The closed native command or template field schema validates each key, index and value before freezing.

## Ownership and integrity rule

A compound plant FK enforces equal plant IDs directly. Every remaining ownership-sensitive FK requires a serialized writer rule. Lock the consumer and referenced parent, establish the parent owner and target kind, and refuse a mismatched owner before commit. Recheck the same rule when changing either endpoint. A foreign child cannot be made legal by changing its stored tenant ID. Implement these checks as the relevant deferred constraint trigger or domain transaction boundary, then prove the races. This proposal documents that rule; it does not claim that SQL FK existence alone proves tenancy.

Mixed-scope operational tables have at most one of `plant_id`, `organization_id`, `account_id`. No owner columns means restricted global work where its closed purpose permits it. A normal mail payload permits this only for public invitation-request mail, which creates no account, Person or newsletter record. A scrubbed accepted/unknown mail locator can also have no owner, with no address or payload and no dispatch authority. Per-account and per-tenant idempotency keys use partial unique keys; global operation/mail keys have a separate unique key.

`reader_feedback.account_id` is the private owner. Its plant or organization context is exclusive and must match its target. Conversations and all descendant entries, plans, reviews and staged handles are private to `conversation.owner_id`, even in a plant or organization context. Review approval must be by that initiating owner. Reading is account-owned; `reading.plant_context_id` does not change ownership. Private weeks require both the original author and original plant.

The owner rule includes these named exceptions, checked through the closed native operation:

- A live actor, assignee, recipient or reader may have an account FK in a shared tenant row. Current exact grants and duty eligibility are checked separately. These are not extra owners.
- An affiliation has a plant, Discovery account or sending church on one side and one exact receiving organization on the other. Endpoint kinds and accepted recognition are checked. Pending pairs confer no rights. Each side gets only its permitted projection.
- Global `reference_item`/versions and entitled article revisions may be referenced from a consuming context. The item kind, article identity, exact source, published state and current source rights must match. A source FK is not consent.
- A staged upload may bind to a real domain owner only through its explicitly approved native effect. Validate owner, purpose, MIME, size, hash and claim. No arbitrary key transfer is allowed.
- An explicit account-to-plant document copy preserves source revision/hash lineage. Source ownership stays unchanged. Reading the copy never authorizes the source.
- Organization assessment contributors bind the exact receiving organization, direct affiliation recognition, source plant, sharing revision and released plant assessment. A source plant does not become organization-owned.
- A body-free witness can retain a legitimate counterparty organization after its original root is gone. The opaque ID is a historical deny witness, not an unchecked live resource selector.

`record_reference` has exactly one nonnull target arm. Its owner columns bind the permitted consuming context. `evidence_link` has exactly one consumer arm. Typed prior/result references preserve merge moves and selected field relations; revision columns hold inverse guards. Reference ownership never grants read access. Secret identity and RSVP proofs and all three care tables are absent from the generic target union. For pure composite links, frozen inputs identify the real endpoint FKs and expected presence; inverse rules check the exact composite pair. Do not add surrogate IDs just to make those pairs generic targets.

Original human recorder/assessor/verifier and old/new correction values live in immutable create/earn/record events for their actual typed target. `person_note.author_id` additionally protects author-only editing. A shared actor becomes a scope-local opaque tombstone on account purge. No private author stream transfers to a successor. Emit genuine domain history, not merely a generic changed event. Readable task/status/stage/contact/reading dates and values stay in scalar event columns; opaque diffs are not metric truth.

## History, publication and recovery

Freeze source-bearing fields of reference/article/training/document versions, submitted debriefs, complete assessment facts/findings, reviewed effects and inputs. Mutable execution state may advance without changing a published manifest's digest or arguments. A new edit creates a new version or an attributable correction under the owning resource. No-op replay returns the original receipt.

The latest effective geography row is current locality. The highest committed reference activation is the serving generation. A current assessment is the latest still-authorized complete result, ordered by durable availability and ID; pending/failed work does not erase it. A native summary reader uses the latest published whole document revision, not a later unpublished draft. Keep captured phase/as-of and previous released results separate from current phase and embargoed results.

A reviewed Launch summary always has a Meetings source-category baseline. `evidence_link` adds every actual contributing category and source. Every whole-revision read requires the current exact affiliation, `shared_findings` and the full category union. Summary publication is immediate to eligible recipients. Model-result release instead follows a genuine eligible first open or 72 elapsed hours after durable availability.

Each per-recipient transport event binds `mail_attempt`, its `mail_request`, ordered member index and actual mail target. This records refusal/unknown/acceptance even after a later safe retry changes the current mail row. Mail acceptance, sent/delivery, opens/clicks, RSVP, contact and task completion remain distinct facts. Frozen payloads are encrypted and excluded from generic history/model projections.

Deletion suspends normal access at request commit. Cancellation is strictly before 30 elapsed days and restores only independently still-valid grants. Current lifecycle and pending security mutation state gate all ordinary reads, writes, dispatch and signed issuance. Coherent live purge starts a nonresetting recovery-copy horizon of at most seven days. Keep claim generations and actual byte/cancellation outcomes. Global address suppression restoration requires fresh proof of the current self address.

Purge in dependency order with RESTRICT FKs. Clear optional current pointers and private provenance links explicitly. Delete account-private conversations, reviews, arguments, drafts, votes, reading, proofs, avatars and care with their actual owner. Legitimate shared domain receipts may retain only minimal factual attribution. Delete revoked/copied bodies and every affected mixed organization run when a source plant becomes purge-eligible; contributor links locate the whole run, not a subtraction from old prose. Counterparty relationship history retains only body-free permitted facts. No audit, snapshot or organization ownership creates an indefinite retention exception. Scrub private mail addresses, address hashes and frozen bodies, clearing expired owner/recipient/provenance FKs. An accepted or unknown mail row can retain only body-free external locator/outcome facts and its original request key/clock. It cannot dispatch. Similarly, feedback publication clears its account, intake, category, area, title and body while retaining only the frozen published/unknown issue locator, marker, hash and outcome. Unattempted rows need no retained stub.

`lifecycle_witness` retains current body-free deletion, seat/affiliation revocation and credential-generation facts in an independently synchronized witness artifact. After a live root is removed, clear its FK and retain the opaque historical key. Remove private generic references; where independent history legitimately needs a body-free old identity, rebind its reference to that exact witness and label it historical. Never treat the witness as a live account, grant or dispatch target. `recovery_copy` pins the encrypted inventory, object checksums, schema, LSN, key version, verification and restore receipt. The restricted manifest records each embedded subject's original expiry. Recopy and restore take the minimum original expiry and reapply current witnesses before service opens. Key material remains outside ordinary database rows. Private-care recovery still enforces original-author access and exclusions. Provider cleanup distinguishes inaccessible bytes from physically confirmed erasure; this is not a universal physical day-37 promise.

## Current tables merged or removed

This mapping covers every current table. Reusing a name does not mean reusing its old column layout. A current table can contribute fields to several proposal resources. `schema.json.replaces` records those moves.

| Current table or tables | Where the data lives |
|---|---|
| `auth_user` | `auth_user` |
| `auth_account` | `auth_account` |
| `auth_session` | `auth_session` |
| `auth_verification` | `auth_verification` |
| `auth_throttle` | `admission_attempt` |
| `app_account` | `account`, `lifecycle_witness` |
| `tenancy_membership` | `seat` |
| `platform_grant` | `platform_grant` |
| `access_invitation`, `association_invitation` | `invitation` |
| `account_person_link`, `person` | `person` |
| `plant` | `lifecycle_witness`, `plant`, `plant_geography` |
| `organization` | `organization` |
| `organization_network_link`, `plant_affiliation`, `organization_sharing_settings`, `discovery_association` | `affiliation` |
| `discovery_profile` | `discovery` |
| `association_event`, `record_correction`, `training_assignment_event`, `meeting_event`, `task_status_event`, `launch_event`, `wiki_read_event`, `audit_event` | `event` |
| `household` | `household` |
| `person_tag_definition` | `tag` |
| `person_tag` | `person_tag` |
| `person_skill` | `person_skill` |
| `person_4c_assessment` | `four_cs` |
| `person_interview` | `interview` |
| `person_commitment` | `commitment` |
| `person_activity` | `event`, `person_note` |
| `person_merge` | `person_merge` |
| `ministry_team` | `team` |
| `team_role` | `team_role` |
| `team_membership` | `team_tenure` |
| `team_responsibility` | `responsibility` |
| `training_program` | `training_program` |
| `training_requirement_version` | `training_version` |
| `training_assignment_episode` | `training_assignment` |
| `training_completion` | `training_credit` |
| `meeting_location` | `venue` |
| `meeting` | `meeting`, `meeting_item` |
| `meeting_participation`, `meeting_invitation`, `vision_response` | `participation` |
| `meeting_rsvp_token` | `rsvp_proof` |
| `meeting_evaluation` | `meeting_evaluation` |
| `meeting_checklist_item` | `meeting_item` |
| `recurrence_series` | `recurrence` |
| `follow_up_obligation` | `obligation` |
| `task`, `task_relation` | `task` |
| `task_dependency` | `task_dependency` |
| `follow_up_outcome` | `contact_outcome` |
| `phase_template_offer_response`, `phase_transition` | `phase_transition` |
| `template_import_receipt`, `operation_execution`, `operation_result`, `command_receipt` | `operation` |
| `plant_attestation`, `person_attestation` | `attestation` |
| `launch` | `document`, `document_revision`, `launch`, `launch_debrief` |
| `launch_milestone`, `launch_milestone_task` | `launch_milestone` |
| `launch_person_attendance` | `launch_guest` |
| `planter_checkin` | `private_week` |
| `planter_checkin_event` | `private_week_revision` |
| `reference_release` | `reference_release` |
| `reference_activation` | `reference_activation` |
| `reference_section` | `article_revision`, `reference_item`, `reference_version` |
| `wiki_article` | `reference_item` |
| `wiki_source`, `wiki_article_version` | `article_revision` |
| `organization_wiki_article_state` | `article_editor_state` |
| `plant_wiki_source_order`, `plant_wiki_source_order_entry` | `wiki_preference` |
| `wiki_read_progress`, `wiki_bookmark` | `reading` |
| `wiki_article_feedback`, `intelligence_feedback` | `reader_feedback` |
| `reference_chunk` | `passage` |
| `reference_template_version` | `reference_version` |
| `owned_documents` | `document` |
| `owned_document_revisions` | `document_revision` |
| `generated_document` | `frozen_input`, `generated_document` |
| `upload_intent`, `object_metadata` | `file_object` |
| `assessment_demand`, `intelligence_assessment_run`, `organization_intelligence_runs`, `organization_intelligence_assessments` | `assessment` |
| `intelligence_insight` | `finding` |
| `organization_intelligence_contributor` | `assessment_contributor` |
| `message_template` | `message_template` |
| `communication`, `communication_delivery_retry` | `communication` |
| `communication_recipient` | `communication_recipient` |
| `email_intent` | `mail` |
| `email_attempt` | `mail_attempt` |
| `provider_event_receipt` | `provider_event` |
| `email_suppression` | `suppression` |
| `notification_preference` | `notification_preference` |
| `inbox_entry` | `notice` |
| `assistant_conversation` | `conversation` |
| `assistant_message`, `assistant_artifact` | `conversation_entry` |
| `assistant_attachment` | `staged_attachment` |
| `assistant_plan` | `candidate_plan` |
| `assistant_approval` | `review` |
| `operation_effect` | `effect` |
| `product_feedback` | `feedback` |
| `feedback_publication` | `feedback_publication` |
| `job` | `job` |
| `deletion_witness` | `lifecycle_witness` |
| `recovery_manifest` | `recovery_copy` |

Specific removals matter:

- `organization.contact_website` has no capability and is omitted, as the inventory review required.
- Team/role `reports_to` hierarchy fields, speculative team type/phase fields and responsibility seeding timestamps do not define current product behavior. Template identity, explicit leader provenance, ordinary slots and offer decisions do.
- Household head is derived from current Person household roles. Original address and propagation choices remain in events and exact effects.
- First genuine commitment date derives from valid original signatures and lifecycle/correction history. Withdrawal does not erase acquisition; reactivation does not create another acquisition.
- Meeting attendee totals, average evaluation score, agenda duration, staffing/training percentages, milestone progress, inbox counts, digest recipient counts and dashboard metrics derive from actual owned records. Saved assessments retain their immutable typed measured values.
- Wiki source identity is the exact organization FK or global release. Sections and approved templates retain canonical identities and immutable file definitions. There is no editable source catalog or cached preferred winner.
- Redundant HTML/plain-text/current/body snapshots are omitted where canonical safe content can render them. Exact sent payloads and saved generated bytes remain frozen exceptions.
- Whole-row `created_at`/`updated_at` copies and three-column actor envelopes are removed where the dated semantic event already supplies that information. Better Auth retains its required timestamps.

New explicit stores close real needs rather than revive unsupported features: `admission_attempt` records exact rolling reservations; `prompt_dismissal` records optional own choices; `private_calendar` protects unanswered-week rollover; `training_requirement` makes obligations queryable; `plant_geography` versions placement; and normalized mail membership plus typed evidence avoids ID arrays. The named manifest/input/reference tables replace previously embedded facts. No new customer workflow, finance, safety, service-calendar or hierarchy product is added.

## JSONB columns and keys

These keys are also recorded in `schema.json.jsonb_keys`. All other structured facts use columns or real links. Opaque scalar before-images can be restored only after typed revision/inverse guards pass; SQL does not inspect their fields to decide eligibility. Account/photo/household/moved-row references are outside those payloads.

| Column | Documented keys | Use |
|---|---|---|
| `person_merge.before_values` | `contact_fields`; `lifecycle_values` | Whole scalar inverse before-image; no joins or permission decisions. |
| `person_merge.field_choices` | `contact_field` | Display of scalar choices; executable field choices are frozen inputs and links. |
| `assessment.model_parameters` | `temperature`; `max_output_tokens`; `seed` | Opaque provider settings pinned to the run. Typed counters own budgets. |
| `mail.frozen_payload` | `subject`; `html`; `text`; `secret` | Encrypted exact rendered bytes. Typed mail metadata owns dispatch gates. |
| `mail_attempt.provider_payload` | `request_id`; `status`; `error` | Allowlisted transport diagnostic only. Member outcomes are typed events. |
| `provider_event.safe_payload` | `diagnostic` | Allowlisted diagnostic only. Event identity, kind, time and processing are columns. |
| `conversation_entry.display_payload` | `layout`; `preview` | Presentation hints and safe preview only. Entitled sources and cursor/completeness are typed links. |
| `candidate_plan.document` | `notes`; `questions`; `answers`; `todo` | Private model-authored planning content. It cannot authorize effects. |
| `event.diff` | `before`; `after` | Permitted scalar old/new audit values. Required history, targets, dates and transitions are typed. |

Native document bodies and article text are canonical safe content, not disguised reference lists. Static template and backup files contain their own documented structured definitions outside SQL. `evidence_link.value_snapshot` stores a frozen scalar citation value; it must not carry encoded IDs or a serialized nested manifest. `frozen_input` can hold bounded native rich text as a text argument but cannot hide additional effect targets, ownership or dependencies inside it.

## Capabilities that need runtime logic

A CHECK cannot prove current authority, a multi-row cycle, an external outcome or a time-dependent rule. These obligations remain explicit:

| Capabilities | Required behavior |
|---|---|
| A-001 through A-006, A-009 | Native auth proof, credential generations, rolling-window reservation locks, single-use token expiry, addressed acceptance, cooldown and atomic provisioning. Registration counts every submitted attempt, including refusals. Login/password-change/reset/email/public-invite budgets remain separate. |
| A-005 through A-010, A-013 through A-015 | Protected actual Owner, one active seat, endpoint kind checks, independent consent, reviewed onboarding effects, finite deletion/cancellation and fresh current access. Invitation creation attempts use their exact workspace/address 30-day window; resend uses 60 seconds. |
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
2. Should the broad checked reference union stay one table? I recommend it for this proposal. It keeps every generic target enforced and pays the sparse columns once. Splitting it by domain would reduce each row's width but add tables and more link variants.
3. Should the explicit mail request/member normalization be adopted? I recommend it. It preserves exact ordered batch replay without JSONB IDs or duplicated request facts. Keeping the current embedded-manifest approach would be smaller only by relaxing the proposal's JSONB rule or accepting denormalization.
4. May current assessment publication be derived from the latest authorized complete result? I recommend deriving it now. It saves mutable pointer authority. A future measured history-query bottleneck could justify a pointer with one atomic publication owner.
5. Should canonical reference definitions remain packaged artifacts? I recommend retaining that permitted approach. They already change through reviewed releases. A future customer-editable definition would require typed owned rows and a separate product decision.

These questions concern approval of the documented choices before implementation. They do not request deployment, database changes, provider spending or a PR. The independent reviewer should also inspect the complete capability-to-field semantics, ownership exceptions, source-kind constraints and retention paths; the mechanical coverage result cannot substitute for that review.
