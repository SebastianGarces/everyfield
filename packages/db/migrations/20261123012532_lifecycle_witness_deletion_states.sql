DELETE FROM identity_proof p USING lifecycle_witness w WHERE p.deletion_subject_id=w.id AND (w.state IN ('active','revoked') OR w.kind IN ('seat','affiliation'));
DELETE FROM lifecycle_witness WHERE state IN ('active','revoked') OR kind IN ('seat','affiliation');
DELETE FROM record r WHERE r.kind='lifecycle_witness' AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.id=r.id) AND NOT EXISTS(SELECT FROM audit_event a WHERE a.subject_id=r.id) AND NOT EXISTS(SELECT FROM job j WHERE j.subject_record_id=r.id) AND NOT EXISTS(SELECT FROM notice n WHERE n.source_record_id=r.id);
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_ck_10";
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_ck_9";
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_ck_3";
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_ck_4";
ALTER TABLE "lifecycle_witness" ADD CONSTRAINT "lifecycle_witness_ck_3" CHECK ((kind = ANY (ARRAY['account'::text, 'plant'::text])));
ALTER TABLE "lifecycle_witness" ADD CONSTRAINT "lifecycle_witness_ck_4" CHECK ((state = ANY (ARRAY['pending_deletion'::text, 'purging'::text, 'purged'::text, 'cancelled'::text])));
CREATE OR REPLACE FUNCTION settings_update_name(handle uuid,new_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE subject uuid;
BEGIN
 SELECT a.id INTO subject FROM auth_session s JOIN account a ON a.auth_user_id=s.user_id WHERE s.id=handle AND s.expires_at>clock_timestamp() FOR UPDATE OF a;
 IF subject IS NULL OR length(btrim(new_name)) NOT BETWEEN 1 AND 200 OR EXISTS(SELECT FROM lifecycle_witness WHERE kind='account' AND opaque_subject_id=subject AND state<>'cancelled') THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 UPDATE auth_user SET name=btrim(new_name),updated_at=clock_timestamp() WHERE id=(SELECT auth_user_id FROM account WHERE id=subject);
END $$;
