CREATE TABLE "church_brand_kit" (
	"tenant_id" uuid NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"primary_color" text,
	"accent_color" text,
	"heading_font" text DEFAULT 'DM Serif Display' NOT NULL,
	"body_font" text DEFAULT 'DM Sans' NOT NULL,
	"legal_name" text,
	"address" text,
	"website" text,
	"phone" text,
	"email" text,
	"ein" text,
	"tagline" text,
	"signer_name" text,
	"signer_title" text,
	"full_logo_object_id" uuid,
	"full_logo_alt" text,
	"full_logo_dark_object_id" uuid,
	"full_logo_dark_alt" text,
	"mark_object_id" uuid,
	"mark_alt" text,
	"mark_dark_object_id" uuid,
	"mark_dark_alt" text,
	"cover_photo_object_id" uuid,
	"cover_photo_alt" text,
	"signature_object_id" uuid,
	"signature_alt" text,
	CONSTRAINT "church_brand_kit_pkey" PRIMARY KEY("tenant_id"),
	CONSTRAINT "church_brand_kit_revision" CHECK ((revision >= 1)),
	CONSTRAINT "church_brand_kit_tenant" CHECK ((tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
	CONSTRAINT "church_brand_kit_colors" CHECK (((primary_color IS NULL) OR (primary_color ~ '^#[0-9A-F]{6}$'::text)) AND ((accent_color IS NULL) OR (accent_color ~ '^#[0-9A-F]{6}$'::text))),
	CONSTRAINT "church_brand_kit_text" CHECK ((char_length(heading_font) <= 60) AND (char_length(body_font) <= 60) AND (char_length(legal_name) <= 200) AND (char_length(address) <= 500) AND (char_length(website) <= 300) AND (char_length(phone) <= 40) AND (char_length(email) <= 200) AND ((ein IS NULL) OR (ein ~ '^[0-9]{2}-[0-9]{7}$'::text)) AND (char_length(tagline) <= 200) AND (char_length(signer_name) <= 120) AND (char_length(signer_title) <= 120)),
	CONSTRAINT "church_brand_kit_full_logo_alt" CHECK (((full_logo_object_id IS NULL) = (full_logo_alt IS NULL)) AND ((full_logo_alt IS NULL) OR (char_length(btrim(full_logo_alt)) BETWEEN 1 AND 300))),
	CONSTRAINT "church_brand_kit_full_logo_dark_alt" CHECK (((full_logo_dark_object_id IS NULL) = (full_logo_dark_alt IS NULL)) AND ((full_logo_dark_alt IS NULL) OR (char_length(btrim(full_logo_dark_alt)) BETWEEN 1 AND 300))),
	CONSTRAINT "church_brand_kit_mark_alt" CHECK (((mark_object_id IS NULL) = (mark_alt IS NULL)) AND ((mark_alt IS NULL) OR (char_length(btrim(mark_alt)) BETWEEN 1 AND 300))),
	CONSTRAINT "church_brand_kit_mark_dark_alt" CHECK (((mark_dark_object_id IS NULL) = (mark_dark_alt IS NULL)) AND ((mark_dark_alt IS NULL) OR (char_length(btrim(mark_dark_alt)) BETWEEN 1 AND 300))),
	CONSTRAINT "church_brand_kit_cover_photo_alt" CHECK (((cover_photo_object_id IS NULL) = (cover_photo_alt IS NULL)) AND ((cover_photo_alt IS NULL) OR (char_length(btrim(cover_photo_alt)) BETWEEN 1 AND 300))),
	CONSTRAINT "church_brand_kit_signature_alt" CHECK (((signature_object_id IS NULL) = (signature_alt IS NULL)) AND ((signature_alt IS NULL) OR (char_length(btrim(signature_alt)) BETWEEN 1 AND 300)))
);
--> statement-breakpoint
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "file_object" DROP CONSTRAINT "file_object_ck_1";--> statement-breakpoint
ALTER TABLE "church_brand_kit" ADD CONSTRAINT "church_brand_kit_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "church_brand_kit" ADD CONSTRAINT "church_brand_kit_full_logo_fk" FOREIGN KEY ("full_logo_object_id","tenant_id") REFERENCES "file_object"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "church_brand_kit" ADD CONSTRAINT "church_brand_kit_full_logo_dark_fk" FOREIGN KEY ("full_logo_dark_object_id","tenant_id") REFERENCES "file_object"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "church_brand_kit" ADD CONSTRAINT "church_brand_kit_mark_fk" FOREIGN KEY ("mark_object_id","tenant_id") REFERENCES "file_object"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "church_brand_kit" ADD CONSTRAINT "church_brand_kit_mark_dark_fk" FOREIGN KEY ("mark_dark_object_id","tenant_id") REFERENCES "file_object"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "church_brand_kit" ADD CONSTRAINT "church_brand_kit_cover_photo_fk" FOREIGN KEY ("cover_photo_object_id","tenant_id") REFERENCES "file_object"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "church_brand_kit" ADD CONSTRAINT "church_brand_kit_signature_fk" FOREIGN KEY ("signature_object_id","tenant_id") REFERENCES "file_object"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "church_brand_kit_full_logo_ref" ON "church_brand_kit" USING btree ("full_logo_object_id");--> statement-breakpoint
CREATE INDEX "church_brand_kit_full_logo_dark_ref" ON "church_brand_kit" USING btree ("full_logo_dark_object_id");--> statement-breakpoint
CREATE INDEX "church_brand_kit_mark_ref" ON "church_brand_kit" USING btree ("mark_object_id");--> statement-breakpoint
CREATE INDEX "church_brand_kit_mark_dark_ref" ON "church_brand_kit" USING btree ("mark_dark_object_id");--> statement-breakpoint
CREATE INDEX "church_brand_kit_cover_photo_ref" ON "church_brand_kit" USING btree ("cover_photo_object_id");--> statement-breakpoint
CREATE INDEX "church_brand_kit_signature_ref" ON "church_brand_kit" USING btree ("signature_object_id");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','audit.imported','branding.changed','communication.approved','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','documents.archived','documents.copied','documents.designated','documents.generated','documents.imported','documents.purged','documents.saved','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','execution.cancelled','execution.completed','execution.partial','execution.reconciled','execution.started','feedback.publication_intended','feedback.published','feedback.received','feedback.reconciled','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.credential_reconciled','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','intelligence.feedback_recorded','intelligence.published','intelligence.requested','intelligence.superseded','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','launch.corrected','launch.debrief_submitted','launch.outcome_recorded','launch.summary_published','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','note_correction','organization.profile_changed','people.corrected','people.created','people.merged','people.recorded','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','security.access_denied','security.audit_exported','security.audit_inspected','security.bulk_export','security.operator_accessed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));--> statement-breakpoint
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_ck_1" CHECK ((purpose = ANY (ARRAY['avatar'::text, 'person_photo'::text, 'commitment'::text, 'generated'::text, 'native_import'::text, 'assistant_staging'::text, 'communication_attachment'::text, 'brand_asset'::text])));
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON "church_brand_kit" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT ON "church_brand_kit" TO everyfield_cleanup;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION file_is_referenced(object_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path FROM CURRENT
AS $function$ SELECT EXISTS (SELECT 1 FROM "account" WHERE "avatar_object_id" = $1 UNION ALL SELECT 1 FROM "person" WHERE "photo_object_id" = $1 UNION ALL SELECT 1 FROM "commitment" WHERE "object_id" = $1 UNION ALL SELECT 1 FROM "document_revision" WHERE "import_object_id" = $1 UNION ALL SELECT 1 FROM "generated_document" WHERE "object_id" = $1 UNION ALL SELECT 1 FROM "church_brand_kit" WHERE "full_logo_object_id" = $1 UNION ALL SELECT 1 FROM "church_brand_kit" WHERE "full_logo_dark_object_id" = $1 UNION ALL SELECT 1 FROM "church_brand_kit" WHERE "mark_object_id" = $1 UNION ALL SELECT 1 FROM "church_brand_kit" WHERE "mark_dark_object_id" = $1 UNION ALL SELECT 1 FROM "church_brand_kit" WHERE "cover_photo_object_id" = $1 UNION ALL SELECT 1 FROM "church_brand_kit" WHERE "signature_object_id" = $1) $function$;
--> statement-breakpoint
-- Plant purge deletes the kit with the other plant-owned rows. The current purge function is patched where it deletes
-- the saved renders, so the kit row goes in the same pass and the same completeness check.
DO $patch$
DECLARE def text;
BEGIN
 def := pg_get_functiondef('settings_purge_content(uuid,uuid,bigint)'::regprocedure);
 def := replace(def, E'  BEGIN\n   DELETE FROM "generated_document" WHERE tenant_id=s;', E'  BEGIN\n   DELETE FROM "church_brand_kit" WHERE tenant_id=s;\n   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;\n  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;\n  BEGIN\n   DELETE FROM "generated_document" WHERE tenant_id=s;');
 def := replace(def, E' IF EXISTS(SELECT FROM "generated_document" WHERE tenant_id=s)', E' IF EXISTS(SELECT FROM "church_brand_kit" WHERE tenant_id=s) THEN RAISE EXCEPTION \'incomplete_owned_cleanup:church_brand_kit\' USING ERRCODE=\'23514\'; END IF;\n IF EXISTS(SELECT FROM "generated_document" WHERE tenant_id=s)');
 IF position('church_brand_kit' in def) = 0 OR (length(def) - length(replace(def, 'church_brand_kit', ''))) / length('church_brand_kit') <> 3 THEN
  RAISE EXCEPTION 'settings_purge_content patch did not apply';
 END IF;
 EXECUTE def;
END
$patch$;
