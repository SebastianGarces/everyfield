CREATE TABLE "task_assignee" (
	"plant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_assignee_pkey" PRIMARY KEY("task_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "obligation" DROP CONSTRAINT "obligation_fk_3";
--> statement-breakpoint
ALTER TABLE "task" DROP CONSTRAINT "task_fk_2";
--> statement-breakpoint
DROP INDEX "obligation_ref_3";--> statement-breakpoint
DROP INDEX "task_ref_2";--> statement-breakpoint
ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_fk_0" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_fk_1" FOREIGN KEY ("task_id","plant_id") REFERENCES "task"("id","plant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignee" ADD CONSTRAINT "task_assignee_fk_2" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_assignee_ref_0" ON "task_assignee" USING btree ("plant_id");--> statement-breakpoint
CREATE INDEX "task_assignee_ref_2" ON "task_assignee" USING btree ("account_id","plant_id");--> statement-breakpoint
-- Every non-null single assignee becomes one row of the set; unassigned tasks get none.
INSERT INTO "task_assignee" ("plant_id","task_id","account_id") SELECT "plant_id","id","assignee_id" FROM "task" WHERE "assignee_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "obligation" DROP COLUMN "assignee_id";--> statement-breakpoint
ALTER TABLE "task" DROP COLUMN "assignee_id";
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON "task_assignee" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON "task_assignee" TO everyfield_cleanup;
--> statement-breakpoint
-- Account purge now removes the account from every assignee set instead of nulling the dropped columns, and plant
-- purge deletes the sets with the other plant-owned rows, before the tasks they name.
DO $patch$
DECLARE def text;
BEGIN
 def := pg_get_functiondef('settings_purge_content(uuid,uuid,bigint)'::regprocedure);
 def := replace(def, E' UPDATE "obligation" SET "assignee_id"=NULL WHERE "assignee_id"=s;\n', '');
 def := replace(def, E' UPDATE "task" SET "assignee_id"=NULL WHERE "assignee_id"=s;\n', E' DELETE FROM "task_assignee" WHERE "account_id"=s;\n');
 def := replace(def, E'  BEGIN\n   DELETE FROM "team" WHERE', E'  BEGIN\n   DELETE FROM "task_assignee" WHERE (w.kind=\'plant\' AND (plant_id=s));\n   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;\n  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;\n  BEGIN\n   DELETE FROM "team" WHERE');
 def := replace(def, E' IF EXISTS(SELECT FROM "team" WHERE', E' IF EXISTS(SELECT FROM "task_assignee" WHERE (w.kind=\'plant\' AND (plant_id=s))) THEN RAISE EXCEPTION \'incomplete_owned_cleanup:task_assignee\' USING ERRCODE=\'23514\'; END IF;\n IF EXISTS(SELECT FROM "team" WHERE');
 IF position('assignee_id' in def) <> 0 OR (length(def) - length(replace(def, 'task_assignee', ''))) / length('task_assignee') <> 4 THEN
  RAISE EXCEPTION 'settings_purge_content patch did not apply';
 END IF;
 EXECUTE def;
END
$patch$;
