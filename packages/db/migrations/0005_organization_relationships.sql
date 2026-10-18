-- Additive adapter storage; baseline migrations and their checksums stay unchanged.
ALTER TABLE affiliation ADD COLUMN consent_revision bigint NOT NULL DEFAULT 1 CHECK(consent_revision>=1);
ALTER TABLE affiliation RENAME COLUMN share_ministry TO share_ministry_teams;
CREATE TABLE relationship_invitation (
  invitation_id uuid PRIMARY KEY REFERENCES invitation(id),
  plant_id uuid REFERENCES plant(id),
  account_id uuid REFERENCES account(id),
  sending_church_id uuid REFERENCES organization(id),
  organization_id uuid NOT NULL REFERENCES organization(id),
  inviter_description text NOT NULL CHECK(length(inviter_description) BETWEEN 1 AND 500),
  subject_revision bigint NOT NULL CHECK(subject_revision>=1),
  CHECK(num_nonnulls(plant_id,account_id,sending_church_id)=1),
  CHECK(organization_id IS DISTINCT FROM sending_church_id)
);
CREATE TABLE relationship_history (
  id uuid PRIMARY KEY REFERENCES event(id),
  relationship_id uuid NOT NULL REFERENCES affiliation(id),
  pair jsonb NOT NULL CHECK(jsonb_typeof(pair)='object'),
  reason text CHECK(length(reason)<=1000),
  source_invitation_id uuid REFERENCES invitation(id)
);
CREATE TABLE organization_operation_result (
  operation_id uuid PRIMARY KEY REFERENCES operation(id),
  receipt jsonb NOT NULL,
  result jsonb NOT NULL
);
GRANT SELECT,INSERT ON relationship_history,organization_operation_result TO everyfield_runtime;
GRANT SELECT,INSERT,UPDATE ON relationship_invitation TO everyfield_runtime;
GRANT SELECT,UPDATE,DELETE ON relationship_history,organization_operation_result,relationship_invitation TO everyfield_cleanup;
-- Narrow original-address check. Runtime has no credential/session table grants.
CREATE FUNCTION relationship_recipient(handle uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT u.email FROM auth_session s JOIN auth_user u ON u.id=s.user_id
    JOIN account a ON a.auth_user_id=u.id
    WHERE s.id=handle AND s.expires_at>clock_timestamp() AND a.registration_state='active' AND u.email_verified
$$;
REVOKE ALL ON FUNCTION relationship_recipient(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relationship_recipient(uuid) TO everyfield_runtime;
CREATE FUNCTION relationship_inviter_name(handle uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT u.name FROM auth_session s JOIN auth_user u ON u.id=s.user_id
    JOIN account a ON a.auth_user_id=u.id
    WHERE s.id=handle AND s.expires_at>clock_timestamp() AND a.registration_state='active'
$$;
REVOKE ALL ON FUNCTION relationship_inviter_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relationship_inviter_name(uuid) TO everyfield_runtime;
