-- The notification worker claims `notification` jobs again (T-229): meeting writes queue one per announcement and
-- reminder slot, and the scheduled runner plans and writes their notices. Widening the check needs no data change.
ALTER TABLE "job" DROP CONSTRAINT "job_ck_1";--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ck_1" CHECK ((kind = ANY (ARRAY['mail'::text, 'notification'::text, 'digest'::text, 'object_cleanup'::text, 'lifecycle_purge'::text, 'assistant_turn'::text, 'people_import'::text, 'evry_effect'::text])));
