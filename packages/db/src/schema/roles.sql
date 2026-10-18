-- Forward-only access privileges. Historical 0002 remains byte-for-byte stable.
REVOKE DELETE ON lifecycle_witness FROM everyfield_runtime,everyfield_cleanup;
REVOKE DELETE ON document_revision FROM everyfield_runtime,everyfield_cleanup;
REVOKE UPDATE,DELETE ON tenant,record FROM everyfield_cleanup;

-- Authenticated server adapters pass a validated handle; this only rechecks it.
-- The runtime receives no auth tokens, credential bodies or auth-table grants.
CREATE OR REPLACE FUNCTION access_session(handle uuid)
RETURNS TABLE(account_id uuid,registration_state text,expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT a.id,a.registration_state,s.expires_at FROM auth_session s
  JOIN account a ON a.auth_user_id=s.user_id
  WHERE s.id=handle AND s.expires_at>clock_timestamp() FOR SHARE OF s,a
$$;
REVOKE ALL ON FUNCTION access_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_session(uuid) TO everyfield_runtime;

-- Only confirmed overdue lifecycle work can erase immutable document bodies.
-- Retain non-content tenant/record identities and witnesses; no root DML grant.
CREATE OR REPLACE FUNCTION purge_document_revisions(subject uuid,request uuid,expected bigint,document_id uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE affected bigint;
BEGIN
  PERFORM 1 FROM lifecycle_witness w WHERE w.opaque_subject_id=subject AND w.request_id=request
    AND w.request_revision=expected AND w.kind IN ('account','plant')
    AND w.state='purging' AND w.cancel_until<=clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM document d WHERE d.id=document_id AND d.tenant_id=subject FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
  -- Provenance-only source links are detached by the lifecycle producer before
  -- this step; FK references refuse incomplete sequencing, never CASCADE it.
  UPDATE document SET current_revision_id=NULL WHERE id=document_id AND tenant_id=subject;
  DELETE FROM document_revision r WHERE r.document_id=purge_document_revisions.document_id AND r.tenant_id=subject;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $$;
REVOKE ALL ON FUNCTION purge_document_revisions(uuid,uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_document_revisions(uuid,uuid,bigint,uuid) TO everyfield_cleanup;
