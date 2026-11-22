ALTER TABLE "embedding_spend" DROP CONSTRAINT "embedding_spend_purpose";--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_ck_1";--> statement-breakpoint
ALTER TABLE "passage" ALTER COLUMN "release_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "passage_organization_uq" ON "passage" USING btree ("revision_id","ordinal") WHERE (release_id IS NULL);--> statement-breakpoint
ALTER TABLE "embedding_spend" ADD CONSTRAINT "embedding_spend_purpose" CHECK ("embedding_spend"."purpose" IN ('query','rebuild','publish'));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ck_1" CHECK ((kind = ANY (ARRAY['mail'::text, 'notification'::text, 'digest'::text, 'object_cleanup'::text, 'lifecycle_purge'::text, 'assistant_turn'::text, 'people_import'::text, 'evry_effect'::text, 'feedback_publication'::text, 'assessment'::text, 'wiki_embedding'::text])));--> statement-breakpoint
ALTER TABLE "passage" ADD CONSTRAINT "passage_release_owner" CHECK (((release_id IS NULL) = (tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)));