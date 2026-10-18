-- Structural rules beyond row-local CHECK and FK constraints. Authority remains in native producers.
CREATE FUNCTION immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'immutable_identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_record BEFORE UPDATE ON record FOR EACH ROW EXECUTE FUNCTION immutable_identity();
CREATE TRIGGER immutable_tenant BEFORE UPDATE ON tenant FOR EACH ROW EXECUTE FUNCTION immutable_identity();

CREATE FUNCTION check_owner_kind() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_kind text;
BEGIN
  SELECT kind INTO owner_kind FROM tenant WHERE id=NEW.tenant_id;
  IF NOT owner_kind = ANY(string_to_array(TG_ARGV[0],',')) THEN
    RAISE EXCEPTION 'invalid_tenant_kind' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_kind BEFORE INSERT OR UPDATE ON document FOR EACH ROW EXECUTE FUNCTION check_owner_kind('account,plant');
CREATE TRIGGER owner_kind BEFORE INSERT OR UPDATE ON generated_document FOR EACH ROW EXECUTE FUNCTION check_owner_kind('account,plant');
CREATE TRIGGER owner_kind BEFORE INSERT OR UPDATE ON assessment FOR EACH ROW EXECUTE FUNCTION check_owner_kind('plant,organization');
CREATE TRIGGER owner_kind BEFORE INSERT OR UPDATE ON reference_item FOR EACH ROW EXECUTE FUNCTION check_owner_kind('organization,global');
CREATE TRIGGER owner_kind BEFORE INSERT OR UPDATE ON reference_release FOR EACH ROW EXECUTE FUNCTION check_owner_kind('organization,global');
CREATE TRIGGER owner_kind BEFORE INSERT OR UPDATE ON article_revision FOR EACH ROW EXECUTE FUNCTION check_owner_kind('organization,global');

CREATE FUNCTION document_revision_owner() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.current_revision_id IS NOT NULL AND NOT EXISTS(
    SELECT FROM document_revision WHERE id=NEW.current_revision_id AND document_id=NEW.id AND tenant_id=NEW.tenant_id
  ) THEN RAISE EXCEPTION 'foreign_document_revision' USING ERRCODE='23514'; END IF;
  IF NEW.kind='launch_summary' AND NOT EXISTS(SELECT FROM tenant WHERE id=NEW.tenant_id AND kind='plant') THEN
    RAISE EXCEPTION 'launch_summary_requires_plant' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER document_current_revision AFTER INSERT OR UPDATE ON document DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION document_revision_owner();

CREATE FUNCTION file_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.purpose,NEW.opaque_key,NEW.upload_key,NEW.media_type,NEW.max_bytes,NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.purpose,OLD.opaque_key,OLD.upload_key,OLD.media_type,OLD.max_bytes,OLD.expires_at)
     OR (OLD.sha256 IS NOT NULL AND ROW(NEW.sha256,NEW.byte_count) IS DISTINCT FROM ROW(OLD.sha256,OLD.byte_count))
     OR NEW.claim_generation < OLD.claim_generation
     OR (OLD.state='ready' AND NEW.state NOT IN ('ready','cleanup'))
     OR (OLD.state='failed' AND NEW.state NOT IN ('failed','cleanup'))
     OR (OLD.state='cleanup' AND NEW.state NOT IN ('cleanup','purged'))
     OR (OLD.state='purged' AND NEW.state<>'purged') THEN
    RAISE EXCEPTION 'immutable_file_identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_file BEFORE UPDATE ON file_object FOR EACH ROW EXECUTE FUNCTION file_immutable();
ALTER TABLE file_object ADD CONSTRAINT file_limits CHECK(max_bytes>0 AND claim_generation>=0 AND (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'));
ALTER TABLE file_object ADD CONSTRAINT opaque_private_key CHECK(opaque_key ~ '^private/[0-9a-f-]{36}/[0-9a-f-]{36}$');

CREATE FUNCTION private_week_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.plant_id,NEW.author_id,NEW.ordinal,NEW.monday,NEW.timezone,NEW.starts_at,NEW.ends_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.plant_id,OLD.author_id,OLD.ordinal,OLD.monday,OLD.timezone,OLD.starts_at,OLD.ends_at) THEN
    RAISE EXCEPTION 'immutable_private_week' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER private_week_identity BEFORE UPDATE ON private_week FOR EACH ROW EXECUTE FUNCTION private_week_identity();
ALTER TABLE phase_transition ADD CONSTRAINT creation_phase CHECK(kind <> 'creation' OR (from_phase IS NULL AND to_phase=1));
ALTER TABLE file_object ADD CONSTRAINT private_key_owner CHECK(split_part(opaque_key,'/',2)::uuid=tenant_id);

CREATE FUNCTION freeze_fields() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text;
BEGIN
  FOREACH field IN ARRAY string_to_array(TG_ARGV[0],',') LOOP
    IF to_jsonb(NEW)->field IS DISTINCT FROM to_jsonb(OLD)->field THEN
      RAISE EXCEPTION 'immutable_source_evidence' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_source BEFORE UPDATE ON document_revision FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,tenant_id,document_id,version_number,body,content_hash,recorded_at,import_format,import_state');
CREATE TRIGGER immutable_source BEFORE UPDATE ON training_version FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,plant_id,program_id,version_number,source_hash,compatible_prior_id');
CREATE TRIGGER immutable_source BEFORE UPDATE ON reference_version FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,item_id,release_id,version_number,artifact_path,content_hash,source_credit');
CREATE TRIGGER immutable_source BEFORE UPDATE ON reference_activation FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,release_id,activation_number,previous_id,activated_at,reason,expected_prior_number');
CREATE TRIGGER immutable_source BEFORE UPDATE ON article_revision FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,article_id,tenant_id,release_id,revision_number,upstream_revision_id,title,slug,excerpt,body,content_type,phase,parent_article_id,position,content_hash,meaningful,meaningful_sequence,section_id');

CREATE FUNCTION reference_version_global() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM 1 FROM reference_item WHERE id=NEW.item_id AND tenant_id='00000000-0000-0000-0000-000000000000' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'packaged_source_requires_global' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM reference_release WHERE id=NEW.release_id AND tenant_id='00000000-0000-0000-0000-000000000000' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'packaged_release_requires_global' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reference_version_global BEFORE INSERT OR UPDATE ON reference_version FOR EACH ROW EXECUTE FUNCTION reference_version_global();

CREATE FUNCTION reference_activation_complete() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE expected integer; actual integer;
BEGIN
  SELECT expected_passages INTO expected FROM reference_release WHERE id=NEW.release_id
    AND tenant_id='00000000-0000-0000-0000-000000000000' AND state='validated'
    AND complete_at IS NOT NULL AND validated_at IS NOT NULL AND approval_hash IS NOT NULL AND approval_locator IS NOT NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'incomplete_reference_release' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO actual FROM passage WHERE release_id=NEW.release_id;
  IF expected<>actual THEN RAISE EXCEPTION 'incomplete_reference_passages' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reference_activation_complete BEFORE INSERT ON reference_activation FOR EACH ROW EXECUTE FUNCTION reference_activation_complete();

CREATE FUNCTION witness_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.request_id IS NOT DISTINCT FROM OLD.request_id AND (
    ROW(NEW.requested_at,NEW.cancel_until) IS DISTINCT FROM ROW(OLD.requested_at,OLD.cancel_until)
    OR (OLD.live_purged_at IS NOT NULL AND NEW.live_purged_at IS DISTINCT FROM OLD.live_purged_at)
    OR (OLD.copy_expires_at IS NOT NULL AND (NEW.copy_expires_at IS NULL OR NEW.copy_expires_at>OLD.copy_expires_at))
  ) THEN RAISE EXCEPTION 'immutable_lifecycle_clock' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER witness_clock BEFORE UPDATE ON lifecycle_witness FOR EACH ROW EXECUTE FUNCTION witness_clock();
