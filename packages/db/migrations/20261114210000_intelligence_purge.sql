-- A plant's live purge removes its Plant Intelligence and every Network Intelligence run it contributed to, whole
-- (docs/architecture/security.md, "NI copies remain governed by their source plants"): the plant's assessment runs
-- with their insights, feedback and opens, and each organization run with a row of this plant, with all of that run's
-- contributor rows and feedback, by cascade. Other plants and the organization survive and can recompute; the
-- organization's refresh audit row stays as its minimum receipt.
DO $patch$
DECLARE def text; patched text;
BEGIN
 def := pg_get_functiondef('settings_purge_content(uuid,uuid,bigint)'::regprocedure);
 patched := replace(def, E' DELETE FROM feedback WHERE w.kind=\'account\' AND account_id=s;\n', E' DELETE FROM feedback WHERE w.kind=\'account\' AND account_id=s;\n DELETE FROM network_intelligence_run WHERE w.kind=\'plant\' AND id IN (SELECT run_id FROM network_intelligence_plant WHERE plant_id=s);\n DELETE FROM assessment_run WHERE w.kind=\'plant\' AND plant_id=s;\n');
 patched := replace(patched, E' IF w.kind=\'plant\' THEN\n  UPDATE plant SET name=', E' IF EXISTS(SELECT FROM network_intelligence_plant WHERE w.kind=\'plant\' AND plant_id=s) THEN RAISE EXCEPTION \'incomplete_owned_cleanup:network_intelligence_plant\' USING ERRCODE=\'23514\'; END IF;\n IF EXISTS(SELECT FROM assessment_run WHERE w.kind=\'plant\' AND plant_id=s) THEN RAISE EXCEPTION \'incomplete_owned_cleanup:assessment_run\' USING ERRCODE=\'23514\'; END IF;\n IF w.kind=\'plant\' THEN\n  UPDATE plant SET name=');
 IF (length(patched) - length(replace(patched, 'network_intelligence_plant', ''))) / length('network_intelligence_plant') <> 3 THEN
  RAISE EXCEPTION 'settings_purge_content patch did not apply';
 END IF;
 EXECUTE patched;
END
$patch$;
--> statement-breakpoint
-- A purged witness's clocks never move again, whatever request id a later write names: a recopy or a restore cannot
-- reset or clear live_purged_at, or extend or clear copy_expires_at. Before the purge, a new request may still set new
-- request and deadline times.
CREATE OR REPLACE FUNCTION witness_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.request_id IS NOT DISTINCT FROM OLD.request_id
      AND ROW(NEW.requested_at,NEW.cancel_until) IS DISTINCT FROM ROW(OLD.requested_at,OLD.cancel_until))
    OR (OLD.live_purged_at IS NOT NULL AND NEW.live_purged_at IS DISTINCT FROM OLD.live_purged_at)
    OR (OLD.copy_expires_at IS NOT NULL AND (NEW.copy_expires_at IS NULL OR NEW.copy_expires_at>OLD.copy_expires_at))
  THEN RAISE EXCEPTION 'immutable_lifecycle_clock' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
