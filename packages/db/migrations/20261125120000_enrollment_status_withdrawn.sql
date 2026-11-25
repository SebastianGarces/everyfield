ALTER TABLE "development_enrollment" DROP CONSTRAINT "development_enrollment_ck_1";
ALTER TABLE "development_enrollment" ADD CONSTRAINT "development_enrollment_ck_1" CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'withdrawn'::text])));
