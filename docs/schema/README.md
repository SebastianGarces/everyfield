# Target schema

[target.json](target.json) is the complete current physical planning contract: **120 tables**, 435 proposed FKs, 1873 fields, 28 normalized Person references and 7 immutable Person-bearing snapshot families. Fields, types/nullability/defaults, PK/unique keys, owner shape, immutable values, integrity checks, state authority, CAS/idempotency, each reference deletion treatment, producer packages and feature/acceptance/future-case links are expanded per table. PostgreSQL DDL, runtime authorization and provider/restore tests have not run.

The count follows concrete persistence boundaries, not the old source inventory. Each table separates a real owned relation, immutable version/history, external-effect failure boundary or shared operational receipt. Ordinary local inbox rows need no dispatch table; one mail intent/attempt ledger serves all producers; one job executor serves bounded asynchronous work; one platform audit supplements domain history without replacing it. There is no table-reduction quota, universal tenant graph, source-helper mirror or customer migration.

## Scope and invariant rules

Plants are independent roots. Organizations are a small separate root with immutable sending-church/network kind and enforced `(id,kind)` identity. Every child uses exact same-owner compound FKs; nullable tagged ownership additionally uses closed owner-shape CHECKs and serialized constraint triggers. Global identity and approved global references are explicit exceptions. Organization article bodies/source identities retain exact current source entitlement even though logical article identities share reference structures. Account seats, Person links, leadership titles and affiliations never grant through one another. Only one active account seat is allowed.

Immutable normalized participant episodes own training applicability; completion history is independent. Actual account/article/source/revision owns Wiki reading credit, with strict >80%, meaningful-update watermark and no split-reader pooling. Private weeks are original-author+plant+stable ordinal and excluded from broad audit/log/model. Owned document revisions share exact document/owner; selected carry-forward creates a new plant copy. Current Launch, task/contact, phase and assessment producers are distinct from version history and model interpretation.

Deletion is explicit per reference: private purge, shared minimal attribution, detach or protected-Owner/manual block. It is not a blanket cascade. Account and Owner-authorized plant request immediately deny normal access, allow narrow cancellation proof for 30 days, then eligible coherent live purge; recovery-copy eligibility ends seven further days after completed live purge. Current independently synchronized witnesses prevent restore resurrection without resetting clocks. No public organization-deletion product, broad audit browser or audit-retention exception is added.

Organization ownership does not preserve a copied plant body. A source plant request/revocation invalidates every affected NI current/history projection and contributor input, advances the exact organization revision and fences publication/jobs. At live purge, the protected contributor manifest selects each whole source-containing mixed run/result, its contributors, linked feedback and registered body derivatives; purge saved validated findings, regional slices, named lens rows and run/input manifests rather than retaining an old aggregate/body snapshot. Clear current pointers first. Other plants/organizations survive and can recompute; only separate minimum organization receipt metadata remains. Every source-containing recovery copy follows the original plant live-purge+seven-day expiry, with no recopy/restore reset.

Every non-tagged child→tagged parent has a concrete compound owner FK plus serialized owner-kind check, or one explicit typed bridge exception. Organization runs require exact organization kind/ID demand and job; Person inverse receipt requires same plant. Approved global message templates, verified provider receipt mapping, organization invitation→exact plant pair and safe platform feedback publication are named conditional variants, not nullable-owner wildcards. SQL constraints enforce these shapes independently of runtime authorization.

`owned_documents.copied_from_document_id` is a separate provenance-only exception: fresh actual private-source read and destination-plant write authority create a new selected plant-owned revision/bytes, with a required source revision hash. The pointer grants no private source read, body lookup or ongoing dependency; it cannot be rebound by ordinary edits. Original purge first detaches the nullable pointer while retaining the immutable hash. Current revision, revision parent, import and object references remain same-owner. Every tagged/assistant FK deletion clause branches on actual private account/assistant/recipient ownership versus legitimately surviving plant/organization ownership, so private variants purge and shared variants keep only their owned content with minimum attribution rather than a blanket shared-retain rule.

Closed profile columns preserve approved editing without arbitrary JSON. Plant street/region/profile map to street_address/state_province/profile_description; city, region, country, street and description may clear independently. Own-org contact email/phone/website map to contact_email/contact_phone/contact_website; description/city/region/country use profile_description/city/state_province/country. The character bounds are name 255, street 500, locality 255, description 10000, phone 100, normalized email 254 and validated HTTPS URL 2048. Exact own-org Owner/Admin edits use CAS/audit; kind/identity and other system fields are protected. No locality/timezone inference or directory disclosure expansion follows.

Assistant context has one closed account/plant/organization tuple. Authenticated-self account context uses account_id=owner_account_id, including explicit no-seat Discovery, and permits only currently authorized own preplant documents, approved global Wiki and Discovery operations. It confers no tenant grants or credential/secret/private-care model surfaces. Plant and exact typed organization contexts require fresh grants and preserve actor-private history ownership.

Task due shapes are closed: none has no date/time/instant/zone; local_date has only the plant-local date; resolved_instant has matching wall date/time, chosen instant and confirmed IANA zone. One-level checklist children are ordinary task rows with optional eligible assignee and their own status/history and parent guard. They have no independent deadline, recurrence or contact hooks. Checklist source/current names alias child create/list/completion only. Recurrence creates fresh child rows with cleared completion facts atomically; inert template/editor definitions are never separately writable live checkbox state. Persisted job_state is ready/claimed/retry_wait/reconcile/succeeded/failed/cancelled/superseded; pending/completed/blocked_unknown are only mapped presentation aliases. The practice type is pre_launch_practice, with prelaunch_practice an alias only.

## Physical inventory

### Identity and access (10)

`auth_user`, `auth_account`, `auth_session`, `auth_verification`, `auth_throttle`, `app_account`, `tenancy_membership`, `platform_grant`, `access_invitation`, `account_person_link`.

### Ownership roots and independent relationships (9)

`plant`, `organization`, `organization_network_link`, `plant_affiliation`, `organization_sharing_settings`, `discovery_profile`, `discovery_association`, `association_invitation`, `association_event`.

### People and human evidence (11)

`household`, `person`, `person_tag_definition`, `person_tag`, `person_skill`, `person_4c_assessment`, `person_interview`, `person_commitment`, `person_activity`, `record_correction`, `person_merge`.

### Teams and explicit training (9)

`ministry_team`, `team_role`, `team_membership`, `team_responsibility`, `training_program`, `training_requirement_version`, `training_assignment_episode`, `training_assignment_event`, `training_completion`.

### Meetings and participation (9)

`meeting_location`, `meeting`, `meeting_participation`, `meeting_invitation`, `meeting_rsvp_token`, `vision_response`, `meeting_evaluation`, `meeting_checklist_item`, `meeting_event`.

### Tasks and stable follow-up (9)

`recurrence_series`, `follow_up_obligation`, `task`, `task_relation`, `task_dependency`, `task_status_event`, `follow_up_outcome`, `phase_template_offer_response`, `template_import_receipt`.

### Phase, Launch and private care (10)

`phase_transition`, `plant_attestation`, `person_attestation`, `launch`, `launch_event`, `launch_milestone`, `launch_milestone_task`, `launch_person_attendance`, `planter_checkin`, `planter_checkin_event`.

### Reference and Wiki (15)

`reference_release`, `reference_activation`, `reference_section`, `wiki_article`, `wiki_source`, `wiki_article_version`, `organization_wiki_article_state`, `plant_wiki_source_order`, `plant_wiki_source_order_entry`, `wiki_read_progress`, `wiki_read_event`, `wiki_bookmark`, `wiki_article_feedback`, `reference_chunk`, `reference_template_version`.

### Documents and private files (5)

`owned_documents`, `owned_document_revisions`, `generated_document`, `upload_intent`, `object_metadata`.

### Assessments and exact-org findings (7)

`assessment_demand`, `intelligence_assessment_run`, `intelligence_insight`, `organization_intelligence_runs`, `organization_intelligence_contributor`, `organization_intelligence_assessments`, `intelligence_feedback`.

### Communications, delivery and inbox (10)

`message_template`, `communication`, `communication_recipient`, `email_intent`, `email_attempt`, `provider_event_receipt`, `communication_delivery_retry`, `email_suppression`, `notification_preference`, `inbox_entry`.

### Evry history and execution (9)

`assistant_conversation`, `assistant_message`, `assistant_artifact`, `assistant_attachment`, `assistant_plan`, `assistant_approval`, `operation_execution`, `operation_effect`, `operation_result`.

### Private feedback and safe publication (2)

`product_feedback`, `feedback_publication`.

### Shared transaction, audit and recovery (5)

`command_receipt`, `job`, `audit_event`, `deletion_witness`, `recovery_manifest`.

## Transactions and reference policies

[Core](../architecture/core.md), [auth](../architecture/auth.md), [audit](../architecture/audit.md) and [security](../architecture/security.md) are the current protocols. Meaningful changes, domain history, material revision, receipt, audit and required intent commit in one short interactive transaction. Better Auth credential creation is a prior resumable unprivileged stage; domain token/grant/Person acceptance is atomic. Model/provider work happens outside locks and generation/revision/grant CAS fences publication/effect handoff.

All actor FKs are nullable and purge scrubs legitimate shared attribution to scope-local opaque deleted-account tokens. All ordinary parent FKs default RESTRICT: purge explicitly clears nullable current pointers/lineage, cancels or reconciles effects, removes owned children/bytes, then removes roots. A historical source ID/manifest never authorizes current data. Private original-account data cannot be preserved through a plant copy or audit exception. Current witness/backup manifests use typed historical root identities without live-root FKs, so they can deny stale restored data after root removal.

The `person_references` and `person_snapshot_references` arrays in target.json are the incremental consumer registry. Every later producer adds its own collision/move/inverse/retirement fixtures before closure. Historical snapshots/merge receipts remain immutable; current relationships use reviewed rewrite and recorded pre/post versions. Guarded Unmerge is retained, with conflict refusal/correction and irreversible-effect limits.

## Build and proof gates

WP-002/004 own the contract and actual DDL/constraint proof; domain owners produce their rows and cases; WP-050 owns scoped audit/maintenance; WP-057/058 own coherent recovery and release. Future cases SCHEMA-001–015, AUTH-001–008, AUDIT-001–008, TEN-001–009, SEC-01–12 and AI44-001–007 are fully specified in the consolidated acceptance catalog. Every case remains future-not-run. Actual SQL catalog/race/adapter/provider/file/restore evidence must pass before package closure; document presence or JSON validity is not that proof.

Only the current specification files are default implementation context. Provenance-only source dispositions and mechanical evidence live in the external handoff; they map all 88 source records, including four dropped historical tables, and all five formerly named additions. No prior decision chain or v2 checkout is needed to build from this target. Paid spend, actual setup credentials/repository identity and the promised merged development workflow remain external input gates; no customers, migration or application/provider mutation is authorized by these documents.

The [complete proposed relations diagram](relations.md) follows every target FK and actual primary key. It is a documentation visualization, not a deployed schema.
