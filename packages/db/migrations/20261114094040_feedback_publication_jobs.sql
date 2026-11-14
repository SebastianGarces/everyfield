-- The public reference is frozen with the author, words and details; only status, revision and the publication fields
-- change after submission.
DROP TRIGGER immutable_source ON "feedback";
--> statement-breakpoint
CREATE TRIGGER immutable_source BEFORE UPDATE ON "feedback" FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,account_id,request_key,category,description,page_label,page_address,church_label,role_label,browser,screen_width,screen_height,theme,app_version,submitted_at,reference');
--> statement-breakpoint
-- Feedback saved before publication existed waits for its first publication run, as new feedback does.
INSERT INTO "job" (tenant_id, kind, subject_record_id, producer_key, state, eligible_at, attempt_count, max_attempts, claim_generation)
SELECT f.account_id, 'feedback_publication', f.id, 'feedback/' || f.id::text, 'ready', clock_timestamp(), 0, 4, 0 FROM "feedback" f
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Run the deferred record checks now, so a later migration in this batch can still alter these tables.
SET CONSTRAINTS ALL IMMEDIATE;
