CREATE TABLE "model_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month" date NOT NULL,
	"charged_micro_usd" bigint NOT NULL,
	CONSTRAINT "model_spend_month_key" UNIQUE("month"),
	CONSTRAINT "model_spend_month" CHECK ("model_spend"."month"=date_trunc('month',"model_spend"."month")::date),
	CONSTRAINT "model_spend_charged" CHECK ("model_spend"."charged_micro_usd" >= 0)
);
--> statement-breakpoint
-- Custom: the Evry turn worker reserves and settles monthly model spend.
GRANT SELECT,INSERT,UPDATE ON model_spend TO everyfield_runtime;
