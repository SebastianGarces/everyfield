-- Each sending goal counts from a day (D-1263) and holds up to 4 chosen counts by fixed stage kind (D-1264). A goal
-- saved before this change counts from the day it was added, in its organization's time zone.
ALTER TABLE "sending_goal" ADD COLUMN "counting_from" date;--> statement-breakpoint
UPDATE "sending_goal" g SET "counting_from"=(g.created_at AT TIME ZONE o.timezone)::date FROM "organization" o
 WHERE o.id=g.organization_id;--> statement-breakpoint
ALTER TABLE "sending_goal" ALTER COLUMN "counting_from" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sending_goal" ADD COLUMN "counts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sending_goal" ADD CONSTRAINT "sending_goal_counts" CHECK (CASE WHEN (jsonb_typeof(counts) = 'array'::text) THEN (jsonb_array_length(counts) <= 4) ELSE false END);
