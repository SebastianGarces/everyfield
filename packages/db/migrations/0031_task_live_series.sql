DROP INDEX "task_uq_1";--> statement-breakpoint
DROP INDEX "task_uq_2";--> statement-breakpoint
CREATE UNIQUE INDEX "task_uq_1" ON "task" USING btree ("series_id","occurrence_key") WHERE ((series_id IS NOT NULL) AND (deleted_at IS NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "task_uq_2" ON "task" USING btree ("predecessor_id") WHERE ((predecessor_id IS NOT NULL) AND (deleted_at IS NULL));