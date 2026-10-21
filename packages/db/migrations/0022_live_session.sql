-- C13/C22: a tenant read checks the live session inside its own statement without row locks, so a sign-out
-- never waits for a running read. access_session keeps its share locks for the callers that write.
CREATE FUNCTION live_session(handle uuid)
RETURNS TABLE(account_id uuid,registration_state text)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT a.id,a.registration_state FROM auth_session s
  JOIN account a ON a.auth_user_id=s.user_id
  WHERE s.id=handle AND s.expires_at>clock_timestamp()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION live_session(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION live_session(uuid) TO everyfield_runtime;
