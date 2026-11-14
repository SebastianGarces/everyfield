import * as C from "@everyfield/contracts/organizations";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { liveResidency } from "../access/pipeline.ts";
import { foundationArticles } from "../onboarding/reading.ts";
import { GLOBAL } from "../wiki/core.ts";
import { activeResidents, answer, one, parse, refuse, seatOf, write, type Executor, type Writer } from "./seat.ts";

// Development programs (REQ-MUL-010, -011, -012). Every seat of the organization reads its programs and enrollments.
// An Owner or Admin creates programs and enrolls people; the program's current director edits and publishes the plan,
// records and confirms an unlinked enrollee's milestones, and writes feedback on hands-on assignments. Feedback is read
// only by the current director and the organization's Owner and Admins. Each read is one statement with the live
// access check inside it (C13); each write runs in the organization's write gate (C88, established) with a body-free
// audit row. A published version never changes: the director's next save starts the next version's draft, and an
// enrollment keeps the version it was enrolled on until the director reviews and applies a newer one (REQ-MUL-011).
// A milestone's `lineage` carries it across versions: an enrollment's completions and feedback keep the milestone and
// version they were recorded on, and every read matches them to the enrollment's plan by lineage.

type Reply<T> = C.ProgramReply<T>;

/** The current Wiki release, whose published global revisions an organization may put on a reading list. */
const release = sql`(SELECT a.release_id FROM reference_activation a ORDER BY a.activation_number DESC LIMIT 1)`;

/**
 * The reading list of version `v` for organization `org`, each item with the slug its source publishes now, or null:
 * the organization's own version while it is still published, a global article while the current release has it and
 * the organization has not hidden it. The pinned row grants no library access (REQ-MUL-010).
 */
const readingsJson = (
	org: string,
) => sql`coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'revisionId',r.revision_id,
 'title',r.title,'source',CASE WHEN pin.tenant_id=${GLOBAL}::uuid THEN 'global' ELSE 'organization' END,
 'slug',CASE WHEN pin.tenant_id=${GLOBAL}::uuid THEN
   (SELECT g.slug FROM article_revision g WHERE g.tenant_id=${GLOBAL}::uuid AND g.article_id=r.article_id
     AND g.content_type='safe_mdx' AND g.published_at IS NOT NULL AND g.release_id=${release}
     AND NOT EXISTS(SELECT FROM article_editor_state h WHERE h.organization_id=${org}::uuid AND h.article_id=r.article_id
      AND h.state='hide') ORDER BY g.revision_number DESC LIMIT 1)
  ELSE (SELECT c.slug FROM article_editor_state e JOIN article_revision c ON c.id=e.current_revision_id
     AND c.tenant_id=e.organization_id WHERE e.organization_id=${org}::uuid AND e.article_id=r.article_id
     AND e.state='published') END) ORDER BY r.position)
 FROM development_reading r JOIN article_revision pin ON pin.id=r.revision_id
 WHERE r.version_id=v.id AND r.organization_id=v.organization_id),'[]'::jsonb)`;

/** Version `v` as the contract's programVersion, with dates in `o.timezone`. */
const versionJson = (org: string) => sql`jsonb_build_object('id',v.id,'number',v.version_number,
 'publishedOn',(v.published_at AT TIME ZONE o.timezone)::date::text,'rhythm',v.rhythm,'expectedMonths',v.expected_months,
 'stages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'label',s.label,'minMonths',s.min_months,
   'maxMonths',s.max_months) ORDER BY s.position,s.id) FROM development_stage s
   WHERE s.version_id=v.id AND s.organization_id=v.organization_id),'[]'::jsonb),
 'milestones',coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'lineage',m.lineage,'title',m.title,
   'description',m.description,'handsOn',m.hands_on) ORDER BY m.position,m.id) FROM development_milestone m
   WHERE m.version_id=v.id AND m.organization_id=v.organization_id),'[]'::jsonb),
 'readings',${readingsJson(org)})`;

/** A seat as `{seatId, name}`. */
const seatJson = (seat: SQL) => sql`(SELECT jsonb_build_object('seatId',rs.id,'name',coalesce(i.display_name,'Staff'))
 FROM seat rs LEFT JOIN LATERAL seat_identity(rs.account_id) i ON true WHERE rs.id=${seat})`;
/** An account's display name. */
const nameOf = (account: SQL) => sql`(SELECT i.display_name FROM seat_identity(${account}) i)`;
/** The organization's current seats, for the director picker. */
const staffJson = (org: string) => sql`coalesce((SELECT jsonb_agg(jsonb_build_object('seatId',s.id,
 'name',coalesce(i.display_name,'Staff')) ORDER BY lower(coalesce(i.display_name,'')),s.id)
 FROM seat s LEFT JOIN LATERAL seat_identity(s.account_id) i ON true
 WHERE s.organization_id=${org}::uuid AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()),'[]'::jsonb)`;

const orgCte = (
	org: string,
) => sql`o AS (SELECT o.name,o.timezone,(clock_timestamp() AT TIME ZONE o.timezone)::date AS today
 FROM organization o JOIN g ON g.allowed WHERE o.id=${org}::uuid)`;

/**
 * The Programs tab: every program with its director, status and active enrollments, and Active residents: distinct
 * live people with at least one active enrollment in a residency-kind program (REQ-MUL-007). One statement.
 */
export async function readPrograms(db: Executor, authority: RequestActor): Promise<Reply<C.ProgramList>> {
	return answer<C.ProgramList, C.ProgramRefusal>(async () => {
		const seat = seatOf(authority) ?? refuse();
		const org = seat.organization;
		const r = await db.execute(sql`WITH g AS (SELECT ${seat.live} AS allowed), ${orgCte(org)}
SELECT g.allowed,(SELECT name FROM o) AS name,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'kind',p.kind,'director',${seatJson(sql`p.director_seat_id`)},
   'publishedNumber',v.version_number,'publishedOn',(v.published_at AT TIME ZONE o.timezone)::date::text,
   'draft',EXISTS(SELECT FROM development_program_version d WHERE d.program_id=p.id AND d.organization_id=p.organization_id
    AND d.published_at IS NULL),
   'activeEnrollments',(SELECT count(*) FROM development_enrollment e JOIN person x ON x.id=e.person_id
    AND x.tenant_id=e.organization_id WHERE e.program_id=p.id AND e.organization_id=p.organization_id AND e.status='active'
    AND x.state='live')) ORDER BY lower(p.name),p.id)
  FROM development_program p CROSS JOIN o LEFT JOIN development_program_version v ON v.id=p.current_version_id
   AND v.organization_id=p.organization_id WHERE p.organization_id=${org}::uuid),'[]'::jsonb) AS programs,
 CASE WHEN EXISTS(SELECT FROM o) THEN ${activeResidents(org)} ELSE 0 END AS residents,
 CASE WHEN ${seat.administrator} AND EXISTS(SELECT FROM o) THEN ${staffJson(org)} ELSE '[]'::jsonb END AS staff
FROM g`);
		const row = z
			.object({
				allowed: z.boolean(),
				name: z.string().nullable(),
				programs: z.array(z.unknown()),
				residents: z.coerce.number(),
				staff: z.array(z.unknown()),
			})
			.parse(r.rows[0]);
		if (!row.allowed || row.name === null) refuse();
		return C.programList.parse({
			organizationName: row.name,
			administrator: seat.administrator,
			activeResidents: row.residents,
			programs: row.programs,
			staff: row.staff,
		});
	});
}

/** One program: its published version, its draft, its enrollments and, for an Owner or Admin, who can be enrolled. */
export async function readProgram(
	db: Executor,
	authority: RequestActor,
	raw: unknown,
): Promise<Reply<C.ProgramDetail>> {
	return answer<C.ProgramDetail, C.ProgramRefusal>(async () => {
		const seat = seatOf(authority) ?? refuse();
		const { programId } = parse(z.strictObject({ programId: z.uuid() }), raw);
		const org = seat.organization;
		const r = await db.execute(sql`WITH g AS (SELECT ${seat.live} AS allowed), ${orgCte(org)},
x AS (SELECT p.* FROM development_program p WHERE EXISTS(SELECT FROM o) AND p.id=${programId}::uuid
 AND p.organization_id=${org}::uuid)
SELECT g.allowed,(SELECT timezone FROM o) AS timezone,(SELECT today::text FROM o) AS today,
 (SELECT jsonb_build_object('id',x.id,'name',x.name,'kind',x.kind,'revision',x.revision::text,
   'director',${seatJson(sql`x.director_seat_id`)},'directorSeatId',x.director_seat_id) FROM x) AS program,
 (SELECT ${versionJson(org)} FROM x JOIN development_program_version v ON v.id=x.current_version_id
   AND v.organization_id=x.organization_id CROSS JOIN o) AS published,
 (SELECT ${versionJson(org)} FROM x JOIN development_program_version v ON v.program_id=x.id
   AND v.organization_id=x.organization_id AND v.published_at IS NULL CROSS JOIN o) AS draft,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'personId',e.person_id,'name',pn.display_name,
   'cohort',e.cohort_label,'status',e.status,'stage',s.label,'versionNumber',ev.version_number)
   ORDER BY e.status<>'active',lower(pn.display_name),e.id)
  FROM x JOIN development_enrollment e ON e.program_id=x.id AND e.organization_id=x.organization_id
  JOIN person pn ON pn.id=e.person_id AND pn.tenant_id=e.organization_id AND pn.state='live'
  JOIN development_stage s ON s.id=e.current_stage_id JOIN development_program_version ev ON ev.id=e.version_id),
  '[]'::jsonb) AS enrollments,
 coalesce((SELECT jsonb_agg(jsonb_build_object('personId',pp.person_id,'name',pn.display_name)
   ORDER BY lower(pn.display_name),pp.person_id)
  FROM pipeline_person pp JOIN person pn ON pn.id=pp.person_id AND pn.tenant_id=pp.organization_id
  WHERE ${seat.administrator} AND EXISTS(SELECT FROM x) AND pp.organization_id=${org}::uuid AND pn.state='live'),
  '[]'::jsonb) AS people
FROM g`);
		const row = z
			.object({
				allowed: z.boolean(),
				timezone: z.string().nullable(),
				today: z.string().nullable(),
				program: z.object({ directorSeatId: z.string() }).catchall(z.unknown()).nullable(),
				published: z.unknown(),
				draft: z.unknown(),
				enrollments: z.array(z.unknown()),
				people: z.array(z.unknown()),
			})
			.parse(r.rows[0]);
		if (!row.allowed || !row.program) refuse();
		const { directorSeatId, ...program } = row.program!;
		return C.programDetail.parse({
			...program,
			viewer: { administrator: seat.administrator, director: directorSeatId === seat.seatId },
			timezone: row.timezone,
			today: row.today,
			published: row.published,
			draft: row.draft,
			enrollments: row.enrollments,
			people: row.people,
		});
	});
}

/**
 * The live residency link `lk` of enrollment `x`'s person, with what its resident shares (REQ-MUL-003). No row
 * without a live link: never linked, left, or ended.
 */
const linkOf = (
	org: string,
) => sql`lk AS (SELECT l.account_id,l.share_milestones,l.share_foundations FROM residency_link l
 JOIN x ON l.person_id=x.person_id WHERE l.organization_id=${org}::uuid AND ${liveResidency} LIMIT 1)`;

/** How many of the six Discovery foundations account `account` has completed on a published revision (REQ-MUL-014). */
const foundationsCompleted = (account: SQL) => sql`(SELECT count(DISTINCT r.article_id)::int FROM reading r
 JOIN article_revision v ON v.id=r.completed_revision_id AND v.article_id=r.article_id
 WHERE r.account_id=${account} AND r.article_id=ANY(${sql.param(foundationArticles)}::uuid[]) AND r.completed_at IS NOT NULL
  AND v.published_at IS NOT NULL)`;

/**
 * Whether completion `c` of enrollment `x` shows to the organization: what it recorded itself, and a linked
 * resident's own mark only while live link `lk` shares milestone progress (REQ-MUL-003, REQ-MUL-014).
 */
const orgSees = sql`(c.source='program_leader' OR coalesce((SELECT share_milestones FROM lk),false))`;

/**
 * Milestone `m` for enrollment `x` as the contract's enrollmentMilestone: its completion and feedback on any version,
 * matched by lineage, with dates in `o.timezone`. Feedback is null unless `x.reads_feedback`;
 * a completion shows only as `orgSees`.
 */
const progressJson = sql`jsonb_build_object('id',m.id,'title',m.title,'description',m.description,'handsOn',m.hands_on,
 'completion',(SELECT jsonb_build_object('completedOn',c.completed_on::text,
   'confirmedOn',(c.confirmed_at AT TIME ZONE o.timezone)::date::text,'recorder',${nameOf(sql`c.recorder_id`)},
   'confirmer',${nameOf(sql`c.confirmer_id`)},'source',c.source)
  FROM enrollment_milestone c JOIN development_milestone cm ON cm.id=c.milestone_id AND cm.organization_id=c.organization_id
  WHERE c.enrollment_id=x.id AND c.organization_id=x.organization_id AND cm.lineage=m.lineage AND ${orgSees}
  ORDER BY c.confirmed_at,c.id LIMIT 1),
 'feedback',CASE WHEN x.reads_feedback THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,
   'writtenOn',(f.written_at AT TIME ZONE o.timezone)::date::text,'writer',${nameOf(sql`f.writer_id`)},'body',f.body)
   ORDER BY f.written_at,f.id) FROM assignment_feedback f JOIN development_milestone fm ON fm.id=f.milestone_id
   AND fm.organization_id=f.organization_id WHERE f.enrollment_id=x.id AND f.organization_id=x.organization_id
   AND fm.lineage=m.lineage),'[]'::jsonb) END)`;

/**
 * One enrollment: the person, the program, the version it is on with that version's stages and milestones, each
 * milestone's completion, and the director's feedback for a viewer who may read it: the current director, or an
 * Owner or Admin (REQ-MUL-012). Records on milestones a later version removed are listed as earlier, kept as they
 * were recorded, and a newer published version is named. Anyone else of the organization reads the rest; feedback
 * reads as null. One statement. A linked resident's own marks show only while they share milestone progress, and
 * their foundations only as a count while they share foundations; what the organization recorded itself always shows
 * (REQ-MUL-003, REQ-MUL-014).
 */
export async function readEnrollment(
	db: Executor,
	authority: RequestActor,
	raw: unknown,
): Promise<Reply<C.EnrollmentDetail>> {
	return answer<C.EnrollmentDetail, C.ProgramRefusal>(async () => {
		const seat = seatOf(authority) ?? refuse();
		const { enrollmentId } = parse(z.strictObject({ enrollmentId: z.uuid() }), raw);
		const org = seat.organization;
		const r = await db.execute(sql`WITH g AS (SELECT ${seat.live} AS allowed), ${orgCte(org)},
x AS (SELECT e.*,p.name AS program_name,p.kind,p.director_seat_id,p.current_version_id,pn.display_name,v.version_number,
  (${seat.administrator} OR p.director_seat_id=${seat.seatId}::uuid) AS reads_feedback
 FROM development_enrollment e JOIN development_program p ON p.id=e.program_id AND p.organization_id=e.organization_id
 JOIN development_program_version v ON v.id=e.version_id AND v.organization_id=e.organization_id
 JOIN person pn ON pn.id=e.person_id AND pn.tenant_id=e.organization_id
 WHERE EXISTS(SELECT FROM o) AND e.id=${enrollmentId}::uuid AND e.organization_id=${org}::uuid AND pn.state='live'),
${linkOf(org)}
SELECT g.allowed,(SELECT today::text FROM o) AS today,(SELECT jsonb_build_object('id',x.id,
  'person',jsonb_build_object('personId',x.person_id,'name',x.display_name),
  'program',jsonb_build_object('id',x.program_id,'name',x.program_name,'kind',x.kind,
   'director',${seatJson(sql`x.director_seat_id`)}),
  'directorSeatId',x.director_seat_id,'versionNumber',x.version_number,'cohort',x.cohort_label,
  'startedOn',x.started_on::text,'expectedEndOn',x.expected_end_on::text,'status',x.status,
  'stage',(SELECT jsonb_build_object('id',s.id,'label',s.label) FROM development_stage s WHERE s.id=x.current_stage_id),
  'nextMeeting',CASE WHEN x.next_meeting_at IS NOT NULL THEN jsonb_build_object(
   'at',to_char(x.next_meeting_at AT TIME ZONE x.meeting_timezone,'YYYY-MM-DD"T"HH24:MI:SS'),'timezone',x.meeting_timezone) END,
  'milestones',coalesce((SELECT jsonb_agg(${progressJson} ORDER BY m.position,m.id)
   FROM development_milestone m WHERE m.version_id=x.version_id AND m.organization_id=x.organization_id),'[]'::jsonb),
  'earlier',coalesce((SELECT jsonb_agg(${progressJson} || jsonb_build_object('versionNumber',m.version_number)
    ORDER BY m.version_number,m.position,m.id)
   FROM (SELECT DISTINCT ON (dm.lineage) dm.*,dv.version_number FROM development_milestone dm
    JOIN development_program_version dv ON dv.id=dm.version_id AND dv.organization_id=dm.organization_id
    WHERE dm.organization_id=x.organization_id AND dm.id IN (SELECT c.milestone_id FROM enrollment_milestone c
      WHERE c.enrollment_id=x.id AND c.organization_id=x.organization_id AND ${orgSees} UNION SELECT f.milestone_id FROM assignment_feedback f
      WHERE x.reads_feedback AND f.enrollment_id=x.id AND f.organization_id=x.organization_id)
     AND NOT EXISTS(SELECT FROM development_milestone cur WHERE cur.version_id=x.version_id
      AND cur.organization_id=x.organization_id AND cur.lineage=dm.lineage)
    ORDER BY dm.lineage,dv.version_number DESC) m),'[]'::jsonb),
  'newerVersion',(SELECT jsonb_build_object('id',cv.id,'number',cv.version_number) FROM development_program_version cv
   WHERE cv.id=x.current_version_id AND cv.organization_id=x.organization_id AND cv.id<>x.version_id),
  'resident',coalesce((SELECT jsonb_build_object('status','linked',
    'milestones',CASE WHEN lk.share_milestones THEN 'shared' ELSE 'not_shared' END,
    'foundations',CASE WHEN lk.share_foundations THEN jsonb_build_object('status','shared',
     'completed',${foundationsCompleted(sql`lk.account_id`)},'total',6) ELSE jsonb_build_object('status','not_shared') END)
   FROM lk),jsonb_build_object('status','not_linked')))
 FROM x CROSS JOIN o) AS enrollment
FROM g`);
		const row = z
			.object({
				allowed: z.boolean(),
				today: z.string().nullable(),
				enrollment: z.object({ directorSeatId: z.string() }).catchall(z.unknown()).nullable(),
			})
			.parse(r.rows[0]);
		if (!row.allowed || !row.enrollment) refuse();
		const { directorSeatId, ...enrollment } = row.enrollment!;
		return C.enrollmentDetail.parse({
			...enrollment,
			viewer: { administrator: seat.administrator, director: directorSeatId === seat.seatId },
			today: row.today,
		});
	});
}

/**
 * Wiki articles the organization may put on a reading list whose title matches: its own published versions, then
 * global articles of the current release it has not hidden. At most 20. One statement.
 */
export async function searchReadings(db: Executor, authority: RequestActor, raw: unknown) {
	return answer<z.infer<typeof C.readingCandidates>, C.ProgramRefusal>(async () => {
		const seat = seatOf(authority) ?? refuse();
		const { q } = parse(C.readingSearchRequest, raw);
		const org = seat.organization;
		const pattern = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
		const r = await db.execute(sql`WITH g AS (SELECT ${seat.live} AS allowed),
own AS (SELECT c.id,c.article_id,c.title FROM article_editor_state e JOIN article_revision c ON c.id=e.current_revision_id
 AND c.tenant_id=e.organization_id JOIN g ON g.allowed WHERE e.organization_id=${org}::uuid AND e.state='published'),
glob AS (SELECT DISTINCT ON (r.article_id) r.id,r.article_id,r.title FROM article_revision r JOIN g ON g.allowed
 WHERE r.tenant_id=${GLOBAL}::uuid AND r.content_type='safe_mdx' AND r.published_at IS NOT NULL AND r.release_id=${release}
  AND NOT EXISTS(SELECT FROM article_editor_state h WHERE h.organization_id=${org}::uuid AND h.article_id=r.article_id
   AND h.state='hide')
 ORDER BY r.article_id,r.revision_number DESC),
c AS (SELECT id,title,'organization' AS source,0 AS rank FROM own UNION ALL SELECT id,title,'global',1 FROM glob)
SELECT g.allowed,coalesce((SELECT jsonb_agg(jsonb_build_object('revisionId',t.id,'title',t.title,'source',t.source)
 ORDER BY t.rank,lower(t.title),t.id) FROM (SELECT * FROM c WHERE c.title ILIKE ${pattern}
 ORDER BY c.rank,lower(c.title),c.id LIMIT 20) t),'[]'::jsonb) AS items FROM g`);
		const row = z.object({ allowed: z.boolean(), items: z.unknown() }).parse(r.rows[0]);
		if (!row.allowed) refuse();
		return C.readingCandidates.parse(row.items);
	});
}

/**
 * The state a version review shows for enrollment `x` (`id`, `revision`, `version_id`, `current_stage_id`,
 * `current_version_id`): the enrollment, its program's current version and its completions. An apply names it, and
 * any change since refuses the apply (REQ-MUL-011).
 */
const basisOf = (org: string) => sql`md5(concat_ws('|',x.revision,x.version_id,x.current_stage_id,x.current_version_id,
 (SELECT string_agg(c.id::text,',' ORDER BY c.id) FROM enrollment_milestone c WHERE c.enrollment_id=x.id
  AND c.organization_id=${org}::uuid)))`;

const milestoneJson = sql`jsonb_build_object('lineage',m.lineage,'title',m.title,'description',m.description,'handsOn',m.hands_on)`;
const milestoneRow = z.object({
	lineage: z.string(),
	title: z.string(),
	description: z.string().nullable(),
	handsOn: z.boolean(),
});
const reviewRow = z.object({
	enrollmentId: z.string(),
	versionId: z.string(),
	fromNumber: z.number(),
	toNumber: z.number(),
	basis: z.string(),
	stage: z.string(),
	from: z.array(milestoneRow),
	to: z.array(milestoneRow),
	stages: z.array(z.object({ id: z.string(), label: z.string() })),
	finished: z.array(z.string()),
});

/**
 * What applying the current version changes for this enrollment, matched by lineage. The stage is preselected to the
 * new version's stage with the same label, else its first stage (D-1272).
 */
function versionReview(r: z.infer<typeof reviewRow>): C.VersionReview {
	const finished = new Set(r.finished);
	const before = new Map(r.from.map((m) => [m.lineage, m]));
	const after = new Set(r.to.map((m) => m.lineage));
	const shown = (m: (typeof r.from)[number]) => ({
		title: m.title,
		description: m.description,
		handsOn: m.handsOn,
		finished: finished.has(m.lineage),
	});
	const label = r.stage.trim().toLowerCase();
	return C.versionReview.parse({
		enrollmentId: r.enrollmentId,
		versionId: r.versionId,
		fromNumber: r.fromNumber,
		toNumber: r.toNumber,
		basis: r.basis,
		added: r.to.filter((m) => !before.has(m.lineage)).map(shown),
		removed: r.from.filter((m) => !after.has(m.lineage)).map(shown),
		changed: r.to.flatMap((m) => {
			const was = before.get(m.lineage);
			if (!was || (was.title === m.title && was.description === m.description && was.handsOn === m.handsOn)) return [];
			return [{ before: shown(was), after: shown(m) }];
		}),
		carried: r.to.filter((m) => finished.has(m.lineage)).map((m) => m.title),
		stage: r.stage,
		stages: r.stages,
		stageId: (r.stages.find((s) => s.label.trim().toLowerCase() === label) ?? r.stages[0]!).id,
	});
}

/**
 * The review the current director reads before applying the program's current published version to an active
 * enrollment on an older one (REQ-MUL-011, D-1271). Anyone else, or an enrollment with nothing newer, reads nothing.
 * One statement.
 */
export async function readVersionReview(
	db: Executor,
	authority: RequestActor,
	raw: unknown,
): Promise<Reply<C.VersionReview>> {
	return answer<C.VersionReview, C.ProgramRefusal>(async () => {
		const seat = seatOf(authority) ?? refuse();
		const { enrollmentId } = parse(z.strictObject({ enrollmentId: z.uuid() }), raw);
		const org = seat.organization;
		const r = await db.execute(sql`WITH g AS (SELECT ${seat.live} AS allowed), ${orgCte(org)},
x AS (SELECT e.id,e.person_id,e.revision,e.version_id,e.current_stage_id,p.current_version_id FROM development_enrollment e
 JOIN development_program p ON p.id=e.program_id AND p.organization_id=e.organization_id
 WHERE EXISTS(SELECT FROM o) AND e.id=${enrollmentId}::uuid AND e.organization_id=${org}::uuid AND e.status='active'
  AND p.director_seat_id=${seat.seatId}::uuid AND p.current_version_id<>e.version_id),
${linkOf(org)}
SELECT g.allowed,(SELECT jsonb_build_object('enrollmentId',x.id,'versionId',x.current_version_id,
  'fromNumber',(SELECT version_number FROM development_program_version WHERE id=x.version_id),
  'toNumber',(SELECT version_number FROM development_program_version WHERE id=x.current_version_id),
  'basis',${basisOf(org)},
  'stage',(SELECT s.label FROM development_stage s WHERE s.id=x.current_stage_id),
  'from',coalesce((SELECT jsonb_agg(${milestoneJson} ORDER BY m.position,m.id) FROM development_milestone m
   WHERE m.version_id=x.version_id AND m.organization_id=${org}::uuid),'[]'::jsonb),
  'to',coalesce((SELECT jsonb_agg(${milestoneJson} ORDER BY m.position,m.id) FROM development_milestone m
   WHERE m.version_id=x.current_version_id AND m.organization_id=${org}::uuid),'[]'::jsonb),
  'stages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'label',s.label) ORDER BY s.position,s.id)
   FROM development_stage s WHERE s.version_id=x.current_version_id AND s.organization_id=${org}::uuid),'[]'::jsonb),
  'finished',coalesce((SELECT jsonb_agg(DISTINCT cm.lineage) FROM enrollment_milestone c JOIN development_milestone cm
   ON cm.id=c.milestone_id AND cm.organization_id=c.organization_id WHERE c.enrollment_id=x.id
   AND c.organization_id=${org}::uuid AND ${orgSees}),'[]'::jsonb)) FROM x) AS review
FROM g`);
		const row = z.object({ allowed: z.boolean(), review: reviewRow.nullable() }).parse(r.rows[0]);
		if (!row.allowed || !row.review) refuse();
		return versionReview(row.review!);
	});
}

type Plan = C.ProgramPlan;

/**
 * The statement that writes a plan into version `version` (inserted when `next` names its number, updated otherwise)
 * and bumps the program, all only when every reading is a published revision of the global
 * library or of this organization. Rows get fresh IDs: a draft's plan is replaced whole, and nothing points at a
 * draft's rows. `program` is the CTE that inserts or locks the program (`id`, `revision`).
 */
function planStatement(
	w: Writer,
	o: {
		program: SQL;
		version: string;
		next: number | null;
		plan: Plan;
		action: string;
		kind: string;
		bump: boolean;
	},
) {
	const org = w.organization;
	const { plan } = o;
	const stages = JSON.stringify(
		plan.stages.map((s, position) => ({
			id: randomUUID(),
			label: s.label,
			min: s.minMonths,
			max: s.maxMonths,
			position,
		})),
	);
	const milestones = JSON.stringify(
		plan.milestones.map((m, position) => ({
			id: randomUUID(),
			lineage: m.lineage,
			title: m.title,
			description: m.description,
			hands_on: m.handsOn,
			position,
		})),
	);
	const readings = JSON.stringify(
		plan.readings.map((r, position) => ({ id: randomUUID(), revision_id: r.revisionId, position })),
	);
	const version =
		o.next === null
			? sql`UPDATE development_program_version v SET rhythm=${plan.rhythm},expected_months=${plan.expectedMonths},
 revision=v.revision+1 FROM ok WHERE ok.ok AND v.id=${o.version}::uuid AND v.organization_id=${org}::uuid AND v.published_at IS NULL
 RETURNING v.id`
			: sql`INSERT INTO development_program_version (id,organization_id,program_id,version_number,rhythm,expected_months,revision)
 SELECT ${o.version}::uuid,${org}::uuid,p.id,${o.next},${plan.rhythm},${plan.expectedMonths},1 FROM p,ok WHERE ok.ok RETURNING id`;
	return sql`WITH p AS (${o.program}),
rr AS (SELECT x.id,x.position,rv.id AS revision_id,rv.article_id,rv.title FROM jsonb_to_recordset(${readings}::jsonb)
 x(id uuid,revision_id uuid,position int) JOIN article_revision rv ON rv.id=x.revision_id
 AND rv.tenant_id IN (${GLOBAL}::uuid,${org}::uuid) AND rv.published_at IS NOT NULL),
ok AS (SELECT (SELECT count(DISTINCT article_id) FROM rr)=${plan.readings.length} AS ok FROM p),
v AS (${version}),
s AS (INSERT INTO development_stage (id,organization_id,version_id,label,position,min_months,max_months,revision)
 SELECT x.id,${org}::uuid,v.id,x.label,x.position,x.min,x.max,1 FROM v,jsonb_to_recordset(${stages}::jsonb)
 x(id uuid,label text,min int,max int,position int)),
m AS (INSERT INTO development_milestone (id,organization_id,version_id,lineage,position,title,description,hands_on)
 SELECT x.id,${org}::uuid,v.id,x.lineage,x.position,x.title,x.description,x.hands_on FROM v,jsonb_to_recordset(${milestones}::jsonb)
 x(id uuid,lineage uuid,title text,description text,hands_on boolean,position int)),
r AS (INSERT INTO development_reading (id,organization_id,version_id,position,article_id,revision_id,title)
 SELECT rr.id,${org}::uuid,v.id,rr.position,rr.article_id,rr.revision_id,rr.title FROM v,rr),
u AS (${o.bump ? sql`UPDATE development_program x SET revision=x.revision+1 FROM v WHERE x.id=(SELECT id FROM p) AND x.organization_id=${org}::uuid RETURNING x.revision` : sql`SELECT p.revision FROM p,v`}),
a AS (${w.audit({ action: o.action, kind: o.kind, subjectType: "development_program", subject: sql`(SELECT id FROM p)`, before: o.bump ? sql`(SELECT revision FROM p)` : undefined, after: sql`(SELECT revision FROM u)`, metadata: { versionId: o.version } })}
 WHERE EXISTS(SELECT FROM u) RETURNING id)
SELECT coalesce((SELECT ok FROM ok),false) AS readings,(SELECT revision::text FROM u) AS revision`;
}
const planAnswer = z.object({ readings: z.boolean(), revision: z.string().nullable() });

/** A seat that may direct a program: current in this organization. */
const eligibleDirector = (w: Writer, seat: string) =>
	sql`EXISTS(SELECT FROM seat s WHERE s.id=${seat}::uuid AND s.organization_id=${w.organization}::uuid
 AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp())`;

/** Creates a program with its first draft: blank, or as the browser filled it from the residency template. */
function createProgram(db: Database, authority: RequestActor, raw: unknown): Promise<Reply<{ revision: string }>> {
	return write<{ revision: string }, C.ProgramRefusal>(db, authority, true, async (w) => {
		const input = parse(C.createProgramRequest, raw);
		const program = sql`INSERT INTO development_program (id,organization_id,kind,name,director_seat_id,revision)
 SELECT ${input.programId}::uuid,${w.organization}::uuid,${input.kind},${input.name},${input.directorSeatId}::uuid,1
 WHERE ${eligibleDirector(w, input.directorSeatId)} ON CONFLICT (id) DO NOTHING RETURNING id,revision`;
		const row = await one(
			w,
			planAnswer.extend({ existing: z.string().nullable(), director: z.boolean() }),
			sql`${planStatement(w, {
				program,
				version: randomUUID(),
				next: 1,
				plan: input.plan,
				action: "development.program_created",
				kind: "create",
				bump: false,
			})},(SELECT revision::text FROM development_program WHERE id=${input.programId}::uuid
 AND organization_id=${w.organization}::uuid) AS existing,${eligibleDirector(w, input.directorSeatId)} AS director`,
		);
		if (row.revision) return { revision: row.revision };
		// A repeat of a request that already created this program answers with its revision.
		if (row.existing) return { revision: row.existing };
		if (!row.director) refuse({ code: "invalid_input", field: "directorSeatId" });
		if (!row.readings) refuse({ code: "invalid_input", field: "readings" });
		return refuse({ code: "conflict" });
	});
}

/**
 * The program `x`, locked, and its draft `d`, locked, for a director's write. Answers whether the writer directs it,
 * its revision and the draft's ID and number.
 */
const directed = (
	w: Writer,
	programId: string,
) => sql`x AS (SELECT p.id,p.revision,p.director_seat_id FROM development_program p
 WHERE p.id=${programId}::uuid AND p.organization_id=${w.organization}::uuid FOR UPDATE),
d AS (SELECT v.id,v.version_number FROM development_program_version v JOIN x ON v.program_id=x.id
 WHERE v.organization_id=${w.organization}::uuid AND v.published_at IS NULL FOR UPDATE OF v)`;
const directedRow = z.object({
	found: z.boolean(),
	director: z.boolean(),
	current: z.string().nullable(),
	draft: z.string().nullable(),
	last: z.number().nullable(),
});

/**
 * Saves the director's plan into the program's draft, or into a new draft of the next version when the current one is
 * published. The first statement locks the program and its draft and clears the draft's rows when the director holds
 * the expected revision; the second writes the plan.
 */
function savePlan(db: Database, authority: RequestActor, raw: unknown): Promise<Reply<{ revision: string }>> {
	return write<{ revision: string }, C.ProgramRefusal>(db, authority, false, async (w) => {
		const input = parse(C.saveProgramPlanRequest, raw);
		const org = w.organization;
		const mine = sql`x.director_seat_id=${w.seatId}::uuid AND x.revision=${input.expectedRevision}::bigint`;
		const locked = await one(
			w,
			directedRow,
			sql`WITH ${directed(w, input.programId)},
clear AS (SELECT d.id FROM d,x WHERE ${mine}),
dm AS (DELETE FROM development_milestone m USING clear WHERE m.version_id=clear.id AND m.organization_id=${org}::uuid),
dr AS (DELETE FROM development_reading r USING clear WHERE r.version_id=clear.id AND r.organization_id=${org}::uuid),
ds AS (DELETE FROM development_stage s USING clear WHERE s.version_id=clear.id AND s.organization_id=${org}::uuid)
SELECT EXISTS(SELECT FROM x) AS found,coalesce((SELECT director_seat_id=${w.seatId}::uuid FROM x),false) AS director,
 (SELECT revision::text FROM x) AS current,(SELECT id::text FROM d) AS draft,
 (SELECT max(version_number) FROM development_program_version WHERE program_id=${input.programId}::uuid
  AND organization_id=${org}::uuid) AS last`,
		);
		if (!locked.found || !locked.director) refuse();
		if (locked.current !== input.expectedRevision) refuse({ code: "conflict" });
		const row = await one(
			w,
			planAnswer,
			planStatement(w, {
				program: sql`SELECT x.id,x.revision FROM development_program x WHERE x.id=${input.programId}::uuid
 AND x.organization_id=${org}::uuid`,
				version: locked.draft ?? randomUUID(),
				next: locked.draft ? null : (locked.last ?? 0) + 1,
				plan: input.plan,
				action: "development.plan_saved",
				kind: "edit",
				bump: true,
			}),
		);
		if (!row.readings) refuse({ code: "invalid_input", field: "readings" });
		return { revision: row.revision! };
	});
}

/** Publishes the draft as the program's current version. The current director only; the draft needs a stage. */
function publishVersion(db: Database, authority: RequestActor, raw: unknown) {
	return write<{ revision: string; number: number }, C.ProgramRefusal>(db, authority, false, async (w) => {
		const input = parse(C.publishProgramRequest, raw);
		const org = w.organization;
		const row = await one(
			w,
			directedRow.extend({ staged: z.boolean(), revision: z.string().nullable(), number: z.number().nullable() }),
			sql`WITH ${directed(w, input.programId)},
ok AS (SELECT d.id FROM d,x WHERE x.director_seat_id=${w.seatId}::uuid AND x.revision=${input.expectedRevision}::bigint
 AND EXISTS(SELECT FROM development_stage s WHERE s.version_id=d.id AND s.organization_id=${org}::uuid)),
vu AS (UPDATE development_program_version v SET published_at=clock_timestamp(),revision=v.revision+1 FROM ok
 WHERE v.id=ok.id RETURNING v.id,v.version_number),
pu AS (UPDATE development_program p SET current_version_id=vu.id,revision=p.revision+1 FROM vu
 WHERE p.id=${input.programId}::uuid AND p.organization_id=${org}::uuid RETURNING p.revision),
a AS (${w.audit({ action: "development.version_published", kind: "publish", subjectType: "development_program", subject: sql`x.id`, before: sql`x.revision`, after: sql`pu.revision`, metadata: { programId: input.programId } })}
 FROM x,pu RETURNING id)
SELECT EXISTS(SELECT FROM x) AS found,coalesce((SELECT director_seat_id=${w.seatId}::uuid FROM x),false) AS director,
 (SELECT revision::text FROM x) AS current,(SELECT id::text FROM d) AS draft,NULL::int AS last,
 EXISTS(SELECT FROM d WHERE EXISTS(SELECT FROM development_stage s WHERE s.version_id=d.id AND s.organization_id=${org}::uuid)) AS staged,
 (SELECT revision::text FROM pu) AS revision,(SELECT version_number FROM vu) AS number`,
		);
		if (!row.found || !row.director) refuse();
		if (row.revision && row.number) return { revision: row.revision, number: row.number };
		if (row.current !== input.expectedRevision || !row.draft) refuse({ code: "conflict" });
		return refuse({ code: "no_stages" });
	});
}

/**
 * Enrolls a live pipeline person in the program's current published version at one of its stages. The pipeline stage
 * is untouched (REQ-MUL-011). A second active enrollment in the same program is refused; another program is fine.
 * The next meeting is in the organization's time zone, which the enrollment keeps. Owner or Admin.
 */
function enroll(db: Database, authority: RequestActor, raw: unknown) {
	return write<{ enrollmentId: string; outcome: "changed" | "noop" }, C.ProgramRefusal>(
		db,
		authority,
		true,
		async (w) => {
			const input = parse(C.enrollRequest, raw);
			const org = w.organization;
			const row = await one(
				w,
				z.object({
					published: z.boolean(),
					found: z.boolean(),
					person: z.boolean(),
					stage: z.boolean(),
					duplicate: z.boolean(),
					added: z.boolean(),
					existing: z.boolean(),
				}),
				sql`WITH pr AS (SELECT p.id,p.current_version_id FROM development_program p WHERE p.id=${input.programId}::uuid
 AND p.organization_id=${org}::uuid FOR SHARE),
pe AS (SELECT pp.person_id FROM pipeline_person pp JOIN person x ON x.id=pp.person_id AND x.tenant_id=pp.organization_id
 WHERE pp.organization_id=${org}::uuid AND pp.person_id=${input.personId}::uuid AND x.state='live' FOR SHARE OF pp,x),
st AS (SELECT s.id FROM development_stage s JOIN pr ON s.version_id=pr.current_version_id WHERE s.id=${input.stageId}::uuid
 AND s.organization_id=${org}::uuid),
dup AS (SELECT e.id FROM development_enrollment e WHERE e.organization_id=${org}::uuid AND e.program_id=${input.programId}::uuid
 AND e.person_id=${input.personId}::uuid AND e.status='active' AND e.id<>${input.enrollmentId}::uuid),
o AS (SELECT timezone FROM organization WHERE id=${org}::uuid),
e AS (INSERT INTO development_enrollment (id,organization_id,person_id,program_id,version_id,cohort_label,started_on,
 expected_end_on,status,current_stage_id,next_meeting_at,meeting_timezone,revision)
 SELECT ${input.enrollmentId}::uuid,${org}::uuid,pe.person_id,pr.id,pr.current_version_id,${input.cohort},
  ${input.startedOn}::date,${input.expectedEndOn}::date,'active',st.id,
  (${input.nextMeetingAt}::timestamp AT TIME ZONE o.timezone),o.timezone,1
 FROM pr,pe,st,o WHERE NOT EXISTS(SELECT FROM dup) ON CONFLICT (id) DO NOTHING RETURNING id),
a AS (${w.audit({ action: "development.enrolled", kind: "create", subjectType: "development_enrollment", subject: sql`e.id`, after: sql`1`, metadata: { programId: input.programId } })}
 FROM e RETURNING id)
SELECT EXISTS(SELECT FROM pr WHERE current_version_id IS NOT NULL) AS published,EXISTS(SELECT FROM pr) AS found,
 EXISTS(SELECT FROM pe) AS person,EXISTS(SELECT FROM st) AS stage,EXISTS(SELECT FROM dup) AS duplicate,
 EXISTS(SELECT FROM e) AS added,EXISTS(SELECT FROM development_enrollment x WHERE x.id=${input.enrollmentId}::uuid
  AND x.organization_id=${org}::uuid AND x.program_id=${input.programId}::uuid AND x.person_id=${input.personId}::uuid) AS existing`,
			);
			if (row.added) return { enrollmentId: input.enrollmentId, outcome: "changed" as const };
			if (row.existing) return { enrollmentId: input.enrollmentId, outcome: "noop" as const };
			if (!row.found) refuse();
			if (!row.published) refuse({ code: "not_published" });
			if (!row.person) refuse({ code: "invalid_input", field: "personId" });
			if (row.duplicate) refuse({ code: "already_enrolled" });
			if (!row.stage) refuse({ code: "invalid_input", field: "stageId" });
			return refuse({ code: "conflict" });
		},
	);
}

/** The active enrollment `x`, locked, that the writer directs, and milestone `m` of its version. */
const directedEnrollment = (w: Writer, enrollmentId: string, milestoneId: string) => sql`x AS (SELECT e.id,e.version_id,
 e.person_id,e.revision FROM development_enrollment e JOIN development_program p ON p.id=e.program_id
 AND p.organization_id=e.organization_id WHERE e.id=${enrollmentId}::uuid AND e.organization_id=${w.organization}::uuid
 AND e.status='active' AND p.director_seat_id=${w.seatId}::uuid FOR UPDATE OF e FOR SHARE OF p),
m AS (SELECT m.id,m.lineage,m.hands_on FROM development_milestone m JOIN x ON m.version_id=x.version_id
 WHERE m.id=${milestoneId}::uuid AND m.organization_id=${w.organization}::uuid)`;

/**
 * The director records that an unlinked enrollee finished a milestone on a day no later than today, and confirms it
 * in the same step: recorder and confirmer are the director, the source is the program leader (REQ-MUL-012). It is
 * refused while the person has a current resident link. A milestone the person marked while linked is hidden once the
 * link ends, so the director's record replaces it; one the director recorded stays as recorded. Nothing else changes:
 * no stage, no commissioning, no plant.
 */
function recordMilestone(db: Database, authority: RequestActor, raw: unknown) {
	return write<{ outcome: "changed" | "noop" }, C.ProgramRefusal>(db, authority, false, async (w) => {
		const input = parse(C.recordMilestoneRequest, raw);
		const org = w.organization;
		const row = await one(
			w,
			z.object({
				found: z.boolean(),
				milestone: z.boolean(),
				past: z.boolean(),
				linked: z.boolean(),
				added: z.boolean(),
				existing: z.boolean(),
			}),
			sql`WITH ${directedEnrollment(w, input.enrollmentId, input.milestoneId)},
linked AS (SELECT FROM residency_link l JOIN x ON l.person_id=x.person_id WHERE l.organization_id=${org}::uuid
 AND ${liveResidency}),
d AS (SELECT ${input.completedOn}::date<=(clock_timestamp() AT TIME ZONE o.timezone)::date AS past FROM organization o
 WHERE o.id=${org}::uuid),
-- The milestone as the organization recorded it on any version, matched by lineage: one carried from an earlier version
-- stays as recorded. A former resident's own mark no longer shows, so it does not count.
done AS (SELECT FROM enrollment_milestone c JOIN development_milestone cm ON cm.id=c.milestone_id
 AND cm.organization_id=c.organization_id JOIN m ON cm.lineage=m.lineage
 WHERE c.enrollment_id=${input.enrollmentId}::uuid AND c.organization_id=${org}::uuid AND c.source='program_leader'),
c AS (INSERT INTO enrollment_milestone (id,organization_id,enrollment_id,version_id,milestone_id,source,completed_on,
 recorder_id,confirmer_id,confirmed_at)
 SELECT ${randomUUID()}::uuid,${org}::uuid,x.id,x.version_id,m.id,'program_leader',${input.completedOn}::date,${w.actor}::uuid,
  ${w.actor}::uuid,clock_timestamp() FROM x,m,d WHERE d.past AND NOT EXISTS(SELECT FROM linked) AND NOT EXISTS(SELECT FROM done)
 ON CONFLICT (enrollment_id,milestone_id) DO UPDATE SET source='program_leader',completed_on=EXCLUDED.completed_on,
  recorder_id=EXCLUDED.recorder_id,confirmer_id=EXCLUDED.confirmer_id,confirmed_at=EXCLUDED.confirmed_at
  WHERE enrollment_milestone.source='resident' RETURNING id),
a AS (${w.audit({ action: "development.milestone_recorded", kind: "complete", subjectType: "development_enrollment", subject: sql`x.id`, metadata: { milestoneId: input.milestoneId, source: "program_leader" } })}
 FROM x,c RETURNING id)
SELECT EXISTS(SELECT FROM x) AS found,EXISTS(SELECT FROM m) AS milestone,coalesce((SELECT past FROM d),false) AS past,
 EXISTS(SELECT FROM linked) AS linked,EXISTS(SELECT FROM c) AS added,EXISTS(SELECT FROM done) AS existing`,
		);
		if (row.added) return { outcome: "changed" as const };
		if (!row.found) refuse();
		if (!row.milestone) refuse({ code: "invalid_input", field: "milestoneId" });
		if (row.linked) refuse({ code: "linked_resident" });
		// A milestone already recorded stays as it was recorded.
		if (row.existing) return { outcome: "noop" as const };
		return refuse({ code: "invalid_input", field: "completedOn" });
	});
}

/**
 * The director confirms a milestone the linked resident marked done (REQ-MUL-012), while the resident shares milestone
 * progress: the confirmer is the director and the confirmation is dated now. A confirmed milestone stays as it was.
 */
function confirmMilestone(db: Database, authority: RequestActor, raw: unknown) {
	return write<{ outcome: "changed" | "noop" }, C.ProgramRefusal>(db, authority, false, async (w) => {
		const input = parse(C.confirmMilestoneRequest, raw);
		const org = w.organization;
		const row = await one(
			w,
			z.object({
				found: z.boolean(),
				milestone: z.boolean(),
				shared: z.boolean(),
				confirmed: z.boolean(),
				already: z.boolean(),
			}),
			sql`WITH ${directedEnrollment(w, input.enrollmentId, input.milestoneId)},
${linkOf(org)},
-- The resident's mark on this milestone, on any version, matched by lineage.
r AS (SELECT c.id,c.confirmed_at FROM enrollment_milestone c JOIN development_milestone cm ON cm.id=c.milestone_id
 AND cm.organization_id=c.organization_id JOIN m ON cm.lineage=m.lineage
 WHERE c.enrollment_id=${input.enrollmentId}::uuid AND c.organization_id=${org}::uuid AND c.source='resident'),
c AS (UPDATE enrollment_milestone c SET confirmer_id=${w.actor}::uuid,confirmed_at=clock_timestamp() FROM x,r
 WHERE c.id=r.id AND c.enrollment_id=x.id AND c.organization_id=${org}::uuid AND c.confirmed_at IS NULL
  AND coalesce((SELECT share_milestones FROM lk),false) RETURNING c.id),
a AS (${w.audit({ action: "development.milestone_confirmed", kind: "accept", subjectType: "development_enrollment", subject: sql`x.id`, metadata: { milestoneId: input.milestoneId, source: "resident" } })}
 FROM x,c RETURNING id)
SELECT EXISTS(SELECT FROM x) AS found,EXISTS(SELECT FROM m) AS milestone,
 coalesce((SELECT share_milestones FROM lk),false) AS shared,EXISTS(SELECT FROM c) AS confirmed,
 EXISTS(SELECT FROM r WHERE r.confirmed_at IS NOT NULL) AS already`,
		);
		if (row.confirmed) return { outcome: "changed" as const };
		if (!row.found) refuse();
		if (!row.milestone) refuse({ code: "invalid_input", field: "milestoneId" });
		// What the resident does not share is not the organization's to confirm.
		if (!row.shared) refuse();
		if (row.already) return { outcome: "noop" as const };
		return refuse({ code: "conflict" });
	});
}

/** Dated feedback from the current director on a hands-on assignment of an active enrollment (REQ-MUL-012). */
function addFeedback(db: Database, authority: RequestActor, raw: unknown) {
	return write<{ feedbackId: string }, C.ProgramRefusal>(db, authority, false, async (w) => {
		const input = parse(C.addFeedbackRequest, raw);
		const org = w.organization;
		const row = await one(
			w,
			z.object({ found: z.boolean(), assignment: z.boolean(), added: z.boolean(), existing: z.boolean() }),
			sql`WITH ${directedEnrollment(w, input.enrollmentId, input.milestoneId)},
f AS (INSERT INTO assignment_feedback (id,organization_id,enrollment_id,version_id,milestone_id,writer_id,written_at,body)
 SELECT ${input.feedbackId}::uuid,${org}::uuid,x.id,x.version_id,m.id,${w.actor}::uuid,clock_timestamp(),${input.body}
 FROM x,m WHERE m.hands_on ON CONFLICT (id) DO NOTHING RETURNING id),
a AS (${w.audit({ action: "development.feedback_recorded", kind: "create", subjectType: "development_enrollment", subject: sql`x.id`, metadata: { feedbackId: input.feedbackId, milestoneId: input.milestoneId } })}
 FROM x,f RETURNING id)
SELECT EXISTS(SELECT FROM x) AS found,EXISTS(SELECT FROM m WHERE m.hands_on) AS assignment,EXISTS(SELECT FROM f) AS added,
 EXISTS(SELECT FROM assignment_feedback f WHERE f.id=${input.feedbackId}::uuid AND f.organization_id=${org}::uuid
  AND f.writer_id=${w.actor}::uuid AND f.enrollment_id=${input.enrollmentId}::uuid) AS existing`,
		);
		if (row.added || row.existing) return { feedbackId: input.feedbackId };
		if (!row.found) refuse();
		if (!row.assignment) refuse({ code: "invalid_input", field: "milestoneId" });
		return refuse({ code: "conflict" });
	});
}

/**
 * The current director moves an active enrollment to the program's current published version at one of its stages,
 * after reviewing it (REQ-MUL-011, D-1271). Only the version and stage change: completions and feedback keep the
 * milestone, version, recorder, confirmer and dates they were recorded with, and nobody is named as a new recorder.
 * A review older than the enrollment's state is refused as stale; the same apply repeated changes nothing.
 */
function applyVersion(db: Database, authority: RequestActor, raw: unknown) {
	return write<{ outcome: "changed" | "noop" }, C.ProgramRefusal>(db, authority, false, async (w) => {
		const input = parse(C.applyVersionRequest, raw);
		const org = w.organization;
		const row = await one(
			w,
			z.object({
				found: z.boolean(),
				already: z.boolean(),
				fresh: z.boolean(),
				applied: z.boolean(),
			}),
			sql`WITH x AS (SELECT e.id,e.revision,e.version_id,e.current_stage_id,p.current_version_id,ev.version_number
 FROM development_enrollment e JOIN development_program p ON p.id=e.program_id AND p.organization_id=e.organization_id
 JOIN development_program_version ev ON ev.id=e.version_id AND ev.organization_id=e.organization_id
 WHERE e.id=${input.enrollmentId}::uuid AND e.organization_id=${org}::uuid AND e.status='active'
  AND p.director_seat_id=${w.seatId}::uuid FOR UPDATE OF e FOR SHARE OF p),
t AS (SELECT v.id,v.version_number FROM development_program_version v JOIN x ON v.id=x.current_version_id
 WHERE v.id=${input.versionId}::uuid AND v.organization_id=${org}::uuid AND v.id<>x.version_id
  AND ${basisOf(org)}=${input.basis}),
st AS (SELECT s.id FROM development_stage s JOIN t ON s.version_id=t.id WHERE s.id=${input.stageId}::uuid
 AND s.organization_id=${org}::uuid),
u AS (UPDATE development_enrollment e SET version_id=t.id,current_stage_id=st.id,revision=e.revision+1 FROM x,t,st
 WHERE e.id=x.id AND e.organization_id=${org}::uuid RETURNING e.revision),
a AS (${w.audit({ action: "development.version_applied", kind: "edit", subjectType: "development_enrollment", subject: sql`x.id`, before: sql`x.revision`, after: sql`u.revision`, metadata: sql`jsonb_build_object('fromVersion',x.version_number,'toVersion',t.version_number)` })}
 FROM x,t,u RETURNING id)
SELECT EXISTS(SELECT FROM x) AS found,EXISTS(SELECT FROM x WHERE x.version_id=${input.versionId}::uuid
  AND x.current_version_id=${input.versionId}::uuid) AS already,
 EXISTS(SELECT FROM t) AS fresh,EXISTS(SELECT FROM u) AS applied`,
		);
		if (row.applied) return { outcome: "changed" as const };
		if (!row.found) refuse();
		// A repeat of an apply that already moved the enrollment to the current version.
		if (row.already) return { outcome: "noop" as const };
		if (!row.fresh) refuse({ code: "stale_review" });
		return refuse({ code: "invalid_input", field: "stageId" });
	});
}

/** Every program write. The statement census measures each one as `programs.<name>`. */
export const programWriter = {
	createProgram,
	savePlan,
	publishVersion,
	enroll,
	recordMilestone,
	confirmMilestone,
	addFeedback,
	applyVersion,
};
