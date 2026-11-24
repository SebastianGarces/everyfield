DO $patch$
DECLARE def text; patched text; tbl text;
BEGIN
 def := pg_get_functiondef('settings_purge_content(uuid,uuid,bigint)'::regprocedure);
 patched := def;
 FOREACH tbl IN ARRAY ARRAY['message_template','communication'] LOOP
  patched := replace(patched, E'  BEGIN\n   DELETE FROM "mail" WHERE tenant_id=s;\n', E'  BEGIN\n   DELETE FROM "' || tbl || E'" WHERE (w.kind=\'plant\' AND (plant_id=s));\n   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;\n  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;\n  BEGIN\n   DELETE FROM "mail" WHERE tenant_id=s;\n');
  patched := replace(patched, E' IF w.kind=\'plant\' THEN\n  UPDATE plant SET name=', E' IF EXISTS(SELECT FROM "' || tbl || E'" WHERE (w.kind=\'plant\' AND (plant_id=s))) THEN RAISE EXCEPTION \'incomplete_owned_cleanup:' || tbl || E'\' USING ERRCODE=\'23514\'; END IF;\n IF w.kind=\'plant\' THEN\n  UPDATE plant SET name=');
  IF (length(patched) - length(replace(patched, '"' || tbl || '" WHERE (w.kind=''plant''', ''))) / length('"' || tbl || '" WHERE (w.kind=''plant''') <> 2 THEN
   RAISE EXCEPTION 'settings_purge_content patch did not apply';
  END IF;
 END LOOP;
 EXECUTE patched;
END
$patch$;
