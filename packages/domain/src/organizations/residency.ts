import * as C from "@everyfield/contracts/organizations";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveResidency } from "../access/pipeline.ts";
import { liveAccess, liveRead, type RequestActor } from "../access/session.ts";
import { hash } from "../operations/canonical.ts";
import { declareWrite, lockedWrite, nativeWrite } from "../operations/writes.ts";
import { GLOBAL } from "../wiki/core.ts";
import { answer, parse, refuse, type Executor } from "./seat.ts";

// My residency (REQ-MUL-013, WP-100): a linked resident's own projection of the residency their sending church runs.
// The resident reads it from their own account, never from a seat, and only while the link is live (liveResidency):
// leaving or an ended link removes it on the next request. Each read is one statement with the account's live check
// inside it (C13). It selects only resident-facing fields: no pipeline stage, stage moves, staff notes, outside
// assessment or inactivity flag ever enters these statements.

type Reply<T> = C.ProgramReply<T>;

/** The resident's own account, or null for a seat or any other actor. */
function residentOf(authority: RequestActor) {
	const context = authority.actor.context;
	if (context.kind !== "account" || context.owner.kind !== "account") return null;
	return { accountId: context.owner.id, live: liveRead(liveAccess(authority)) };
}

/** The account's live residency link `l`, newest first, when the account's access is live (`g.allowed`). */
const linkCte = (account: string) => sql`l AS (SELECT l.* FROM residency_link l JOIN g ON g.allowed
 WHERE l.account_id=${account}::uuid AND ${liveResidency} ORDER BY l.accepted_at DESC,l.id LIMIT 1)`;

const MINUTE = `'YYYY-MM-DD"T"HH24:MI:SS'`;

/**
 * The resident's view of their residency: the program, the program stage and next meeting of each active enrollment,
 * the milestones with their completion and the director's feedback on this enrollment, the reading list, and the
 * resident's own sharing choices. The next meeting is in the resident's personal time zone, else the church's.
 */
export async function readMyResidency(db: Executor, authority: RequestActor): Promise<Reply<C.MyResidency>> {
	return answer<C.MyResidency, C.ProgramRefusal>(async () => {
		const me = residentOf(authority);
		if (!me) return C.myResidency.parse({ status: "not_linked" });
		const r = await db.execute(sql`WITH g AS (SELECT ${me.live} AS allowed), ${linkCte(me.accountId)},
o AS (SELECT o.name,coalesce(acc.personal_timezone,o.timezone) AS tz,
 (clock_timestamp() AT TIME ZONE coalesce(acc.personal_timezone,o.timezone))::date AS today,o.timezone AS church_tz
 FROM l JOIN organization o ON o.id=l.organization_id JOIN account acc ON acc.id=l.account_id),
e AS (SELECT e.*,p.name AS program_name,p.kind,p.director_seat_id FROM l JOIN development_enrollment e
 ON e.person_id=l.person_id AND e.organization_id=l.organization_id AND e.status='active'
 JOIN development_program p ON p.id=e.program_id AND p.organization_id=e.organization_id)
SELECT g.allowed,(SELECT jsonb_build_object('linkId',l.id,'organizationName',o.name,'timezone',o.tz,'today',o.today::text,
  'sharing',jsonb_build_object('shareMilestones',l.share_milestones,'shareFoundations',l.share_foundations)) FROM l,o) AS link,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,
  'program',jsonb_build_object('name',e.program_name,'kind',e.kind,'director',(SELECT coalesce(i.display_name,'Your director')
    FROM seat s LEFT JOIN LATERAL seat_identity(s.account_id) i ON true WHERE s.id=e.director_seat_id)),
  'cohort',e.cohort_label,'startedOn',e.started_on::text,'expectedEndOn',e.expected_end_on::text,
  'stage',(SELECT s.label FROM development_stage s WHERE s.id=e.current_stage_id),
  'nextMeeting',CASE WHEN e.next_meeting_at IS NOT NULL THEN jsonb_build_object(
   'at',to_char(e.next_meeting_at AT TIME ZONE o.tz,${sql.raw(MINUTE)}),
   'churchAt',to_char(e.next_meeting_at AT TIME ZONE e.meeting_timezone,${sql.raw(MINUTE)}),'churchTimezone',e.meeting_timezone) END,
  'milestones',coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'title',m.title,'description',m.description,
    'handsOn',m.hands_on,
    'completion',(SELECT jsonb_build_object('completedOn',c.completed_on::text,
      'confirmedOn',(c.confirmed_at AT TIME ZONE o.church_tz)::date::text,'source',c.source)
     FROM enrollment_milestone c WHERE c.enrollment_id=e.id AND c.milestone_id=m.id AND c.organization_id=e.organization_id),
    'feedback',coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,
      'writtenOn',(f.written_at AT TIME ZONE o.church_tz)::date::text,
      'writer',(SELECT i.display_name FROM seat_identity(f.writer_id) i),'body',f.body) ORDER BY f.written_at,f.id)
     FROM assignment_feedback f WHERE f.enrollment_id=e.id AND f.milestone_id=m.id AND f.organization_id=e.organization_id),
     '[]'::jsonb)) ORDER BY m.position,m.id)
   FROM development_milestone m WHERE m.version_id=e.version_id AND m.organization_id=e.organization_id),'[]'::jsonb),
  'readings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,
    'source',CASE WHEN pin.tenant_id=${GLOBAL}::uuid THEN 'global' ELSE 'organization' END,
    'available',z.slug IS NOT NULL,'slug',CASE WHEN pin.tenant_id=${GLOBAL}::uuid THEN z.slug END) ORDER BY r.position)
   FROM development_reading r JOIN article_revision pin ON pin.id=r.revision_id
   CROSS JOIN LATERAL (SELECT CASE WHEN pin.tenant_id=${GLOBAL}::uuid THEN
     (SELECT gr.slug FROM article_revision gr WHERE gr.tenant_id=${GLOBAL}::uuid AND gr.article_id=r.article_id
       AND gr.content_type='safe_mdx' AND gr.published_at IS NOT NULL AND gr.release_id=(SELECT a.release_id
        FROM reference_activation a ORDER BY a.activation_number DESC LIMIT 1)
       AND NOT EXISTS(SELECT FROM article_editor_state h WHERE h.organization_id=r.organization_id
        AND h.article_id=r.article_id AND h.state='hide') ORDER BY gr.revision_number DESC LIMIT 1)
    ELSE (SELECT c.slug FROM article_editor_state st JOIN article_revision c ON c.id=st.current_revision_id
      AND c.tenant_id=st.organization_id WHERE st.organization_id=r.organization_id AND st.article_id=r.article_id
      AND st.state='published') END AS slug) z
   WHERE r.version_id=e.version_id AND r.organization_id=e.organization_id),'[]'::jsonb))
  ORDER BY e.started_on,e.id) FROM e CROSS JOIN o),'[]'::jsonb) AS enrollments
FROM g`);
		const row = z
			.object({ allowed: z.boolean(), link: z.record(z.string(), z.unknown()).nullable(), enrollments: z.unknown() })
			.parse(r.rows[0]);
		if (!row.allowed || !row.link) return C.myResidency.parse({ status: "not_linked" });
		return C.myResidency.parse({ status: "linked", ...row.link, enrollments: row.enrollments });
	});
}

/**
 * The account's live residency link, for its navigation: the link and the church's name, or null. One statement; null
 * for a seat, a lost session or once the link ends.
 */
export async function readResidencyLink(db: Executor, authority: RequestActor) {
	const me = residentOf(authority);
	if (!me) return null;
	const r = await db.execute(sql`WITH g AS (SELECT ${me.live} AS allowed), ${linkCte(me.accountId)}
SELECT l.id AS "linkId",o.name AS "organizationName" FROM l JOIN organization o ON o.id=l.organization_id`);
	return z.object({ linkId: z.string(), organizationName: z.string() }).nullable().parse(r.rows[0] ?? null);
}

/**
 * One church-owned item of the resident's reading list: the church's current published version of that article,
 * only while it is on an active enrollment's version and the church still publishes it. Linking grants no other
 * access to the church's library (REQ-MUL-014). One statement.
 */
export async function readResidentReading(
	db: Executor,
	authority: RequestActor,
	raw: unknown,
): Promise<Reply<C.ResidentReadingResult>> {
	return answer<C.ResidentReadingResult, C.ProgramRefusal>(async () => {
		const me = residentOf(authority);
		const { readingId } = parse(C.residentReadingRequest, raw);
		if (!me) return C.residentReadingResult.parse({ status: "unavailable" });
		const r = await db.execute(sql`WITH g AS (SELECT ${me.live} AS allowed), ${linkCte(me.accountId)},
r AS (SELECT r.* FROM l JOIN development_enrollment e ON e.person_id=l.person_id AND e.organization_id=l.organization_id
 AND e.status='active' JOIN development_reading r ON r.version_id=e.version_id AND r.organization_id=e.organization_id
 WHERE r.id=${readingId}::uuid LIMIT 1)
SELECT (SELECT jsonb_build_object('title',c.title,'organizationName',o.name,'contentType',c.content_type,'body',c.body)
 FROM r JOIN article_revision pin ON pin.id=r.revision_id AND pin.tenant_id=r.organization_id
 JOIN article_editor_state st ON st.organization_id=r.organization_id AND st.article_id=r.article_id AND st.state='published'
 JOIN article_revision c ON c.id=st.current_revision_id AND c.tenant_id=st.organization_id AND c.published_at IS NOT NULL
 JOIN organization o ON o.id=r.organization_id) AS article`);
		const article = z.object({ article: z.record(z.string(), z.unknown()).nullable() }).parse(r.rows[0]).article;
		return C.residentReadingResult.parse(article ? { status: "available", ...article } : { status: "unavailable" });
	});
}

/**
 * The resident marks one of their own milestones done today, in the church's time zone (REQ-MUL-012). It then waits
 * for the director's confirmation. The established path (C88): the first statement locks the enrollment and the live
 * link; the second writes the mark with its body-free audit row in the church's own audit. A milestone already
 * recorded or marked stays as it was.
 */
async function markMilestone(db: Database, authority: RequestActor, raw: unknown) {
	return answer<{ outcome: "changed" | "noop" }, C.ProgramRefusal>(async () => {
		const input = parse(C.markMilestoneRequest, raw);
		const me = residentOf(authority) ?? refuse();
		const selected = authority.actor.context.owner;
		return nativeWrite(db, authority, selected, async (tx) => {
			await declareWrite(tx, "established");
			const locked = await lockedWrite(tx);
			if (!locked || locked.actor.context.kind !== "account" || locked.actor.accountId !== me.accountId) refuse();
			const actor = me.accountId;
			const found = await tx.execute(sql`SELECT e.id,e.organization_id,e.version_id,
 EXISTS(SELECT FROM development_milestone m WHERE m.id=${input.milestoneId}::uuid AND m.version_id=e.version_id
  AND m.organization_id=e.organization_id) AS milestone
 FROM development_enrollment e JOIN residency_link l ON l.person_id=e.person_id AND l.organization_id=e.organization_id
 WHERE e.id=${input.enrollmentId}::uuid AND e.status='active' AND l.account_id=${actor}::uuid AND ${liveResidency}
 FOR UPDATE OF e FOR SHARE OF l`);
			const x = z
				.object({ id: z.string(), organization_id: z.string(), version_id: z.string(), milestone: z.boolean() })
				.optional()
				.parse(found.rows[0]);
			if (!x) refuse();
			if (!x.milestone) refuse({ code: "invalid_input", field: "milestoneId" });
			const org = x.organization_id;
			const added = await tx.execute(sql`WITH c AS (INSERT INTO enrollment_milestone (id,organization_id,enrollment_id,
 version_id,milestone_id,source,completed_on,recorder_id)
 SELECT ${randomUUID()}::uuid,${org}::uuid,${x.id}::uuid,${x.version_id}::uuid,${input.milestoneId}::uuid,'resident',
  (clock_timestamp() AT TIME ZONE o.timezone)::date,${actor}::uuid FROM organization o WHERE o.id=${org}::uuid
 ON CONFLICT (enrollment_id,milestone_id) DO NOTHING RETURNING id),
a AS (INSERT INTO audit_event (id,tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id,metadata)
 SELECT ${randomUUID()}::uuid,${org}::uuid,${actor}::uuid,${hash([org, actor])},'development.milestone_marked','complete',
  'development_enrollment',${x.id}::uuid,${JSON.stringify({ milestoneId: input.milestoneId, source: "resident" })}::jsonb
 FROM c RETURNING id)
SELECT EXISTS(SELECT FROM c) AS added`);
			return { outcome: z.object({ added: z.boolean() }).parse(added.rows[0]).added ? "changed" : "noop" } as const;
		});
	});
}

/** Every resident write. The statement census measures each one as `residency.<name>`. */
export const residentWriter = { markMilestone };
