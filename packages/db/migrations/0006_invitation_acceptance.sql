CREATE TABLE "identity_operation_result" (
	"operation_id" uuid NOT NULL,
	"receipt" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "identity_operation_result_pkey" PRIMARY KEY("operation_id")
);
--> statement-breakpoint
ALTER TABLE "invitation" ADD COLUMN "inviter_description" text DEFAULT 'EveryField invitation' NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_operation_result" ADD CONSTRAINT "identity_operation_result_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "operation"("id") ON DELETE no action ON UPDATE no action;