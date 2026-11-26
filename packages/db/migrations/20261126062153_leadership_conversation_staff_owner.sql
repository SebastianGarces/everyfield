ALTER TABLE "seat" ADD CONSTRAINT "seat_id_organization" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "leadership_conversation" DROP CONSTRAINT "leadership_conversation_staff";--> statement-breakpoint
ALTER TABLE "leadership_conversation" ADD CONSTRAINT "leadership_conversation_staff" FOREIGN KEY ("staff_seat_id","organization_id") REFERENCES "seat"("id","organization_id") ON DELETE restrict ON UPDATE no action;
