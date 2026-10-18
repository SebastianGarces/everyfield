CREATE TABLE "onboarding_result" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_setup" (
	"plant_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"creation_operation_id" uuid NOT NULL,
	"lead" jsonb NOT NULL,
	"journey" jsonb NOT NULL,
	"launch" jsonb NOT NULL,
	"people_step" text NOT NULL,
	"completed_material_revision" bigint,
	CONSTRAINT "onboarding_setup_account_id_unique" UNIQUE("account_id"),
	CONSTRAINT "onboarding_setup_creation_operation_id_unique" UNIQUE("creation_operation_id"),
	CONSTRAINT "onboarding_people_step" CHECK ("onboarding_setup"."people_step" IN ('pending','saved','skipped')),
	CONSTRAINT "onboarding_completion_revision" CHECK ("onboarding_setup"."completed_material_revision" IS NULL OR "onboarding_setup"."completed_material_revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "plant" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "plant" ADD COLUMN "state_province" text;--> statement-breakpoint
ALTER TABLE "plant" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "onboarding_result" ADD CONSTRAINT "onboarding_result_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_result" ADD CONSTRAINT "onboarding_result_operation" FOREIGN KEY ("operation_id","tenant_id") REFERENCES "operation"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_setup" ADD CONSTRAINT "onboarding_setup_plant_id_plant_id_fk" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_setup" ADD CONSTRAINT "onboarding_setup_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_setup" ADD CONSTRAINT "onboarding_setup_creation_operation_id_operation_id_fk" FOREIGN KEY ("creation_operation_id") REFERENCES "operation"("id") ON DELETE no action ON UPDATE no action;