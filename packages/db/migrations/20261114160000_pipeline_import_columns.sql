-- The pipeline import's remembered column choices (T-363): each column title an Owner or Admin imported, normalized,
-- with what they chose for it, so the next export of the same form lines up by title without choosing again.
ALTER TABLE "organization" ADD COLUMN "pipeline_import_columns" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_pipeline_import_columns" CHECK ((jsonb_typeof(pipeline_import_columns) = 'object'::text));
