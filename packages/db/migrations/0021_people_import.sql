CREATE TABLE "person_import" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"plan" jsonb NOT NULL,
	"upload" text,
	"failed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "person_import_pkey" PRIMARY KEY("id"),
	CONSTRAINT "person_import_job" UNIQUE("job_id"),
	CONSTRAINT "person_import_plan" CHECK (jsonb_typeof("person_import"."plan")='object'),
	CONSTRAINT "person_import_failed" CHECK (jsonb_typeof("person_import"."failed")='array')
);
--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_ck_1";--> statement-breakpoint
ALTER TABLE "person_import" ADD CONSTRAINT "person_import_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ck_1" CHECK ((kind = ANY (ARRAY['mail'::text, 'notification'::text, 'digest'::text, 'assessment'::text, 'reference_generation'::text, 'feedback_publication'::text, 'object_cleanup'::text, 'lifecycle_purge'::text, 'assistant_turn'::text, 'document_render'::text, 'people_import'::text])));--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON person_import TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON person_import TO everyfield_cleanup;
