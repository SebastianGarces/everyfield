CREATE TABLE "answer_review" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"note_id" uuid,
	"reviewer_seat_id" uuid NOT NULL,
	"sender_id" uuid,
	"group_name" text NOT NULL,
	"questions" text[] NOT NULL,
	"sent_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "answer_review_pkey" PRIMARY KEY("id"),
	CONSTRAINT "answer_review_revision" CHECK ((revision >= 1)),
	CONSTRAINT "answer_review_group_name" CHECK (((length(btrim(group_name)) >= 1) AND (length(group_name) <= 120))),
	CONSTRAINT "answer_review_questions" CHECK (((cardinality(questions) >= 1) AND (cardinality(questions) <= 200)))
);
--> statement-breakpoint
ALTER TABLE "notice" DROP CONSTRAINT "notice_ck_1";--> statement-breakpoint
ALTER TABLE "notice" DROP CONSTRAINT "notice_ck_2";--> statement-breakpoint
ALTER TABLE "notification_preference" DROP CONSTRAINT "notification_preference_ck_1";--> statement-breakpoint
ALTER TABLE "record" DROP CONSTRAINT "record_ck_0";--> statement-breakpoint
ALTER TABLE "person_note" ADD COLUMN "questions" text[];--> statement-breakpoint
ALTER TABLE "answer_review" ADD CONSTRAINT "answer_review_organization" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_review" ADD CONSTRAINT "answer_review_person" FOREIGN KEY ("person_id","organization_id") REFERENCES "person"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_review" ADD CONSTRAINT "answer_review_note" FOREIGN KEY ("note_id") REFERENCES "person_note"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_review" ADD CONSTRAINT "answer_review_reviewer" FOREIGN KEY ("reviewer_seat_id") REFERENCES "seat"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_review" ADD CONSTRAINT "answer_review_sender" FOREIGN KEY ("sender_id") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_review_note_idx" ON "answer_review" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "answer_review_person_idx" ON "answer_review" USING btree ("person_id","organization_id");--> statement-breakpoint
CREATE INDEX "answer_review_reviewer_idx" ON "answer_review" USING btree ("reviewer_seat_id");--> statement-breakpoint
CREATE INDEX "answer_review_sender_idx" ON "answer_review" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "answer_review_organization_idx" ON "answer_review" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_ck_1" CHECK ((category = ANY (ARRAY['task'::text, 'meeting'::text, 'phase'::text, 'insight'::text, 'relationship'::text, 'reference_update'::text, 'digest'::text, 'launch'::text, 'communication'::text, 'residency'::text, 'review'::text])));--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_ck_2" CHECK ((purpose = ANY (ARRAY['answer_review'::text, 'communication_unsubscribed'::text, 'insight_available'::text, 'launch_milestone'::text, 'meeting_evaluation'::text, 'meeting_invitation'::text, 'meeting_reminder'::text, 'oversight_digest'::text, 'phase_offer'::text, 'phase_transition'::text, 'planter_digest'::text, 'reference_update'::text, 'relationship_decision'::text, 'relationship_invitation'::text, 'residency_confirmation'::text, 'residency_feedback'::text, 'task_assignment'::text, 'task_due'::text])));--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_ck_1" CHECK (category IN ('task_due','task_overdue','meeting_announcement','meeting_reminder','planter_digest','oversight_digest','relationship_milestone','sharing_milestone','phase_milestone','launch_milestone','wiki_upstream_review','scheduled_email_unsubscribe','residency_confirmation','residency_feedback','answer_review'));--> statement-breakpoint
ALTER TABLE "person_note" ADD CONSTRAINT "person_note_questions" CHECK (((questions IS NULL) OR ((cardinality(questions) >= 1) AND (cardinality(questions) <= 200))));--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_ck_0" CHECK ((kind = ANY (ARRAY['account'::text, 'affiliation'::text, 'answer_review'::text, 'article_editor_state'::text, 'article_revision'::text, 'assessment'::text, 'assessment_contributor'::text, 'assessment_fact'::text, 'assignment_feedback'::text, 'attestation'::text, 'commitment'::text, 'communication'::text, 'communication_recipient'::text, 'contact_outcome'::text, 'conversation'::text, 'conversation_entry'::text, 'development_enrollment'::text, 'development_milestone'::text, 'development_program'::text, 'development_program_version'::text, 'development_reading'::text, 'development_stage'::text, 'digest_coverage'::text, 'discovery'::text, 'document'::text, 'document_revision'::text, 'effect'::text, 'enrollment_milestone'::text, 'enrollment_plan'::text, 'feedback'::text, 'feedback_publication'::text, 'file_object'::text, 'finding'::text, 'four_cs'::text, 'generated_document'::text, 'household'::text, 'interview'::text, 'invitation'::text, 'job'::text, 'launch_debrief'::text, 'launch_guest'::text, 'launch_milestone'::text, 'launch_summary'::text, 'leadership_conversation'::text, 'lifecycle_witness'::text, 'mail'::text, 'mail_attempt'::text, 'mail_request'::text, 'meeting'::text, 'meeting_evaluation'::text, 'meeting_item'::text, 'message_template'::text, 'notice'::text, 'notification_preference'::text, 'obligation'::text, 'audit_event'::text, 'organization'::text, 'organization_person_removal'::text, 'participation'::text, 'passage'::text, 'person'::text, 'person_merge'::text, 'person_note'::text, 'person_skill'::text, 'phase_transition'::text, 'pipeline_person'::text, 'pipeline_sharing'::text, 'pipeline_stage'::text, 'pipeline_stage_move'::text, 'plant'::text, 'plant_geography'::text, 'platform_grant'::text, 'prompt_dismissal'::text, 'provider_event'::text, 'reader_feedback'::text, 'reading'::text, 'recurrence'::text, 'reference_activation'::text, 'reference_item'::text, 'reference_release'::text, 'reference_version'::text, 'residency_link'::text, 'responsibility'::text, 'review'::text, 'seat'::text, 'sending_goal'::text, 'suppression'::text, 'tag'::text, 'task'::text, 'team'::text, 'team_role'::text, 'team_tenure'::text, 'training_assignment'::text, 'training_credit'::text, 'training_program'::text, 'training_requirement'::text, 'training_version'::text, 'venue'::text, 'wiki_preference'::text])));--> statement-breakpoint
CREATE OR REPLACE FUNCTION answer_review_bind_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE actual_owner uuid;
BEGIN
  actual_owner := NEW.organization_id;
  
  IF TG_OP='UPDATE' AND NEW.id <> OLD.id THEN RAISE EXCEPTION 'immutable_record_id' USING ERRCODE='23514'; END IF;
  INSERT INTO record(id,kind,tenant_id) VALUES (NEW.id,'answer_review',actual_owner) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM record WHERE id=NEW.id AND kind='answer_review' AND tenant_id=actual_owner FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_subtype_owner_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION answer_review_bind_record() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bind_record AFTER INSERT OR UPDATE ON "answer_review" FOR EACH ROW EXECUTE FUNCTION answer_review_bind_record();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assert_record_binding AFTER INSERT OR UPDATE ON "answer_review" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_record_binding('"organization_id"');
--> statement-breakpoint
-- A send is written once and only withdrawn after; the reviewer's live read checks its note, person and seat. Removing
-- the note leaves the send with no note; removing the person on request keeps it, as no longer shared.
REVOKE ALL ON "answer_review" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON "answer_review" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "answer_review" TO everyfield_cleanup;
