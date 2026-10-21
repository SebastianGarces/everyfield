# Platform audit and domain history

Meaningful changes have append-only attributable audit records and the domain history needed by authorized readers. History and audit may share storage. Domain packages own history meaning; platform audit permits only safe attribution and purpose-bound investigation. Audit never supplies current authority. Private care has original-author history and no central audit identity. Mechanisms follow [EveryField patterns](intent://local/note/df294729-367b-493b-9faf-654cf6b25b62).

## Envelope and closed actions

Audit identifies the actual owner, action, subject type and identity, actor or identified service cause, time and known outcome. It preserves enough lineage to inspect the exact human review and any external work where applicable. A service cannot invent a human approver. The action families below define required coverage; they do not require an event table or a separate receipt per operation.

Audit records changed fields and their permitted before/after values, safe status, bounded counts and required lineage. Each action has an allowlisted projection, bounded to 2048 UTF-8 bytes. Never serialize whole rows, arbitrary narratives or unbounded metadata. Authorized domain history may retain its content evidence; platform audit cannot expose that content.

| Action family | Safe metadata examples | Producer/meaning |
|---|---|---|
| audit.imported | original kind, time and attribution | Historical event without a typed action or linked operation; never emitted for a new business change |
| identity.credential_observed, identity.domain_accepted, identity.credential_changed, identity.credential_reconciled, identity.email_changed, identity.sessions_revoked | result code, revoked-session count | Domain activation and truthful significant credential outcomes; no secret, address or proof token |
| membership.created, membership.role_changed, membership.ended, invitation.changed, invitation.claimed, invitation.revoked | old/new role/status, invitation revision | Exact seat lifecycle; not an inferred CRM/title grant |
| plant.created, plant.profile_changed, organization.profile_changed | changed non-sensitive field names, profile revision | Owned roots/settings; organization kind and scope remain immutable |
| settings.changed | changed field names and section revision; no credential, private-care or changed-value payload | Authenticated self or exact current plant/team/organization scope |
| affiliation.approved, affiliation.ended, sharing.changed | recognition episode, named category booleans, policy revision | Exact bilateral pair; current projections and notice intent atomic |
| people.created, people.updated, people.retired, people.restored, people.stage_changed, people.merged, people.unmerged, people.recorded, people.corrected | operation subtype, record/version IDs, stage transition, reviewed move-manifest hash | No Person rows, contact values, note/interview/commitment narratives or record snapshots |
| teams.changed, roles.changed, training.assigned, training.assignment_removed, training.completed, training.revoked, training.corrected | status/program/requirement-version IDs, bounded counts, selection manifest hash | Native roster/history remains independently queryable |
| meetings.changed, meetings.finalized, meetings.corrected, meetings.rsvp_recorded, meetings.response_recorded | meeting type, participation revision, generated-effect manifest hash, bounded counts | Cards and RSVP remain distinct; token/body omitted |
| tasks.changed, tasks.completed, tasks.waived, followup.recorded, followup.corrected | task/outcome type, successor or obligation IDs | Complete, no longer needed and actual contact remain distinct |
| phase.created, phase.declared, phase.transitioned, attestation.recorded, attestation.corrected | phase/criterion/source version and type | Human ownership; no private-care or pastoral narrative |
| launch.changed, launch.outcome_recorded, launch.debrief_submitted, launch.summary_published, launch.corrected | domain revision, summary hash/category provenance | Canonical aggregate+typed history; raw answers remain domain-private |
| wiki.published, wiki.hidden, wiki.source_order_changed, reference.activated, documents.saved, documents.copied, files.finalized | logical/source/version IDs, content hash, format/byte count where permitted | Body/attachment bytes and signed URL omitted; private document metadata stays account scoped |
| intelligence.requested, intelligence.published, intelligence.superseded, intelligence.feedback_recorded | run/asOf/source/reference/execution ownership and safe status | Not raw snapshot/contributor inputs/model prompts |
| communication.approved, communication.send_intended, mail.accepted, mail.delivered, mail.refused, mail.reconciled, mail.cancelled | payload/audience hash, provider receipt ID, safe result | Accepted is not delivered; addresses/body omitted; unknown remains unknown |
| feedback.received, feedback.publication_intended, feedback.published, feedback.reconciled | safe publication hash, actual repository/issue locator, result | Private original/body/identity/screenshots/logs omitted |
| evry.conversation_created, evry.turn_submitted, evry.turn_cancelled, evry.turn_retried | conversation and turn IDs, message sequence | The initiating account's private Evry activity; no message text, read results or model output |
| evry.proposal_prepared, evry.proposal_revised, evry.proposal_approved, evry.proposal_cancelled, evry.proposal_retried | proposal ID, revision and review digest | The initiating account's review decisions; the executed change writes its own domain audit row with the change, keyed by the proposal and revision |
| execution.started, execution.completed, execution.partial, execution.cancelled, execution.reconciled | exact effect manifest hash/result IDs, safe status | Actual initiator/reviewer and immutable plan digest retained |
| account.deletion_requested, plant.deletion_requested, deletion.cancelled, deletion.live_purge_completed, recovery.copy_expired, recovery.restored | request revision/deadline/completion/copy expiry and manifest hash | No private-care subject/count metadata; no new org-deletion product |
| security.access_denied, security.bulk_export, security.audit_inspected, security.audit_exported, security.operator_accessed | allowed purpose, scope/resource class, reason code | Bounded significant security activity; no per-request or bot-event flood |


Each action has its own safe field projection. Raw interviews/four Cs, notes, photos, contact/address values, model prompts, mail bodies/attachments, secrets, headers and signed URLs are excluded from platform audit. Action/resource types cannot come from a URL or untrusted user/model instruction.

## Transactional truth

Meaningful domain facts, required history/audit, reported outcomes and recoverable side effects agree. A failure leaves no partial domain change. Exact retry returns the known outcome without adding a fictitious change. Bulk history names exact same-owner targets or a bounded selection; cross-tenant content cannot hide in readable metadata.

Better Auth owns credential/session changes separately. Append the app security event only after the supported call succeeds. A later event failure cannot undo credentials; report that gap truthfully for restricted reconciliation. Do not store passwords for retry or claim atomic credential-plus-domain writes. Pending registration remains unprivileged until domain acceptance, which is atomic. Ordinary renewal and bounded failed-auth telemetry are not business audit.

Denied or rolled-back changes have no successful audit action. Significant denial or failure evidence may be recorded separately with a safe truthful code. Provider acceptance, delivery, refusal and unknown reconciliation stay linked to the actual original work. Duplicate or out-of-order callbacks cannot invent or regress delivery.

## Private-care and investigation boundary

Private-care answers, notes, identities, timestamps, weekly periods, existence, nudge counts and access-open activity never enter central audit, model/Evry, organization, export, email, log, trace or evaluation paths. A broad purge outcome may say authorized cleanup completed but cannot identify or count care subjects. Original-author private history remains separate in purpose and access.

Audit investigation or export requires current explicitly bounded operator purpose and scope with safe field projections. Owner/Admin, affiliation or general platform administration grants no broad audit browser or private narrative access. Record significant audit inspection/export itself and keep reads bounded to the authorized owner, subject and action.

## Deletion and retention

Live actor links are nullable. Personal purge preserves legitimate shared attribution only as an opaque deleted-account token local to the owning scope, clearing unnecessary identity linkage. No universal cross-tenant token map, email or name copy is retained. The token is pseudonymous, not guaranteed anonymous.

Account-owned audit details purge with the account; plant-owned history purges with the plant. Counterparts retain only minimum independent relationship evidence. There is no blanket audit retention exception or separately approved retention period. Ordinary writers cannot change or delete history; corrections append evidence, and restricted policy cleanup may scrub or purge. This is not a tamper-proof storage guarantee. Current deletion/access authority overrides restored history before access and cannot reset copy expiry.

AUDIT-001 through AUDIT-008 and relevant tenancy/schema/deletion cases remain future SQL and application proof.
