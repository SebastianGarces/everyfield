CREATE TABLE "attestation_revision" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plant_id" uuid NOT NULL,
	"attestation_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"key" text NOT NULL,
	"person_id" uuid,
	"kind" text NOT NULL,
	"answer" boolean,
	"as_of" date NOT NULL,
	"detail" text,
	"reference" text,
	"period_start" date,
	"period_end" date,
	"attendance_continuous" boolean,
	"volunteering_continuous" boolean,
	"question_version" text NOT NULL,
	"author_id" uuid,
	"request_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "attestation_revision_pkey" PRIMARY KEY("id"),
	CONSTRAINT "attestation_revision_uq_0" UNIQUE("attestation_id","revision"),
	CONSTRAINT "attestation_revision_uq_1" UNIQUE("plant_id","request_key"),
	CONSTRAINT "attestation_revision_ck_0" CHECK ((revision >= 1)),
	CONSTRAINT "attestation_revision_ck_1" CHECK (((key = 'leadership_candidate'::text) OR ((kind = 'retracted'::text) = (answer IS NULL)))),
	CONSTRAINT "attestation_revision_ck_5" CHECK ((key = ANY (ARRAY['values_documented'::text, 'financial_base_established'::text, 'core_group_giving'::text, 'prayer_leader_assigned'::text, 'prayer_rhythm_established'::text, 'prayer_in_gatherings'::text, 'systems_tested'::text, 'leadership_candidate'::text]))),
	CONSTRAINT "attestation_revision_ck_6" CHECK (((key <> 'leadership_candidate'::text) OR ((person_id IS NOT NULL) AND (period_start IS NOT NULL) AND (period_end IS NOT NULL) AND (attendance_continuous IS NOT NULL) AND (volunteering_continuous IS NOT NULL)))),
	CONSTRAINT "attestation_revision_ck_2" CHECK (((char_length(request_key) >= 1) AND (char_length(request_key) <= 200))),
	CONSTRAINT "attestation_revision_ck_3" CHECK (((period_end IS NULL) OR (period_start <= period_end))),
	CONSTRAINT "attestation_revision_ck_4" CHECK (((detail IS NULL) OR ((char_length(detail) >= 1) AND (char_length(detail) <= 500))) AND ((reference IS NULL) OR ((char_length(reference) >= 1) AND (char_length(reference) <= 500))))
);
--> statement-breakpoint
ALTER TABLE "attestation" ALTER COLUMN "reference_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attestation_revision" ADD CONSTRAINT "attestation_revision_fk_3" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestation_revision" ADD CONSTRAINT "attestation_revision_fk_0" FOREIGN KEY ("attestation_id","plant_id") REFERENCES "attestation"("id","plant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestation_revision" ADD CONSTRAINT "attestation_revision_fk_1" FOREIGN KEY ("person_id","plant_id") REFERENCES "person"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestation_revision" ADD CONSTRAINT "attestation_revision_fk_2" FOREIGN KEY ("author_id") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attestation_revision_ref_1" ON "attestation_revision" USING btree ("plant_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attestation_revision_ref_2" ON "attestation_revision" USING btree ("person_id","plant_id");--> statement-breakpoint
CREATE INDEX "attestation_revision_ref_3" ON "attestation_revision" USING btree ("author_id");--> statement-breakpoint
-- A revision keeps everything it recorded for good (SCHEMA-007). Only the author link may clear when the account is deleted.
CREATE TRIGGER immutable_revision BEFORE UPDATE ON "attestation_revision" FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,plant_id,attestation_id,revision,key,person_id,kind,answer,as_of,detail,reference,period_start,period_end,attendance_continuous,volunteering_continuous,question_version,request_key,request_fingerprint,recorded_at');
--> statement-breakpoint
-- The runtime appends revisions and edits the current answer. Neither it nor a cascade from the runtime can remove
-- history: deletion belongs to the church purge, which already deletes attestations and now cascades to revisions.
REVOKE ALL ON "attestation_revision" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT ON "attestation_revision" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "attestation_revision" TO everyfield_cleanup;
--> statement-breakpoint
REVOKE DELETE ON "attestation" FROM everyfield_runtime;
