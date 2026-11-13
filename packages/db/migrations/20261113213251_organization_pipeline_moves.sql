CREATE TABLE "pipeline_stage_move" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"pipeline_person_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid NOT NULL,
	"from_label" text,
	"to_label" text NOT NULL,
	"reason" text,
	CONSTRAINT "pipeline_stage_move_pkey" PRIMARY KEY("id"),
	CONSTRAINT "pipeline_stage_move_from_label" CHECK (((from_stage_id IS NULL) = (from_label IS NULL))),
	CONSTRAINT "pipeline_stage_move_reason" CHECK (((reason IS NULL AND from_stage_id IS NULL) OR ((length(btrim(reason)) >= 1) AND (length(reason) <= 1000))))
);
--> statement-breakpoint
ALTER TABLE "pipeline_stage_move" ADD CONSTRAINT "pipeline_stage_move_audit" FOREIGN KEY ("id","organization_id") REFERENCES "audit_event"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage_move" ADD CONSTRAINT "pipeline_stage_move_person" FOREIGN KEY ("pipeline_person_id","organization_id") REFERENCES "pipeline_person"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage_move" ADD CONSTRAINT "pipeline_stage_move_from" FOREIGN KEY ("from_stage_id","organization_id") REFERENCES "pipeline_stage"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage_move" ADD CONSTRAINT "pipeline_stage_move_to" FOREIGN KEY ("to_stage_id","organization_id") REFERENCES "pipeline_stage"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_stage_move_person_idx" ON "pipeline_stage_move" USING btree ("pipeline_person_id","organization_id");--> statement-breakpoint
CREATE INDEX "pipeline_stage_move_from_idx" ON "pipeline_stage_move" USING btree ("from_stage_id");--> statement-breakpoint
CREATE INDEX "pipeline_stage_move_to_idx" ON "pipeline_stage_move" USING btree ("to_stage_id");--> statement-breakpoint
-- A move row is written once with its audit event and never rewritten. Removing an organization person removes it.
REVOKE ALL ON "pipeline_stage_move" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT ON "pipeline_stage_move" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "pipeline_stage_move" TO everyfield_cleanup;
