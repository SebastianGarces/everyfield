-- contract: no code has read or written lifecycle_witness.seat_id or affiliation_id since T-581, and no witness kind can set them; ck_1 and ck_6 already allow at most one of account_id and plant_id (D-2292), so ck_5 is dropped, not rewritten.
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_ck_5";
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_ck_7";
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_ck_8";
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_fk_3";
ALTER TABLE "lifecycle_witness" DROP CONSTRAINT "lifecycle_witness_fk_4";
DROP INDEX "lifecycle_witness_ref_3";
DROP INDEX "lifecycle_witness_ref_4";
ALTER TABLE "lifecycle_witness" DROP COLUMN "seat_id";
ALTER TABLE "lifecycle_witness" DROP COLUMN "affiliation_id";