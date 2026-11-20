ALTER TABLE "development_enrollment" DROP CONSTRAINT "development_enrollment_ck_1";--> statement-breakpoint
ALTER TABLE "development_enrollment" ADD CONSTRAINT "development_enrollment_ck_1" CHECK ((status = 'active'::text));--> statement-breakpoint
-- An enrollment is only ever active (R-33), so removal on request deletes every enrollment and keeps no completion count.
CREATE OR REPLACE FUNCTION remove_organization_person(org uuid,subject uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE members uuid[]; m uuid; moves int; conversations int; marks int; feedback int; enrollments int;
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
 DELETE FROM development_enrollment WHERE organization_id=org AND person_id=ANY(members);
 GET DIAGNOSTICS enrollments = ROW_COUNT;
 DELETE FROM person_merge WHERE tenant_id=org AND (source_id=ANY(members) OR survivor_id=ANY(members));
 UPDATE person SET merged_into_person_id=NULL WHERE tenant_id=org AND id=ANY(members) AND merged_into_person_id IS NOT NULL;
 RETURN jsonb_build_object('stageMoves',moves,'conversations',conversations,'milestoneMarks',marks,'feedback',feedback,
  'enrollments',enrollments,'mergedRecords',cardinality(members)-1);
END $$;
