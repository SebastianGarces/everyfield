CREATE OR REPLACE FUNCTION file_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claimed boolean := OLD.purpose='assistant_staging' AND NEW.purpose='person_photo' AND OLD.state='pending'
    AND NEW.state='ready' AND NEW.media_type IN ('image/jpeg','image/png','image/webp') AND NEW.sha256 IS NOT NULL;
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,CASE WHEN claimed THEN OLD.purpose ELSE NEW.purpose END,NEW.opaque_key,NEW.upload_key,NEW.media_type,NEW.max_bytes,NEW.expires_at)
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
