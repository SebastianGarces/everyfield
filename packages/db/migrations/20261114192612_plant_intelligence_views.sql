CREATE TABLE "assessment_feedback" (
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"plant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"rubric_version" text NOT NULL,
	"rating" text NOT NULL,
	"comment" text,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assessment_feedback_pkey" PRIMARY KEY("run_id","ordinal","account_id"),
	CONSTRAINT "assessment_feedback_rating" CHECK ((rating = ANY (ARRAY['useful'::text, 'not_useful'::text]))),
	CONSTRAINT "assessment_feedback_comment" CHECK (((comment IS NULL) OR ((char_length(comment) >= 1) AND (char_length(comment) <= 1000))))
);
--> statement-breakpoint
CREATE TABLE "assessment_seen" (
	"run_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assessment_seen_pkey" PRIMARY KEY("run_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "assessment_feedback" ADD CONSTRAINT "assessment_feedback_run" FOREIGN KEY ("run_id","plant_id") REFERENCES "assessment_run"("id","plant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_feedback" ADD CONSTRAINT "assessment_feedback_plant" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_feedback" ADD CONSTRAINT "assessment_feedback_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_seen" ADD CONSTRAINT "assessment_seen_run" FOREIGN KEY ("run_id","plant_id") REFERENCES "assessment_run"("id","plant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_seen" ADD CONSTRAINT "assessment_seen_plant" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_seen" ADD CONSTRAINT "assessment_seen_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_feedback_plant_idx" ON "assessment_feedback" USING btree ("plant_id");--> statement-breakpoint
CREATE INDEX "assessment_feedback_account_idx" ON "assessment_feedback" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "assessment_seen_plant_idx" ON "assessment_seen" USING btree ("plant_id");--> statement-breakpoint
CREATE INDEX "assessment_seen_account_idx" ON "assessment_seen" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','branding.changed','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','development.enrolled','development.feedback_recorded','development.milestone_confirmed','development.milestone_marked','development.milestone_recorded','development.plan_saved','development.program_created','development.version_applied','development.version_published','documents.archived','documents.church_archived','documents.church_restored','documents.branding_changed','documents.copied','documents.created_from_template','documents.designated','documents.export_deleted','documents.exported','documents.generated','documents.imported','documents.purged','documents.saved','documents.template_deleted','documents.template_details_changed','documents.template_saved','documents.template_updated','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','feedback.publication_held','feedback.publication_intended','feedback.publication_unknown','feedback.published','feedback.received','feedback.status_changed','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','intelligence.assessed','intelligence.assessment_opened','intelligence.feedback_saved','intelligence.refresh_requested','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','launch.corrected','launch.debrief_submitted','launch.outcome_recorded','launch.summary_published','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','organization.profile_changed','people.corrected','people.created','people.duplicate_dismissed','people.duplicate_restored','people.merged','people.recorded','people.removed','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));--> statement-breakpoint
-- A reader's own feedback is written and changed only by its author; a first open is written once. Removing a plant
-- or an account removes both.
REVOKE ALL ON "assessment_feedback" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON "assessment_feedback" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "assessment_feedback" TO everyfield_cleanup;
--> statement-breakpoint
REVOKE ALL ON "assessment_seen" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT ON "assessment_seen" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "assessment_seen" TO everyfield_cleanup;
