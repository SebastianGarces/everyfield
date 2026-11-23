CREATE TABLE "guardian_contact" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plant_id" uuid NOT NULL,
	"child_person_id" uuid NOT NULL,
	"guardian_person_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "guardian_contact_pkey" PRIMARY KEY("id"),
	CONSTRAINT "guardian_contact_distinct" CHECK (child_person_id <> guardian_person_id)
);
--> statement-breakpoint
ALTER TABLE "mail" DROP CONSTRAINT "mail_refusal";--> statement-breakpoint
ALTER TABLE "mail" ADD COLUMN "guardian_mail_ids" uuid[];--> statement-breakpoint
ALTER TABLE "mail" ADD COLUMN "guardian_copy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guardian_contact" ADD CONSTRAINT "guardian_contact_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_contact" ADD CONSTRAINT "guardian_contact_child" FOREIGN KEY ("child_person_id","plant_id") REFERENCES "person"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_contact" ADD CONSTRAINT "guardian_contact_guardian" FOREIGN KEY ("guardian_person_id","plant_id") REFERENCES "person"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_contact" ADD CONSTRAINT "guardian_contact_household" FOREIGN KEY ("household_id","plant_id") REFERENCES "household"("id","plant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_contact_pair" ON "guardian_contact" USING btree ("plant_id","child_person_id","guardian_person_id");--> statement-breakpoint
CREATE INDEX "guardian_contact_ref_0" ON "guardian_contact" USING btree ("child_person_id","plant_id");--> statement-breakpoint
CREATE INDEX "guardian_contact_ref_1" ON "guardian_contact" USING btree ("guardian_person_id","plant_id");--> statement-breakpoint
CREATE INDEX "guardian_contact_household" ON "guardian_contact" USING btree ("household_id","plant_id");--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_guardian" CHECK (((refusal IS NOT DISTINCT FROM 'guardian'::text) = (COALESCE(cardinality(guardian_mail_ids), 0) > 0)));--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_refusal" CHECK (((refusal IS NULL) OR ((refusal = ANY (ARRAY['unsubscribed'::text, 'child'::text, 'guardian'::text])) AND (state = 'refused'::text))));--> statement-breakpoint
-- An Owner or Admin adds and removes a child's parent or guardian contact (D-2336): the runtime inserts, refreshes the
-- household on a repeat add and deletes the row. Church purge removes it with either Person.
REVOKE ALL ON "guardian_contact" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON "guardian_contact" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "guardian_contact" TO everyfield_cleanup;
