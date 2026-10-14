CREATE TABLE early_access_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL CHECK (kind IN ('planter', 'network')),
  email text NOT NULL CHECK (email = lower(btrim(email))),
  data jsonb NOT NULL,
  ip_address inet,
  mail_payload jsonb NOT NULL,
  mail_id text,
  mailed_at timestamptz,
  CHECK ((mail_id IS NULL) = (mailed_at IS NULL))
);
CREATE INDEX early_access_request_duplicate ON early_access_request (email, kind, created_at DESC);
CREATE INDEX early_access_request_retention ON early_access_request (created_at);

-- Valid attempts, including duplicates, count toward the abuse limits.
-- These records expire after the longest rate window, 24 hours.
CREATE TABLE early_access_attempt (
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  email text NOT NULL,
  ip_key text NOT NULL
);
CREATE INDEX early_access_attempt_email ON early_access_attempt (email, created_at);
CREATE INDEX early_access_attempt_ip ON early_access_attempt (ip_key, created_at);
