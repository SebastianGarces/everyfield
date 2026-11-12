DROP INDEX "task_uq_2";--> statement-breakpoint
CREATE UNIQUE INDEX "task_uq_2" ON "task" USING btree ("series_id","predecessor_id") WHERE ((predecessor_id IS NOT NULL) AND (deleted_at IS NULL));