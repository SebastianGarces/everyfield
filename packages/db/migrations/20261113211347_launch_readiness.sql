ALTER TABLE "launch_milestone" ALTER COLUMN "source_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "launch_milestone" ADD COLUMN "template_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "launch_milestone" ADD COLUMN "completed_by" uuid;--> statement-breakpoint
ALTER TABLE "launch_milestone" ADD COLUMN "completed_task_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "launch_task_key" text;--> statement-breakpoint
ALTER TABLE "launch_milestone" ADD CONSTRAINT "launch_milestone_fk_3" FOREIGN KEY ("completed_by") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "launch_milestone_ref_1" ON "launch_milestone" USING btree ("completed_by");--> statement-breakpoint
CREATE UNIQUE INDEX "task_uq_5" ON "task" USING btree ("plant_id","launch_task_key") WHERE (launch_task_key IS NOT NULL);--> statement-breakpoint
ALTER TABLE "launch_milestone" ADD CONSTRAINT "launch_milestone_uq_1" UNIQUE("plant_id","template_key");--> statement-breakpoint
ALTER TABLE "launch_milestone" ADD CONSTRAINT "launch_milestone_ck_1" CHECK ((area = ANY (ARRAY['operations'::text, 'launch_team'::text, 'promotion'::text])));--> statement-breakpoint
ALTER TABLE "launch_milestone" ADD CONSTRAINT "launch_milestone_ck_2" CHECK (((completed_by IS NULL) OR (completed_at IS NOT NULL)));