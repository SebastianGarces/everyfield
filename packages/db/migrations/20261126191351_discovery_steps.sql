ALTER TABLE "discovery" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "discovery" ADD COLUMN "steps_revision" bigint DEFAULT 1 NOT NULL;
ALTER TABLE "discovery" ADD CONSTRAINT "discovery_ck_5" CHECK ((jsonb_typeof(steps) = 'array'::text));
ALTER TABLE "discovery" ADD CONSTRAINT "discovery_ck_6" CHECK ((steps_revision >= 1));