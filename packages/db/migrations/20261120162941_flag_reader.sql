DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='everyfield_flag_reader') THEN
    CREATE ROLE everyfield_flag_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
CREATE OR REPLACE VIEW flag_rollout WITH (security_barrier) AS
SELECT f.name, f.value, c.occurred_at AS changed_at
FROM feature_flag f
LEFT JOIN LATERAL (SELECT a.occurred_at FROM audit_event a
  WHERE a.tenant_id=f.tenant_id AND a.subject_id=f.id AND a.action='flags.changed'
  ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1) c ON true
WHERE f.tenant_id='00000000-0000-0000-0000-000000000000'::uuid;
DO $$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO everyfield_flag_reader',current_schema());
END $$;
GRANT SELECT ON flag_rollout TO everyfield_flag_reader;
