-- RT-1: the request viewer reads the session, its user and the account in the same statement as the viewer.
-- The server verifies the signed session cookie first and passes the token it already holds. The runtime still
-- cannot read auth tables or tokens: this returns no token. No row locks, as live_session (C27).
CREATE FUNCTION request_session(token text)
RETURNS TABLE(session_id uuid,account_id uuid,registration_state text,expires_at timestamptz,name text,email text,email_verified boolean)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT s.id,a.id,a.registration_state,s.expires_at,u.name,u.email,u.email_verified FROM auth_session s
  JOIN auth_user u ON u.id=s.user_id JOIN account a ON a.auth_user_id=u.id
  WHERE s.token=$1 AND s.expires_at>clock_timestamp()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION request_session(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION request_session(text) TO everyfield_runtime;
