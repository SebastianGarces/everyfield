CREATE FUNCTION audit_actor_token(tenant uuid, account uuid)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE STRICT PARALLEL SAFE
 SET search_path FROM CURRENT
AS $function$ SELECT encode(sha256(convert_to('["'||tenant::text||'","'||account::text||'"]','UTF8')),'hex') $function$;
REVOKE ALL ON FUNCTION audit_actor_token(uuid,uuid) FROM PUBLIC;
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
 UPDATE audit_event SET before_value=NULL,after_value=NULL,reason=NULL,actor_token=coalesce(audit_actor_token(tenant_id,actor_id),actor_token),actor_id=NULL,result=NULL,request_identity=NULL WHERE tenant_id=org AND subject_id=subject;
END $function$;
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
 UPDATE audit_event SET actor_token=audit_actor_token(tenant_id,subject),actor_id=NULL WHERE actor_id=subject;
 UPDATE audit_event SET before_value=before_value-'linked_account_id' WHERE before_value->>'linked_account_id'=subject::text;
 UPDATE audit_event SET after_value=after_value-'linked_account_id' WHERE after_value->>'linked_account_id'=subject::text;
END $function$;
DO $patch$
DECLARE def text; old text := 'actor_token=coalesce(actor_token,encode(sha256(convert_to(tenant_id::text||''/''||s::text,''UTF8'')),''hex''))';
BEGIN
 def := pg_get_functiondef('settings_purge_content(uuid,uuid,bigint)'::regprocedure);
 IF (length(def) - length(replace(def, old, ''))) / length(old) <> 1 THEN
  RAISE EXCEPTION 'settings_purge_content patch did not apply';
 END IF;
 EXECUTE replace(def, old, 'actor_token=audit_actor_token(tenant_id,s)');
END
$patch$;
UPDATE audit_event SET actor_token=audit_actor_token(tenant_id,actor_id)
 WHERE actor_id IS NOT NULL AND actor_token IS NOT NULL AND actor_token<>audit_actor_token(tenant_id,actor_id);
SET CONSTRAINTS ALL IMMEDIATE;
