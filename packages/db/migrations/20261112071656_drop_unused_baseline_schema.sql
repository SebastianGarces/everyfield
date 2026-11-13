ALTER TABLE "launch_milestone" DROP CONSTRAINT "launch_milestone_uq_1";--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "commitment" DROP CONSTRAINT "commitment_fk_4";
--> statement-breakpoint
ALTER TABLE "digest_coverage" DROP CONSTRAINT "digest_coverage_fk_2";
--> statement-breakpoint
ALTER TABLE "digest_coverage" DROP CONSTRAINT "digest_coverage_fk_3";
--> statement-breakpoint
ALTER TABLE "launch" DROP CONSTRAINT "launch_fk_2";
--> statement-breakpoint
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_fk_5";
--> statement-breakpoint
ALTER TABLE "mail" DROP CONSTRAINT "mail_fk_6";
--> statement-breakpoint
ALTER TABLE "phase_transition" DROP CONSTRAINT "phase_transition_fk_2";
--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_fk_11";
--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_fk_12";
--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_fk_13";
--> statement-breakpoint
DROP INDEX "commitment_ref_4";--> statement-breakpoint
DROP INDEX "digest_coverage_ref_2";--> statement-breakpoint
DROP INDEX "digest_coverage_ref_3";--> statement-breakpoint
DROP INDEX "launch_ref_2";--> statement-breakpoint
DROP INDEX "lifecycle_witness_ref_5";--> statement-breakpoint
DROP INDEX "mail_ref_6";--> statement-breakpoint
DROP INDEX "phase_transition_ref_2";--> statement-breakpoint
DROP INDEX "task_ref_11";--> statement-breakpoint
DROP INDEX "task_ref_12";--> statement-breakpoint
DROP INDEX "task_ref_13";--> statement-breakpoint
DROP INDEX "task_uq_5";--> statement-breakpoint
ALTER TABLE "commitment" DROP COLUMN "corrected_commitment_id";--> statement-breakpoint
ALTER TABLE "digest_coverage" DROP COLUMN "last_mail_id";--> statement-breakpoint
ALTER TABLE "digest_coverage" DROP COLUMN "last_operation_id";--> statement-breakpoint
ALTER TABLE "file_object" DROP COLUMN "retention_until";--> statement-breakpoint
ALTER TABLE "launch" DROP COLUMN "outcome_notes";--> statement-breakpoint
ALTER TABLE "launch" DROP COLUMN "outcome_recorded_at";--> statement-breakpoint
ALTER TABLE "launch" DROP COLUMN "summary_document_id";--> statement-breakpoint
ALTER TABLE "launch_milestone" DROP COLUMN "seed_key";--> statement-breakpoint
ALTER TABLE "lifecycle_witness" DROP COLUMN "byte_manifest_hash";--> statement-breakpoint
ALTER TABLE "lifecycle_witness" DROP COLUMN "cancellation_manifest_hash";--> statement-breakpoint
ALTER TABLE "lifecycle_witness" DROP COLUMN "counterparty_organization_id";--> statement-breakpoint
ALTER TABLE "mail" DROP COLUMN "original_mail_id";--> statement-breakpoint
ALTER TABLE "mail_attempt" DROP COLUMN "retry_at";--> statement-breakpoint
ALTER TABLE "mail_attempt" DROP COLUMN "provider_payload";--> statement-breakpoint
ALTER TABLE "notice" DROP COLUMN "schedule_time";--> statement-breakpoint
ALTER TABLE "phase_transition" DROP COLUMN "criterion_version_id";--> statement-breakpoint
ALTER TABLE "reading" DROP COLUMN "resume_position";--> statement-breakpoint
ALTER TABLE "reference_release" DROP COLUMN "failure_code";--> statement-breakpoint
ALTER TABLE "task" DROP COLUMN "source_template_id";--> statement-breakpoint
ALTER TABLE "task" DROP COLUMN "import_operation_id";--> statement-breakpoint
ALTER TABLE "task" DROP COLUMN "milestone_id";--> statement-breakpoint
ALTER TABLE "task" DROP COLUMN "seed_key";--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','branding.changed','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','documents.archived','documents.branding_changed','documents.copied','documents.created_from_template','documents.designated','documents.export_deleted','documents.exported','documents.generated','documents.imported','documents.purged','documents.saved','documents.template_deleted','documents.template_details_changed','documents.template_saved','documents.template_updated','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','feedback.received','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','organization.profile_changed','people.corrected','people.created','people.duplicate_dismissed','people.duplicate_restored','people.merged','people.recorded','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));