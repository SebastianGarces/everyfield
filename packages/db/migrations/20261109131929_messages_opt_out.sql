CREATE TABLE "person_email_opt_out" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"undone_at" timestamp with time zone,
	CONSTRAINT "person_email_opt_out_pkey" PRIMARY KEY("id"),
	CONSTRAINT "person_email_opt_out_undone" CHECK (((undone_at IS NULL) OR (undone_at >= opted_out_at)))
);
--> statement-breakpoint
ALTER TABLE "mail" ADD COLUMN "refusal" text;--> statement-breakpoint
ALTER TABLE "person_email_opt_out" ADD CONSTRAINT "person_email_opt_out_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_email_opt_out" ADD CONSTRAINT "person_email_opt_out_person" FOREIGN KEY ("person_id","plant_id") REFERENCES "person"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_email_opt_out_current" ON "person_email_opt_out" USING btree ("person_id") WHERE undone_at IS NULL;--> statement-breakpoint
CREATE INDEX "person_email_opt_out_plant" ON "person_email_opt_out" USING btree ("plant_id","person_id");--> statement-breakpoint
ALTER TABLE "mail" ADD CONSTRAINT "mail_refusal" CHECK (((refusal IS NULL) OR (refusal = 'unsubscribed'::text AND state = 'refused'::text)));--> statement-breakpoint
-- A Messages opt-out is the person's own choice (D-284). The runtime inserts it from the person's token and may stamp
-- undone_at once, from the person's own undo; it cannot delete the row or rewrite who, which church or when.
CREATE TRIGGER immutable_opt_out BEFORE UPDATE ON "person_email_opt_out" FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,plant_id,person_id,opted_out_at');
--> statement-breakpoint
CREATE TRIGGER undone_once BEFORE UPDATE ON "person_email_opt_out" FOR EACH ROW WHEN (OLD.undone_at IS NOT NULL) EXECUTE FUNCTION freeze_fields('undone_at');
--> statement-breakpoint
REVOKE ALL ON "person_email_opt_out" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT ON "person_email_opt_out" TO everyfield_runtime;
--> statement-breakpoint
GRANT UPDATE ("undone_at") ON "person_email_opt_out" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "person_email_opt_out" TO everyfield_cleanup;
