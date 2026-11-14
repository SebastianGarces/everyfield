ALTER TABLE "audit_event" DROP CONSTRAINT "audit_action";--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_action" CHECK ((action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','branding.changed','communication.draft_deleted','communication.draft_saved','communication.rescheduled','communication.scheduled','communication.send_intended','communication.template_archived','communication.template_created','communication.template_deleted','communication.template_forked','communication.template_updated','deletion.cancelled','deletion.live_purge_completed','development.enrolled','development.feedback_recorded','development.milestone_recorded','development.plan_saved','development.program_created','development.version_applied','development.version_published','documents.archived','documents.church_archived','documents.church_restored','documents.branding_changed','documents.copied','documents.created_from_template','documents.designated','documents.export_deleted','documents.exported','documents.generated','documents.imported','documents.purged','documents.saved','documents.template_deleted','documents.template_details_changed','documents.template_saved','documents.template_updated','evry.conversation_created','evry.proposal_approved','evry.proposal_cancelled','evry.proposal_prepared','evry.proposal_retried','evry.proposal_revised','evry.turn_cancelled','evry.turn_retried','evry.turn_submitted','feedback.received','feedback.status_changed','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','organization.profile_changed','people.corrected','people.created','people.duplicate_dismissed','people.duplicate_restored','people.merged','people.recorded','people.removed','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.bookmark_changed','wiki.hidden','wiki.published','wiki.reading_recorded','wiki.source_order_changed')));--> statement-breakpoint
-- Removal on request (REQ-MUL-005). Once the removal witnesses are written and the Persons retired in the same
-- transaction, this deletes the pipeline rows that hold the person's bodies, which the runtime role may not delete:
-- stage moves with their reasons, leadership conversations, the place on the pipeline, milestone marks, feedback and
-- every enrollment that did not complete. It acts on the subject and every record merged into it, since a merge keeps
-- the source's place on the pipeline where it was, and deletes the merges' reviewed prior values. It scrubs each
-- record's audit trail through purge_organization_person_history, which refuses without the witness. Completed
-- enrollments stay as program completion counts. Returns the counts.
CREATE FUNCTION remove_organization_person(org uuid,subject uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE members uuid[]; m uuid; moves int; conversations int; marks int; feedback int; enrollments int; completions int;
BEGIN
 WITH RECURSIVE g(id) AS (SELECT subject UNION SELECT p.id FROM person p JOIN g ON p.merged_into_person_id=g.id
  WHERE p.tenant_id=org) SELECT array_agg(id) INTO members FROM g;
 FOREACH m IN ARRAY members LOOP PERFORM purge_organization_person_history(org,m); END LOOP;
 DELETE FROM leadership_conversation c USING pipeline_person pp WHERE c.pipeline_person_id=pp.id
  AND c.organization_id=pp.organization_id AND pp.organization_id=org AND pp.person_id=ANY(members);
 GET DIAGNOSTICS conversations = ROW_COUNT;
 DELETE FROM pipeline_stage_move s USING pipeline_person pp WHERE s.pipeline_person_id=pp.id
  AND s.organization_id=pp.organization_id AND pp.organization_id=org AND pp.person_id=ANY(members);
 GET DIAGNOSTICS moves = ROW_COUNT;
 DELETE FROM pipeline_person WHERE organization_id=org AND person_id=ANY(members);
 DELETE FROM assignment_feedback f USING development_enrollment e WHERE f.enrollment_id=e.id
  AND f.organization_id=e.organization_id AND e.organization_id=org AND e.person_id=ANY(members);
 GET DIAGNOSTICS feedback = ROW_COUNT;
 DELETE FROM enrollment_milestone x USING development_enrollment e WHERE x.enrollment_id=e.id
  AND x.organization_id=e.organization_id AND e.organization_id=org AND e.person_id=ANY(members);
 GET DIAGNOSTICS marks = ROW_COUNT;
 DELETE FROM development_enrollment WHERE organization_id=org AND person_id=ANY(members) AND status<>'completed';
 GET DIAGNOSTICS enrollments = ROW_COUNT;
 SELECT count(*) INTO completions FROM development_enrollment WHERE organization_id=org AND person_id=ANY(members);
 DELETE FROM person_merge WHERE tenant_id=org AND (source_id=ANY(members) OR survivor_id=ANY(members));
 UPDATE person SET merged_into_person_id=NULL WHERE tenant_id=org AND id=ANY(members) AND merged_into_person_id IS NOT NULL;
 RETURN jsonb_build_object('stageMoves',moves,'conversations',conversations,'milestoneMarks',marks,'feedback',feedback,
  'enrollments',enrollments,'programCompletions',completions,'mergedRecords',cardinality(members)-1);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION remove_organization_person(uuid,uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION remove_organization_person(uuid,uuid) TO everyfield_runtime;
