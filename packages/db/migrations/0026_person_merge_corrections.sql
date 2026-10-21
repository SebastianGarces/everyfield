CREATE TABLE "person_merge" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"survivor_id" uuid NOT NULL,
	"merged_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"prior" jsonb NOT NULL,
	"moved" jsonb NOT NULL,
	"source_revision" bigint NOT NULL,
	"survivor_revision" bigint NOT NULL,
	"references_digest" text NOT NULL,
	"unmerged_at" timestamp with time zone,
	CONSTRAINT "person_merge_pkey" PRIMARY KEY("id"),
	CONSTRAINT "person_merge_distinct" CHECK ("person_merge"."source_id"<>"person_merge"."survivor_id"),
	CONSTRAINT "person_merge_prior" CHECK (jsonb_typeof("person_merge"."prior")='object'),
	CONSTRAINT "person_merge_moved" CHECK (jsonb_typeof("person_merge"."moved")='object')
);
--> statement-breakpoint
CREATE TABLE "record_correction" (
	"id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"corrected_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"before_value" jsonb NOT NULL,
	"after_value" jsonb NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "record_correction_pkey" PRIMARY KEY("id"),
	CONSTRAINT "record_correction_type" CHECK ("record_correction"."record_type" IN ('assessment','interview','commitment'))
);
--> statement-breakpoint
ALTER TABLE "person_merge" ADD CONSTRAINT "person_merge_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merge" ADD CONSTRAINT "person_merge_source" FOREIGN KEY ("source_id","tenant_id") REFERENCES "person"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merge" ADD CONSTRAINT "person_merge_survivor" FOREIGN KEY ("survivor_id","tenant_id") REFERENCES "person"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_correction" ADD CONSTRAINT "record_correction_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_correction" ADD CONSTRAINT "record_correction_person" FOREIGN KEY ("person_id","plant_id") REFERENCES "person"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_correction" ADD CONSTRAINT "record_correction_target" FOREIGN KEY ("record_id","plant_id") REFERENCES "record"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_merge_open_source" ON "person_merge" USING btree ("source_id") WHERE unmerged_at IS NULL;--> statement-breakpoint
CREATE INDEX "person_merge_survivor_ref" ON "person_merge" USING btree ("survivor_id","tenant_id");--> statement-breakpoint
CREATE INDEX "record_correction_record" ON "record_correction" USING btree ("plant_id","record_id","corrected_at");--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON person_merge TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON person_merge TO everyfield_cleanup;
--> statement-breakpoint
-- Corrections are append-only history for ordinary writers. Only the Person they belong to may change, so a merge
-- and its Unmerge move a correction with its record; old values, new values and reason stay as written.
GRANT SELECT,INSERT ON record_correction TO everyfield_runtime;
--> statement-breakpoint
GRANT UPDATE (person_id) ON record_correction TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON record_correction TO everyfield_cleanup;
