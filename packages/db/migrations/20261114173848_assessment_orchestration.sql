CREATE TABLE "assessment_insight" (
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"plant_id" uuid NOT NULL,
	"role" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "assessment_insight_pkey" PRIMARY KEY("run_id","ordinal"),
	CONSTRAINT "assessment_insight_role" CHECK ((role = ANY (ARRAY['focus'::text, 'supporting'::text, 'positive'::text]))),
	CONSTRAINT "assessment_insight_severity" CHECK ((severity = ANY (ARRAY['info'::text, 'low'::text, 'medium'::text, 'high'::text])))
);
--> statement-breakpoint
ALTER TABLE "assessment_run" DROP CONSTRAINT "assessment_run_outcome";--> statement-breakpoint
ALTER TABLE "assessment_run" DROP CONSTRAINT "assessment_run_published";--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_ck_1";--> statement-breakpoint
ALTER TABLE "platform_grant" DROP CONSTRAINT "platform_grant_ck_1";--> statement-breakpoint
ALTER TABLE "assessment_run" ADD COLUMN "demand" text;--> statement-breakpoint
ALTER TABLE "assessment_run" ADD COLUMN "demand_key" text;--> statement-breakpoint
ALTER TABLE "assessment_run" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "assessment_run" ADD COLUMN "captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assessment_run" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assessment_run" ADD COLUMN "pending_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_run" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assessment_run" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assessment_run" ADD COLUMN "available_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assessment_run" ADD COLUMN "delta" jsonb;--> statement-breakpoint
-- Runs from the Owner-started run (WP-042) were settled when stored: each was its own manual demand, captured,
-- settled and, when published, current from that moment. A deferred one had no retry; it is recorded as failed.
UPDATE "assessment_run" SET demand='manual', demand_key='manual/' || id::text, captured_at=recorded_at,
	deadline_at=recorded_at, settled_at=recorded_at, available_at=CASE WHEN outcome='published' THEN recorded_at END,
	outcome=CASE WHEN outcome='deferred' THEN 'failed' ELSE outcome END;--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "assessment_run" ALTER COLUMN "demand" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_run" ALTER COLUMN "demand_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_run" ALTER COLUMN "captured_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_run" ALTER COLUMN "deadline_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_insight" ADD CONSTRAINT "assessment_insight_run" FOREIGN KEY ("run_id") REFERENCES "assessment_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_insight" ADD CONSTRAINT "assessment_insight_plant" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_insight_plant_idx" ON "assessment_insight" USING btree ("plant_id");--> statement-breakpoint
CREATE INDEX "assessment_run_current_idx" ON "assessment_run" USING btree ("plant_id","available_at");--> statement-breakpoint
ALTER TABLE "assessment_run" ADD CONSTRAINT "assessment_run_demand" UNIQUE("plant_id","demand_key");--> statement-breakpoint
ALTER TABLE "assessment_run" ADD CONSTRAINT "assessment_run_demand_kind" CHECK ((demand = ANY (ARRAY['change'::text, 'time'::text, 'manual'::text, 'followup'::text])));--> statement-breakpoint
ALTER TABLE "assessment_run" ADD CONSTRAINT "assessment_run_outcome" CHECK ((outcome = ANY (ARRAY['pending'::text, 'deferred'::text, 'published'::text, 'failed'::text, 'degraded'::text, 'superseded'::text])));--> statement-breakpoint
ALTER TABLE "assessment_run" ADD CONSTRAINT "assessment_run_published" CHECK ((((outcome = 'published'::text) = (result IS NOT NULL)) AND ((outcome = 'published'::text) = (available_at IS NOT NULL)) AND ((grounding = 'degraded'::text) = (model_input IS NULL)) AND ((grounding = 'degraded'::text) = (outcome = 'degraded'::text)) AND ((reference_release IS NULL) = (reference_activation IS NULL)) AND ((outcome = 'deferred'::text) = (retry_at IS NOT NULL)) AND ((outcome = ANY (ARRAY['pending'::text, 'deferred'::text])) = (settled_at IS NULL))));--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','branding.changed','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','development.enrolled','development.feedback_recorded','development.milestone_confirmed','development.milestone_marked','development.milestone_recorded','development.plan_saved','development.program_created','development.version_applied','development.version_published','documents.archived','documents.church_archived','documents.church_restored','documents.branding_changed','documents.copied','documents.created_from_template','documents.designated','documents.export_deleted','documents.exported','documents.generated','documents.imported','documents.purged','documents.saved','documents.template_deleted','documents.template_details_changed','documents.template_saved','documents.template_updated','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','feedback.publication_held','feedback.publication_intended','feedback.publication_unknown','feedback.published','feedback.received','feedback.status_changed','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','intelligence.assessed','intelligence.refresh_requested','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','launch.corrected','launch.debrief_submitted','launch.outcome_recorded','launch.summary_published','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','organization.profile_changed','people.corrected','people.created','people.duplicate_dismissed','people.duplicate_restored','people.merged','people.recorded','people.removed','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ck_1" CHECK ((kind = ANY (ARRAY['mail'::text, 'notification'::text, 'digest'::text, 'object_cleanup'::text, 'lifecycle_purge'::text, 'assistant_turn'::text, 'people_import'::text, 'evry_effect'::text, 'feedback_publication'::text, 'assessment'::text])));--> statement-breakpoint
ALTER TABLE "platform_grant" ADD CONSTRAINT "platform_grant_ck_1" CHECK ((capability = ANY (ARRAY['feedback_triage'::text, 'reference_publish'::text, 'recovery_operator'::text, 'assessment_operator'::text])));
--> statement-breakpoint
-- A run's captured snapshot never changes; only its progress and outcome advance. Insights are written once.
CREATE TRIGGER immutable_source BEFORE UPDATE ON "assessment_run" FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,plant_id,as_of,phase,source_revision,formula_version,rubric_version,rubric_sha256,reference_release,reference_activation,model,grounding,facts,model_input,recorded_at,demand,demand_key,job_id,captured_at,deadline_at');
--> statement-breakpoint
GRANT UPDATE ON "assessment_run" TO everyfield_runtime;
--> statement-breakpoint
REVOKE ALL ON "assessment_insight" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT ON "assessment_insight" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "assessment_insight" TO everyfield_cleanup;
