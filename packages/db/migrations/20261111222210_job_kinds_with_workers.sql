-- The queue keeps only kinds a worker claims (D-517, D-530). Rows of the dropped kinds never ran: release the nullable
-- references to them, then delete them (a person import cascades), so the new checks validate on existing data.
CREATE TEMP TABLE dropped_job ON COMMIT DROP AS SELECT id, tenant_id FROM "job" WHERE kind IN ('notification', 'assessment', 'reference_generation', 'feedback_publication', 'document_render');--> statement-breakpoint
UPDATE "conversation" SET active_turn_id = NULL WHERE active_turn_id IN (SELECT id FROM dropped_job);--> statement-breakpoint
UPDATE "conversation_event" SET turn_id = NULL WHERE turn_id IN (SELECT id FROM dropped_job);--> statement-breakpoint
UPDATE "mail" SET job_id = NULL WHERE job_id IN (SELECT id FROM dropped_job);--> statement-breakpoint
UPDATE "proposal" SET job_id = NULL WHERE job_id IN (SELECT id FROM dropped_job);--> statement-breakpoint
DELETE FROM "job" WHERE id IN (SELECT id FROM dropped_job);--> statement-breakpoint
-- Run the deferred key checks now: a table with pending trigger events cannot be altered in the same transaction.
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_ck_1";--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_ck_7";--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ck_1" CHECK ((kind = ANY (ARRAY['mail'::text, 'digest'::text, 'object_cleanup'::text, 'lifecycle_purge'::text, 'assistant_turn'::text, 'people_import'::text, 'evry_effect'::text])));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ck_7" CHECK (((tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid) OR (kind = ANY (ARRAY['mail'::text, 'object_cleanup'::text, 'lifecycle_purge'::text]))));