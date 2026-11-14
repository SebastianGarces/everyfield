import * as C from "@everyfield/contracts/organizations";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { answer, one, parse, refuse, seatOf, write, type Executor, type Writer } from "./seat.ts";

// The organization pipeline (REQ-MUL-001, -002, -008, -009). An Owner or Admin reads and changes everyone; a seat named
// responsible staff reads those people and their notes and writes notes; any other seat reads counts per stage only.
// Each read is one statement with the live access check inside it (C13). Each write runs the established way (C88):
// the gate locks the organization, so every write for it queues, and the change and its body-free audit row go in one
// statement. A move's reason and the stage labels at that moment live in pipeline_stage_move, whose id is the move's
// audit event; central audit never holds a reason or a note body (REQ-MUL-002).

const PAGE = 24;

/**
 * The starter stages (REQ-MUL-008) with IDs derived from the organization, so a board read can show them before
 * anything is saved, and the first write that needs them inserts the same rows (once: a repeat conflicts on the ID).
 */
function starterStages(organizationId: string) {
	return C.STARTER_STAGES.map(([kind, label], position) => {
		const h = createHash("sha256").update(`pipeline-stage:${organizationId}:${kind}`).digest("hex");
		const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
		return { id, kind, label, position };
	});
}
const startersJson = (organizationId: string) => JSON.stringify(starterStages(organizationId));
/** Inserts the starter stages for an organization that has none saved yet; a repeat inserts nothing. */
const insertStarters = (
	o: string,
) => sql`INSERT INTO pipeline_stage (id,organization_id,stable_kind,label,position,revision)
 SELECT x.id,${o}::uuid,x.kind,x.label,x.position,1 FROM jsonb_to_recordset(${startersJson(o)}::jsonb) x(id uuid,kind text,label text,position int)
 WHERE NOT EXISTS(SELECT FROM pipeline_stage s WHERE s.organization_id=${o}::uuid) ON CONFLICT (id) DO NOTHING`;

const boardRow = z.object({
	allowed: z.boolean(),
	name: z.string().nullable(),
	as_of: z.string().nullable(),
	audience: C.pipelineAudience.nullable(),
	stages: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			kind: z.string(),
			revision: z.string(),
			count: z.number(),
			matching: z.number(),
			people: z.array(z.record(z.string(), z.unknown())),
		}),
	),
	staff: z.array(z.object({ seatId: z.string(), name: z.string(), role: z.string() })),
	retired: z.coerce.number(),
});

/**
 * The Pipeline page: the stages in order with their counts, and the people the viewer may see, 24 per stage per page
 * (D67), under the URL's filters. A counts-only viewer gets no person, no search and no filter. One statement.
 */
export async function readPipelineBoard(db: Executor, authority: RequestActor, raw: unknown) {
	return answer(async () => {
		const seat = seatOf(authority) ?? refuse();
		const query = parse(C.pipelineBoardQuery, raw);
		const org = seat.organization;
		const words = query.q.replace(/[\\%_]/g, (c) => "\\" + c);
		const pattern = `%${words}%`;
		const retired = query.view === "retired";
		const offset = (query.page - 1) * PAGE;
		const r = await db.execute(sql`WITH g AS (SELECT ${seat.live} AS allowed),
o AS (SELECT o.name,o.timezone,(clock_timestamp() AT TIME ZONE o.timezone)::date AS today FROM organization o JOIN g ON g.allowed
 WHERE o.id=${org}::uuid),
st AS (
 SELECT s.id,s.label,s.stable_kind AS kind,s.position,s.revision::text AS revision FROM pipeline_stage s
  WHERE s.organization_id=${org}::uuid AND s.removed_at IS NULL AND EXISTS(SELECT FROM o)
 UNION ALL
 SELECT x.id,x.label,x.kind,x.position,'1' FROM jsonb_to_recordset(${startersJson(org)}::jsonb) x(id uuid,kind text,label text,position int)
  WHERE EXISTS(SELECT FROM o) AND NOT EXISTS(SELECT FROM pipeline_stage s WHERE s.organization_id=${org}::uuid)),
pp AS (
 SELECT pp.id,pp.person_id,pp.stage_id,pp.responsible_seat_id,pp.revision::text AS revision,p.display_name,p.email,p.state,
  (SELECT max(a.occurred_at) FROM pipeline_stage_move m JOIN audit_event a ON a.id=m.id AND a.tenant_id=m.organization_id
   WHERE m.pipeline_person_id=pp.id AND m.organization_id=pp.organization_id) AS last_move
 FROM pipeline_person pp JOIN person p ON p.id=pp.person_id AND p.tenant_id=pp.organization_id
 WHERE pp.organization_id=${org}::uuid AND p.state IN ('live','retired') AND EXISTS(SELECT FROM o)),
aud AS (SELECT CASE WHEN ${seat.administrator} THEN 'administrator'
 WHEN EXISTS(SELECT FROM pp WHERE pp.responsible_seat_id=${seat.seatId}::uuid AND pp.state='live') THEN 'responsible'
 ELSE 'counts' END AS a FROM o),
seen AS (
 SELECT pp.*,(pp.last_move AT TIME ZONE o.timezone)::date AS last_on,
  row_number() OVER (PARTITION BY pp.stage_id ORDER BY lower(pp.display_name),pp.person_id) AS rn
 FROM pp CROSS JOIN o CROSS JOIN aud
 WHERE pp.state=${retired ? "retired" : "live"}
  AND (aud.a='administrator' OR (aud.a='responsible' AND NOT ${retired} AND pp.responsible_seat_id=${seat.seatId}::uuid))
  AND (NOT ${query.stale && !retired} OR coalesce((pp.last_move AT TIME ZONE o.timezone)::date,'-infinity'::date)
   < (o.today - interval '6 months')::date)
  AND (${words} = '' OR pp.display_name ILIKE ${pattern} OR pp.email ILIKE ${pattern}
   OR EXISTS(SELECT FROM person_note n WHERE n.tenant_id=${org}::uuid AND n.plant_id IS NULL AND n.person_id=pp.person_id
    AND n.removed_at IS NULL AND n.body ILIKE ${pattern})))
SELECT g.allowed,(SELECT name FROM o) AS name,(SELECT today::text FROM o) AS as_of,(SELECT a FROM aud) AS audience,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',st.id,'label',st.label,'kind',st.kind,'revision',st.revision,
  'count',(SELECT count(*) FROM pp WHERE pp.stage_id=st.id AND pp.state='live'),
  'matching',(SELECT count(*) FROM seen WHERE seen.stage_id=st.id),
  'people',coalesce((SELECT jsonb_agg(jsonb_build_object('personId',seen.person_id,'name',seen.display_name,'email',seen.email,
    'revision',seen.revision,'lastMovedOn',seen.last_on::text,
    'responsible',(SELECT jsonb_build_object('seatId',rs.id,'name',coalesce(i.display_name,'Staff')) FROM seat rs
     LEFT JOIN LATERAL seat_identity(rs.account_id) i ON true WHERE rs.id=seen.responsible_seat_id))
    ORDER BY seen.rn) FROM seen WHERE seen.stage_id=st.id AND seen.rn>${offset} AND seen.rn<=${offset + PAGE}),'[]'::jsonb))
  ORDER BY st.position,st.label,st.id) FROM st),'[]'::jsonb) AS stages,
 coalesce((SELECT jsonb_agg(jsonb_build_object('seatId',s.id,'name',coalesce(i.display_name,'Staff'),'role',s.role)
  ORDER BY lower(coalesce(i.display_name,'')),s.id)
  FROM seat s LEFT JOIN LATERAL seat_identity(s.account_id) i ON true
  WHERE ${seat.administrator} AND EXISTS(SELECT FROM o) AND s.organization_id=${org}::uuid AND s.ended_at IS NULL
   AND s.accepted_at<=clock_timestamp()),'[]'::jsonb) AS staff,
 (SELECT count(*) FROM pp WHERE ${seat.administrator} AND pp.state='retired') AS retired
FROM g`);
		const row = boardRow.parse(r.rows[0]);
		if (!row.allowed || !row.audience || !row.as_of || row.name === null) refuse();
		const counts = row.audience === "counts";
		const pages = Math.max(1, ...row.stages.map((s) => Math.ceil(s.matching / PAGE)));
		return C.pipelineBoard.parse({
			audience: row.audience,
			organizationName: row.name,
			asOf: row.as_of,
			// A counts-only viewer has no search and no inactivity filter, so nothing about a person leaks through one.
			query: counts ? { ...query, q: "", stale: false, view: "board" } : query,
			stages: row.stages.map((s) => ({ ...s, matching: counts ? 0 : s.matching, people: counts ? [] : s.people })),
			pages: counts ? 1 : pages,
			staff: row.staff,
			retiredCount: row.retired,
		});
	});
}

const recordRow = z.object({
	allowed: z.boolean(),
	as_of: z.string().nullable(),
	person: z
		.object({
			personId: z.string(),
			name: z.string(),
			email: z.string().nullable(),
			state: z.string(),
			revision: z.string(),
			stage: z.object({ id: z.string(), label: z.string(), kind: z.string() }),
			responsible: z.object({ seatId: z.string(), name: z.string() }).nullable(),
			assessedOn: z.string().nullable(),
			assessor: z.string().nullable(),
		})
		.nullable(),
	history: z.array(
		z.object({
			id: z.string(),
			on: z.string(),
			actor: z.string().nullable(),
			action: z.string(),
			from_label: z.string().nullable(),
			to_label: z.string().nullable(),
			reason: z.string().nullable(),
			moved: z.boolean(),
		}),
	),
	notes: z.array(
		z.object({
			id: z.string(),
			revision: z.string(),
			body: z.string(),
			author_id: z.string().nullable(),
			author: z.string().nullable(),
			written: z.string(),
			edited: z.string().nullable(),
			removed: z.string().nullable(),
		}),
	),
});

/**
 * One pipeline person's record: details, history (with the stage labels as they were) and notes. An Owner or Admin
 * reads anyone, live or retired; the responsible staff member reads the live people they are responsible for. Anyone
 * else gets `unavailable`, the same answer as for a person who does not exist. One statement.
 */
export async function readPipelinePersonRecord(db: Executor, authority: RequestActor, raw: unknown) {
	return answer(async () => {
		const seat = seatOf(authority) ?? refuse();
		const { personId } = parse(z.strictObject({ personId: z.uuid() }), raw);
		const org = seat.organization;
		const r = await db.execute(sql`WITH g AS (SELECT ${seat.live} AS allowed),
o AS (SELECT o.timezone,(clock_timestamp() AT TIME ZONE o.timezone)::date AS today FROM organization o JOIN g ON g.allowed
 WHERE o.id=${org}::uuid),
x AS (SELECT pp.*,p.display_name,p.email,p.state FROM pipeline_person pp
 JOIN person p ON p.id=pp.person_id AND p.tenant_id=pp.organization_id
 WHERE EXISTS(SELECT FROM o) AND pp.organization_id=${org}::uuid AND pp.person_id=${personId}::uuid
  AND (p.state='live' OR (p.state='retired' AND ${seat.administrator}))
  AND (${seat.administrator} OR pp.responsible_seat_id=${seat.seatId}::uuid))
SELECT g.allowed,(SELECT today::text FROM o) AS as_of,
 (SELECT jsonb_build_object('personId',x.person_id,'name',x.display_name,'email',x.email,'state',x.state,
  'revision',x.revision::text,'assessedOn',x.assessed_on::text,'assessor',x.assessor_label,
  'stage',(SELECT jsonb_build_object('id',s.id,'label',s.label,'kind',s.stable_kind) FROM pipeline_stage s WHERE s.id=x.stage_id),
  'responsible',(SELECT jsonb_build_object('seatId',rs.id,'name',coalesce(i.display_name,'Staff')) FROM seat rs
   LEFT JOIN LATERAL seat_identity(rs.account_id) i ON true WHERE rs.id=x.responsible_seat_id)) FROM x) AS person,
 coalesce((SELECT jsonb_agg(h ORDER BY h.at DESC,h.id DESC) FROM (
  SELECT a.id,a.occurred_at AS at,(a.occurred_at AT TIME ZONE o.timezone)::date::text AS on,
   (SELECT i.display_name FROM seat_identity(a.actor_id) i) AS actor,a.action,m.from_label,m.to_label,m.reason,
   (m.id IS NOT NULL) AS moved
  FROM x CROSS JOIN o JOIN audit_event a ON a.tenant_id=${org}::uuid AND a.subject_id=x.person_id
  LEFT JOIN pipeline_stage_move m ON m.id=a.id AND m.organization_id=a.tenant_id
  WHERE a.action IN ('people.created','people.stage_changed','people.recorded','people.retired','people.restored','people.updated')
   AND a.metadata->>'category' IS DISTINCT FROM 'note'
  ORDER BY a.occurred_at DESC,a.id DESC LIMIT 200) h),'[]'::jsonb) AS history,
 coalesce((SELECT jsonb_agg(n ORDER BY n.at DESC,n.id DESC) FROM (
  SELECT n.id,n.occurred_at AS at,n.revision::text AS revision,n.body,n.author_id,
   (SELECT i.display_name FROM seat_identity(n.author_id) i) AS author,
   (n.occurred_at AT TIME ZONE o.timezone)::date::text AS written,(n.edited_at AT TIME ZONE o.timezone)::date::text AS edited,
   (n.removed_at AT TIME ZONE o.timezone)::date::text AS removed
  FROM x CROSS JOIN o JOIN person_note n ON n.tenant_id=${org}::uuid AND n.plant_id IS NULL AND n.person_id=x.person_id
  ORDER BY n.occurred_at DESC,n.id DESC LIMIT 200) n),'[]'::jsonb) AS notes
FROM g`);
		const row = recordRow.parse(r.rows[0]);
		if (!row.allowed || !row.person || !row.as_of) refuse();
		const p = row.person!;
		return C.pipelinePersonRecord.parse({
			audience: seat.administrator ? "administrator" : "responsible",
			personId: p.personId,
			name: p.name,
			email: p.email,
			retired: p.state === "retired",
			revision: p.revision,
			stage: p.stage,
			responsible: p.responsible,
			assessment: p.assessedOn && p.assessor ? { on: p.assessedOn, by: p.assessor } : null,
			history: row.history.map((h) => {
				const base = { id: h.id, on: h.on, actor: h.actor };
				if (h.moved && h.from_label === null) return { ...base, kind: "placed", to: h.to_label };
				if (h.moved) return { ...base, kind: "moved", from: h.from_label, to: h.to_label, reason: h.reason };
				const kind =
					h.action === "people.recorded"
						? "assessment"
						: h.action === "people.retired"
							? "retired"
							: h.action === "people.restored"
								? "restored"
								: "edited";
				return { ...base, kind };
			}),
			notes: row.notes.map((n) =>
				n.removed
					? { state: "removed", id: n.id, author: n.author, removedOn: n.removed }
					: {
							state: "current",
							id: n.id,
							revision: n.revision,
							body: n.body,
							author: n.author,
							writtenOn: n.written,
							editedOn: n.edited,
							mine: n.author_id === seat.accountId,
						},
			),
			asOf: row.as_of,
			viewer: seat.accountId,
		});
	});
}

/** A seat that may be named responsible: current in this organization (REQ-MUL-002). */
const eligibleSeat = (w: Writer, seat: string | null) =>
	sql`(${seat}::uuid IS NULL OR EXISTS(SELECT FROM seat s WHERE s.id=${seat}::uuid AND s.organization_id=${w.organization}::uuid
 AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()))`;

const changed = z.object({ found: z.boolean(), current: z.string().nullable(), revision: z.string().nullable() });
/** The answer to a change: the new revision, `conflict` for a stale one, `unavailable` for a person not found. */
function settle(row: z.infer<typeof changed>, expected: string) {
	if (!row.found) refuse();
	if (row.revision) return { revision: row.revision };
	if (row.current !== expected) refuse({ code: "conflict" });
	return { revision: row.current };
}

/** Adds a person to the pipeline at a stage, with an optional email and responsible staff member. Owner or Admin. */
function addPerson(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.addPipelinePersonRequest, raw);
		const o = w.organization;
		const event = randomUUID(),
			entry = randomUUID();
		const row = await one(
			w,
			z.object({ stage: z.boolean(), seat: z.boolean(), added: z.boolean(), existing: z.string().nullable() }),
			sql`WITH starters AS (${insertStarters(o)} RETURNING id,label),
dest AS (
 SELECT id,label FROM pipeline_stage WHERE id=${input.stageId}::uuid AND organization_id=${o}::uuid AND removed_at IS NULL
 UNION ALL SELECT id,label FROM starters WHERE id=${input.stageId}::uuid),
ok AS (SELECT ${eligibleSeat(w, input.responsibleSeatId)} AS seat),
p AS (
 INSERT INTO person (id,tenant_id,organization_id,display_name,email,source,created_at,state,revision)
 SELECT ${input.personId}::uuid,${o}::uuid,${o}::uuid,${input.displayName},${input.email},'other',clock_timestamp(),'live',1
 FROM dest,ok WHERE ok.seat ON CONFLICT (id) DO NOTHING RETURNING id),
pp AS (
 INSERT INTO pipeline_person (id,organization_id,person_id,stage_id,responsible_seat_id,revision)
 SELECT ${entry}::uuid,${o}::uuid,p.id,dest.id,${input.responsibleSeatId}::uuid,1 FROM p,dest RETURNING id),
a AS (${w.audit({ id: event, action: "people.created", kind: "create", subject: sql`p.id`, after: sql`1` })} FROM p RETURNING id),
m AS (
 INSERT INTO pipeline_stage_move (id,organization_id,pipeline_person_id,to_stage_id,to_label)
 SELECT a.id,${o}::uuid,pp.id,dest.id,dest.label FROM a,pp,dest RETURNING id)
SELECT EXISTS(SELECT FROM dest) AS stage,(SELECT seat FROM ok) AS seat,EXISTS(SELECT FROM m) AS added,
 (SELECT pp.revision::text FROM pipeline_person pp WHERE pp.person_id=${input.personId}::uuid AND pp.organization_id=${o}::uuid) AS existing`,
		);
		if (row.added) return { personId: input.personId, revision: "1", outcome: "changed" as const };
		// A repeat of a request that already added this person answers as it did.
		if (row.existing) return { personId: input.personId, revision: row.existing, outcome: "noop" as const };
		if (!row.stage) refuse({ code: "invalid_input", field: "stageId" });
		if (!row.seat) refuse({ code: "invalid_input", field: "responsibleSeatId" });
		return refuse({ code: "conflict" });
	});
}

/** The live pipeline person row `x`, locked, for the person a write names. */
const target = (w: Writer, person: string, state = "live") =>
	sql`SELECT pp.id,pp.person_id,pp.stage_id,pp.revision FROM pipeline_person pp JOIN person p ON p.id=pp.person_id
 AND p.tenant_id=pp.organization_id WHERE pp.organization_id=${w.organization}::uuid AND pp.person_id=${person}::uuid
 AND p.state=${state} FOR UPDATE OF pp,p`;

/** Changes a person's name, email and responsible staff. Owner or Admin. */
function editPerson(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.editPipelinePersonRequest, raw);
		const row = await one(
			w,
			changed.extend({ seat: z.boolean() }),
			sql`WITH x AS (${target(w, input.personId)}), ok AS (SELECT ${eligibleSeat(w, input.responsibleSeatId)} AS seat),
u AS (UPDATE pipeline_person pp SET responsible_seat_id=${input.responsibleSeatId}::uuid,revision=pp.revision+1 FROM x,ok
 WHERE pp.id=x.id AND x.revision=${input.expectedRevision}::bigint AND ok.seat RETURNING pp.revision),
p AS (UPDATE person p SET display_name=${input.displayName},email=${input.email},revision=p.revision+1 FROM x,u
 WHERE p.id=x.person_id AND p.tenant_id=${w.organization}::uuid RETURNING p.id),
a AS (${w.audit({ action: "people.updated", kind: "edit", subject: sql`x.person_id`, before: sql`x.revision`, after: sql`u.revision`, metadata: { fields: ["displayName", "email", "responsibleSeatId"] } })}
 FROM x,u,p RETURNING id)
SELECT EXISTS(SELECT FROM x) AS found,(SELECT revision::text FROM x) AS current,(SELECT revision::text FROM u) AS revision,
 (SELECT seat FROM ok) AS seat`,
		);
		if (row.found && !row.seat) refuse({ code: "invalid_input", field: "responsibleSeatId" });
		return settle(row, input.expectedRevision);
	});
}

/**
 * Moves a person to another stage with a reason. Owner or Admin: a person does it, never a rule (REQ-MUL-008). The
 * move row keeps both stages' labels as they are now. A move to the person's own stage changes nothing.
 */
function movePerson(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.movePipelinePersonRequest, raw);
		const o = w.organization;
		const row = await one(
			w,
			changed.extend({ stage: z.boolean(), same: z.boolean() }),
			sql`WITH x AS (${target(w, input.personId)}),
fromstage AS (SELECT s.id,s.label FROM pipeline_stage s JOIN x ON s.id=x.stage_id),
dest AS (SELECT id,label FROM pipeline_stage WHERE id=${input.stageId}::uuid AND organization_id=${o}::uuid AND removed_at IS NULL
 FOR SHARE),
u AS (UPDATE pipeline_person pp SET stage_id=dest.id,revision=pp.revision+1 FROM x,dest
 WHERE pp.id=x.id AND x.revision=${input.expectedRevision}::bigint AND x.stage_id<>dest.id RETURNING pp.revision),
a AS (${w.audit({ action: "people.stage_changed", kind: "stage_change", subject: sql`x.person_id`, before: sql`x.revision`, after: sql`u.revision` })}
 FROM x,u RETURNING id),
m AS (INSERT INTO pipeline_stage_move (id,organization_id,pipeline_person_id,from_stage_id,to_stage_id,from_label,to_label,reason)
 SELECT a.id,${o}::uuid,x.id,fromstage.id,dest.id,fromstage.label,dest.label,${input.reason} FROM a,x,fromstage,dest)
SELECT EXISTS(SELECT FROM x) AS found,(SELECT revision::text FROM x) AS current,(SELECT revision::text FROM u) AS revision,
 EXISTS(SELECT FROM dest) AS stage,EXISTS(SELECT FROM x,dest WHERE x.stage_id=dest.id) AS same`,
		);
		if (row.found && !row.stage) refuse({ code: "invalid_input", field: "stageId" });
		if (row.found && row.same && row.current === input.expectedRevision) return { revision: row.current };
		return settle(row, input.expectedRevision);
	});
}

/**
 * Records that an outside assessment happened, on a day no later than today in the organization's time zone, and who
 * ran it. The request has no outcome field and the row has no outcome column (REQ-MUL-008). Owner or Admin.
 */
function recordAssessment(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.recordAssessmentRequest, raw);
		const row = await one(
			w,
			changed.extend({ past: z.boolean() }),
			sql`WITH x AS (${target(w, input.personId)}),
d AS (SELECT ${input.assessedOn}::date<=(clock_timestamp() AT TIME ZONE o.timezone)::date AS past FROM organization o
 WHERE o.id=${w.organization}::uuid),
u AS (UPDATE pipeline_person pp SET assessed_on=${input.assessedOn}::date,assessor_label=${input.assessor},revision=pp.revision+1
 FROM x,d WHERE pp.id=x.id AND x.revision=${input.expectedRevision}::bigint AND d.past RETURNING pp.revision),
a AS (${w.audit({ action: "people.recorded", kind: "edit", subject: sql`x.person_id`, before: sql`x.revision`, after: sql`u.revision`, metadata: { category: "outside_assessment" } })}
 FROM x,u RETURNING id)
SELECT EXISTS(SELECT FROM x) AS found,(SELECT revision::text FROM x) AS current,(SELECT revision::text FROM u) AS revision,
 coalesce((SELECT past FROM d),false) AS past`,
		);
		if (row.found && !row.past) refuse({ code: "invalid_input", field: "assessedOn" });
		return settle(row, input.expectedRevision);
	});
}

/**
 * Retires a live person or restores a retired one. Retiring keeps the stage and history; the person leaves the board,
 * the counts and every picker until restored, back at the same stage (REQ-MUL-001). Owner or Admin.
 */
function lifecycle(change: "retire" | "restore") {
	return (db: Database, authority: RequestActor, raw: unknown) =>
		write(db, authority, true, async (w) => {
			const input = parse(C.pipelinePersonLifecycleRequest, raw);
			const [from, to] = change === "retire" ? ["live", "retired"] : ["retired", "live"];
			const row = await one(
				w,
				changed,
				sql`WITH x AS (${target(w, input.personId, from)}),
u AS (UPDATE pipeline_person pp SET revision=pp.revision+1 FROM x
 WHERE pp.id=x.id AND x.revision=${input.expectedRevision}::bigint RETURNING pp.revision),
p AS (UPDATE person p SET state=${to},retired_at=${change === "retire" ? sql`clock_timestamp()` : sql`NULL`},revision=p.revision+1
 FROM x,u WHERE p.id=x.person_id AND p.tenant_id=${w.organization}::uuid RETURNING p.id),
a AS (${w.audit({ action: change === "retire" ? "people.retired" : "people.restored", kind: change, subject: sql`x.person_id`, before: sql`x.revision`, after: sql`u.revision` })}
 FROM x,u,p RETURNING id)
SELECT EXISTS(SELECT FROM x) AS found,(SELECT revision::text FROM x) AS current,(SELECT revision::text FROM u) AS revision`,
			);
			return settle(row, input.expectedRevision);
		});
}

const stageRows = z.array(
	z.object({
		id: z.string(),
		label: z.string(),
		kind: z.string(),
		position: z.number(),
		revision: z.string(),
		held: z.coerce.number(),
	}),
);
/**
 * Saves the reviewed stage list (REQ-MUL-008): renames, new stages, order and removals, all or nothing. A stage that
 * still holds a person, live or retired, cannot be removed. An existing stage keeps its kind. Owner or Admin.
 */
function saveStages(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.saveStagesRequest, raw);
		const o = w.organization;
		await w.tx.execute(insertStarters(o));
		const current = stageRows.parse(
			(
				await w.tx.execute(sql`SELECT s.id,s.label,s.stable_kind AS kind,s.position,s.revision::text AS revision,
 (SELECT count(*) FROM pipeline_person pp JOIN person p ON p.id=pp.person_id AND p.tenant_id=pp.organization_id
  WHERE pp.stage_id=s.id AND pp.organization_id=s.organization_id AND p.state IN ('live','retired')) AS held
 FROM pipeline_stage s WHERE s.organization_id=${o}::uuid AND s.removed_at IS NULL ORDER BY s.position,s.id FOR UPDATE OF s`)
			).rows,
		);
		const byId = new Map(current.map((s) => [s.id, s]));
		const listed = new Set<string>(input.stages.map((s) => s.id));
		const removed = new Set<string>(input.removed.map((s) => s.id));
		if (listed.size !== input.stages.length || [...listed].some((id) => removed.has(id)))
			refuse({ code: "invalid_input", field: "stages" });
		const labels = input.stages.map((s) => s.label.toLowerCase());
		if (new Set(labels).size !== labels.length) refuse({ code: "invalid_input", field: "label" });
		// The editor must have seen every current stage, each at the revision it holds now.
		if (current.some((s) => !listed.has(s.id) && !removed.has(s.id))) refuse({ code: "conflict" });
		for (const s of input.removed) {
			const now = byId.get(s.id);
			if (!now || now.revision !== s.expectedRevision) refuse({ code: "conflict" });
			if (now!.held > 0) refuse({ code: "stage_occupied", stageId: s.id as never, people: now!.held });
		}
		const changes = input.stages.map((s, position) => {
			const now = byId.get(s.id);
			if (s.expectedRevision === null) {
				if (now) refuse({ code: "conflict" });
				return { id: s.id, label: s.label, kind: s.kind, position, change: "add" };
			}
			if (!now || now.revision !== s.expectedRevision) refuse({ code: "conflict" });
			if (now!.kind !== s.kind) refuse({ code: "invalid_input", field: "kind" });
			const same = now!.label === s.label && now!.position === position;
			return { id: s.id, label: s.label, kind: s.kind, position, change: same ? "keep" : "edit" };
		});
		const gone = input.removed.map((s) => s.id);
		if (!gone.length && changes.every((c) => c.change === "keep")) return { outcome: "noop" as const };
		const rows = JSON.stringify(changes.filter((c) => c.change !== "keep"));
		await w.tx
			.execute(sql`WITH c AS (SELECT * FROM jsonb_to_recordset(${rows}::jsonb) c(id uuid,label text,kind text,position int,change text)),
e AS (UPDATE pipeline_stage s SET label=c.label,position=c.position,revision=s.revision+1 FROM c
 WHERE c.change='edit' AND s.id=c.id AND s.organization_id=${o}::uuid RETURNING s.id),
n AS (INSERT INTO pipeline_stage (id,organization_id,stable_kind,label,position,revision)
 SELECT c.id,${o}::uuid,c.kind,c.label,c.position,1 FROM c WHERE c.change='add' RETURNING id),
r AS (UPDATE pipeline_stage s SET removed_at=clock_timestamp(),revision=s.revision+1
 WHERE s.organization_id=${o}::uuid AND s.id=ANY(${sql.param(gone)}::uuid[]) RETURNING s.id),
a AS (${w.audit({
			action: "settings.changed",
			kind: "edit",
			subjectType: "organization",
			subject: sql`${o}::uuid`,
			metadata: {
				category: "pipeline_stages",
				added: changes.filter((c) => c.change === "add").map((c) => c.id),
				edited: changes.filter((c) => c.change === "edit").map((c) => c.id),
				removed: gone,
			},
		})} RETURNING id)
SELECT 1`);
		return { outcome: "changed" as const };
	});
}

/** Whether the writer may read and write notes on the live person `x`: an Owner or Admin, or their responsible staff. */
const noteDuty = (w: Writer) => sql`(${w.administrator} OR x.responsible_seat_id=${w.seatId}::uuid)`;
const noteTarget = (w: Writer, person: SQL) =>
	sql`SELECT pp.person_id,pp.responsible_seat_id FROM pipeline_person pp JOIN person p ON p.id=pp.person_id
 AND p.tenant_id=pp.organization_id WHERE pp.organization_id=${w.organization}::uuid AND pp.person_id=${person}
 AND p.state='live' FOR SHARE OF pp,p`;

/**
 * Adds a note to a person the writer is responsible for, or to anyone for an Owner or Admin (REQ-MUL-009). The browser
 * names the note's ID, so a repeated request adds no second note.
 */
function addNote(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, false, async (w) => {
		const input = parse(C.addPipelineNoteRequest, raw);
		const row = await one(
			w,
			z.object({ allowed: z.boolean(), added: z.boolean(), existing: z.string().nullable() }),
			sql`WITH x AS (${noteTarget(w, sql`${input.personId}::uuid`)}),
n AS (INSERT INTO person_note (id,tenant_id,person_id,author_id,body,occurred_at,recorded_at,revision)
 SELECT ${input.noteId}::uuid,${w.organization}::uuid,x.person_id,${w.actor}::uuid,${input.body},clock_timestamp(),clock_timestamp(),1
 FROM x WHERE ${noteDuty(w)} ON CONFLICT (id) DO NOTHING RETURNING id,person_id),
a AS (${w.audit({ action: "people.updated", kind: "create", subject: sql`n.person_id`, metadata: { category: "note", noteId: input.noteId } })}
 FROM n RETURNING id)
SELECT EXISTS(SELECT FROM x WHERE ${noteDuty(w)}) AS allowed,EXISTS(SELECT FROM n) AS added,
 (SELECT revision::text FROM person_note WHERE id=${input.noteId}::uuid AND tenant_id=${w.organization}::uuid
  AND author_id=${w.actor}::uuid AND person_id=${input.personId}::uuid) AS existing`,
		);
		if (!row.allowed) refuse();
		if (row.added) return { noteId: input.noteId, revision: "1" };
		if (row.existing) return { noteId: input.noteId, revision: row.existing };
		return refuse({ code: "conflict" });
	});
}

/**
 * Edits or removes a note. Only its author may, and only while they still hold the duty to read it (REQ-MUL-009).
 * Removal clears the body; the note's author and day remain as "Note removed".
 */
function noteChange(change: "edit" | "remove") {
	return (db: Database, authority: RequestActor, raw: unknown) =>
		write(db, authority, false, async (w) => {
			const input = parse(change === "edit" ? C.editPipelineNoteRequest : C.removePipelineNoteRequest, raw);
			const body = "body" in input ? input.body : "";
			const row = await one(
				w,
				changed,
				sql`WITH n AS (SELECT n.id,n.person_id,n.revision FROM person_note n WHERE n.id=${input.noteId}::uuid
 AND n.tenant_id=${w.organization}::uuid AND n.plant_id IS NULL AND n.author_id=${w.actor}::uuid AND n.removed_at IS NULL FOR UPDATE),
x AS (${noteTarget(w, sql`(SELECT person_id FROM n)`)}),
u AS (UPDATE person_note t SET body=${body},${change === "edit" ? sql`edited_at` : sql`removed_at`}=clock_timestamp(),
 revision=t.revision+1 FROM n,x WHERE t.id=n.id AND ${noteDuty(w)} AND n.revision=${input.expectedRevision}::bigint RETURNING t.revision),
a AS (${w.audit({ action: "people.updated", kind: change === "edit" ? "edit" : "remove", subject: sql`n.person_id`, before: sql`n.revision`, after: sql`u.revision`, metadata: { category: "note", noteId: input.noteId } })}
 FROM n,u RETURNING id)
SELECT EXISTS(SELECT FROM n,x WHERE ${noteDuty(w)}) AS found,(SELECT revision::text FROM n) AS current,
 (SELECT revision::text FROM u) AS revision`,
			);
			return { noteId: input.noteId, ...settle(row, input.expectedRevision) };
		});
}

/** Every pipeline write. The statement census measures each one as `pipeline.<name>`. */
export const pipelineWriter = {
	addPerson,
	editPerson,
	movePerson,
	recordAssessment,
	retirePerson: lifecycle("retire"),
	restorePerson: lifecycle("restore"),
	saveStages,
	addNote,
	editNote: noteChange("edit"),
	removeNote: noteChange("remove"),
};
