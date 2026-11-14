ALTER TABLE "network_intelligence_plant" ADD COLUMN "overdue_followups" integer;--> statement-breakpoint
ALTER TABLE "network_intelligence_plant" ADD COLUMN "unowned_followups" integer;--> statement-breakpoint
ALTER TABLE "network_intelligence_plant" ADD COLUMN "growth_days" integer;--> statement-breakpoint
ALTER TABLE "network_intelligence_plant" ADD COLUMN "required_training" integer;--> statement-breakpoint
ALTER TABLE "network_intelligence_plant" ADD CONSTRAINT "network_intelligence_plant_rule_counts" CHECK (((overdue_followups IS NULL) = (unowned_followups IS NULL)) AND ((overdue_followups IS NULL) OR ((unowned_followups >= 0) AND (unowned_followups <= overdue_followups))) AND ((growth_days IS NULL) OR (growth_days >= 0)) AND ((required_training IS NULL) OR (required_training >= 1)));