-- Nothing writes a withdrawn enrollment, so the state goes (R-33). Completed stays: gate ADR1-005 names it (D-2267).
ALTER TABLE "development_enrollment" DROP CONSTRAINT "development_enrollment_ck_1";--> statement-breakpoint
ALTER TABLE "development_enrollment" ADD CONSTRAINT "development_enrollment_ck_1" CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text])));
