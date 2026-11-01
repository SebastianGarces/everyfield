ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "document" DROP CONSTRAINT "document_ck_1";--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "template_id" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "document_class" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "use_church_branding" boolean;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "input_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "document_revision" ADD COLUMN "author_account_id" uuid;--> statement-breakpoint
ALTER TABLE "generated_document" ADD COLUMN "source_document_id" uuid;--> statement-breakpoint
ALTER TABLE "generated_document" ADD COLUMN "source_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "generated_document" ADD COLUMN "theme_kind" text;--> statement-breakpoint
ALTER TABLE "generated_document" ADD COLUMN "theme_primary" text;--> statement-breakpoint
ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_author_fk" FOREIGN KEY ("author_account_id") REFERENCES "account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_document" ADD CONSTRAINT "generated_document_source_document_fk" FOREIGN KEY ("source_document_id","tenant_id") REFERENCES "document"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_document" ADD CONSTRAINT "generated_document_source_revision_fk" FOREIGN KEY ("source_revision_id","tenant_id") REFERENCES "document_revision"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generated_document_source_ref" ON "generated_document" USING btree ("source_document_id","tenant_id");--> statement-breakpoint
CREATE INDEX "generated_document_source_revision_ref" ON "generated_document" USING btree ("source_revision_id","tenant_id");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','audit.imported','branding.changed','communication.approved','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','documents.archived','documents.branding_changed','documents.copied','documents.created_from_template','documents.designated','documents.exported','documents.generated','documents.imported','documents.purged','documents.saved','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','execution.cancelled','execution.completed','execution.partial','execution.reconciled','execution.started','feedback.publication_intended','feedback.published','feedback.received','feedback.reconciled','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.credential_reconciled','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','intelligence.feedback_recorded','intelligence.published','intelligence.requested','intelligence.superseded','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','launch.corrected','launch.debrief_submitted','launch.outcome_recorded','launch.summary_published','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','note_correction','organization.profile_changed','people.corrected','people.created','people.merged','people.recorded','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','security.access_denied','security.audit_exported','security.audit_inspected','security.bulk_export','security.operator_accessed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_church" CHECK (((kind = 'church_document') = (template_id IS NOT NULL)) AND ((kind = 'church_document') = (template_version IS NOT NULL)) AND ((kind = 'church_document') = (document_class IS NOT NULL)) AND ((kind = 'church_document') = (use_church_branding IS NOT NULL)) AND ((kind = 'church_document') = (input_provenance IS NOT NULL)) AND ((template_version IS NULL) OR (template_version >= 1)) AND ((input_provenance IS NULL) OR (octet_length(input_provenance::text) <= 65536)));--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_ck_1" CHECK ((kind = ANY (ARRAY['native'::text, 'core_values'::text, 'launch_summary'::text, 'church_document'::text])));--> statement-breakpoint
ALTER TABLE "generated_document" ADD CONSTRAINT "generated_document_source" CHECK (((source_document_id IS NULL) = (source_revision_id IS NULL)) AND ((source_document_id IS NULL) = (theme_kind IS NULL)) AND ((theme_primary IS NULL) OR (theme_primary ~ '^#[0-9A-F]{6}$'::text)));--> statement-breakpoint
-- A Church Document keeps the template it was made from. Its branding toggle is the only field that changes.
CREATE TRIGGER immutable_template BEFORE UPDATE ON "document" FOR EACH ROW EXECUTE FUNCTION freeze_fields('template_id,template_version,document_class,input_provenance');
--> statement-breakpoint
-- An export keeps the document revision and the theme it was made from, with the other frozen fields.
DROP TRIGGER immutable_source ON "generated_document";
--> statement-breakpoint
CREATE TRIGGER immutable_source BEFORE UPDATE ON "generated_document" FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,tenant_id,template_id,template_version,saved_template_name,renderer_version,format,object_id,inputs,download_name,generated_at,request_key,source_document_id,source_revision_id,theme_kind,theme_primary');
--> statement-breakpoint
-- Plant purge deletes the saved exports before the documents and revisions they name.
DO $patch$
DECLARE def text; patched text;
BEGIN
 def := pg_get_functiondef('settings_purge_content(uuid,uuid,bigint)'::regprocedure);
 patched := replace(def, E'  BEGIN\n   DELETE FROM "document" WHERE tenant_id=s;', E'  BEGIN\n   DELETE FROM "generated_document" WHERE tenant_id=s;\n   GET DIAGNOSTICS n=ROW_COUNT; removed=removed+n;\n  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN NULL; END;\n  BEGIN\n   DELETE FROM "document" WHERE tenant_id=s;');
 IF patched = def THEN
  RAISE EXCEPTION 'settings_purge_content patch did not apply';
 END IF;
 EXECUTE patched;
END
$patch$;
