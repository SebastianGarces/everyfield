ALTER TABLE "launch" ADD COLUMN "gathering_path" text DEFAULT 'launch_sunday' NOT NULL;--> statement-breakpoint
ALTER TABLE "launch" ADD COLUMN "gathering_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "launch" ADD COLUMN "gathering_reached_on" date;--> statement-breakpoint
ALTER TABLE "launch" ADD COLUMN "gathering_reached_name" text;--> statement-breakpoint
ALTER TABLE "launch" ADD COLUMN "gathering_note" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "gathering_milestone_offered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "gathering_milestone_name" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "gathering_milestone_description" text;--> statement-breakpoint
ALTER TABLE "launch" ADD CONSTRAINT "launch_gathering_organization" FOREIGN KEY ("gathering_organization_id") REFERENCES "organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "launch_gathering_organization_idx" ON "launch" USING btree ("gathering_organization_id");--> statement-breakpoint
ALTER TABLE "launch" ADD CONSTRAINT "launch_gathering_path" CHECK ((gathering_path = ANY (ARRAY['launch_sunday'::text, 'milestone'::text])));--> statement-breakpoint
ALTER TABLE "launch" ADD CONSTRAINT "launch_gathering_sunday" CHECK (((gathering_path = 'milestone'::text) OR ((gathering_organization_id IS NULL) AND (gathering_reached_on IS NULL))));--> statement-breakpoint
ALTER TABLE "launch" ADD CONSTRAINT "launch_gathering_reached" CHECK ((((gathering_reached_on IS NULL) = (gathering_reached_name IS NULL)) AND ((gathering_reached_on IS NOT NULL) OR (gathering_note IS NULL))));--> statement-breakpoint
ALTER TABLE "launch" ADD CONSTRAINT "launch_gathering_lengths" CHECK ((((gathering_reached_name IS NULL) OR (length(gathering_reached_name) <= 120)) AND ((gathering_note IS NULL) OR (length(gathering_note) <= 2000))));--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_gathering_milestone" CHECK ((((NOT gathering_milestone_offered) OR (gathering_milestone_name IS NOT NULL)) AND ((gathering_milestone_name IS NULL) OR ((length(btrim(gathering_milestone_name)) > 0) AND (length(gathering_milestone_name) <= 120))) AND ((gathering_milestone_description IS NULL) OR (length(gathering_milestone_description) <= 2000))));