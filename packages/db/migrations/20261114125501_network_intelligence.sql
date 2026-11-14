CREATE TABLE "network_intelligence_feedback" (
	"run_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"pattern_key" text NOT NULL,
	"rating" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "network_intelligence_feedback_pkey" PRIMARY KEY("run_id","account_id","pattern_key"),
	CONSTRAINT "network_intelligence_feedback_rating" CHECK ((rating = ANY (ARRAY['useful'::text, 'not_useful'::text]))),
	CONSTRAINT "network_intelligence_feedback_key" CHECK (((length(pattern_key) >= 1) AND (length(pattern_key) <= 200)))
);
--> statement-breakpoint
CREATE TABLE "network_intelligence_plant" (
	"run_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"launched" boolean NOT NULL,
	"days_to_launch" integer,
	"unfilled_roles" integer,
	"outstanding_training" integer,
	"region_item_id" uuid,
	"state_province" text,
	"country" text,
	CONSTRAINT "network_intelligence_plant_pkey" PRIMARY KEY("run_id","plant_id"),
	CONSTRAINT "network_intelligence_plant_counts" CHECK (((unfilled_roles IS NULL) OR (unfilled_roles >= 0)) AND ((outstanding_training IS NULL) OR (outstanding_training >= 0)))
);
--> statement-breakpoint
CREATE TABLE "network_intelligence_run" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"requested_by" uuid,
	"ran_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"rubric_version" text NOT NULL,
	CONSTRAINT "network_intelligence_run_pkey" PRIMARY KEY("id"),
	CONSTRAINT "network_intelligence_run_rubric" CHECK ((rubric_version = 'everyfield-network/v1'::text))
);
--> statement-breakpoint
ALTER TABLE "network_intelligence_feedback" ADD CONSTRAINT "network_intelligence_feedback_run" FOREIGN KEY ("run_id") REFERENCES "network_intelligence_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_intelligence_feedback" ADD CONSTRAINT "network_intelligence_feedback_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_intelligence_plant" ADD CONSTRAINT "network_intelligence_plant_run" FOREIGN KEY ("run_id") REFERENCES "network_intelligence_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_intelligence_plant" ADD CONSTRAINT "network_intelligence_plant_plant" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_intelligence_plant" ADD CONSTRAINT "network_intelligence_plant_region" FOREIGN KEY ("region_item_id") REFERENCES "reference_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_intelligence_run" ADD CONSTRAINT "network_intelligence_run_organization" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_intelligence_run" ADD CONSTRAINT "network_intelligence_run_requester" FOREIGN KEY ("requested_by") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "network_intelligence_feedback_account_idx" ON "network_intelligence_feedback" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "network_intelligence_plant_plant_idx" ON "network_intelligence_plant" USING btree ("plant_id");--> statement-breakpoint
CREATE INDEX "network_intelligence_plant_region_idx" ON "network_intelligence_plant" USING btree ("region_item_id");--> statement-breakpoint
CREATE INDEX "network_intelligence_run_organization_idx" ON "network_intelligence_run" USING btree ("organization_id","ran_at");--> statement-breakpoint
CREATE INDEX "network_intelligence_run_requester_idx" ON "network_intelligence_run" USING btree ("requested_by");--> statement-breakpoint
-- A Network Intelligence run is written once and never changed; a seat's rating of a pattern is its own and may be
-- changed. Removing a plant or an account removes what it contributed or rated.
REVOKE ALL ON "network_intelligence_run", "network_intelligence_plant", "network_intelligence_feedback" FROM everyfield_runtime, everyfield_cleanup;
--> statement-breakpoint
GRANT SELECT,INSERT ON "network_intelligence_run", "network_intelligence_plant" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON "network_intelligence_feedback" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "network_intelligence_run", "network_intelligence_plant", "network_intelligence_feedback" TO everyfield_cleanup;
