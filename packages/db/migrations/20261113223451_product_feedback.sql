CREATE TABLE "feedback" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"page_label" text,
	"page_address" text,
	"church_label" text,
	"role_label" text,
	"browser" text,
	"screen_width" integer,
	"screen_height" integer,
	"theme" text,
	"app_version" text,
	"submitted_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "feedback_pkey" PRIMARY KEY("id"),
	CONSTRAINT "feedback_revision" CHECK ((revision >= 1)),
	CONSTRAINT "feedback_category" CHECK ((category = ANY (ARRAY['bug'::text, 'suggestion'::text, 'question'::text, 'other'::text]))),
	CONSTRAINT "feedback_status" CHECK ((status = ANY (ARRAY['new'::text, 'reviewed'::text, 'resolved'::text, 'dismissed'::text]))),
	CONSTRAINT "feedback_description" CHECK ((length(btrim(description)) BETWEEN 1 AND 5000)),
	CONSTRAINT "feedback_labels" CHECK (((length(page_label) <= 500) AND (length(church_label) <= 200) AND (length(role_label) <= 200) AND (length(browser) <= 500) AND (length(app_version) <= 100)) IS NOT FALSE),
	CONSTRAINT "feedback_address" CHECK (((page_address IS NULL) OR ((length(page_address) <= 500) AND (page_address ~~ '/%'::text) AND (strpos(page_address, '?'::text) = 0) AND (strpos(page_address, '#'::text) = 0)))),
	CONSTRAINT "feedback_theme" CHECK (((theme IS NULL) OR (theme = ANY (ARRAY['light'::text, 'dark'::text])))),
	CONSTRAINT "feedback_screen" CHECK (((screen_width IS NULL) OR ((screen_width >= 1) AND (screen_width <= 100000))) AND ((screen_height IS NULL) OR ((screen_height >= 1) AND (screen_height <= 100000))))
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_record" FOREIGN KEY ("id","account_id") REFERENCES "record"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_request" ON "feedback" USING btree ("account_id","request_key");--> statement-breakpoint
CREATE INDEX "feedback_own" ON "feedback" USING btree ("account_id","submitted_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "feedback_triage" ON "feedback" USING btree ("submitted_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','branding.changed','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','documents.archived','documents.church_archived','documents.church_restored','documents.branding_changed','documents.copied','documents.created_from_template','documents.designated','documents.export_deleted','documents.exported','documents.generated','documents.imported','documents.purged','documents.saved','documents.template_deleted','documents.template_details_changed','documents.template_saved','documents.template_updated','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','feedback.received','feedback.status_changed','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','organization.profile_changed','people.corrected','people.created','people.duplicate_dismissed','people.duplicate_restored','people.merged','people.recorded','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT "feedback_record";
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_record" FOREIGN KEY ("id", "account_id") REFERENCES "record" ("id", "tenant_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION feedback_bind_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE actual_owner uuid;
BEGIN
  actual_owner := NEW.account_id;
  IF TG_OP='UPDATE' AND NEW.id <> OLD.id THEN RAISE EXCEPTION 'immutable_record_id' USING ERRCODE='23514'; END IF;
  INSERT INTO record(id,kind,tenant_id) VALUES (NEW.id,'feedback',actual_owner) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM record WHERE id=NEW.id AND kind='feedback' AND tenant_id=actual_owner FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_subtype_owner_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION feedback_bind_record() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION feedback_bind_record() TO everyfield_runtime;
--> statement-breakpoint
CREATE TRIGGER bind_record AFTER INSERT OR UPDATE ON "feedback" FOR EACH ROW EXECUTE FUNCTION feedback_bind_record();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assert_record_binding AFTER INSERT OR UPDATE ON "feedback" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_record_binding('"account_id"');
--> statement-breakpoint
-- The author, the words and the details never change; a triager changes only status and revision.
CREATE TRIGGER immutable_source BEFORE UPDATE ON "feedback" FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,account_id,request_key,category,description,page_label,page_address,church_label,role_label,browser,screen_width,screen_height,theme,app_version,submitted_at');
--> statement-breakpoint
REVOKE ALL ON "feedback" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON "feedback" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "feedback" TO everyfield_cleanup;
--> statement-breakpoint
-- The account purge removes the author's feedback, with its private details.
DO $patch$
DECLARE def text; patched text;
BEGIN
 def := pg_get_functiondef('settings_purge_content(uuid,uuid,bigint)'::regprocedure);
 patched := replace(def, E' DELETE FROM private_calendar WHERE plant_id=s OR (w.kind=\'account\' AND author_id=s);\n', E' DELETE FROM private_calendar WHERE plant_id=s OR (w.kind=\'account\' AND author_id=s);\n DELETE FROM feedback WHERE w.kind=\'account\' AND account_id=s;\n');
 IF patched = def THEN
  RAISE EXCEPTION 'settings_purge_content patch did not apply';
 END IF;
 EXECUTE patched;
END
$patch$;
