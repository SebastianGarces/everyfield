CREATE TABLE "communication" (
	"id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"author_id" uuid,
	"revision" bigint DEFAULT 1 NOT NULL,
	"state" text NOT NULL,
	"subject" text,
	"body_html" text,
	"body_text" text,
	"template_id" uuid,
	"template_source" text,
	"meeting_id" uuid,
	"audience" jsonb DEFAULT '{"groups":[],"teamIds":[],"personIds":[]}'::jsonb NOT NULL,
	"review_digest" text,
	"scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "communication_pkey" PRIMARY KEY("id"),
	CONSTRAINT "communication_uq_0" UNIQUE("id","plant_id"),
	CONSTRAINT "communication_ck_0" CHECK ((revision >= 1)),
	CONSTRAINT "communication_ck_1" CHECK ((state = ANY (ARRAY['draft'::text, 'reviewed'::text, 'scheduled'::text]))),
	CONSTRAINT "communication_ck_2" CHECK (((subject IS NULL) OR ((length(btrim(subject)) >= 1) AND (length(btrim(subject)) <= 500)))),
	CONSTRAINT "communication_ck_3" CHECK (((body_html IS NULL) OR (length(btrim(body_html)) >= 1))),
	CONSTRAINT "communication_ck_4" CHECK (((state <> 'scheduled'::text) OR ((scheduled_at IS NOT NULL) AND (subject IS NOT NULL) AND (body_html IS NOT NULL)))),
	CONSTRAINT "communication_ck_5" CHECK ((jsonb_typeof(audience) = 'object'::text)),
	CONSTRAINT "communication_ck_6" CHECK (((template_source IS NULL) OR ((length(template_source) >= 1) AND (length(template_source) <= 80))))
);
--> statement-breakpoint
CREATE TABLE "message_template" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plant_id" uuid NOT NULL,
	"source_key" text,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"meeting_type" text,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text NOT NULL,
	"archived_at" timestamp with time zone,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "message_template_pkey" PRIMARY KEY("id"),
	CONSTRAINT "message_template_uq_0" UNIQUE("id","plant_id"),
	CONSTRAINT "message_template_ck_0" CHECK ((revision >= 1)),
	CONSTRAINT "message_template_ck_1" CHECK ((category = ANY (ARRAY['meeting_invitation'::text, 'meeting_reminder'::text, 'follow_up'::text, 'announcement'::text]))),
	CONSTRAINT "message_template_ck_2" CHECK ((meeting_type = ANY (ARRAY['vision_meeting'::text, 'orientation'::text, 'team_meeting'::text]))),
	CONSTRAINT "message_template_ck_3" CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 255))),
	CONSTRAINT "message_template_ck_4" CHECK (((description IS NULL) OR (length(description) <= 1000))),
	CONSTRAINT "message_template_ck_5" CHECK (((length(btrim(subject)) >= 1) AND (length(btrim(subject)) <= 500))),
	CONSTRAINT "message_template_ck_6" CHECK ((length(btrim(body_html)) >= 1)),
	CONSTRAINT "message_template_ck_7" CHECK (((meeting_type IS NULL) OR (category = 'meeting_invitation'::text))),
	CONSTRAINT "message_template_ck_8" CHECK (((source_key IS NULL) OR ((length(source_key) >= 1) AND (length(source_key) <= 80))))
);
--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_fk_0" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_fk_1" FOREIGN KEY ("author_id") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_fk_2" FOREIGN KEY ("template_id","plant_id") REFERENCES "message_template"("id","plant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_fk_3" FOREIGN KEY ("meeting_id") REFERENCES "meeting"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication" ADD CONSTRAINT "communication_fk_4" FOREIGN KEY ("id","plant_id") REFERENCES "record"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_fk_0" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_fk_1" FOREIGN KEY ("id","plant_id") REFERENCES "record"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "communication_ref_0" ON "communication" USING btree ("plant_id");--> statement-breakpoint
CREATE INDEX "communication_ref_1" ON "communication" USING btree ("template_id","plant_id");--> statement-breakpoint
CREATE INDEX "communication_ref_2" ON "communication" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "message_template_ref_0" ON "message_template" USING btree ("plant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_uq_1" ON "message_template" USING btree ("plant_id","source_key") WHERE (source_key IS NOT NULL);
--> statement-breakpoint
-- WP-027: a draft and a plant template bind a record in the same plant.
ALTER TABLE "communication" ALTER CONSTRAINT "communication_fk_0" DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "communication" ALTER CONSTRAINT "communication_fk_1" DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "communication" ALTER CONSTRAINT "communication_fk_2" DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "communication" ALTER CONSTRAINT "communication_fk_3" DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "communication" ALTER CONSTRAINT "communication_fk_4" DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "message_template" ALTER CONSTRAINT "message_template_fk_0" DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "message_template" ALTER CONSTRAINT "message_template_fk_1" DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION communication_bind_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE actual_owner uuid;
BEGIN
  actual_owner := NEW.plant_id;
  
  IF TG_OP='UPDATE' AND NEW.id <> OLD.id THEN RAISE EXCEPTION 'immutable_record_id' USING ERRCODE='23514'; END IF;
  INSERT INTO record(id,kind,tenant_id) VALUES (NEW.id,'communication',actual_owner) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM record WHERE id=NEW.id AND kind='communication' AND tenant_id=actual_owner FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_subtype_owner_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION communication_bind_record() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bind_record AFTER INSERT OR UPDATE ON "communication" FOR EACH ROW EXECUTE FUNCTION communication_bind_record();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assert_record_binding AFTER INSERT OR UPDATE ON "communication" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_record_binding('"plant_id"');
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON "communication" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON "communication" TO everyfield_cleanup;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION message_template_bind_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path FROM CURRENT
AS $function$
DECLARE actual_owner uuid;
BEGIN
  actual_owner := NEW.plant_id;
  
  IF TG_OP='UPDATE' AND NEW.id <> OLD.id THEN RAISE EXCEPTION 'immutable_record_id' USING ERRCODE='23514'; END IF;
  INSERT INTO record(id,kind,tenant_id) VALUES (NEW.id,'message_template',actual_owner) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM record WHERE id=NEW.id AND kind='message_template' AND tenant_id=actual_owner FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'record_subtype_owner_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION message_template_bind_record() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bind_record AFTER INSERT OR UPDATE ON "message_template" FOR EACH ROW EXECUTE FUNCTION message_template_bind_record();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assert_record_binding AFTER INSERT OR UPDATE ON "message_template" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_record_binding('"plant_id"');
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON "message_template" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON "message_template" TO everyfield_cleanup;
