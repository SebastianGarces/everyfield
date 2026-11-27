CREATE TABLE "evry_question_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"questions" integer NOT NULL,
	CONSTRAINT "evry_question_day_key" UNIQUE("account_id","day"),
	CONSTRAINT "evry_question_day_questions" CHECK ("evry_question_day"."questions" >= 0)
);
ALTER TABLE "evry_question_day" ADD CONSTRAINT "evry_question_day_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE cascade ON UPDATE no action;
REVOKE ALL ON "evry_question_day" FROM everyfield_runtime, everyfield_cleanup;
GRANT SELECT,INSERT,UPDATE ON "evry_question_day" TO everyfield_runtime;
