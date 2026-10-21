ALTER TABLE "meeting" ADD COLUMN "evaluation_scores" integer[];--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "evaluation_notes" text;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "evaluated_on" date;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "evaluation_corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "evaluation_revision" bigint;--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_ck_9" CHECK (((evaluation_scores IS NULL) = (evaluated_at IS NULL) AND (evaluated_at IS NULL) = (evaluated_on IS NULL) AND (evaluated_at IS NULL) = (evaluation_revision IS NULL)));--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_ck_10" CHECK (((evaluation_scores IS NULL) OR ((type = 'vision_meeting'::text) AND (cardinality(evaluation_scores) = 8) AND (1 <= ALL (evaluation_scores)) AND (5 >= ALL (evaluation_scores)) AND (evaluation_revision >= 1))));