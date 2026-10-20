CREATE TABLE "audit_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_token" text,
	"system_cause" text,
	"action" text NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text DEFAULT 'record' NOT NULL,
	"subject_id" uuid NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"before_revision" bigint,
	"after_revision" bigint,
	"reason" text,
	"request_key" text,
	"request_identity" jsonb,
	"result" jsonb,
	"command_id" uuid,
	"event_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_event_pkey" PRIMARY KEY("id"),
	CONSTRAINT "audit_event_identity" UNIQUE("id","tenant_id"),
	CONSTRAINT "audit_request_key" UNIQUE("tenant_id","request_key"),
	CONSTRAINT "audit_event_key" UNIQUE("subject_id","event_key")
);
--> statement-breakpoint
ALTER TABLE "record" DROP CONSTRAINT "record_ck_0";
--> statement-breakpoint
ALTER TABLE "affiliation" DROP CONSTRAINT "affiliation_fk_5";
--> statement-breakpoint
ALTER TABLE "assessment_contributor" DROP CONSTRAINT "assessment_contributor_fk_3";
--> statement-breakpoint
ALTER TABLE "conversation_entry" DROP CONSTRAINT "conversation_entry_fk_4";
--> statement-breakpoint
ALTER TABLE "digest_coverage" DROP CONSTRAINT "digest_coverage_fk_3";
--> statement-breakpoint
ALTER TABLE "discovery" DROP CONSTRAINT "discovery_fk_2";
--> statement-breakpoint
ALTER TABLE "effect" DROP CONSTRAINT "effect_fk_1";
--> statement-breakpoint
ALTER TABLE "evidence_link" DROP CONSTRAINT "evidence_link_fk_1";
--> statement-breakpoint
ALTER TABLE "evidence_link" DROP CONSTRAINT "evidence_link_fk_3";
--> statement-breakpoint
ALTER TABLE "generated_document" DROP CONSTRAINT "generated_document_fk_3";
--> statement-breakpoint
ALTER TABLE "mail" DROP CONSTRAINT "mail_fk_3";
--> statement-breakpoint
ALTER TABLE "onboarding_setup" DROP CONSTRAINT "onboarding_setup_creation_operation_id_operation_id_fk";
--> statement-breakpoint
ALTER TABLE "person_merge" DROP CONSTRAINT "person_merge_fk_3";
--> statement-breakpoint
ALTER TABLE "person_merge" DROP CONSTRAINT "person_merge_fk_4";
--> statement-breakpoint
ALTER TABLE "phase_transition" DROP CONSTRAINT "phase_transition_fk_1";
--> statement-breakpoint
ALTER TABLE "suppression" DROP CONSTRAINT "suppression_fk_1";
--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_fk_12";
--> statement-breakpoint
ALTER TABLE "training_assignment" DROP CONSTRAINT "training_assignment_fk_4";
--> statement-breakpoint
ALTER TABLE "wiki_preference" DROP CONSTRAINT "wiki_preference_fk_2";
--> statement-breakpoint

-- Preserve exact committed replies, and migrate old evidence before retiring its tables.
INSERT INTO audit_event(id,tenant_id,actor_id,actor_token,system_cause,action,kind,subject_type,subject_id,occurred_at,recorded_at,request_key,request_identity,result,metadata)
SELECT o.id,o.tenant_id,o.actor_id,o.actor_tombstone,CASE WHEN o.actor_id IS NULL AND o.actor_tombstone IS NULL THEN 'migrated_service' END,o.name,'edit','command',coalesce(p.person_id,ref.subject_id,CASE WHEN o.tenant_id='00000000-0000-0000-0000-000000000000'::uuid THEN o.id ELSE o.tenant_id END),o.started_at,coalesce(o.completed_at,o.started_at),o.request_key,
 coalesce(coalesce(p.value,s.value,n.value,i.result,g.result)->'receipt'->'request',CASE WHEN o.actor_id IS NOT NULL THEN jsonb_build_object('owner',jsonb_strip_nulls(jsonb_build_object('kind',ten.kind,'id',o.tenant_id,'organizationKind',org.kind)),'actorId',o.actor_id,'operation',o.name,'requestKey',o.request_key,'digest',o.request_digest,'origin',CASE WHEN o.review_id IS NULL THEN jsonb_build_object('kind','native') ELSE jsonb_build_object('kind','assistant','reviewId',o.review_id,'conversationId',o.conversation_id,'planDigest',review.digest) END) END),
 coalesce(p.value,s.value,n.value,i.result,g.result,ref.receipt),
 jsonb_build_object('migrated',true,'outcome',o.outcome,'reviewId',o.review_id,'conversationId',o.conversation_id,'requestDigest',o.request_digest)
FROM operation o JOIN tenant ten ON ten.id=o.tenant_id LEFT JOIN organization org ON org.id=o.tenant_id LEFT JOIN review ON review.id=o.review_id
 LEFT JOIN people_result p ON p.operation_id=o.id
 LEFT JOIN settings_result s ON s.operation_id=o.id LEFT JOIN onboarding_result n ON n.operation_id=o.id
 LEFT JOIN identity_operation_result i ON i.operation_id=o.id LEFT JOIN organization_operation_result g ON g.operation_id=o.id
 LEFT JOIN LATERAL (SELECT a.id AS subject_id,jsonb_build_object('operationId',o.id,'activationId',a.id,'eventId',e.id,'number',a.activation_number::text,'generationKey',r.release_key,'replayed',false) receipt FROM event e JOIN reference_activation a ON a.id=e.target_record_id JOIN reference_release r ON r.id=a.release_id WHERE e.operation_id=o.id AND o.name IN ('reference.activateGeneration','reference.rollbackActivation') LIMIT 1) ref ON true;
INSERT INTO audit_event(id,tenant_id,actor_id,actor_token,system_cause,action,kind,subject_type,subject_id,occurred_at,recorded_at,before_revision,after_revision,reason,command_id,event_key,metadata)
SELECT id,tenant_id,actor_id,actor_tombstone,system_cause,coalesce(action,kind),kind,'record',target_record_id,occurred_at,recorded_at,before_revision,after_revision,reason,operation_id,event_key,
 jsonb_strip_nulls(jsonb_build_object('effectId',effect_id,'diff',diff,'from',from_value,'to',to_value,'number',number_value,'occurrenceDate',occurrence_date,'mailAttemptId',mail_attempt_id,'mailRequestId',mail_request_id,'mailPosition',mail_position)) FROM event;
UPDATE audit_event a SET before_value=h.before_value,after_value=h.after_value,reason=h.reason,actor_token=h.actor_token
FROM people_history h WHERE a.command_id=h.operation_id AND a.subject_id=h.person_id AND a.action=h.action;
INSERT INTO audit_event(id,tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,before_value,after_value,occurred_at,recorded_at,before_revision,after_revision,reason,command_id)
SELECT h.id,h.tenant_id,h.actor_id,h.actor_token,h.action,'edit','person',h.person_id,h.before_value,h.after_value,h.occurred_at,h.recorded_at,h.before_revision,h.after_revision,h.reason,h.operation_id
FROM people_history h WHERE NOT EXISTS(SELECT FROM audit_event a WHERE a.command_id=h.operation_id AND a.subject_id=h.person_id AND a.action=h.action);
UPDATE audit_event a SET reason=h.reason,metadata=a.metadata||jsonb_build_object('pair',h.pair,'sourceInvitationId',h.source_invitation_id)
FROM relationship_history h WHERE h.id=a.id;
-- Existing complete snapshots become changed-field evidence without discarding creation facts.
WITH deltas AS (
 SELECT id,
 (SELECT jsonb_object_agg(k,before_value->k) FROM jsonb_object_keys(coalesce(before_value,'{}')||coalesce(after_value,'{}')) k WHERE k<>'revision' AND before_value->k IS DISTINCT FROM after_value->k) b,
 (SELECT jsonb_object_agg(k,after_value->k) FROM jsonb_object_keys(coalesce(before_value,'{}')||coalesce(after_value,'{}')) k WHERE k<>'revision' AND before_value->k IS DISTINCT FROM after_value->k) a
 FROM audit_event WHERE jsonb_typeof(before_value)='object' AND jsonb_typeof(after_value)='object'
) UPDATE audit_event a SET before_value=d.b,after_value=d.a FROM deltas d WHERE a.id=d.id;
-- Receipt subject identities now name the one physical audit subtype.
UPDATE audit_event SET result=jsonb_set(result,'{receipt,subjects}',coalesce((SELECT jsonb_agg(CASE WHEN item->>'kind'='operation' THEN jsonb_set(item,'{kind}','"audit_event"') ELSE item END) FROM jsonb_array_elements(result->'receipt'->'subjects') item),'[]'::jsonb)) WHERE jsonb_typeof(result->'receipt'->'subjects')='array';

ALTER TABLE record DISABLE TRIGGER immutable_record;
UPDATE record SET kind='audit_event' WHERE kind='operation';
ALTER TABLE record ENABLE TRIGGER immutable_record;
INSERT INTO record(id,kind,tenant_id) SELECT id,'audit_event',tenant_id FROM audit_event ON CONFLICT(id) DO NOTHING;

--> statement-breakpoint
DROP TABLE "event" CASCADE;
--> statement-breakpoint
DROP TABLE "identity_operation_result" CASCADE;
--> statement-breakpoint
DROP TABLE "onboarding_result" CASCADE;
--> statement-breakpoint
DROP TABLE "operation" CASCADE;
--> statement-breakpoint
DROP TABLE "organization_operation_result" CASCADE;
--> statement-breakpoint
DROP TABLE "people_history" CASCADE;
--> statement-breakpoint
DROP TABLE "people_result" CASCADE;
--> statement-breakpoint
DROP TABLE "relationship_history" CASCADE;
--> statement-breakpoint
DROP TABLE "settings_result" CASCADE;
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_owner" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor" FOREIGN KEY ("actor_id") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_subject_history" ON "audit_event" USING btree ("tenant_id","subject_id","occurred_at","id");
--> statement-breakpoint
CREATE INDEX "audit_command" ON "audit_event" USING btree ("command_id");
--> statement-breakpoint
ALTER TABLE "affiliation" ADD CONSTRAINT "affiliation_fk_5" FOREIGN KEY ("recognition_operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "assessment_contributor" ADD CONSTRAINT "assessment_contributor_fk_3" FOREIGN KEY ("recognition_operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "conversation_entry" ADD CONSTRAINT "conversation_entry_fk_4" FOREIGN KEY ("operation_id","tenant_id") REFERENCES "audit_event"("id","tenant_id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "digest_coverage" ADD CONSTRAINT "digest_coverage_fk_3" FOREIGN KEY ("last_operation_id","tenant_id") REFERENCES "audit_event"("id","tenant_id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "discovery" ADD CONSTRAINT "discovery_fk_2" FOREIGN KEY ("conversion_operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "effect" ADD CONSTRAINT "effect_fk_1" FOREIGN KEY ("operation_id","tenant_id") REFERENCES "audit_event"("id","tenant_id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_fk_1" FOREIGN KEY ("event_id","tenant_id") REFERENCES "audit_event"("id","tenant_id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "evidence_link" ADD CONSTRAINT "evidence_link_fk_3" FOREIGN KEY ("source_operation_id","tenant_id") REFERENCES "audit_event"("id","tenant_id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "generated_document" ADD CONSTRAINT "generated_document_fk_3" FOREIGN KEY ("generation_operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_fk_3" FOREIGN KEY ("operation_id","tenant_id") REFERENCES "audit_event"("id","tenant_id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "onboarding_setup" ADD CONSTRAINT "onboarding_setup_creation_operation_id_audit_event_id_fk" FOREIGN KEY ("creation_operation_id") REFERENCES "audit_event"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "person_merge" ADD CONSTRAINT "person_merge_fk_3" FOREIGN KEY ("operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "person_merge" ADD CONSTRAINT "person_merge_fk_4" FOREIGN KEY ("reversed_operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "phase_transition" ADD CONSTRAINT "phase_transition_fk_1" FOREIGN KEY ("operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "suppression" ADD CONSTRAINT "suppression_fk_1" FOREIGN KEY ("clear_operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_fk_12" FOREIGN KEY ("import_operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "training_assignment" ADD CONSTRAINT "training_assignment_fk_4" FOREIGN KEY ("selection_operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "wiki_preference" ADD CONSTRAINT "wiki_preference_fk_2" FOREIGN KEY ("recognition_operation_id") REFERENCES "audit_event"("id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_ck_0" CHECK ((kind = ANY (ARRAY['account'::text, 'affiliation'::text, 'article_editor_state'::text, 'article_revision'::text, 'assessment'::text, 'assessment_contributor'::text, 'assessment_fact'::text, 'assignment_feedback'::text, 'attestation'::text, 'commitment'::text, 'communication'::text, 'communication_recipient'::text, 'contact_outcome'::text, 'conversation'::text, 'conversation_entry'::text, 'development_enrollment'::text, 'development_milestone'::text, 'development_program'::text, 'development_program_version'::text, 'development_reading'::text, 'development_stage'::text, 'digest_coverage'::text, 'discovery'::text, 'document'::text, 'document_revision'::text, 'effect'::text, 'enrollment_milestone'::text, 'enrollment_plan'::text, 'feedback'::text, 'feedback_publication'::text, 'file_object'::text, 'finding'::text, 'four_cs'::text, 'generated_document'::text, 'household'::text, 'interview'::text, 'invitation'::text, 'job'::text, 'launch_debrief'::text, 'launch_guest'::text, 'launch_milestone'::text, 'leadership_conversation'::text, 'lifecycle_witness'::text, 'mail'::text, 'mail_attempt'::text, 'mail_request'::text, 'meeting'::text, 'meeting_evaluation'::text, 'meeting_item'::text, 'message_template'::text, 'notice'::text, 'notification_preference'::text, 'obligation'::text, 'audit_event'::text, 'organization'::text, 'organization_person_removal'::text, 'participation'::text, 'passage'::text, 'person'::text, 'person_merge'::text, 'person_note'::text, 'person_skill'::text, 'phase_transition'::text, 'pipeline_person'::text, 'pipeline_sharing'::text, 'pipeline_stage'::text, 'pipeline_stage_move'::text, 'plant'::text, 'plant_geography'::text, 'platform_grant'::text, 'prompt_dismissal'::text, 'provider_event'::text, 'reader_feedback'::text, 'reading'::text, 'recurrence'::text, 'reference_activation'::text, 'reference_item'::text, 'reference_release'::text, 'reference_version'::text, 'residency_link'::text, 'responsibility'::text, 'review'::text, 'seat'::text, 'sending_goal'::text, 'suppression'::text, 'tag'::text, 'task'::text, 'team'::text, 'team_role'::text, 'team_tenure'::text, 'training_assignment'::text, 'training_credit'::text, 'training_program'::text, 'training_requirement'::text, 'training_version'::text, 'venue'::text, 'wiki_preference'::text])));
--> statement-breakpoint
DROP FUNCTION operation_bind_record();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION purge_organization_person_history(org uuid, subject uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
BEGIN
 PERFORM 1 FROM organization_person_removal w JOIN person p ON p.id=w.person_record_id AND p.organization_id=w.organization_id
 WHERE w.organization_id=org AND w.person_record_id=subject AND p.state='retired' FOR SHARE OF w,p;
 IF NOT FOUND THEN RAISE EXCEPTION 'removal_witness_required' USING ERRCODE='23514'; END IF;
 UPDATE audit_event SET before_value=NULL,after_value=NULL,reason=NULL,actor_token=coalesce(actor_token,encode(sha256(convert_to(tenant_id::text||'/'||actor_id::text,'UTF8')),'hex')),actor_id=NULL,result=NULL,request_identity=NULL WHERE tenant_id=org AND subject_id=subject;
END $function$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION scrub_people_account_author(subject uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
BEGIN
 PERFORM 1 FROM lifecycle_witness WHERE account_id=subject AND state IN ('purging','purged') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account_purge_witness_required' USING ERRCODE='23514'; END IF;
 UPDATE person_note SET author_id=NULL WHERE author_id=subject;
 UPDATE audit_event SET actor_token=coalesce(actor_token,encode(sha256(convert_to(tenant_id::text||'/'||subject::text,'UTF8')),'hex')),actor_id=NULL WHERE actor_id=subject;
 UPDATE audit_event SET before_value=before_value-'linked_account_id' WHERE before_value->>'linked_account_id'=subject::text;
 UPDATE audit_event SET after_value=after_value-'linked_account_id' WHERE after_value->>'linked_account_id'=subject::text;
END $function$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION settings_purge_content(witness uuid, request uuid, expected bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE w lifecycle_witness%ROWTYPE; s uuid; n bigint; removed bigint; pass integer; copied uuid[];
BEGIN
 SELECT * INTO w FROM lifecycle_witness WHERE id=witness AND request_id=request AND request_revision=expected AND state='purging' AND cancel_until<=clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 s=w.opaque_subject_id;
 UPDATE audit_event SET actor_token=coalesce(actor_token,encode(sha256(convert_to(tenant_id::text||'/'||s::text,'UTF8')),'hex')),actor_id=NULL,request_identity=NULL,result=CASE WHEN id IN (SELECT creation_operation_id FROM onboarding_setup WHERE account_id=s AND plant_id<>s) THEN result ELSE NULL END WHERE actor_id=s AND w.kind='account';
 UPDATE audit_event a SET result=jsonb_build_object('plant',a.result->'plant','creation',a.result->'creation'),request_identity=NULL,request_key=NULL,before_value=NULL,after_value=NULL,metadata='{}' WHERE a.id IN (SELECT creation_operation_id FROM onboarding_setup WHERE account_id=s AND plant_id<>s);
 UPDATE provider_event SET mail_id=NULL WHERE mail_id IN (SELECT id FROM mail WHERE tenant_id=s);
 DELETE FROM feedback_publication WHERE state IN ('pending','held','rejected') AND feedback_id IN (SELECT id FROM feedback WHERE (account_id=s AND w.kind='account') OR (plant_context_id=s AND w.kind='plant'));
 UPDATE feedback_publication SET feedback_id=NULL,account_id=NULL,category=NULL,public_area=NULL,sanitized_title=NULL,sanitized_body=NULL,state=CASE WHEN state='publishing' THEN 'unknown' ELSE state END WHERE feedback_id IN (SELECT id FROM feedback WHERE (account_id=s AND w.kind='account') OR (plant_context_id=s AND w.kind='plant'));
 UPDATE mail SET notice_id=NULL WHERE notice_id IN (SELECT id FROM notice WHERE tenant_id=s OR (recipient_id=s AND w.kind='account'));
 SELECT array_agg(assessment_id) INTO copied FROM assessment_contributor WHERE plant_id=s AND w.kind='plant';
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
 UPDATE "assignment_feedback" SET "author_id"=NULL WHERE "author_id"=s;
 UPDATE "communication" SET "author_id"=NULL WHERE "author_id"=s;
 UPDATE "enrollment_milestone" SET "completed_by"=NULL WHERE "completed_by"=s;
 UPDATE "enrollment_milestone" SET "confirmed_by"=NULL WHERE "confirmed_by"=s;
 UPDATE "enrollment_plan" SET "adopted_by"=NULL WHERE "adopted_by"=s;
 UPDATE "leadership_conversation" SET "staff_account_id"=NULL WHERE "staff_account_id"=s;
 UPDATE "meeting" SET "creator_id"=NULL WHERE "creator_id"=s;
 UPDATE "obligation" SET "assignee_id"=NULL WHERE "assignee_id"=s;
 UPDATE "organization_person_removal" SET "requested_by"=NULL WHERE "requested_by"=s;
 UPDATE "participation" SET "card_author_id"=NULL WHERE "card_author_id"=s;
 UPDATE "person" SET "linked_account_id"=NULL WHERE "linked_account_id"=s;
 UPDATE "person_note" SET "author_id"=NULL WHERE "author_id"=s;
 UPDATE "pipeline_sharing" SET "changed_by"=NULL WHERE "changed_by"=s;
 UPDATE "pipeline_stage_move" SET "actor_id"=NULL WHERE "actor_id"=s;
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
 FOR pass IN 1..93 LOOP
  removed=0;
  BEGIN
   DELETE FROM "affiliation" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "article_link" WHERE revision_id IN (SELECT id FROM article_revision WHERE tenant_id=s);
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "article_revision" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "assessment" WHERE tenant_id=s OR (w.kind='plant' AND id=ANY(copied));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "assessment_contributor" WHERE (w.kind='plant' AND (plant_id=s)) OR (w.kind='plant' AND assessment_id=ANY(copied));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "assessment_fact" WHERE tenant_id=s OR (w.kind='plant' AND assessment_id=ANY(copied));
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
   DELETE FROM "communication" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "communication_recipient" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "contact_outcome" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "conversation" WHERE tenant_id=s OR (w.kind='account' AND (owner_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "conversation_entry" WHERE tenant_id=s OR (w.kind='account' AND conversation_id IN (SELECT id FROM conversation WHERE owner_id=s));
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
   DELETE FROM "effect" WHERE tenant_id=s OR (w.kind='account' AND review_id IN (SELECT id FROM review WHERE conversation_id IN (SELECT id FROM conversation WHERE owner_id=s)));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "effect_dependency" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "evidence_link" WHERE tenant_id=s;
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "feedback" WHERE (w.kind='plant' AND (plant_context_id=s)) OR (w.kind='account' AND (account_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "finding" WHERE tenant_id=s OR (w.kind='plant' AND assessment_id=ANY(copied));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "four_cs" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "generated_document" WHERE tenant_id=s;
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
   DELETE FROM "launch_debrief" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "launch_guest" WHERE (w.kind='plant' AND (plant_id=s));
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
   DELETE FROM "meeting_evaluation" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "meeting_item" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "message_template" WHERE (w.kind='plant' AND (plant_id=s));
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
   DELETE FROM "person_merge" WHERE tenant_id=s OR (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "person_note" WHERE tenant_id=s OR (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "person_skill" WHERE (w.kind='plant' AND (plant_id=s));
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
   DELETE FROM "private_calendar" WHERE (w.kind='account' AND (account_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "private_week" WHERE (w.kind='plant' AND (plant_id=s)) OR (w.kind='account' AND (author_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "private_week_revision" WHERE (w.kind='plant' AND (plant_id=s)) OR (w.kind='account' AND (author_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "prompt_dismissal" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "reader_feedback" WHERE (w.kind='plant' AND (plant_context_id=s)) OR (w.kind='account' AND (account_id=s)) OR (w.kind='plant' AND assessment_id=ANY(copied));
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
   DELETE FROM "review" WHERE tenant_id=s OR (w.kind='account' AND conversation_id IN (SELECT id FROM conversation WHERE owner_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "rsvp_proof" WHERE (w.kind='plant' AND (plant_id=s));
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
   DELETE FROM "task_dependency" WHERE (w.kind='plant' AND (plant_id=s));
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
   DELETE FROM "training_assignment" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "training_credit" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "training_program" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "training_requirement" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "training_version" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "venue" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  BEGIN
   DELETE FROM "wiki_preference" WHERE (w.kind='plant' AND (plant_id=s));
   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;
  EXIT WHEN removed=0;
 END LOOP;
 DELETE FROM audit_event WHERE tenant_id=s AND id NOT IN (SELECT creation_operation_id FROM onboarding_setup WHERE plant_id<>s) AND (command_id IS NULL OR command_id NOT IN (SELECT creation_operation_id FROM onboarding_setup WHERE plant_id<>s));
 IF EXISTS(SELECT FROM "affiliation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:affiliation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "article_link" WHERE revision_id IN (SELECT id FROM article_revision WHERE tenant_id=s)) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:article_link' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "article_revision" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:article_revision' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "assessment" WHERE tenant_id=s OR (w.kind='plant' AND id=ANY(copied))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:assessment' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "assessment_contributor" WHERE (w.kind='plant' AND (plant_id=s)) OR (w.kind='plant' AND assessment_id=ANY(copied))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:assessment_contributor' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "assessment_fact" WHERE tenant_id=s OR (w.kind='plant' AND assessment_id=ANY(copied))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:assessment_fact' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "attestation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:attestation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "commitment" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:commitment' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "communication" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:communication' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "communication_recipient" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:communication_recipient' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "contact_outcome" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:contact_outcome' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "conversation" WHERE tenant_id=s OR (w.kind='account' AND (owner_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:conversation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "conversation_entry" WHERE tenant_id=s OR (w.kind='account' AND conversation_id IN (SELECT id FROM conversation WHERE owner_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:conversation_entry' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "digest_coverage" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:digest_coverage' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "discovery" WHERE (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:discovery' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "document" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:document' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "document_revision" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:document_revision' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "effect" WHERE tenant_id=s OR (w.kind='account' AND review_id IN (SELECT id FROM review WHERE conversation_id IN (SELECT id FROM conversation WHERE owner_id=s)))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:effect' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "effect_dependency" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:effect_dependency' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "evidence_link" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:evidence_link' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "feedback" WHERE (w.kind='plant' AND (plant_context_id=s)) OR (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:feedback' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "finding" WHERE tenant_id=s OR (w.kind='plant' AND assessment_id=ANY(copied))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:finding' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "four_cs" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:four_cs' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "generated_document" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:generated_document' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "household" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:household' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "identity_proof" WHERE (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:identity_proof' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "interview" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:interview' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "invitation" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:invitation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "job" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:job' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "launch" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:launch' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "launch_debrief" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:launch_debrief' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "launch_guest" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:launch_guest' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "launch_milestone" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:launch_milestone' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "mail" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:mail' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "mail_attempt" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:mail_attempt' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "mail_request" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:mail_request' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "mail_request_member" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:mail_request_member' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "meeting" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:meeting' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "meeting_evaluation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:meeting_evaluation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "meeting_item" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:meeting_item' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "message_template" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:message_template' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "notice" WHERE tenant_id=s OR (w.kind='account' AND (recipient_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:notice' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "notification_preference" WHERE (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:notification_preference' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "obligation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:obligation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "onboarding_setup" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:onboarding_setup' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "participation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:participation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "passage" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:passage' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "people_column" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:people_column' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "person" WHERE tenant_id=s OR (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:person' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "person_merge" WHERE tenant_id=s OR (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:person_merge' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "person_note" WHERE tenant_id=s OR (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:person_note' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "person_skill" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:person_skill' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "person_tag" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:person_tag' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "phase_transition" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:phase_transition' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "plant_geography" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:plant_geography' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "platform_grant" WHERE (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:platform_grant' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "private_calendar" WHERE (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:private_calendar' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "private_week" WHERE (w.kind='plant' AND (plant_id=s)) OR (w.kind='account' AND (author_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:private_week' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "private_week_revision" WHERE (w.kind='plant' AND (plant_id=s)) OR (w.kind='account' AND (author_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:private_week_revision' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "prompt_dismissal" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:prompt_dismissal' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "reader_feedback" WHERE (w.kind='plant' AND (plant_context_id=s)) OR (w.kind='account' AND (account_id=s)) OR (w.kind='plant' AND assessment_id=ANY(copied))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:reader_feedback' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "reading" WHERE (w.kind='plant' AND (plant_context_id=s)) OR (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:reading' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "recurrence" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:recurrence' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "reference_item" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:reference_item' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "reference_release" WHERE tenant_id=s) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:reference_release' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "relationship_invitation" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:relationship_invitation' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "responsibility" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:responsibility' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "review" WHERE tenant_id=s OR (w.kind='account' AND conversation_id IN (SELECT id FROM conversation WHERE owner_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:review' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "rsvp_proof" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:rsvp_proof' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "seat" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:seat' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "settings_preview" WHERE tenant_id=s OR (w.kind='account' AND (account_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:settings_preview' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "tag" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:tag' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "task" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:task' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "task_dependency" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:task_dependency' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "team" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:team' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "team_role" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:team_role' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "team_tenure" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:team_tenure' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "training_assignment" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:training_assignment' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "training_credit" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:training_credit' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "training_program" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:training_program' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "training_requirement" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:training_requirement' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "training_version" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:training_version' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "venue" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:venue' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT FROM "wiki_preference" WHERE (w.kind='plant' AND (plant_id=s))) THEN RAISE EXCEPTION 'incomplete_owned_cleanup:wiki_preference' USING ERRCODE='23514'; END IF;
 IF w.kind='plant' THEN
  UPDATE plant SET name='Removed workspace',street=NULL,description=NULL,city=NULL,state_province=NULL,country=NULL WHERE id=s;
 END IF;
 UPDATE mail SET recipient_address_encrypted=NULL,frozen_payload=NULL,address_hash=NULL,recipient_account_id=NULL,state=CASE WHEN state IN ('pending','dispatched') THEN 'cancelled' ELSE state END WHERE recipient_account_id=s AND w.kind='account';
END $function$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_event_bind_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE actual_owner uuid;
BEGIN
  actual_owner := NEW.tenant_id;
  
  IF TG_OP='UPDATE' AND NEW.id <> OLD.id THEN RAISE EXCEPTION 'immutable_record_id' USING ERRCODE='23514'; END IF;
  INSERT INTO record(id,kind,tenant_id) VALUES (NEW.id,'audit_event',actual_owner) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM record WHERE id=NEW.id AND kind='audit_event' AND tenant_id=actual_owner FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_subtype_owner_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $function$;

--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assert_record_binding AFTER INSERT OR UPDATE ON audit_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_record_binding('"tenant_id"');
--> statement-breakpoint
CREATE TRIGGER bind_record AFTER INSERT OR UPDATE ON audit_event FOR EACH ROW EXECUTE FUNCTION audit_event_bind_record();
--> statement-breakpoint
GRANT SELECT,INSERT ON audit_event TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON audit_event TO everyfield_cleanup;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_event_bind_record() FROM PUBLIC;

--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_public_subject" FOREIGN KEY ("subject_id") REFERENCES "record"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('access.checkOperation','access.currentActor','access.projectRead','account.cancelDeletion','account.changePassword','account.confirmEmailChange','account.deletion_requested','account.finalizeAvatar','account.getAvatar','account.getDeletionStatus','account.previewPersonalTimezoneChange','account.removeAvatar','account.requestAvatarUpload','account.requestDeletion','account.requestEmailChange','account.setPersonalTimezone','accounts.getRegistrationOptions','accounts.getRegistrationStatus','accounts.register','accounts.resumeRegistration','affiliation.approved','affiliation.ended','associations.acceptInvitation','associations.declineInvitation','associations.end','associations.getHistory','associations.invite','associations.resendInvitation','associations.respondInvitation','associations.revokeInvitation','attestation.corrected','attestation.recorded','auth.classifyPublicPreview','auth.getSession','auth.recoverInvalidSession','auth.recoverPassword','auth.requestPasswordRecovery','auth.revokeOtherSessions','auth.signIn','auth.signOut','calendar.getContext','calendar.resolve','church.digestSchedule.set','churches.cancelWorkspaceDeletion','churches.getDeletionStatus','churches.requestWorkspaceDeletion','communication.approved','communication.cancelScheduledReviewed','communication.correctContactLog','communication.deleteDraft','communication.deliveryTotals','communication.dispatchAttempt','communication.executeResend','communication.forMeeting','communication.forPerson','communication.get','communication.getDraft','communication.getExecutionResult','communication.list','communication.listAudienceTeams','communication.listDrafts','communication.listRecipients','communication.meetingRecipientTracking','communication.preview','communication.reconcileProviderOutcome','communication.recordContactFromTask','communication.replaceScheduledReviewed','communication.rescheduleReviewed','communication.resendCandidates','communication.resolveAudience','communication.resolveMergeFields','communication.retryProvenFailed','communication.saveDraft','communication.scheduleReviewed','communication.searchRecipients','communication.sendReviewed','communication.send_intended','communication.templates.archiveOrDelete','communication.templates.create','communication.templates.forMeeting','communication.templates.fork','communication.templates.get','communication.templates.list','communication.templates.update','dashboard.activity','dashboard.availableActions','dashboard.metrics','dashboard.promptState','dashboard.readSetupGaps','dashboard.resolveHome','deletion.cancelled','deletion.live_purge_completed','dev.cleanupPreview','dev.createIsolatedPreview','dev.inspectPreviewProvenance','dev.switchFixtureIdentity','development.applyVersion','development.completeMilestone','development.confirmMilestone','development.draftPlan','development.enroll','development.publishVersion','development.readFeedback','development.readProgram','development.recordFeedback','development.recordUnlinkedCompletion','development.saveProgram','development.updateEnrollment','discovery.convertToPlant','discovery.create','discovery.getProfile','documents.archive','documents.copied','documents.designateCoreValues','documents.download','documents.generate','documents.getAuthorized','documents.history.get','documents.history.list','documents.importTextOrWord','documents.listOwned','documents.preview','documents.purgeOwnedForDeletion','documents.read','documents.readCoreValuesEvidence','documents.reconcileOrphans','documents.resolveContext','documents.saveNative','documents.saved','documents.templates.contextual','documents.templates.get','documents.templates.list','documents.useForChurch','domain.executeAtomicConsequences','emailSuppression.requestRestore','engineering.auditProofCoverage','engineering.installChosenHooks','engineering.inventoryTools','engineering.trackWork','engineering.validateRequirements','events.appendRequiredOutbox','events.deliverIdempotentConsumer','evry.appendAudit','evry.approveProposal','evry.askClarification','evry.bindAttachment','evry.cancelProposal','evry.cancelTurn','evry.claimEffect','evry.classifyRequest','evry.cleanupAttachments','evry.collectHistory','evry.compileContext','evry.composeReads','evry.createConversation','evry.executeProposal','evry.expireProposal','evry.invokeRead','evry.listConversations','evry.observeRun','evry.openConversation','evry.prepareMeetingInvitation','evry.prepareProposal','evry.projectArtifact','evry.projectError','evry.readCatalog','evry.readConversation','evry.readDraft','evry.readReview','evry.readUsage','evry.readWorkflowHint','evry.recordEffectResult','evry.resolveReferences','evry.resumeRun','evry.retryTurn','evry.retryUnresolvedEffects','evry.reuseRecipe','evry.reviseProposal','evry.runEvaluation','evry.selectQualifiedModel','evry.selectReturnedRows','evry.stageAttachment','evry.submitTurn','evry.updateDraft','execution.cancelled','execution.completed','execution.partial','execution.reconciled','execution.started','feedback.admin.changeStatus','feedback.admin.list','feedback.createConfiguredIssue','feedback.getOwnStatus','feedback.listOwn','feedback.notifyOperator','feedback.publication_intended','feedback.published','feedback.received','feedback.reconcileIssueLink','feedback.reconciled','feedback.submit','feedback.triageIssue','files.finalized','fixtures.resetOwnedEnvironment','fixtures.seedOwnedEnvironment','followup.corrected','followup.recorded','followups.correctOutcome','followups.listContactHistory','followups.readObligations','followups.recordOutcome','geography.listReportingRegionCandidates','identity.answerLeadOnboarding','identity.credential_changed','identity.credential_observed','identity.credential_reconciled','identity.domain_accepted','identity.email_changed','identity.ensureOwnerPerson','identity.sessions_revoked','intelligence.appendAssessmentConsequences','intelligence.buildFactSnapshot','intelligence.callProvider','intelligence.computeSnapshotDelta','intelligence.deriveLensEvidence','intelligence.describeRunFailure','intelligence.evaluateAssessment','intelligence.executeDemand','intelligence.feedback_recorded','intelligence.formatCitedFact','intelligence.markAssessmentSeen','intelligence.publishAssessment','intelligence.published','intelligence.readAssessment','intelligence.readAssessmentDelta','intelligence.readAssessmentHistory','intelligence.readAssessmentRun','intelligence.readColdStartGuidance','intelligence.readCommittedAdultCohort','intelligence.readCriterionEvidence','intelligence.readExitCriteria','intelligence.readFacts','intelligence.readFocus','intelligence.readJourney','intelligence.readOwnFeedback','intelligence.readRubric','intelligence.readScorecard','intelligence.recordAttemptTelemetry','intelligence.releaseAssessmentToOversight','intelligence.requestOperatorRefresh','intelligence.requestRefresh','intelligence.requested','intelligence.resolveCitation','intelligence.retrieveMethodology','intelligence.runAssessmentBatch','intelligence.runEvaluation','intelligence.scheduleAssessment','intelligence.selectAssessmentCandidates','intelligence.settleRun','intelligence.submitFeedback','intelligence.superseded','intelligence.validateConcernPairing','intelligence.validateDraft','invitation.claimed','invitation.revoked','invitations.describeRegistrationContext','jobs.inspectLag','jobs.manualRun','jobs.tickAssessments','jobs.tickNotifications','launch.addGuestAttendance','launch.changed','launch.completeMilestone','launch.correctDebrief','launch.correctGuestAttendance','launch.correctOutcome','launch.corrected','launch.debrief_submitted','launch.ensureReadiness','launch.move','launch.outcome_recorded','launch.postpone','launch.publishDebriefSummary','launch.readCountdown','launch.readDebrief','launch.readJournal','launch.readMilestoneHistory','launch.readWorkspace','launch.recordActualOccurrence','launch.recordOutcome','launch.reopenMilestone','launch.saveDebriefDraft','launch.saveDebriefSummaryDraft','launch.schedule','launch.submitDebrief','launch.summary_published','mail.acceptWebhook','mail.accepted','mail.cancelled','mail.delivered','mail.processDeliveryEvent','mail.reconcileDeliveryState','mail.reconciled','mail.refused','mail.renderTransactional','mail.sendTransactional','mail.suppression.listForSelf','mail.suppression.recordProviderFact','mail.suppression.restoreReviewed','maintenance.purgeEligibleSubject','maintenance.restoreWithCurrentManifest','marketing.expireAccessRequests','marketing.exportAccessRequests','marketing.privacyPolicy','marketing.readProductExamples','marketing.requestInvitation','marketing.sitemap','marketing.terms','meeting.answerRsvpToken','meeting.createRsvpToken','meeting.describeRsvpToken','meeting.rsvpStatus','meetings.addAttendeeNote','meetings.attendanceSummary','meetings.attendanceTrend','meetings.captureAttendanceBatch','meetings.cardBreakdown','meetings.changeStatus','meetings.changed','meetings.checkIn','meetings.clearAttendance','meetings.clearCard','meetings.communicationContext','meetings.compareEvaluation','meetings.completePractice','meetings.copyTeamRoster','meetings.correctEvaluation','meetings.correctOccurrence','meetings.correctPracticeOccurrence','meetings.correctRsvp','meetings.corrected','meetings.createGuestContact','meetings.createWalkInContact','meetings.delete','meetings.edit','meetings.evaluationHistory','meetings.evaluationTrend','meetings.finalizeAttendance','meetings.finalized','meetings.get','meetings.getEvaluation','meetings.getOwnRsvp','meetings.hasHistory','meetings.invitationAttribution','meetings.inviteGuest','meetings.linkedTaskProgress','meetings.list','meetings.listAttendance','meetings.listCards','meetings.listCompletedPreLaunchPractices','meetings.listGuests','meetings.listKit','meetings.planNotifications','meetings.populateKit','meetings.previewRosterImport','meetings.readAgenda','meetings.readAnalytics','meetings.readTokenRsvp','meetings.reconcileAttendance','meetings.reconcileInvitationResponse','meetings.recordCard','meetings.recordEvaluation','meetings.removeGuest','meetings.replaceAgenda','meetings.resolveTokenRsvp','meetings.response_recorded','meetings.rsvp_recorded','meetings.saveOwnRsvp','meetings.schedule','meetings.setAttendance','meetings.setInviter','meetings.summaryStats','meetings.syncNotifications','meetings.updateKitItem','membership.created','membership.ended','membership.role_changed','note_correction','notifications.applyEmailOptOut','notifications.cancelForEntity','notifications.cancelTaskReminders','notifications.claimDue','notifications.describeEmailOptOut','notifications.digestCadence.set','notifications.dispatchBatch','notifications.emitLaunchMilestone','notifications.emitPhaseMilestone','notifications.emitRelationshipMilestone','notifications.emitSharingMilestone','notifications.emitWikiUpstreamReview','notifications.enqueue','notifications.feed','notifications.generateOwedOversightDigests','notifications.generateOwedPlanterDigests','notifications.inspectAssociationReceipt','notifications.markAllVisibleRead','notifications.markRead','notifications.markSelectedRead','notifications.meetingAudience','notifications.oversightDigestCadence.set','notifications.preferences.get','notifications.preferences.set','notifications.previewOversightDigest','notifications.previewPlanterDigest','notifications.reconcileUnknownOutcome','notifications.recoverLease','notifications.retryAssociationReceipt','notifications.sendDiscoveryAssociationReceipt','notifications.setPreferences','notifications.syncMeetingReminders','notifications.syncTaskReminders','notifications.undoEmailOptOut','notifications.unreadCount','onboarding.complete','onboarding.createPlant','onboarding.declareJourney','onboarding.getResume','ops.applyVersionedMigration','ops.errorCorrelation','ops.flushTelemetry','ops.inspectLegacyEvidence','ops.inspectMigrationProvenance','ops.liveness','ops.readiness','ops.reportError','ops.schemaValidate','ops.traceModelAttempt','ops.traceOperation','orgPeople.addNote','orgPeople.create','orgPeople.export','orgPeople.findDuplicates','orgPeople.merge','orgPeople.read','orgPeople.readNotes','orgPeople.remove','orgPeople.removeNote','orgPeople.restore','orgPeople.retire','orgPeople.unmerge','orgPeople.update','orgPeople.updateNote','organization.profile_changed','organizationIntelligence.read','organizationIntelligence.readHistory','organizationIntelligence.readLocationHistory','organizationIntelligence.readLocations','organizationIntelligence.requestRefresh','organizationIntelligence.submitFeedback','organizationLaunchSummary.readPublished','organizations.correctReportingLocation','organizations.getProfile','organizations.updateProfile','oversight.getHealth','oversight.getPlant','oversight.getSendingChurch','oversight.listPlants','oversight.listSendingChurches','oversight.readLaunchReadiness','people.addNote','people.addSkill','people.addToHousehold','people.applyRecordedRecruitmentEvent','people.assignTag','people.changeStatus','people.checkForDuplicates','people.correctAdultClassification','people.correctCommitmentLifecycle','people.correctPersonRecord','people.corrected','people.createAssessment','people.createCommitment','people.createHouseholdWithHead','people.createInterview','people.createPerson','people.createTag','people.created','people.deleteHousehold','people.deleteNote','people.deletePerson','people.deleteTag','people.editNote','people.ensureAccountPerson','people.executeBulkImport','people.exportPeople','people.generateCsvTemplate','people.getAccountLink','people.getActivities','people.getAssessments','people.getCommitmentDownload','people.getCommitments','people.getHousehold','people.getHouseholdMembers','people.getImportReceipt','people.getInterviews','people.getMergeReview','people.getOwnAccountPerson','people.getPerson','people.getPersonCommunications','people.getPersonPhoto','people.getPersonSkills','people.getPersonTags','people.getPersonTeams','people.getPersonTraining','people.getPipelineData','people.getStatusWarnings','people.listDuplicatePairs','people.listHouseholds','people.listPeople','people.listRecordCorrections','people.listTags','people.mergePeople','people.merged','people.mergedPersonDestination','people.previewImport','people.previewUnmerge','people.propagateAddress','people.reactivateCommitment','people.readPipelineMetrics','people.recordAdultClassification','people.recorded','people.removeFromHousehold','people.removePersonPhoto','people.removeSkill','people.removeTag','people.reorderPipeline','people.restorePerson','people.restored','people.retired','people.setHouseholdRole','people.setPersonPhoto','people.stage_changed','people.unmergePeople','people.unmerged','people.updateHousehold','people.updatePerson','people.updateSkill','people.updateTag','people.updated','people.withdrawCommitment','phase.created','phase.declared','phase.transitioned','phases.appendConsequences','phases.classifyChange','phases.declare','phases.readCatalog','phases.readHistory','phases.readReadiness','phases.transition','pipeline.listPeople','pipeline.logConversation','pipeline.moveStage','pipeline.proposeStageMove','pipeline.readConversationCounts','pipeline.readConversationNote','pipeline.readGoals','pipeline.recordAssessmentOccurrence','pipeline.saveGoal','pipeline.saveStages','pipelineAccess.readPerson','pipelineSharing.checkAggregateAccess','pipelineSharing.readConsent','pipelineSharing.setConsent','plant.created','plant.deletion_requested','plant.previewTimezoneChange','plant.profile_changed','plant.setDigestSchedule','plant.setTimezone','plant.updateProfile','platformAdmin.authorize','privacy.getSharing','privacy.setSharing','qa.hermeticBuild','qa.verifyContracts','qa.verifyNativeTransactions','qa.verifyVerticalSlices','recovery.copy_expired','recovery.restored','reference.activateGeneration','reference.activated','reference.auditLanguage','reference.bootstrapApprovedBundle','reference.embedQuery','reference.exportApprovedWiki','reference.installApprovedWiki','reference.installMessageTemplates','reference.invalidateWikiCache','reference.packageDocumentTemplates','reference.packagePlaybook','reference.packageTaskTemplates','reference.packageTeamTemplates','reference.readRubricManifest','reference.rebuildEmbeddings','reference.rollbackActivation','reference.validateBundle','residency.invite','residency.leave','residency.readMine','residency.readProgress','residency.readSharing','residency.resolveReading','residency.respondInvitation','residency.setSharing','roles.changed','seats.acceptInvitation','seats.appointAdmin','seats.changeOrdinaryRole','seats.demote','seats.invite','seats.list','seats.listInvitations','seats.readCurrentMembership','seats.remove','seats.resendInvitation','seats.revokeInvitation','security.access_denied','security.audit_exported','security.audit_inspected','security.bulk_export','security.checkRequestOrigin','security.operator_accessed','security.safeReturn','settings.changed','settings.getSection','settings.saveSection','sharing.changed','signals.attest','signals.correct','signals.getHistory','signals.listDefinitions','signals.reaffirm','storage.createAuthorizedDownload','storage.deleteUnreferencedObject','storage.putPrivateObject','storage.readAuthorizedObject','tasks.acceptPhaseOffer','tasks.answerPhaseOffer','tasks.applyManagedStatus','tasks.assignFollowUp','tasks.bulkComplete','tasks.bulkReschedule','tasks.changeStatus','tasks.changed','tasks.complete','tasks.completeOccurrence','tasks.completed','tasks.configureRecurrence','tasks.count','tasks.create','tasks.createFollowUp','tasks.createSubtask','tasks.declinePhaseOffer','tasks.delete','tasks.edit','tasks.eligibleAssignees','tasks.ensureManagedTask','tasks.ensureMeetingObligations','tasks.ensureObligation','tasks.executeHandoff','tasks.findOpenOccurrence','tasks.followUpCoverage','tasks.get','tasks.importReceipt','tasks.importTemplate','tasks.list','tasks.listFollowUpOwners','tasks.listPrerequisites','tasks.listSubtasks','tasks.listTemplates','tasks.normalizeDescription','tasks.planHandoff','tasks.prerequisiteCandidates','tasks.previewDescription','tasks.previewTemplate','tasks.readPhaseOffer','tasks.relationOptions','tasks.removeSubtask','tasks.reopen','tasks.reopenObligation','tasks.replacePrerequisites','tasks.setSubtaskCompletion','tasks.settleManagedEvaluation','tasks.statusHistory','tasks.waive','tasks.waived','teams.addResponsibility','teams.aggregateHealth','teams.appointLeader','teams.archive','teams.assignMember','teams.assignRole','teams.assignmentEffects','teams.attestCompletion','teams.changed','teams.completeResponsibility','teams.correct','teams.correctProgram','teams.create','teams.createProgram','teams.createRole','teams.deleteResponsibility','teams.edit','teams.editResponsibility','teams.editRole','teams.endMembership','teams.exportOrgChart','teams.get','teams.health','teams.history','teams.importRoles','teams.initialize','teams.leaderCandidates','teams.leadershipEffects','teams.list','teams.listImportTemplates','teams.listMeetings','teams.listResponsibilities','teams.listRoles','teams.listTraining','teams.membershipHistory','teams.offerResponsibilities','teams.orgChart','teams.personAssignments','teams.personTeamCounts','teams.personTraining','teams.previewRequiredTrainingParticipants','teams.previewResponsibilities','teams.previewTemplateImport','teams.reactivateMembership','teams.readRequiredTrainingParticipants','teams.recompleteTraining','teams.removeRole','teams.restore','teams.retireRole','teams.revokeCompletion','teams.scheduleMeeting','teams.searchMembers','teams.setRequiredTrainingParticipants','teams.staffingFacts','teams.staffingSummary','teams.trainingHistory','teams.trainingMatrix','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','venues.archive','venues.correct','venues.create','venues.edit','venues.get','venues.history','venues.list','venues.restore','wiki.article.exportPdf','wiki.article.print','wiki.articleNeighbors','wiki.articles.get','wiki.articles.list','wiki.bookmarks.list','wiki.bookmarks.set','wiki.contextGuide','wiki.feedback.getMine','wiki.feedback.setMine','wiki.hidden','wiki.navigation','wiki.organizationArticles.add','wiki.organizationArticles.edit','wiki.organizationArticles.getDraft','wiki.organizationArticles.hide','wiki.organizationArticles.publish','wiki.publicPreviewMetadata','wiki.published','wiki.reading.recent','wiki.reading.recordView','wiki.reading.resume','wiki.reading.stats','wiki.reading.updateProgress','wiki.recommendForPhase','wiki.referenceExcerpt','wiki.renderGlobalPreview','wiki.search','wiki.setSourceOrder','wiki.source_order_changed','wiki.tableOfContents')));--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_kind" CHECK ((kind IN ('create','edit','correct','retire','restore','merge','unmerge','stage_change','classification_change','commitment_change','assign','remove','accept','revoke','resend','role_change','leader_change','tick','untick','archive','earn','revoke_credit','offer_answer','publish','hide','read','progress','complete','reopen','waive','supersede','finalize','reconcile','noop','triage','suppress','suppression_clear','preference','model_attempt','tool_attempt','effect_result','mail_member','outcome','declaration','movement')));--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_attribution" CHECK (num_nonnulls(actor_id,actor_token,system_cause)>=1);--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_projection" CHECK (jsonb_typeof(metadata)='object' AND (metadata->'diff' IS NULL OR (jsonb_typeof(metadata->'diff')='object' AND octet_length(convert_to((metadata->'diff')::text,'UTF8'))<=2048)));
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_command" FOREIGN KEY ("command_id") REFERENCES "audit_event"("id") ON DELETE set null ON UPDATE no action;
