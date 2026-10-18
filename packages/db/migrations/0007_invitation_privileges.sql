-- Custom Drizzle migration. Credential proof is read only for a server-validated
-- native session. Runtime never receives credential/session-table privileges.
GRANT SELECT,INSERT ON identity_operation_result TO everyfield_runtime;
GRANT SELECT,DELETE ON identity_operation_result TO everyfield_cleanup;
CREATE FUNCTION invitation_identity(handle uuid)
RETURNS TABLE(account_id uuid,email text,display_name text,verified boolean,registration_state text)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT a.id,u.email,u.name,u.email_verified,a.registration_state
 FROM auth_session s JOIN auth_user u ON u.id=s.user_id JOIN account a ON a.auth_user_id=u.id
 WHERE s.id=handle AND s.expires_at>clock_timestamp() FOR UPDATE OF a FOR SHARE OF s,u
$$;
REVOKE ALL ON FUNCTION invitation_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_identity(uuid) TO everyfield_runtime;
CREATE FUNCTION revoke_removed_seat_sessions(subject uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
 PERFORM 1 FROM seat WHERE account_id=subject AND ended_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT FROM seat WHERE account_id=subject AND ended_at IS NULL)
 THEN RAISE EXCEPTION 'unavailable' USING ERRCODE='42501'; END IF;
 DELETE FROM auth_session WHERE user_id=(SELECT auth_user_id FROM account WHERE id=subject);
END $$;
REVOKE ALL ON FUNCTION revoke_removed_seat_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_removed_seat_sessions(uuid) TO everyfield_runtime;
CREATE FUNCTION seat_identity(subject uuid) RETURNS TABLE(display_name text,created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT u.name,u.created_at FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE a.id=subject
$$;
REVOKE ALL ON FUNCTION seat_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seat_identity(uuid) TO everyfield_runtime;
