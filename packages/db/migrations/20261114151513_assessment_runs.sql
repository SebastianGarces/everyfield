CREATE TABLE "assessment_run" (
	"id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"requested_by" uuid,
	"as_of" timestamp with time zone NOT NULL,
	"phase" integer NOT NULL,
	"source_revision" text NOT NULL,
	"formula_version" text NOT NULL,
	"rubric_version" text NOT NULL,
	"rubric_sha256" text NOT NULL,
	"reference_release" text,
	"reference_activation" bigint,
	"model" text NOT NULL,
	"outcome" text NOT NULL,
	"grounding" text NOT NULL,
	"reason" text,
	"facts" jsonb NOT NULL,
	"model_input" jsonb,
	"drafts" jsonb NOT NULL,
	"result" jsonb,
	"attempts" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "assessment_run_pkey" PRIMARY KEY("id"),
	CONSTRAINT "assessment_run_phase" CHECK (((phase >= 0) AND (phase <= 6))),
	CONSTRAINT "assessment_run_rubric" CHECK ((rubric_version = ANY (ARRAY['v0'::text, 'v1'::text]))),
	CONSTRAINT "assessment_run_outcome" CHECK ((outcome = ANY (ARRAY['published'::text, 'failed'::text, 'deferred'::text, 'degraded'::text]))),
	CONSTRAINT "assessment_run_grounding" CHECK ((grounding = ANY (ARRAY['grounded'::text, 'degraded'::text]))),
	CONSTRAINT "assessment_run_published" CHECK ((((outcome = 'published'::text) = (result IS NOT NULL)) AND ((grounding = 'degraded'::text) = (model_input IS NULL)) AND ((grounding = 'degraded'::text) = (outcome = 'degraded'::text)) AND ((reference_release IS NULL) = (reference_activation IS NULL)))),
	CONSTRAINT "assessment_run_budget" CHECK (((attempts >= 0) AND (attempts <= 12) AND (input_tokens >= 0) AND (output_tokens >= 0)))
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "assessment_run" ADD CONSTRAINT "assessment_run_plant" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run" ADD CONSTRAINT "assessment_run_requester" FOREIGN KEY ("requested_by") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_run_plant_idx" ON "assessment_run" USING btree ("plant_id","recorded_at");--> statement-breakpoint
CREATE INDEX "assessment_run_requester_idx" ON "assessment_run" USING btree ("requested_by");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','branding.changed','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','development.enrolled','development.feedback_recorded','development.milestone_confirmed','development.milestone_marked','development.milestone_recorded','development.plan_saved','development.program_created','development.version_applied','development.version_published','documents.archived','documents.church_archived','documents.church_restored','documents.branding_changed','documents.copied','documents.created_from_template','documents.designated','documents.export_deleted','documents.exported','documents.generated','documents.imported','documents.purged','documents.saved','documents.template_deleted','documents.template_details_changed','documents.template_saved','documents.template_updated','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','feedback.publication_held','feedback.publication_intended','feedback.publication_unknown','feedback.published','feedback.received','feedback.status_changed','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','intelligence.assessed','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','launch.corrected','launch.debrief_submitted','launch.outcome_recorded','launch.summary_published','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','organization.profile_changed','people.corrected','people.created','people.duplicate_dismissed','people.duplicate_restored','people.merged','people.recorded','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));--> statement-breakpoint
-- An assessment run is written once and never changed. Removing a plant removes its runs; deleting an account clears
-- who requested a run.
REVOKE ALL ON "assessment_run" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT ON "assessment_run" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "assessment_run" TO everyfield_cleanup;
