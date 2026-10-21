CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"context_kind" text NOT NULL,
	"title" text NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"active_turn_id" uuid,
	"active_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "conversation_title" CHECK (char_length("conversation"."title") BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "conversation_event" (
	"conversation_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"turn_id" uuid,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"request_key" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "conversation_event_pkey" PRIMARY KEY("conversation_id","sequence"),
	CONSTRAINT "conversation_event_request" UNIQUE("conversation_id","request_key"),
	CONSTRAINT "conversation_event_body" CHECK (jsonb_typeof("conversation_event"."body")='object')
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_active_session_id_auth_session_id_fk" FOREIGN KEY ("active_session_id") REFERENCES "auth_session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_active_turn" FOREIGN KEY ("active_turn_id","tenant_id") REFERENCES "job"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_event" ADD CONSTRAINT "conversation_event_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_event" ADD CONSTRAINT "conversation_event_turn_id_job_id_fk" FOREIGN KEY ("turn_id") REFERENCES "job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_owner_recent" ON "conversation" USING btree ("account_id","tenant_id","updated_at","id");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','audit.imported','communication.approved','communication.send_intended','deletion.cancelled','deletion.live_purge_completed','documents.copied','documents.saved','evry.conversation_created','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','execution.cancelled','execution.completed','execution.partial','execution.reconciled','execution.started','feedback.publication_intended','feedback.published','feedback.received','feedback.reconciled','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.credential_reconciled','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','intelligence.feedback_recorded','intelligence.published','intelligence.requested','intelligence.superseded','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','launch.corrected','launch.debrief_submitted','launch.outcome_recorded','launch.summary_published','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','note_correction','organization.profile_changed','people.corrected','people.created','people.merged','people.recorded','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','security.access_denied','security.audit_exported','security.audit_inspected','security.bulk_export','security.operator_accessed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.hidden','wiki.published','wiki.source_order_changed')));
--> statement-breakpoint
-- Custom: record binding, runtime privileges and owner cleanup for Evry conversations.
CREATE FUNCTION conversation_bind_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE actual_owner uuid;
BEGIN
  actual_owner := NEW.tenant_id;
  IF TG_OP='UPDATE' AND NEW.id <> OLD.id THEN RAISE EXCEPTION 'immutable_record_id' USING ERRCODE='23514'; END IF;
  INSERT INTO record(id,kind,tenant_id) VALUES (NEW.id,'conversation',actual_owner) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM record WHERE id=NEW.id AND kind='conversation' AND tenant_id=actual_owner FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_subtype_owner_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION conversation_bind_record() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bind_record AFTER INSERT OR UPDATE OF id,tenant_id ON conversation FOR EACH ROW EXECUTE FUNCTION conversation_bind_record();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assert_record_binding AFTER INSERT OR UPDATE OF id,tenant_id ON conversation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_record_binding('"tenant_id"');
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON conversation TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,INSERT ON conversation_event TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON conversation,conversation_event TO everyfield_cleanup;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION settings_purge_content(witness uuid, request uuid, expected bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE w lifecycle_witness%ROWTYPE; s uuid; n bigint; removed bigint; pass integer;
BEGIN
 SELECT * INTO w FROM lifecycle_witness WHERE id=witness AND request_id=request AND request_revision=expected AND state='purging' AND cancel_until<=clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 s=w.opaque_subject_id;
 -- Private Evry conversations go with their account or exact context; their events cascade.
 DELETE FROM conversation WHERE tenant_id=s OR (w.kind='account' AND account_id=s);
 UPDATE audit_event SET actor_token=coalesce(actor_token,encode(sha256(convert_to(tenant_id::text||'/'||s::text,'UTF8')),'hex')),actor_id=NULL,request_identity=NULL,result=CASE WHEN id IN (SELECT creation_operation_id FROM onboarding_setup WHERE account_id=s AND plant_id<>s) THEN result ELSE NULL END WHERE actor_id=s AND w.kind='account';
 UPDATE audit_event a SET result=jsonb_build_object('plant',a.result->'plant','creation',a.result->'creation'),request_identity=NULL,request_key=NULL,before_value=NULL,after_value=NULL,metadata='{}' WHERE a.id IN (SELECT creation_operation_id FROM onboarding_setup WHERE account_id=s AND plant_id<>s);
 UPDATE provider_event SET mail_id=NULL WHERE mail_id IN (SELECT id FROM mail WHERE tenant_id=s);
 UPDATE mail SET notice_id=NULL WHERE notice_id IN (SELECT id FROM notice WHERE tenant_id=s OR (recipient_id=s AND w.kind='account'));
 -- Detach mutable current pointers before deleting immutable revision bodies.
 UPDATE document SET current_revision_id=NULL WHERE tenant_id=s;
 IF w.kind='account' THEN
  UPDATE mail SET notice_id=NULL WHERE recipient_account_id=s;
  UPDATE account SET avatar_object_id=NULL,personal_timezone=NULL,registration_digest=NULL WHERE id=s;
  UPDATE mail SET recipient_address_encrypted=NULL,frozen_payload=NULL,address_hash=NULL,recipient_account_id=NULL,state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE state END WHERE recipient_account_id=s;
  UPDATE seat SET ended_at=coalesce(ended_at,clock_timestamp()) WHERE account_id=s;
  UPDATE affiliation SET ended_at=coalesce(ended_at,clock_timestamp()) WHERE account_id=s;
  UPDATE residency_link SET ended_at=coalesce(ended_at,clock_timestamp()) WHERE account_id=s;
  PERFORM scrub_people_account_author(s);
 UPDATE "article_revision" SET "author_id"=NULL WHERE "author_id"=s;
 UPDATE "meeting" SET "creator_id"=NULL WHERE "creator_id"=s;
 UPDATE "obligation" SET "assignee_id"=NULL WHERE "assignee_id"=s;
 UPDATE "organization_person_removal" SET "requested_by"=NULL WHERE "requested_by"=s;
 UPDATE "participation" SET "card_author_id"=NULL WHERE "card_author_id"=s;
 UPDATE "person" SET "linked_account_id"=NULL WHERE "linked_account_id"=s;
 UPDATE "person_note" SET "author_id"=NULL WHERE "author_id"=s;
 UPDATE "pipeline_sharing" SET "changed_by"=NULL WHERE "changed_by"=s;
 UPDATE "reference_activation" SET "actor_id"=NULL,actor_tombstone='removed_account' WHERE "actor_id"=s;
 UPDATE "task" SET "creator_id"=NULL WHERE "creator_id"=s;
 UPDATE "task" SET "assignee_id"=NULL WHERE "assignee_id"=s;
  -- Shared onboarding setup/phase facts survive. The original account-scoped
  -- result keeps only church creation evidence, without a login/seat snapshot.
  UPDATE auth_user SET name='Removed account',email='removed-'||s::text||'@removed.invalid',image=NULL,email_verified=false WHERE id=(SELECT auth_user_id FROM account WHERE id=s);
  DELETE FROM auth_session WHERE user_id=(SELECT auth_user_id FROM account WHERE id=s);
  DELETE FROM auth_account WHERE user_id=(SELECT auth_user_id FROM account WHERE id=s);
  DELETE FROM auth_verification WHERE value=(SELECT auth_user_id::text FROM account WHERE id=s);
 END IF;
 -- Required FK dependencies determine which deletion can make progress. A
 -- surviving reference refuses completion, instead of cascading another owner.
 FOR pass IN 1..49 LOOP
  removed=0;
  BEGIN
   DELETE FROM "affiliation" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "article_revision" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "attestation" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "commitment" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "contact_outcome" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "digest_coverage" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "discovery" WHERE (w.kind='account' AND (account_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "document" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "document_revision" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "household" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "identity_proof" WHERE (w.kind='account' AND (account_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "interview" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "invitation" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "job" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "launch" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "launch_milestone" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "mail" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "mail_attempt" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "mail_request" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "mail_request_member" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "meeting" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "notice" WHERE tenant_id=s OR (w.kind='account' AND (recipient_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "notification_preference" WHERE (w.kind='account' AND (account_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "obligation" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "onboarding_setup" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "participation" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "passage" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "people_column" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "person" WHERE tenant_id=s OR (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "person_note" WHERE tenant_id=s OR (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "person_tag" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "phase_transition" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "plant_geography" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "platform_grant" WHERE (w.kind='account' AND (account_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "reading" WHERE (w.kind='plant' AND (plant_context_id=s)) OR (w.kind='account' AND (account_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "recurrence" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "reference_item" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "reference_release" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "relationship_invitation" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "responsibility" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "seat" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "settings_preview" WHERE tenant_id=s OR (w.kind='account' AND (account_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "tag" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "task" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "team" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "team_role" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "team_tenure" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "venue" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  EXIT WHEN removed=0;
 END LOOP;
 DELETE FROM audit_event WHERE tenant_id=s AND id NOT IN (SELECT creation_operation_id FROM onboarding_setup WHERE plant_id<>s) AND (command_id IS NULL OR command_id NOT IN (SELECT creation_operation_id FROM onboarding_setup WHERE plant_id<>s));
 IF EXISTS(SELECT FROM "affiliation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:affiliation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "article_revision" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:article_revision' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "attestation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:attestation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "commitment" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:commitment' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "contact_outcome" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:contact_outcome' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "digest_coverage" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:digest_coverage' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "discovery" WHERE (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:discovery' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "document" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:document' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "document_revision" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:document_revision' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "household" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:household' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "identity_proof" WHERE (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:identity_proof' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "interview" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:interview' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "invitation" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:invitation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "job" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:job' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "launch" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:launch' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "launch_milestone" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:launch_milestone' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "mail" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:mail' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "mail_attempt" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:mail_attempt' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "mail_request" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:mail_request' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "mail_request_member" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:mail_request_member' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "meeting" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:meeting' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "notice" WHERE tenant_id=s OR (w.kind='account' AND (recipient_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:notice' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "notification_preference" WHERE (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:notification_preference' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "obligation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:obligation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "onboarding_setup" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:onboarding_setup' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "participation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:participation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "passage" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:passage' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "people_column" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:people_column' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "person" WHERE tenant_id=s OR (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:person' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "person_note" WHERE tenant_id=s OR (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:person_note' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "person_tag" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:person_tag' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "phase_transition" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:phase_transition' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "plant_geography" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:plant_geography' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "platform_grant" WHERE (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:platform_grant' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "reading" WHERE (w.kind='plant' AND (plant_context_id=s)) OR (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:reading' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "recurrence" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:recurrence' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "reference_item" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:reference_item' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "reference_release" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:reference_release' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "relationship_invitation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:relationship_invitation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "responsibility" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:responsibility' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "seat" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:seat' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "settings_preview" WHERE tenant_id=s OR (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:settings_preview' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "tag" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:tag' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "task" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:task' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "team" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:team' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "team_role" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:team_role' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "team_tenure" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:team_tenure' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "venue" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:venue' USING ERRCODE='23514'; END IF;
 IF w.kind='plant' THEN
  UPDATE plant SET name='Removed workspace',street=NULL,description=NULL,city=NULL,state_province=NULL,country=NULL WHERE id=s;
 END IF;
 UPDATE mail SET recipient_address_encrypted=NULL,frozen_payload=NULL,address_hash=NULL,recipient_account_id=NULL,state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE state END WHERE recipient_account_id=s AND w.kind='account';
END $function$;
