-- contract: no code has read or written lifecycle_witness.seat_id or affiliation_id since T-581, and no witness kind can set them; ck_1 and ck_6 already allow at most one of account_id and plant_id (D-2292), so ck_5 is dropped, not rewritten.
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_ck_5";--> statement-breakpoint
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_ck_7";--> statement-breakpoint
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_ck_8";--> statement-breakpoint
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_fk_3";
--> statement-breakpoint
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_fk_4";
--> statement-breakpoint
DROP INDEX "lifecycle_witness_ref_3";--> statement-breakpoint
DROP INDEX "lifecycle_witness_ref_4";--> statement-breakpoint
ALTER TABLE "lifecycle_witness" DROP COLUMN "seat_id";--> statement-breakpoint
ALTER TABLE "lifecycle_witness" DROP COLUMN "affiliation_id";