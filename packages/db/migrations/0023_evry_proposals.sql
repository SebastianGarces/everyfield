CREATE TABLE "proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"input" jsonb NOT NULL,
	"review" jsonb NOT NULL,
	"digest" text NOT NULL,
	"state" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_session_id" uuid,
	"job_id" uuid,
	"outcome" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "proposal_revision" CHECK ("proposal"."revision" >= 1),
	CONSTRAINT "proposal_approval" CHECK (("proposal"."state"='approved') = ("proposal"."approved_at" IS NOT NULL)),
	CONSTRAINT "proposal_outcome" CHECK ("proposal"."outcome" IS NULL OR "proposal"."state"='approved'),
	CONSTRAINT "proposal_json" CHECK (jsonb_typeof("proposal"."input")='object' AND jsonb_typeof("proposal"."review")='object')
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_ck_1";--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_approved_session_id_auth_session_id_fk" FOREIGN KEY ("approved_session_id") REFERENCES "auth_session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_identity" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_conversation_owner" FOREIGN KEY ("conversation_id","tenant_id") REFERENCES "conversation"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_job" FOREIGN KEY ("job_id","tenant_id") REFERENCES "job"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_conversation" ON "proposal" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','audit.imported','communication.approved','communication.send_intended','deletion.cancelled','deletion.live_purge_completed','documents.copied','documents.saved','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','execution.cancelled','execution.completed','execution.partial','execution.reconciled','execution.started','feedback.publication_intended','feedback.published','feedback.received','feedback.reconciled','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.credential_reconciled','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','intelligence.feedback_recorded','intelligence.published','intelligence.requested','intelligence.superseded','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','launch.corrected','launch.debrief_submitted','launch.outcome_recorded','launch.summary_published','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','note_correction','organization.profile_changed','people.corrected','people.created','people.merged','people.recorded','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','security.access_denied','security.audit_exported','security.audit_inspected','security.bulk_export','security.operator_accessed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.hidden','wiki.published','wiki.source_order_changed')));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ck_1" CHECK ((kind = ANY (ARRAY['mail'::text, 'notification'::text, 'digest'::text, 'assessment'::text, 'reference_generation'::text, 'feedback_publication'::text, 'object_cleanup'::text, 'lifecycle_purge'::text, 'assistant_turn'::text, 'document_render'::text, 'evry_effect'::text])));--> statement-breakpoint
-- Custom: runtime and cleanup privileges for Evry proposals. Conversations cascade to them in owner purge.
GRANT SELECT,INSERT,UPDATE ON proposal TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON proposal TO everyfield_cleanup;
