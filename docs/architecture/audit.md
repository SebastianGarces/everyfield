# Platform audit and domain history

The adopted `event` table holds domain history and a bounded platform audit projection. Domain packages own history meaning; platform audit owns safe attribution and purpose-bound investigation. Neither is a universal event bus or a source of current authority. Private care has its own original-author history and no shared event identity.

## Envelope and closed actions

`event.tenant_id` and `event.target_record_id` identify the actual owner and registered historical target. `event.kind` is the closed domain event kind. Nullable `event.action` distinguishes platform audit actions and has the literal closed CHECK listed below. Domain-only events have no platform action. `event.operation_id` and `event.effect_id` resolve receipt and execution lineage, including the trusted review through those relations. Actual actor, scoped tombstone or service cause is mandatory; a service cannot invent a human approver.

Platform audit records only permitted field names, safe scalar revisions/statuses, bounded counts where allowed and hashes/IDs for required lineage. The optional `event.diff` uses its documented before/after structure with only action-allowlisted scalar fields and at most 2048 UTF-8 bytes, enforced by CHECK. Never serialize whole rows, arbitrary narratives or an unbounded general metadata payload. Domain history may retain its authorized content evidence; that does not make it readable through the platform audit projection. The CHECK bounds shape/size, while producer and reader projections enforce field purpose.

| Action family | Safe metadata examples | Producer/meaning |
|---|---|---|
| identity.credential_observed, identity.domain_accepted, identity.credential_changed, identity.credential_reconciled, identity.email_changed, identity.sessions_revoked | result code, revoked-session count | Domain activation and truthful significant credential outcomes; no secret, address or proof token |
| membership.created, membership.role_changed, membership.ended, invitation.claimed, invitation.revoked | old/new role/status, invitation revision | Exact seat lifecycle; not an inferred CRM/title grant |
| plant.created, plant.profile_changed, organization.profile_changed | changed non-sensitive field names, profile revision | Owned roots/settings; organization kind and scope remain immutable |
| settings.changed | section revision only; no credential, private-care or changed-value payload | Authenticated self or exact current plant/team/organization scope |
| affiliation.approved, affiliation.ended, sharing.changed | recognition episode, named category booleans, policy revision | Exact bilateral pair; current projections and notice intent atomic |
| people.created, people.updated, people.retired, people.restored, people.stage_changed, people.merged, people.unmerged, people.recorded, people.corrected | operation subtype, record/version IDs, stage transition, reviewed move-manifest hash | No Person rows, contact values, note/interview/commitment narratives or record snapshots |
| teams.changed, roles.changed, training.assigned, training.assignment_removed, training.completed, training.revoked, training.corrected | status/program/requirement-version IDs, bounded counts, selection manifest hash | Native roster/history remains independently queryable |
| meetings.changed, meetings.finalized, meetings.corrected, meetings.rsvp_recorded, meetings.response_recorded | meeting type, participation revision, generated-effect manifest hash, bounded counts | Cards and RSVP remain distinct; token/body omitted |
| tasks.changed, tasks.completed, tasks.waived, followup.recorded, followup.corrected | task/outcome type, successor or obligation IDs | Complete, no longer needed and actual contact remain distinct |
| phase.created, phase.declared, phase.transitioned, attestation.recorded, attestation.corrected | phase/criterion/source version and type | Human ownership; no private-care or pastoral narrative |
| launch.changed, launch.outcome_recorded, launch.debrief_submitted, launch.summary_published, launch.corrected | domain revision, summary hash/category provenance | Canonical aggregate+typed history; raw answers remain domain-private |
| wiki.published, wiki.hidden, wiki.source_order_changed, reference.activated, documents.saved, documents.copied, files.finalized | logical/source/version IDs, content hash, format/byte count where permitted | Body/attachment bytes and signed URL omitted; private document metadata stays account scoped |
| intelligence.requested, intelligence.published, intelligence.superseded, intelligence.feedback_recorded | run/asOf/source/reference/claim generation and safe status | Not raw snapshot/contributor inputs/model prompts |
| communication.approved, communication.send_intended, mail.accepted, mail.delivered, mail.refused, mail.reconciled, mail.cancelled | payload/audience hash, provider receipt ID, safe result | Accepted is not delivered; addresses/body omitted; unknown remains unknown |
| feedback.received, feedback.publication_intended, feedback.published, feedback.reconciled | safe publication hash, actual repository/issue locator, result | Private original/body/identity/screenshots/logs omitted |
| execution.started, execution.completed, execution.partial, execution.cancelled, execution.reconciled | exact effect manifest hash/result IDs, safe status | Actual initiator/reviewer and immutable plan digest retained |
| account.deletion_requested, plant.deletion_requested, deletion.cancelled, deletion.live_purge_completed, recovery.copy_expired, recovery.restored | request revision/deadline/completion/copy expiry and manifest hash | No private-care subject/count metadata; no new org-deletion product |
| security.access_denied, security.bulk_export, security.audit_inspected, security.audit_exported, security.operator_accessed | allowed purpose, scope/resource class, reason code | Bounded significant security activity; no per-request or bot-event flood |


Each action has its own safe field projection. Raw interviews/four Cs, notes, photos, contact/address values, model prompts, mail bodies/attachments, secrets, headers and signed URLs are excluded from platform audit. Action/resource types cannot come from a URL or untrusted user/model instruction.

## Transactional truth

Meaningful domain facts, required history/audit, receipt and effect intent commit in one short transaction. Failure rolls back the change. Exact replay returns original receipt/event identities without adding a fictitious change. Bulk history has exact same-owner targets or a bounded manifest; cross-tenant content cannot hide in readable JSON.

Better Auth owns credential/session changes separately. Append the app security event only after the supported call succeeds. A later event failure cannot undo credentials; report that gap truthfully for restricted reconciliation. Do not store passwords for retry or claim atomic credential-plus-domain writes. Pending registration remains unprivileged until domain acceptance, which is atomic. Ordinary renewal and bounded failed-auth telemetry are not business audit.

Denied or rolled-back operations have no successful event from that transaction. Significant denial/failure evidence may append afterward with a safe truthful code. Provider handoff occurs outside locks after intent commit; acceptance, delivery, refusal and unknown reconciliation link the existing effect. Duplicate/out-of-order callbacks cannot invent or regress delivery.

## Private-care and investigation boundary

Private-care answers, notes, row IDs, timestamps, weekly periods, existence, nudge counts and access-open events never enter central `event`, model/Evry, organization, export, email, log, trace or evaluation paths. A broad purge receipt may say the authorized purge completed but cannot identify or count care subjects. Its native private revision tables remain separate.

Audit investigation/export requires current explicitly bounded operator purpose/scope and safe field projections. Owner/Admin, affiliation or general platform administration grants no broad audit browser or private narrative access. Record significant audit inspection/export itself; keep reads bounded. Indexes support exact owner/target/receipt lookup; a broad JSON search platform is not required.

## Deletion and retention

Live actor links are nullable. Personal purge preserves legitimate shared attribution only as an opaque deleted-account token local to the owning scope, clearing unnecessary identity linkage. No universal cross-tenant token map, email or name copy is retained. The token is pseudonymous, not guaranteed anonymous.

Account-owned event details purge with the account; plant-owned history purges with the plant. Counterparts keep only minimum independent relationship receipts. There is no blanket audit retention exception or separate approved retention period. Ordinary writers cannot update/delete history; restricted policy cleanup may scrub/purge, and correction appends evidence. Database-owner power means this is not tamper-proof storage. Current lifecycle witnesses override restored event images before access and cannot reset copy expiry.

AUDIT-001 through AUDIT-008 and relevant tenancy/schema/deletion cases remain future SQL and application proof.
