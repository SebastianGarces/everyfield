CREATE TABLE "assessment_release" (
	"run_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	"cause" text NOT NULL,
	"request_key" uuid,
	CONSTRAINT "assessment_release_pkey" PRIMARY KEY("run_id"),
	CONSTRAINT "assessment_release_cause" CHECK ((cause = ANY (ARRAY['opened'::text, 'elapsed_72_hours'::text])))
);
CREATE TABLE "network_reference" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"rubric_version" text NOT NULL,
	"content_hash" text NOT NULL,
	"state" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"activation_number" integer,
	"activated_at" timestamp with time zone,
	CONSTRAINT "network_reference_pkey" PRIMARY KEY("id"),
	CONSTRAINT "network_reference_activation" UNIQUE("activation_number"),
	CONSTRAINT "network_reference_state" CHECK ((state = ANY (ARRAY['building'::text, 'validated'::text, 'failed'::text]))),
	CONSTRAINT "network_reference_activated" CHECK ((((activation_number IS NULL) = (activated_at IS NULL)) AND ((activation_number IS NULL) OR ((activation_number >= 1) AND (state = 'validated'::text)))))
);
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";
ALTER TABLE "network_intelligence_plant" ADD COLUMN "affiliation_revision" bigint;
ALTER TABLE "network_intelligence_plant" ADD COLUMN "released_run_id" uuid;
ALTER TABLE "network_intelligence_run" ADD COLUMN "outcome" text DEFAULT 'published'::text NOT NULL;
ALTER TABLE "network_intelligence_run" ADD COLUMN "claim_generation" integer DEFAULT 1 NOT NULL;
ALTER TABLE "network_intelligence_run" ADD COLUMN "lease_owner" text;
ALTER TABLE "network_intelligence_run" ADD COLUMN "lease_until" timestamp with time zone;
ALTER TABLE "network_intelligence_run" ADD COLUMN "reference_activation" integer;
ALTER TABLE "network_intelligence_run" ADD COLUMN "violations" jsonb;
ALTER TABLE "network_intelligence_run" ADD COLUMN "settled_at" timestamp with time zone;
ALTER TABLE "assessment_release" ADD CONSTRAINT "assessment_release_run" FOREIGN KEY ("run_id","plant_id") REFERENCES "assessment_run"("id","plant_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "assessment_release" ADD CONSTRAINT "assessment_release_plant" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "assessment_release_plant_idx" ON "assessment_release" USING btree ("plant_id","released_at");
ALTER TABLE "network_intelligence_plant" ADD CONSTRAINT "network_intelligence_plant_released" FOREIGN KEY ("released_run_id") REFERENCES "assessment_run"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','branding.changed','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','development.enrolled','development.enrollment_updated','development.feedback_recorded','development.milestone_confirmed','development.milestone_marked','development.milestone_recorded','development.plan_saved','development.program_created','development.version_applied','development.version_published','documents.archived','documents.church_archived','documents.church_restored','documents.branding_changed','documents.copied','documents.created_from_template','documents.designated','documents.export_deleted','documents.exported','documents.generated','documents.imported','documents.purged','documents.saved','documents.template_deleted','documents.template_details_changed','documents.template_saved','documents.template_updated','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','feedback.publication_held','feedback.publication_intended','feedback.publication_unknown','feedback.published','feedback.received','feedback.status_changed','files.finalized','flags.changed','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','intelligence.assessed','intelligence.assessment_opened','intelligence.feedback_saved','intelligence.refresh_requested','intelligence.released','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','launch.corrected','launch.debrief_submitted','launch.outcome_recorded','launch.summary_published','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','organization.profile_changed','people.corrected','people.created','people.duplicate_dismissed','people.duplicate_restored','people.merged','people.recorded','people.removed','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));
ALTER TABLE "network_intelligence_run" ADD CONSTRAINT "network_intelligence_run_outcome" CHECK ((outcome = ANY (ARRAY['pending'::text, 'deferred'::text, 'published'::text, 'failed'::text, 'degraded'::text, 'superseded'::text])));
ALTER TABLE "network_intelligence_run" ADD CONSTRAINT "network_intelligence_run_claim" CHECK (((claim_generation >= 1) AND ((lease_owner IS NULL) = (lease_until IS NULL))));
INSERT INTO "assessment_release" (run_id, plant_id, released_at, cause)
SELECT r.id, r.plant_id, least(r.available_at + interval '72 hours', s.seen_at),
	CASE WHEN s.seen_at IS NOT NULL AND s.seen_at <= r.available_at + interval '72 hours' THEN 'opened' ELSE 'elapsed_72_hours' END
FROM "assessment_run" r
LEFT JOIN LATERAL (SELECT min(x.seen_at) AS seen_at FROM "assessment_seen" x WHERE x.run_id = r.id) s ON true
WHERE r.outcome = 'published' AND r.available_at IS NOT NULL
	AND least(r.available_at + interval '72 hours', s.seen_at) <= clock_timestamp();
UPDATE "network_intelligence_plant" c SET released_run_id = (SELECT x.run_id FROM "assessment_release" x
	JOIN "assessment_run" r ON r.id = x.run_id WHERE x.plant_id = c.plant_id AND x.released_at <= n.ran_at
	ORDER BY r.available_at DESC, r.id DESC LIMIT 1)
FROM "network_intelligence_run" n WHERE n.id = c.run_id;
INSERT INTO "network_reference" (rubric_version, content_hash, state, activation_number, activated_at)
VALUES ('everyfield-network/v1', 'cd2966f38295df547930bb3a767bd5d4704dac14c7e5813ebe9a30ac4c04effd', 'validated', 1, clock_timestamp());
UPDATE "network_intelligence_run" SET reference_activation = 1, settled_at = ran_at;
REVOKE ALL ON "assessment_release", "network_reference" FROM everyfield_runtime, everyfield_cleanup;
GRANT SELECT,INSERT ON "assessment_release" TO everyfield_runtime;
GRANT SELECT,DELETE ON "assessment_release" TO everyfield_cleanup;
GRANT SELECT,INSERT,UPDATE ON "network_reference" TO everyfield_runtime;
GRANT SELECT ON "network_reference" TO everyfield_cleanup;
GRANT UPDATE ON "network_intelligence_run" TO everyfield_runtime;
