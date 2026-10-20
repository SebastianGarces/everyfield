DROP TABLE "article_link" CASCADE;--> statement-breakpoint
DROP TABLE "assessment" CASCADE;--> statement-breakpoint
DROP TABLE "assessment_contributor" CASCADE;--> statement-breakpoint
DROP TABLE "assessment_fact" CASCADE;--> statement-breakpoint
DROP TABLE "assignment_feedback" CASCADE;--> statement-breakpoint
DROP TABLE "communication" CASCADE;--> statement-breakpoint
DROP TABLE "communication_recipient" CASCADE;--> statement-breakpoint
DROP TABLE "development_milestone" CASCADE;--> statement-breakpoint
DROP TABLE "development_reading" CASCADE;--> statement-breakpoint
DROP TABLE "enrollment_milestone" CASCADE;--> statement-breakpoint
DROP TABLE "enrollment_plan" CASCADE;--> statement-breakpoint
DROP TABLE "evidence_link" CASCADE;--> statement-breakpoint
DROP TABLE "feedback" CASCADE;--> statement-breakpoint
DROP TABLE "feedback_publication" CASCADE;--> statement-breakpoint
DROP TABLE "finding" CASCADE;--> statement-breakpoint
DROP TABLE "four_cs" CASCADE;--> statement-breakpoint
DROP TABLE "generated_document" CASCADE;--> statement-breakpoint
DROP TABLE "launch_debrief" CASCADE;--> statement-breakpoint
DROP TABLE "launch_guest" CASCADE;--> statement-breakpoint
DROP TABLE "leadership_conversation" CASCADE;--> statement-breakpoint
DROP TABLE "meeting_evaluation" CASCADE;--> statement-breakpoint
DROP TABLE "meeting_item" CASCADE;--> statement-breakpoint
DROP TABLE "message_template" CASCADE;--> statement-breakpoint
DROP TABLE "person_merge" CASCADE;--> statement-breakpoint
DROP TABLE "person_skill" CASCADE;--> statement-breakpoint
DROP TABLE "pipeline_stage_move" CASCADE;--> statement-breakpoint
DROP TABLE "private_calendar" CASCADE;--> statement-breakpoint
DROP TABLE "private_week" CASCADE;--> statement-breakpoint
DROP TABLE "private_week_revision" CASCADE;--> statement-breakpoint
DROP TABLE "prompt_dismissal" CASCADE;--> statement-breakpoint
DROP TABLE "reader_feedback" CASCADE;--> statement-breakpoint
DROP TABLE "rsvp_proof" CASCADE;--> statement-breakpoint
DROP TABLE "sending_goal" CASCADE;--> statement-breakpoint
DROP TABLE "task_dependency" CASCADE;--> statement-breakpoint
DROP TABLE "training_assignment" CASCADE;--> statement-breakpoint
DROP TABLE "training_credit" CASCADE;--> statement-breakpoint
DROP TABLE "training_program" CASCADE;--> statement-breakpoint
DROP TABLE "training_requirement" CASCADE;--> statement-breakpoint
DROP TABLE "training_version" CASCADE;--> statement-breakpoint
DROP TABLE "wiki_preference" CASCADE;
--> statement-breakpoint
-- Schema trim (D72): the purge and file-reference functions stop naming the dropped tables.
CREATE OR REPLACE FUNCTION file_is_referenced(object_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path FROM CURRENT
AS $function$ SELECT EXISTS (SELECT 1 FROM "account" WHERE "avatar_object_id" = object_id UNION ALL SELECT 1 FROM "person" WHERE "photo_object_id" = object_id UNION ALL SELECT 1 FROM "commitment" WHERE "object_id" = object_id UNION ALL SELECT 1 FROM "document_revision" WHERE "import_object_id" = object_id) $function$;
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
--> statement-breakpoint
-- Trigger functions of the dropped tables.
DROP FUNCTION assessment_bind_record();
--> statement-breakpoint
DROP FUNCTION assessment_contributor_bind_record();
--> statement-breakpoint
DROP FUNCTION assessment_fact_bind_record();
--> statement-breakpoint
DROP FUNCTION assignment_feedback_bind_record();
--> statement-breakpoint
DROP FUNCTION communication_bind_record();
--> statement-breakpoint
DROP FUNCTION communication_recipient_bind_record();
--> statement-breakpoint
DROP FUNCTION development_milestone_bind_record();
--> statement-breakpoint
DROP FUNCTION development_reading_bind_record();
--> statement-breakpoint
DROP FUNCTION enrollment_milestone_bind_record();
--> statement-breakpoint
DROP FUNCTION enrollment_plan_bind_record();
--> statement-breakpoint
DROP FUNCTION feedback_bind_record();
--> statement-breakpoint
DROP FUNCTION feedback_publication_bind_record();
--> statement-breakpoint
DROP FUNCTION finding_bind_record();
--> statement-breakpoint
DROP FUNCTION four_cs_bind_record();
--> statement-breakpoint
DROP FUNCTION generated_document_bind_record();
--> statement-breakpoint
DROP FUNCTION launch_debrief_bind_record();
--> statement-breakpoint
DROP FUNCTION launch_guest_bind_record();
--> statement-breakpoint
DROP FUNCTION leadership_conversation_bind_record();
--> statement-breakpoint
DROP FUNCTION meeting_evaluation_bind_record();
--> statement-breakpoint
DROP FUNCTION meeting_item_bind_record();
--> statement-breakpoint
DROP FUNCTION message_template_bind_record();
--> statement-breakpoint
DROP FUNCTION person_merge_bind_record();
--> statement-breakpoint
DROP FUNCTION person_skill_bind_record();
--> statement-breakpoint
DROP FUNCTION pipeline_stage_move_bind_record();
--> statement-breakpoint
DROP FUNCTION prompt_dismissal_bind_record();
--> statement-breakpoint
DROP FUNCTION reader_feedback_bind_record();
--> statement-breakpoint
DROP FUNCTION sending_goal_bind_record();
--> statement-breakpoint
DROP FUNCTION training_assignment_bind_record();
--> statement-breakpoint
DROP FUNCTION training_credit_bind_record();
--> statement-breakpoint
DROP FUNCTION training_program_bind_record();
--> statement-breakpoint
DROP FUNCTION training_requirement_bind_record();
--> statement-breakpoint
DROP FUNCTION training_version_bind_record();
--> statement-breakpoint
DROP FUNCTION wiki_preference_bind_record();
