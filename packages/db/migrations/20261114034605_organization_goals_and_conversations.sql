CREATE TABLE "leadership_conversation" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"pipeline_person_id" uuid NOT NULL,
	"staff_seat_id" uuid NOT NULL,
	"occurred_on" date NOT NULL,
	"note" text,
	"revision" bigint NOT NULL,
	CONSTRAINT "leadership_conversation_pkey" PRIMARY KEY("id"),
	CONSTRAINT "leadership_conversation_revision" CHECK ((revision >= 1)),
	CONSTRAINT "leadership_conversation_note" CHECK (((note IS NULL) OR ((length(btrim(note)) >= 1) AND (length(note) <= 1000))))
);
--> statement-breakpoint
CREATE TABLE "sending_goal" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"leader_target" integer NOT NULL,
	"plant_target" integer NOT NULL,
	"target_year" integer NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"revision" bigint NOT NULL,
	CONSTRAINT "sending_goal_pkey" PRIMARY KEY("id"),
	CONSTRAINT "sending_goal_revision" CHECK ((revision >= 1)),
	CONSTRAINT "sending_goal_leader_target" CHECK (((leader_target >= 0) AND (leader_target <= 10000))),
	CONSTRAINT "sending_goal_plant_target" CHECK (((plant_target >= 0) AND (plant_target <= 10000))),
	CONSTRAINT "sending_goal_target_year" CHECK (((target_year >= 2000) AND (target_year <= 2200))),
	CONSTRAINT "sending_goal_rationale" CHECK (((length(btrim(rationale)) >= 1) AND (length(rationale) <= 1000)))
);
--> statement-breakpoint
ALTER TABLE "leadership_conversation" ADD CONSTRAINT "leadership_conversation_person" FOREIGN KEY ("pipeline_person_id","organization_id") REFERENCES "pipeline_person"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leadership_conversation" ADD CONSTRAINT "leadership_conversation_staff" FOREIGN KEY ("staff_seat_id") REFERENCES "seat"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sending_goal" ADD CONSTRAINT "sending_goal_organization" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leadership_conversation_on_idx" ON "leadership_conversation" USING btree ("organization_id","occurred_on");--> statement-breakpoint
CREATE INDEX "leadership_conversation_person_idx" ON "leadership_conversation" USING btree ("pipeline_person_id","organization_id");--> statement-breakpoint
CREATE INDEX "leadership_conversation_staff_idx" ON "leadership_conversation" USING btree ("staff_seat_id");--> statement-breakpoint
CREATE INDEX "sending_goal_organization_idx" ON "sending_goal" USING btree ("organization_id","created_at");--> statement-breakpoint
-- Goals and conversations change only through their revisioned writes. Removing an organization person removes their
-- conversations.
REVOKE ALL ON "sending_goal", "leadership_conversation" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON "sending_goal", "leadership_conversation" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "sending_goal", "leadership_conversation" TO everyfield_cleanup;
