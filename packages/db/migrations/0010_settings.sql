CREATE TABLE "settings_preview" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"expected_revision" bigint NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "settings_preview_kind" CHECK ("settings_preview"."kind" IN ('plant_timezone','personal_timezone'))
);
--> statement-breakpoint
CREATE TABLE "settings_result" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event" DROP CONSTRAINT "event_ck_3";--> statement-breakpoint
ALTER TABLE "notification_preference" DROP CONSTRAINT "notification_preference_ck_1";--> statement-breakpoint
ALTER TABLE "notification_preference" DROP CONSTRAINT "notification_preference_ck_6";
-- BEGIN NOTIFICATION PREFERENCE DATA
DELETE FROM notification_preference WHERE category='insight';
INSERT INTO notification_preference(id,account_id,category,channel,enabled,cadence,weekday,hour,unsubscribe_revision,revision) SELECT gen_random_uuid(),account_id,'task_overdue',channel,enabled,cadence,weekday,hour,unsubscribe_revision,revision FROM notification_preference WHERE category='task';
UPDATE notification_preference SET category='task_due' WHERE category='task';
INSERT INTO notification_preference(id,account_id,category,channel,enabled,cadence,weekday,hour,unsubscribe_revision,revision) SELECT gen_random_uuid(),account_id,'meeting_reminder',channel,enabled,cadence,weekday,hour,unsubscribe_revision,revision FROM notification_preference WHERE category='meeting';
UPDATE notification_preference SET category='meeting_announcement' WHERE category='meeting';
INSERT INTO notification_preference(id,account_id,category,channel,enabled,cadence,weekday,hour,unsubscribe_revision,revision) SELECT gen_random_uuid(),account_id,'sharing_milestone',channel,enabled,cadence,weekday,hour,unsubscribe_revision,revision FROM notification_preference WHERE category='relationship';
UPDATE notification_preference SET category='relationship_milestone' WHERE category='relationship';
INSERT INTO notification_preference(id,account_id,category,channel,enabled,cadence,weekday,hour,unsubscribe_revision,revision) SELECT gen_random_uuid(),account_id,'launch_milestone',channel,enabled,cadence,weekday,hour,unsubscribe_revision,revision FROM notification_preference WHERE category='phase';
UPDATE notification_preference SET category='phase_milestone' WHERE category='phase';
UPDATE notification_preference SET category='wiki_upstream_review' WHERE category='reference_update';
SET CONSTRAINTS ALL IMMEDIATE;
-- END NOTIFICATION PREFERENCE DATA
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "personal_timezone_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "plant" ADD COLUMN "digest_cadence" text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings_preview" ADD CONSTRAINT "settings_preview_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_preview" ADD CONSTRAINT "settings_preview_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_result" ADD CONSTRAINT "settings_result_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_result" ADD CONSTRAINT "settings_result_operation" FOREIGN KEY ("operation_id","tenant_id") REFERENCES "operation"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_ck_3" CHECK ((action = ANY (ARRAY['identity.credential_observed'::text, 'identity.domain_accepted'::text, 'identity.credential_changed'::text, 'identity.credential_reconciled'::text, 'identity.email_changed'::text, 'identity.sessions_revoked'::text, 'membership.created'::text, 'membership.role_changed'::text, 'membership.ended'::text, 'invitation.claimed'::text, 'invitation.revoked'::text, 'plant.created'::text, 'plant.profile_changed'::text, 'settings.changed'::text, 'organization.profile_changed'::text, 'affiliation.approved'::text, 'affiliation.ended'::text, 'sharing.changed'::text, 'people.created'::text, 'people.updated'::text, 'people.retired'::text, 'people.restored'::text, 'people.stage_changed'::text, 'people.merged'::text, 'people.unmerged'::text, 'people.recorded'::text, 'people.corrected'::text, 'teams.changed'::text, 'roles.changed'::text, 'training.assigned'::text, 'training.assignment_removed'::text, 'training.completed'::text, 'training.revoked'::text, 'training.corrected'::text, 'meetings.changed'::text, 'meetings.finalized'::text, 'meetings.corrected'::text, 'meetings.rsvp_recorded'::text, 'meetings.response_recorded'::text, 'tasks.changed'::text, 'tasks.completed'::text, 'tasks.waived'::text, 'followup.recorded'::text, 'followup.corrected'::text, 'phase.created'::text, 'phase.declared'::text, 'phase.transitioned'::text, 'attestation.recorded'::text, 'attestation.corrected'::text, 'launch.changed'::text, 'launch.outcome_recorded'::text, 'launch.debrief_submitted'::text, 'launch.summary_published'::text, 'launch.corrected'::text, 'wiki.published'::text, 'wiki.hidden'::text, 'wiki.source_order_changed'::text, 'reference.activated'::text, 'documents.saved'::text, 'documents.copied'::text, 'files.finalized'::text, 'intelligence.requested'::text, 'intelligence.published'::text, 'intelligence.superseded'::text, 'intelligence.feedback_recorded'::text, 'communication.approved'::text, 'communication.send_intended'::text, 'mail.accepted'::text, 'mail.delivered'::text, 'mail.refused'::text, 'mail.reconciled'::text, 'mail.cancelled'::text, 'feedback.received'::text, 'feedback.publication_intended'::text, 'feedback.published'::text, 'feedback.reconciled'::text, 'execution.started'::text, 'execution.completed'::text, 'execution.partial'::text, 'execution.cancelled'::text, 'execution.reconciled'::text, 'account.deletion_requested'::text, 'plant.deletion_requested'::text, 'deletion.cancelled'::text, 'deletion.live_purge_completed'::text, 'recovery.copy_expired'::text, 'recovery.restored'::text, 'security.access_denied'::text, 'security.bulk_export'::text, 'security.audit_inspected'::text, 'security.audit_exported'::text, 'security.operator_accessed'::text])));--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_ck_1" CHECK (category IN ('task_due','task_overdue','meeting_announcement','meeting_reminder','planter_digest','oversight_digest','relationship_milestone','sharing_milestone','phase_milestone','launch_milestone','wiki_upstream_review'));--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_ck_6" CHECK (((category <> 'wiki_upstream_review'::text) OR (channel = 'in_app'::text)));--> statement-breakpoint
ALTER TABLE "plant" ADD CONSTRAINT "plant_digest_cadence" CHECK (digest_cadence IN ('off','daily','weekly'));