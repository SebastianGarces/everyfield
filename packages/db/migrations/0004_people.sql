-- WP-011 producer history is separate from the body-free central audit.
CREATE TABLE people_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 person_id uuid NOT NULL, operation_id uuid NOT NULL, actor_id uuid REFERENCES account(id) ON DELETE SET NULL,
 actor_token text NOT NULL, action text NOT NULL, occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), before_revision bigint,
 after_revision bigint NOT NULL, before_value jsonb, after_value jsonb, reason text,
 FOREIGN KEY(person_id,tenant_id) REFERENCES person(id,tenant_id),
 FOREIGN KEY(operation_id,tenant_id) REFERENCES operation(id,tenant_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX people_history_cursor ON people_history(tenant_id,person_id,occurred_at,id);
CREATE TABLE people_result (
 operation_id uuid PRIMARY KEY REFERENCES operation(id), person_id uuid,
 value jsonb NOT NULL
);
CREATE TABLE people_column (
 plant_id uuid NOT NULL REFERENCES plant(id), column_name text NOT NULL,
 revision bigint NOT NULL DEFAULT 1, PRIMARY KEY(plant_id,column_name),
 CHECK(column_name IN ('prospect','attendee','following_up','interviewed','core_group'))
);
ALTER TABLE person_note DROP CONSTRAINT person_note_ck_1;
ALTER TABLE person_note ADD CONSTRAINT person_note_ck_1 CHECK(
 (removed_at IS NULL AND length(btrim(body)) BETWEEN 1 AND 5000) OR (removed_at IS NOT NULL AND body=''));
-- All new current references lock the Person lifecycle row. Retiring and inserting
-- a reference cannot both commit with the Person retired.
CREATE FUNCTION people_live_reference() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE pid uuid; prior uuid; tid uuid;
BEGIN
 pid=(to_jsonb(NEW)->>TG_ARGV[0])::uuid;
 IF TG_OP='UPDATE' THEN prior=(to_jsonb(OLD)->>TG_ARGV[0])::uuid; END IF;
 IF pid IS NULL OR (TG_OP='UPDATE' AND pid IS NOT DISTINCT FROM prior) THEN RETURN NEW; END IF;
 tid=coalesce((to_jsonb(NEW)->>'plant_id')::uuid,(to_jsonb(NEW)->>'organization_id')::uuid,(to_jsonb(NEW)->>'tenant_id')::uuid);
 PERFORM 1 FROM person WHERE id=pid AND tenant_id=tid AND state='live' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'person_not_live' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER people_live_reference BEFORE INSERT OR UPDATE OF person_id ON participation FOR EACH ROW EXECUTE FUNCTION people_live_reference('person_id');
CREATE TRIGGER people_live_reference BEFORE INSERT OR UPDATE OF person_id ON launch_guest FOR EACH ROW EXECUTE FUNCTION people_live_reference('person_id');
CREATE TRIGGER people_live_reference BEFORE INSERT OR UPDATE OF person_id ON task FOR EACH ROW EXECUTE FUNCTION people_live_reference('person_id');
CREATE TRIGGER people_live_reference BEFORE INSERT OR UPDATE OF person_id ON team_tenure FOR EACH ROW EXECUTE FUNCTION people_live_reference('person_id');
CREATE TRIGGER people_live_reference BEFORE INSERT OR UPDATE OF person_id ON development_enrollment FOR EACH ROW EXECUTE FUNCTION people_live_reference('person_id');
CREATE TRIGGER people_live_reference BEFORE INSERT OR UPDATE OF person_id ON residency_link FOR EACH ROW EXECUTE FUNCTION people_live_reference('person_id');
REVOKE ALL ON FUNCTION people_live_reference() FROM PUBLIC;
GRANT SELECT,INSERT ON people_history TO everyfield_runtime;
-- Removal scrubs protected bodies; application API offers no general history editor.
GRANT UPDATE ON people_history TO everyfield_runtime,everyfield_cleanup;
GRANT SELECT,INSERT,UPDATE,DELETE ON people_result,people_column TO everyfield_runtime;
GRANT SELECT,UPDATE,DELETE ON people_result TO everyfield_cleanup;
-- Internal verified-contact lookup; not a client-facing identity selector.
CREATE FUNCTION access_account_contact(subject uuid) RETURNS TABLE(email text,verified boolean)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
 SELECT u.email,u.email_verified FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE a.id=subject
$$;
REVOKE ALL ON FUNCTION access_account_contact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_account_contact(uuid) TO everyfield_runtime;
-- A retirement also prevents new current leadership references.
CREATE TRIGGER people_live_leader BEFORE INSERT OR UPDATE OF leader_person_id ON team FOR EACH ROW EXECUTE FUNCTION people_live_reference('leader_person_id');
-- Ordinary writers append history. Only this exact witnessed organization removal
-- may scrub protected history bodies; the recovery witness remains durable.
REVOKE UPDATE ON people_history FROM everyfield_runtime;
CREATE FUNCTION purge_organization_person_history(org uuid,subject uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
 PERFORM 1 FROM organization_person_removal w JOIN person p ON p.id=w.person_record_id AND p.organization_id=w.organization_id
 WHERE w.organization_id=org AND w.person_record_id=subject AND p.state='retired' FOR SHARE OF w,p;
 IF NOT FOUND THEN RAISE EXCEPTION 'removal_witness_required' USING ERRCODE='23514'; END IF;
 UPDATE people_history SET before_value=NULL,after_value=NULL,reason=NULL,actor_id=NULL WHERE tenant_id=org AND person_id=subject;
 UPDATE people_result SET value='{}' WHERE person_id=subject;
END $$;
REVOKE ALL ON FUNCTION purge_organization_person_history(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_organization_person_history(uuid,uuid) TO everyfield_runtime,everyfield_cleanup;
CREATE FUNCTION scrub_people_account_author(subject uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
 PERFORM 1 FROM lifecycle_witness WHERE account_id=subject AND state IN ('purging','purged') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account_purge_witness_required' USING ERRCODE='23514'; END IF;
 UPDATE person_note SET author_id=NULL WHERE author_id=subject;
 UPDATE people_history SET actor_id=NULL WHERE actor_id=subject;
 UPDATE people_history SET before_value=before_value-'linked_account_id' WHERE before_value->>'linked_account_id'=subject::text;
 UPDATE people_history SET after_value=after_value-'linked_account_id' WHERE after_value->>'linked_account_id'=subject::text;
END $$;
REVOKE ALL ON FUNCTION scrub_people_account_author(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scrub_people_account_author(uuid) TO everyfield_runtime,everyfield_cleanup;
