-- The purge removes the subject's queued work but keeps its lifecycle_purge jobs. The running purge job must outlive
-- the content step, so a removal the provider has not confirmed waits for its retry and the finished purge records
-- its outcome. A purge job holds only the witness id, the request revision and its key, no personal content.
DO $patch$
DECLARE def text;
BEGIN
 def := pg_get_functiondef('settings_purge_content(uuid,uuid,bigint)'::regprocedure);
 def := replace(def, E'   DELETE FROM "job" WHERE tenant_id=s;\n', E'   DELETE FROM "job" WHERE tenant_id=s AND kind<>\'lifecycle_purge\';\n');
 def := replace(def, E' IF EXISTS(SELECT FROM "job" WHERE tenant_id=s) THEN', E' IF EXISTS(SELECT FROM "job" WHERE tenant_id=s AND kind<>\'lifecycle_purge\') THEN');
 IF (length(def) - length(replace(def, 'kind<>''lifecycle_purge''', ''))) / length('kind<>''lifecycle_purge''') <> 2 THEN
  RAISE EXCEPTION 'settings_purge_content patch did not apply';
 END IF;
 EXECUTE def;
END
$patch$;
