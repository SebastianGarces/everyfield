CREATE TABLE "assignment_feedback" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"writer_id" uuid NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "assignment_feedback_pkey" PRIMARY KEY("id"),
	CONSTRAINT "assignment_feedback_body" CHECK (((length(btrim(body)) >= 1) AND (length(body) <= 5000)))
);
--> statement-breakpoint
CREATE TABLE "development_milestone" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"lineage" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"hands_on" boolean NOT NULL,
	CONSTRAINT "development_milestone_pkey" PRIMARY KEY("id"),
	CONSTRAINT "development_milestone_key" UNIQUE("id","version_id","organization_id"),
	CONSTRAINT "development_milestone_lineage" UNIQUE("version_id","lineage"),
	CONSTRAINT "development_milestone_position" CHECK ((position >= 0)),
	CONSTRAINT "development_milestone_title" CHECK (((length(btrim(title)) >= 1) AND (length(title) <= 200))),
	CONSTRAINT "development_milestone_description" CHECK (((description IS NULL AND NOT hands_on) OR ((length(btrim(description)) >= 1) AND (length(description) <= 2000))))
);
--> statement-breakpoint
CREATE TABLE "development_reading" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"article_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "development_reading_pkey" PRIMARY KEY("id"),
	CONSTRAINT "development_reading_article_once" UNIQUE("version_id","article_id"),
	CONSTRAINT "development_reading_position" CHECK ((position >= 0)),
	CONSTRAINT "development_reading_title" CHECK (((length(btrim(title)) >= 1) AND (length(title) <= 500)))
);
--> statement-breakpoint
CREATE TABLE "enrollment_milestone" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"source" text NOT NULL,
	"completed_on" date NOT NULL,
	"recorder_id" uuid NOT NULL,
	"confirmer_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "enrollment_milestone_pkey" PRIMARY KEY("id"),
	CONSTRAINT "enrollment_milestone_once" UNIQUE("enrollment_id","milestone_id"),
	CONSTRAINT "enrollment_milestone_source" CHECK ((source = 'program_leader'::text))
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_enrollment" FOREIGN KEY ("enrollment_id","version_id","organization_id") REFERENCES "development_enrollment"("id","version_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_milestone" FOREIGN KEY ("milestone_id","version_id","organization_id") REFERENCES "development_milestone"("id","version_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_feedback" ADD CONSTRAINT "assignment_feedback_writer" FOREIGN KEY ("writer_id") REFERENCES "account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_milestone" ADD CONSTRAINT "development_milestone_version" FOREIGN KEY ("version_id","organization_id") REFERENCES "development_program_version"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_reading" ADD CONSTRAINT "development_reading_version" FOREIGN KEY ("version_id","organization_id") REFERENCES "development_program_version"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_reading" ADD CONSTRAINT "development_reading_article" FOREIGN KEY ("article_id") REFERENCES "reference_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_reading" ADD CONSTRAINT "development_reading_revision" FOREIGN KEY ("revision_id") REFERENCES "article_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_milestone" ADD CONSTRAINT "enrollment_milestone_enrollment" FOREIGN KEY ("enrollment_id","version_id","organization_id") REFERENCES "development_enrollment"("id","version_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_milestone" ADD CONSTRAINT "enrollment_milestone_milestone" FOREIGN KEY ("milestone_id","version_id","organization_id") REFERENCES "development_milestone"("id","version_id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_milestone" ADD CONSTRAINT "enrollment_milestone_recorder" FOREIGN KEY ("recorder_id") REFERENCES "account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_milestone" ADD CONSTRAINT "enrollment_milestone_confirmer" FOREIGN KEY ("confirmer_id") REFERENCES "account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_feedback_enrollment_idx" ON "assignment_feedback" USING btree ("enrollment_id","version_id","organization_id");--> statement-breakpoint
CREATE INDEX "assignment_feedback_milestone_idx" ON "assignment_feedback" USING btree ("milestone_id","version_id","organization_id");--> statement-breakpoint
CREATE INDEX "development_reading_revision_idx" ON "development_reading" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "enrollment_milestone_milestone_idx" ON "enrollment_milestone" USING btree ("milestone_id","version_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "development_program_version_draft" ON "development_program_version" USING btree ("program_id") WHERE (published_at IS NULL);--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','branding.changed','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','development.enrolled','development.feedback_recorded','development.milestone_recorded','development.plan_saved','development.program_created','development.version_published','documents.archived','documents.church_archived','documents.church_restored','documents.branding_changed','documents.copied','documents.created_from_template','documents.designated','documents.export_deleted','documents.exported','documents.generated','documents.imported','documents.purged','documents.saved','documents.template_deleted','documents.template_details_changed','documents.template_saved','documents.template_updated','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','feedback.received','feedback.status_changed','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','organization.profile_changed','people.corrected','people.created','people.duplicate_dismissed','people.duplicate_restored','people.merged','people.recorded','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));--> statement-breakpoint
ALTER TABLE "development_program" ADD CONSTRAINT "development_program_name" CHECK (((length(btrim(name)) >= 1) AND (length(name) <= 120)));--> statement-breakpoint
ALTER TABLE "development_program_version" ADD CONSTRAINT "development_program_version_rhythm" CHECK ((rhythm = ANY (ARRAY['weekly'::text, 'every_two_weeks'::text, 'monthly'::text])));-- A draft's milestones and reading list are replaced whole on each save; a published version's rows never change.
--> statement-breakpoint
-- A draft's milestones and reading list are replaced whole on each save; a published version's rows never change.
-- Completions and feedback are written once and never rewritten.
REVOKE ALL ON "development_milestone", "development_reading", "enrollment_milestone", "assignment_feedback" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON "development_milestone", "development_reading" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,INSERT ON "enrollment_milestone", "assignment_feedback" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "development_milestone", "development_reading", "enrollment_milestone", "assignment_feedback" TO everyfield_cleanup;
