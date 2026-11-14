CREATE TABLE "launch_debrief" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"went_well" text,
	"to_change" text,
	"operations" text,
	"follow_up_plan" text,
	"support_needed" text,
	"missing_names" text,
	"missing_count" integer,
	"saved_at" timestamp with time zone NOT NULL,
	"saved_by" uuid,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "launch_debrief_pkey" PRIMARY KEY("id"),
	CONSTRAINT "launch_debrief_revision" CHECK ((revision >= 1)),
	CONSTRAINT "launch_debrief_version" CHECK ((version >= 1)),
	CONSTRAINT "launch_debrief_missing_names" CHECK ((missing_names = ANY (ARRAY['yes'::text, 'no'::text]))),
	CONSTRAINT "launch_debrief_missing_count" CHECK ((((missing_names = 'yes'::text) AND ((missing_count IS NULL) OR ((missing_count >= 1) AND (missing_count <= 1000000)))) OR ((missing_names IS DISTINCT FROM 'yes'::text) AND (missing_count IS NULL)))),
	CONSTRAINT "launch_debrief_submitted" CHECK (((submitted_at IS NULL) OR (missing_names = 'no'::text) OR (missing_count IS NOT NULL))),
	CONSTRAINT "launch_debrief_lengths" CHECK (((length(coalesce(went_well, ''::text)) <= 10000) AND (length(coalesce(to_change, ''::text)) <= 10000) AND (length(coalesce(operations, ''::text)) <= 10000) AND (length(coalesce(follow_up_plan, ''::text)) <= 10000) AND (length(coalesce(support_needed, ''::text)) <= 10000)))
);
--> statement-breakpoint
CREATE TABLE "launch_guest" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"recorded_by" uuid,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "launch_guest_pkey" PRIMARY KEY("id"),
	CONSTRAINT "launch_guest_revision" CHECK ((revision >= 1))
);
--> statement-breakpoint
CREATE TABLE "launch_summary" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"source_categories" text[] DEFAULT '{meetings}'::text[] NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	"saved_by" uuid,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "launch_summary_pkey" PRIMARY KEY("id"),
	CONSTRAINT "launch_summary_revision" CHECK ((revision >= 1)),
	CONSTRAINT "launch_summary_version" CHECK ((version >= 1)),
	CONSTRAINT "launch_summary_body" CHECK (((length(btrim(body)) >= 1) AND (length(body) <= 4000))),
	CONSTRAINT "launch_summary_sources" CHECK (((cardinality(source_categories) >= 1) AND (source_categories <@ ARRAY['meetings'::text, 'people'::text, 'tasks'::text, 'ministry'::text])))
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "record" DROP CONSTRAINT "record_ck_0";--> statement-breakpoint
ALTER TABLE "launch" ADD COLUMN "outcome_note" text;--> statement-breakpoint
ALTER TABLE "launch" ADD COLUMN "outcome_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launch" ADD COLUMN "outcome_recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "launch_debrief" ADD CONSTRAINT "launch_debrief_launch" FOREIGN KEY ("plant_id") REFERENCES "launch"("plant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_debrief" ADD CONSTRAINT "launch_debrief_saver" FOREIGN KEY ("saved_by") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_debrief" ADD CONSTRAINT "launch_debrief_submitter" FOREIGN KEY ("submitted_by") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_guest" ADD CONSTRAINT "launch_guest_launch" FOREIGN KEY ("plant_id") REFERENCES "launch"("plant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_guest" ADD CONSTRAINT "launch_guest_person" FOREIGN KEY ("person_id","plant_id") REFERENCES "person"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_guest" ADD CONSTRAINT "launch_guest_recorder" FOREIGN KEY ("recorded_by") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_summary" ADD CONSTRAINT "launch_summary_launch" FOREIGN KEY ("plant_id") REFERENCES "launch"("plant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_summary" ADD CONSTRAINT "launch_summary_saver" FOREIGN KEY ("saved_by") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_summary" ADD CONSTRAINT "launch_summary_publisher" FOREIGN KEY ("published_by") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "launch_debrief_version_once" ON "launch_debrief" USING btree ("plant_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_debrief_one_draft" ON "launch_debrief" USING btree ("plant_id") WHERE (submitted_at IS NULL);--> statement-breakpoint
CREATE INDEX "launch_debrief_saver_idx" ON "launch_debrief" USING btree ("saved_by");--> statement-breakpoint
CREATE INDEX "launch_debrief_submitter_idx" ON "launch_debrief" USING btree ("submitted_by");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_guest_once" ON "launch_guest" USING btree ("plant_id","person_id");--> statement-breakpoint
CREATE INDEX "launch_guest_person_idx" ON "launch_guest" USING btree ("person_id","plant_id");--> statement-breakpoint
CREATE INDEX "launch_guest_recorder_idx" ON "launch_guest" USING btree ("recorded_by");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_summary_version_once" ON "launch_summary" USING btree ("plant_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_summary_one_draft" ON "launch_summary" USING btree ("plant_id") WHERE (published_at IS NULL);--> statement-breakpoint
CREATE INDEX "launch_summary_saver_idx" ON "launch_summary" USING btree ("saved_by");--> statement-breakpoint
CREATE INDEX "launch_summary_publisher_idx" ON "launch_summary" USING btree ("published_by");--> statement-breakpoint
ALTER TABLE "launch" ADD CONSTRAINT "launch_outcome_recorded_by" FOREIGN KEY ("outcome_recorded_by") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "launch_outcome_recorded_by_idx" ON "launch" USING btree ("outcome_recorded_by");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','branding.changed','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','development.enrolled','development.feedback_recorded','development.milestone_recorded','development.plan_saved','development.program_created','development.version_applied','development.version_published','documents.archived','documents.church_archived','documents.church_restored','documents.branding_changed','documents.copied','documents.created_from_template','documents.designated','documents.export_deleted','documents.exported','documents.generated','documents.imported','documents.purged','documents.saved','documents.template_deleted','documents.template_details_changed','documents.template_saved','documents.template_updated','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','feedback.received','feedback.status_changed','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','launch.corrected','launch.debrief_submitted','launch.outcome_recorded','launch.summary_published','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','organization.profile_changed','people.corrected','people.created','people.duplicate_dismissed','people.duplicate_restored','people.merged','people.recorded','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));--> statement-breakpoint
ALTER TABLE "launch" ADD CONSTRAINT "launch_outcome_note" CHECK (((outcome_note IS NULL) OR (length(outcome_note) <= 10000)));--> statement-breakpoint
ALTER TABLE "launch" ADD CONSTRAINT "launch_outcome_recorded" CHECK (((actual_date IS NULL) = (outcome_recorded_at IS NULL)));--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_ck_0" CHECK ((kind = ANY (ARRAY['account'::text, 'affiliation'::text, 'article_editor_state'::text, 'article_revision'::text, 'assessment'::text, 'assessment_contributor'::text, 'assessment_fact'::text, 'assignment_feedback'::text, 'attestation'::text, 'commitment'::text, 'communication'::text, 'communication_recipient'::text, 'contact_outcome'::text, 'conversation'::text, 'conversation_entry'::text, 'development_enrollment'::text, 'development_milestone'::text, 'development_program'::text, 'development_program_version'::text, 'development_reading'::text, 'development_stage'::text, 'digest_coverage'::text, 'discovery'::text, 'document'::text, 'document_revision'::text, 'effect'::text, 'enrollment_milestone'::text, 'enrollment_plan'::text, 'feedback'::text, 'feedback_publication'::text, 'file_object'::text, 'finding'::text, 'four_cs'::text, 'generated_document'::text, 'household'::text, 'interview'::text, 'invitation'::text, 'job'::text, 'launch_debrief'::text, 'launch_guest'::text, 'launch_milestone'::text, 'launch_summary'::text, 'leadership_conversation'::text, 'lifecycle_witness'::text, 'mail'::text, 'mail_attempt'::text, 'mail_request'::text, 'meeting'::text, 'meeting_evaluation'::text, 'meeting_item'::text, 'message_template'::text, 'notice'::text, 'notification_preference'::text, 'obligation'::text, 'audit_event'::text, 'organization'::text, 'organization_person_removal'::text, 'participation'::text, 'passage'::text, 'person'::text, 'person_merge'::text, 'person_note'::text, 'person_skill'::text, 'phase_transition'::text, 'pipeline_person'::text, 'pipeline_sharing'::text, 'pipeline_stage'::text, 'pipeline_stage_move'::text, 'plant'::text, 'plant_geography'::text, 'platform_grant'::text, 'prompt_dismissal'::text, 'provider_event'::text, 'reader_feedback'::text, 'reading'::text, 'recurrence'::text, 'reference_activation'::text, 'reference_item'::text, 'reference_release'::text, 'reference_version'::text, 'residency_link'::text, 'responsibility'::text, 'review'::text, 'seat'::text, 'sending_goal'::text, 'suppression'::text, 'tag'::text, 'task'::text, 'team'::text, 'team_role'::text, 'team_tenure'::text, 'training_assignment'::text, 'training_credit'::text, 'training_program'::text, 'training_requirement'::text, 'training_version'::text, 'venue'::text, 'wiki_preference'::text])));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION launch_guest_bind_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE actual_owner uuid;
BEGIN
  actual_owner := NEW.plant_id;
  
  IF TG_OP='UPDATE' AND NEW.id <> OLD.id THEN RAISE EXCEPTION 'immutable_record_id' USING ERRCODE='23514'; END IF;
  INSERT INTO record(id,kind,tenant_id) VALUES (NEW.id,'launch_guest',actual_owner) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM record WHERE id=NEW.id AND kind='launch_guest' AND tenant_id=actual_owner FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_subtype_owner_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION launch_guest_bind_record() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bind_record AFTER INSERT OR UPDATE ON "launch_guest" FOR EACH ROW EXECUTE FUNCTION launch_guest_bind_record();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assert_record_binding AFTER INSERT OR UPDATE ON "launch_guest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_record_binding('"plant_id"');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION launch_debrief_bind_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE actual_owner uuid;
BEGIN
  actual_owner := NEW.plant_id;
  
  IF TG_OP='UPDATE' AND NEW.id <> OLD.id THEN RAISE EXCEPTION 'immutable_record_id' USING ERRCODE='23514'; END IF;
  INSERT INTO record(id,kind,tenant_id) VALUES (NEW.id,'launch_debrief',actual_owner) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM record WHERE id=NEW.id AND kind='launch_debrief' AND tenant_id=actual_owner FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_subtype_owner_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION launch_debrief_bind_record() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bind_record AFTER INSERT OR UPDATE ON "launch_debrief" FOR EACH ROW EXECUTE FUNCTION launch_debrief_bind_record();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assert_record_binding AFTER INSERT OR UPDATE ON "launch_debrief" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_record_binding('"plant_id"');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION launch_summary_bind_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE actual_owner uuid;
BEGIN
  actual_owner := NEW.plant_id;
  
  IF TG_OP='UPDATE' AND NEW.id <> OLD.id THEN RAISE EXCEPTION 'immutable_record_id' USING ERRCODE='23514'; END IF;
  INSERT INTO record(id,kind,tenant_id) VALUES (NEW.id,'launch_summary',actual_owner) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM record WHERE id=NEW.id AND kind='launch_summary' AND tenant_id=actual_owner FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_subtype_owner_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION launch_summary_bind_record() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bind_record AFTER INSERT OR UPDATE ON "launch_summary" FOR EACH ROW EXECUTE FUNCTION launch_summary_bind_record();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assert_record_binding AFTER INSERT OR UPDATE ON "launch_summary" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_record_binding('"plant_id"');
--> statement-breakpoint
-- A guest link moves with a merged Person and back with Unmerge. A debrief or summary draft is rewritten until it is
-- submitted or published; a submitted or published version is never rewritten. Church purge removes all three with the
-- launch row.
REVOKE ALL ON "launch_guest", "launch_debrief", "launch_summary" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON "launch_guest", "launch_debrief", "launch_summary" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "launch_guest", "launch_debrief", "launch_summary" TO everyfield_cleanup;
