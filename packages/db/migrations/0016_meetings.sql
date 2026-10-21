CREATE TABLE "meeting_kit_item" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"plant_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"position" integer NOT NULL,
	"category" text NOT NULL,
	"text" text NOT NULL,
	"assignee_person_id" uuid,
	"checked" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"notes" text,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "meeting_kit_item_pkey" PRIMARY KEY("id"),
	CONSTRAINT "meeting_kit_item_uq_0" UNIQUE("meeting_id","item_key"),
	CONSTRAINT "meeting_kit_item_ck_0" CHECK ((revision >= 1)),
	CONSTRAINT "meeting_kit_item_ck_1" CHECK ((category = ANY (ARRAY['essential'::text, 'materials'::text, 'setup'::text, 'av'::text, 'organization'::text]))),
	CONSTRAINT "meeting_kit_item_ck_2" CHECK ((checked = (checked_at IS NOT NULL))),
	CONSTRAINT "meeting_kit_item_ck_3" CHECK (((char_length(text) >= 1) AND (char_length(text) <= 200))),
	CONSTRAINT "meeting_kit_item_ck_4" CHECK (((notes IS NULL) OR (char_length(notes) <= 1000)))
);
--> statement-breakpoint
ALTER TABLE "meeting" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "agenda" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "agenda_version" integer;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "kit_version" integer;--> statement-breakpoint
ALTER TABLE "meeting" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "rsvp_source" text;--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "rsvp_token_hash" text;--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "rsvp_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "rsvp_token_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "participation" ADD COLUMN "card_occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_kit_item" ADD CONSTRAINT "meeting_kit_item_fk_0" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_kit_item" ADD CONSTRAINT "meeting_kit_item_fk_1" FOREIGN KEY ("meeting_id","plant_id") REFERENCES "meeting"("id","plant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_kit_item" ADD CONSTRAINT "meeting_kit_item_fk_2" FOREIGN KEY ("assignee_person_id","plant_id") REFERENCES "person"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_kit_item_ref_0" ON "meeting_kit_item" USING btree ("assignee_person_id","plant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participation_uq_2" ON "participation" USING btree ("rsvp_token_hash");--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_ck_7" CHECK (((type = 'vision_meeting'::text) OR (kit_version IS NULL)));--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_ck_8" CHECK ((jsonb_typeof(agenda) = 'array'::text));--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_ck_7" CHECK ((rsvp_source = ANY (ARRAY['invitation'::text, 'token'::text, 'own'::text, 'admin'::text])));--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_ck_8" CHECK (((rsvp_token_hash IS NULL) = (rsvp_token_expires_at IS NULL)));--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_ck_9" CHECK (((NOT rsvp_token_open) OR (rsvp_token_hash IS NOT NULL)));