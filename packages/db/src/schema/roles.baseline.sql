-- Non-login capabilities. Operators provision separate LOGIN secrets out of band.
-- Role names carry no credentials and grant no tenant authority.
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='everyfield_runtime') THEN
    CREATE ROLE everyfield_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='everyfield_auth') THEN
    CREATE ROLE everyfield_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='everyfield_cleanup') THEN
    CREATE ROLE everyfield_cleanup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
DO $$ DECLARE tab pg_catalog.record; fn pg_catalog.record;
BEGIN
  -- Migrations set a trusted search path. Isolated schema rehearsals do the same.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO everyfield_runtime,everyfield_auth,everyfield_cleanup',current_schema());
  FOR tab IN SELECT tablename FROM pg_tables WHERE schemaname=current_schema() LOOP
    IF tab.tablename LIKE 'auth\_%' THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO everyfield_auth',tab.tablename);
    ELSIF tab.tablename NOT IN ('schema_migration','early_access_request','early_access_attempt') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO everyfield_runtime',tab.tablename);
      EXECUTE format('GRANT SELECT,UPDATE,DELETE ON %I TO everyfield_cleanup',tab.tablename);
    END IF;
  END LOOP;
  REVOKE INSERT,UPDATE,DELETE ON tenant,record FROM everyfield_runtime;
  REVOKE UPDATE,DELETE ON event,private_week_revision FROM everyfield_runtime;
  REVOKE ALL ON FUNCTION file_is_referenced(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION file_is_referenced(uuid) TO everyfield_runtime,everyfield_cleanup;
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=current_schema() AND p.prorettype='trigger'::regtype LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
  END LOOP;
END $$;
