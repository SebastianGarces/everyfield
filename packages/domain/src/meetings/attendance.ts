import * as c from "@everyfield/contracts/meetings";
import { stage as personStage } from "@everyfield/contracts/people";
import { followUpOwner } from "@everyfield/contracts/tasks";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { AuditWrite } from "../operations/writes.ts";
import { columnsChanged, freshPosition } from "../people/people.ts";
import {
	applyManagedStatus,
	ensureMeetingObligations,
	managedTasks,
	obligationFacts,
	type TaskReminders,
} from "../tasks/index.ts";
import { TaskRefusal } from "../tasks/core.ts";
import {
	command,
	deny,
	parse,
	reply,
	type Change,
	type MeetingWrite,
	type MeetingsContext,
	type Tx,
	type Writer,
} from "./core.ts";

// Attendance, finalization, evaluation and attendee notes (WP-022). Each command is one meetings command (D70): the
// locked actor, the request key, one locked fact read, then one write statement with the change and its audit rows.
// Generated tasks join that statement through WP-024's producers; their reminders sync once after it.

type Presence = z.infer<typeof c.presence>;
type Classification = z.infer<typeof c.classification>;
type Stage = z.infer<typeof personStage>;
const COMMITTED: readonly Stage[] = ["core_group", "launch_team", "leader"];
const date = z.coerce.date();

export const guestRow = z.object({
	id: z.uuid(),
	revision: z.string(),
	person_id: z.uuid(),
	presence: c.presence,
	rsvp: c.rsvp,
	has_card: z.boolean(),
	removed_at: date.nullable(),
	classification: c.classification.nullable(),
	classification_stage: personStage.nullable(),
	classification_person_revision: z.string().nullable(),
	classification_as_of: date.nullable(),
	prior_vision_id: z.uuid().nullable(),
	actual_occurrence_at: date.nullable(),
	display_name: z.string(),
	person_state: z.enum(["live", "retired", "merged"]),
});
type GuestRow = z.infer<typeof guestRow>;
const personRow = z.object({
	id: z.uuid(),
	state: z.enum(["live", "retired", "merged"]),
	stage: personStage,
	revision: z.string(),
	pipeline_position: z.string().nullable(),
	display_name: z.string(),
});
/** Another meeting's attended row whose first-or-returning answer depends on this meeting (late history). */
const laterRow = guestRow.omit({ display_name: true, person_state: true, rsvp: true, has_card: true }).extend({
	meeting_id: z.uuid(),
	follow_up: z.uuid().nullable(),
	next_first: z.uuid().nullable(),
	meeting_date: z.string(),
	meeting_zone: z.string(),
	meeting_at: date,
});
const lockedTasks = z.array(z.object({ obligation_id: z.uuid(), assignee_id: z.uuid().nullable() }));
const ownerFactsRow = z.object({
	seats: z.record(z.string(), z.string()),
	names: z.record(z.string(), z.string()),
	reasons: z.record(z.string(), z.string().nullable()),
});
const obligationRow = z.object({
	id: z.uuid(),
	kind: z.enum(["follow_up", "evaluation"]),
	person_id: z.uuid().nullable(),
	assignee_id: z.uuid().nullable(),
	task_status: z.string().nullable(),
});
const factsRow = z.object({
	id: z.uuid(),
	type: c.meetingType,
	status: c.meetingStatus,
	local_date: z.string(),
	timezone: z.string(),
	occurred_at: date,
	voided: z.boolean(),
	attendance_revision: z.string(),
	snapshot_revision: z.string(),
	finalized_at: date.nullable(),
	finalized_revision: z.string().nullable(),
	leads: z.boolean(),
	now: date,
	guests: z.array(guestRow),
	people: z.array(personRow),
	earlier: z.record(z.string(), z.uuid()),
	later: z.array(laterRow),
	obligations: z.array(obligationRow),
	// Settling only: WP-024's producer facts and the locked tasks of these People's follow-ups.
	obligation_facts: z.unknown(),
	tasks: z.unknown(),
});
type Facts = z.infer<typeof factsRow>;

const occurrence = sql`coalesce(o.actual_occurrence_at, o.starts_at)`;
const here = sql`coalesce(m.actual_occurrence_at, m.starts_at)`;
/** An attended row on a finalized, unvoided meeting of the same type: real attendance history. */
const attendedOn = sql`g.presence = 'attended' AND g.removed_at IS NULL AND o.type = m.type
	AND o.finalized_at IS NOT NULL AND o.occurrence_voided_at IS NULL AND g.plant_id = m.plant_id`;

/**
 * The meeting (row lock), its guests (row locks), the named People and the attendance history that decides first or
 * returning, in one statement. A wait for the meeting lock leaves the statement's older snapshot in the subqueries;
 * the fresh meeting revision then differs from the snapshot's and the read runs once more under the lock it holds.
 */
async function lockAttendance(
	tx: Tx,
	w: Writer,
	meetingId: string,
	personIds: readonly string[],
	settling: { assignees: readonly string[] } | null,
) {
	const forUpdate = settling !== null;
	const ids = sql`${sql.param([...personIds])}::uuid[]`;
	// Parameters, not the outer alias `m`: these expressions also run inside the task producers' own queries.
	const plant = sql`${w.plant.id}::uuid`,
		meeting = sql`${meetingId}::uuid`;
	const subjects = sql`(SELECT unnest(${ids}) UNION SELECT s.person_id FROM participation s
		WHERE s.meeting_id = ${meeting} AND s.presence = 'attended' AND s.removed_at IS NULL)`;
	const query = sql`SELECT m.id, m.type, m.status, m.local_date::text AS local_date, m.timezone,
		${here} AS occurred_at, m.occurrence_voided_at IS NOT NULL AS voided,
		m.attendance_revision::text AS attendance_revision,
		(SELECT x.attendance_revision::text FROM meeting x WHERE x.id = m.id) AS snapshot_revision,
		m.finalized_at, m.finalized_revision::text AS finalized_revision,
		(m.type = 'team_meeting' AND EXISTS (SELECT FROM team t JOIN person lp ON lp.id = t.leader_person_id
			WHERE t.id = m.team_id AND t.plant_id = m.plant_id AND t.archived_at IS NULL AND lp.state = 'live'
			AND lp.linked_account_id = ${w.accountId}::uuid)) AS leads,
		clock_timestamp() AS now,
		(SELECT coalesce(json_agg(x ORDER BY x.id), '[]') FROM (SELECT g.id, g.revision::text AS revision, g.person_id,
			g.presence, coalesce(g.rsvp, 'pending') AS rsvp, g.card_response IS NOT NULL AS has_card, g.removed_at,
			g.classification, g.classification_stage, g.classification_person_revision::text AS classification_person_revision,
			g.classification_as_of, g.prior_vision_id, g.actual_occurrence_at, p.display_name, p.state AS person_state
			FROM participation g JOIN person p ON p.id = g.person_id WHERE g.meeting_id = m.id ORDER BY g.id
			FOR UPDATE OF g) x) AS guests,
		(SELECT coalesce(json_agg(x ORDER BY x.id), '[]') FROM (SELECT p.id, p.state, p.stage, p.revision::text AS revision,
			p.pipeline_position::text AS pipeline_position, p.display_name FROM person p
			WHERE p.id IN ${subjects} AND p.tenant_id = m.plant_id AND p.plant_id = m.plant_id ORDER BY p.id
			${forUpdate ? sql`FOR UPDATE OF p` : sql`FOR SHARE OF p`}) x) AS people,
		(SELECT coalesce(json_object_agg(x.person_id, x.first_id), '{}') FROM (SELECT DISTINCT ON (g.person_id) g.person_id,
			o.id AS first_id FROM participation g JOIN meeting o ON o.id = g.meeting_id
			WHERE ${attendedOn} AND o.id <> m.id AND g.person_id IN ${subjects} AND ${occurrence} < ${here}
			ORDER BY g.person_id, ${occurrence}, o.id) x) AS earlier,
		(SELECT coalesce(json_agg(x ORDER BY x.id), '[]') FROM (SELECT g.id, g.revision::text AS revision, g.person_id,
			g.presence, g.removed_at, g.classification, g.classification_stage,
			g.classification_person_revision::text AS classification_person_revision, g.classification_as_of,
			g.prior_vision_id, g.actual_occurrence_at, g.meeting_id, o.local_date::text AS meeting_date,
			o.timezone AS meeting_zone, ${occurrence} AS meeting_at,
			(SELECT b.id FROM obligation b WHERE b.meeting_id = o.id AND b.person_id = g.person_id AND b.kind = 'follow_up'
				AND b.superseded_at IS NULL) AS follow_up,
			(SELECT f.id FROM participation e JOIN meeting f ON f.id = e.meeting_id
				WHERE e.person_id = g.person_id AND e.presence = 'attended' AND e.removed_at IS NULL AND f.type = m.type
				AND f.finalized_at IS NOT NULL AND f.occurrence_voided_at IS NULL AND f.id NOT IN (m.id, o.id)
				AND coalesce(f.actual_occurrence_at, f.starts_at) < ${occurrence}
				ORDER BY coalesce(f.actual_occurrence_at, f.starts_at), f.id LIMIT 1) AS next_first
			FROM participation g JOIN meeting o ON o.id = g.meeting_id
			LEFT JOIN meeting pv ON pv.id = g.prior_vision_id
			WHERE ${attendedOn} AND o.id <> m.id AND g.person_id IN ${subjects} AND ${occurrence} > ${here}
			AND (g.prior_vision_id IS NULL OR g.prior_vision_id = m.id
				OR coalesce(pv.actual_occurrence_at, pv.starts_at) > ${here})
			ORDER BY g.id FOR UPDATE OF g) x) AS later,
		(SELECT coalesce(json_agg(json_build_object('id', b.id, 'kind', b.kind, 'person_id', b.person_id,
			'assignee_id', t.assignee_id, 'task_status', t.status)), '[]')
			FROM obligation b LEFT JOIN task t ON t.obligation_id = b.id AND t.deleted_at IS NULL
			WHERE b.meeting_id = m.id AND b.plant_id = m.plant_id AND b.superseded_at IS NULL) AS obligations,
		${
			settling
				? sql`${obligationFacts(
						w.plant.id,
						sql`ARRAY(SELECT ${meeting} UNION SELECT s.meeting_id FROM participation s WHERE s.plant_id = ${plant}
							AND s.person_id IN ${subjects})`,
						sql`ARRAY${subjects}`,
						// The input's assignees and the owners of the locked duties below, so settle builds each owner view once.
						sql`ARRAY(SELECT unnest(${sql.param([...settling.assignees])}::uuid[])
							UNION SELECT t.assignee_id FROM task t JOIN obligation b ON b.id = t.obligation_id
							WHERE b.plant_id = ${plant} AND t.deleted_at IS NULL AND t.assignee_id IS NOT NULL
							AND (b.meeting_id = ${meeting} OR (b.kind = 'follow_up' AND b.person_id IN ${subjects})))`,
					)} AS obligation_facts,
					${managedTasks(
						w.plant.id,
						sql`ARRAY(SELECT b.id FROM obligation b WHERE b.plant_id = ${plant} AND b.kind = 'follow_up'
							AND b.person_id IN ${subjects})`,
					)} AS tasks`
				: sql`NULL AS obligation_facts, NULL AS tasks`
		}
		FROM meeting m WHERE m.plant_id = ${w.plant.id}::uuid AND m.id = ${meetingId}::uuid AND m.retired_at IS NULL
		FOR UPDATE OF m`;
	for (let attempt = 0; ; attempt++) {
		const r = await tx.execute(query);
		if (!r.rows[0]) deny();
		const f = factsRow.parse(r.rows[0]);
		if (f.snapshot_revision === f.attendance_revision || attempt > 0) {
			// Only an Owner or Admin, or the current leader of this team meeting, records attendance.
			if (!w.admin && !f.leads) deny();
			return f;
		}
	}
}

/** WP-024's producers refuse in their own terms; a meetings command answers in its contract's codes. */
async function generated<T>(body: () => Promise<T>): Promise<T> {
	try {
		return await body();
	} catch (error) {
		if (!(error instanceof TaskRefusal)) throw error;
		if (error.code === "invalid_subject" || error.code === "invalid_input" || error.code === "owner_ineligible")
			deny(error.code, {});
		deny();
	}
}
const committed = (s: Stage | null) => s !== null && COMMITTED.includes(s);
function classify(stage: Stage, prior: string | null): Classification {
	return committed(stage) ? "core_group" : prior ? "returning" : "first_time";
}
const attendedIds = (f: Facts) =>
	f.guests.filter((g) => g.presence === "attended" && !g.removed_at).map((g) => g.person_id);
export const attendee = (g: GuestRow) =>
	c.attendee.parse({
		guestId: g.id,
		revision: g.revision,
		person: { personId: g.person_id, displayName: g.display_name, state: g.person_state },
		presence: g.presence,
		rsvp: g.rsvp,
		hasCard: g.has_card,
		classification: g.classification,
		classificationStage: g.classification_stage,
		priorVisionId: g.prior_vision_id,
	});
/** Every named Person that would start a new row must be a live Person of this church; otherwise nothing is written. */
function requireLive(f: Facts, ids: readonly string[]) {
	const live = new Set(f.people.filter((p) => p.state === "live").map((p) => p.id));
	const bad = ids.filter((id) => !live.has(id));
	if (bad.length) deny("invalid_subject", { personIds: bad });
}

type RowWrite = Omit<GuestRow, "display_name" | "person_state" | "rsvp" | "has_card">;
/** All participation changes of a command in one UPDATE, fenced by the revision each row was read at. */
function updateRows(plantId: string, rows: readonly RowWrite[]): SQL {
	const values = rows.map((r) => ({
		id: r.id,
		revision: r.revision,
		presence: r.presence,
		removed: r.removed_at !== null,
		classification: r.classification,
		classification_stage: r.classification_stage,
		classification_person_revision: r.classification_person_revision,
		classification_as_of: r.classification_as_of?.toISOString() ?? null,
		prior_vision_id: r.prior_vision_id,
		actual_occurrence_at: r.actual_occurrence_at?.toISOString() ?? null,
	}));
	return sql`UPDATE participation g SET presence = v.presence,
		removed_at = CASE WHEN v.removed THEN g.removed_at ELSE NULL END, classification = v.classification,
		classification_stage = v.classification_stage, classification_person_revision = v.classification_person_revision,
		classification_as_of = v.classification_as_of, prior_vision_id = v.prior_vision_id,
		actual_occurrence_at = v.actual_occurrence_at, revision = g.revision + 1
		FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS v(id uuid, revision bigint, presence text, removed boolean,
			classification text, classification_stage text, classification_person_revision bigint,
			classification_as_of timestamptz, prior_vision_id uuid, actual_occurrence_at timestamptz)
		WHERE g.id = v.id AND g.revision = v.revision AND g.plant_id = ${plantId}::uuid`;
}
/** New guest rows with the same full snapshot shape updateRows writes, so an insert never drops a classification. */
function insertRows(plantId: string, meetingId: string, rows: readonly RowWrite[]) {
	const values = rows.map((r) => ({
		id: r.id,
		person_id: r.person_id,
		presence: r.presence,
		classification: r.classification,
		classification_stage: r.classification_stage,
		classification_person_revision: r.classification_person_revision,
		classification_as_of: r.classification_as_of?.toISOString() ?? null,
		prior_vision_id: r.prior_vision_id,
		actual_occurrence_at: r.actual_occurrence_at?.toISOString() ?? null,
	}));
	return sql`INSERT INTO participation (id, plant_id, meeting_id, person_id, roster_member, rsvp, presence,
		classification, classification_stage, classification_person_revision, classification_as_of, prior_vision_id,
		actual_occurrence_at)
		SELECT v.id, ${plantId}::uuid, ${meetingId}::uuid, v.person_id, false, 'pending', v.presence, v.classification,
			v.classification_stage, v.classification_person_revision, v.classification_as_of, v.prior_vision_id,
			v.actual_occurrence_at
		FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS v(id uuid, person_id uuid, presence text,
			classification text, classification_stage text, classification_person_revision bigint,
			classification_as_of timestamptz, prior_vision_id uuid, actual_occurrence_at timestamptz)`;
}
const bumpAttendance = (f: Facts, finalize: boolean) =>
	sql`UPDATE meeting SET attendance_revision = attendance_revision + 1
		${finalize ? sql`, finalized_revision = attendance_revision + 1, finalized_at = coalesce(finalized_at, clock_timestamp())` : sql``}
		WHERE id = ${f.id}::uuid AND attendance_revision = ${f.attendance_revision}::bigint`;
const nextRevision = (r: string) => String(BigInt(r) + 1n);

/**
 * Draft presence for some guests (REQ-MTG-010). A live Person not on the list joins it when marked attended (a
 * walk-in); a Person who is neither a guest nor live refuses the whole change. RSVP, card, inviter and notes stay.
 * Finalized attendance changes only through reconcileAttendance.
 */
async function setPresence(
	tx: Tx,
	w: Writer,
	audit: AuditWrite,
	meetingId: string,
	entries: readonly { personId: string; presence: Presence }[],
	options: { join: boolean },
): Promise<Change<z.infer<typeof c.attendanceMutationResult>>> {
	const f = await lockAttendance(
		tx,
		w,
		meetingId,
		entries.map((e) => e.personId),
		null,
	);
	if (f.finalized_at) deny("status_transition");
	if (f.status === "cancelled") deny("status_transition");
	const byPerson = new Map(f.guests.map((g) => [g.person_id, g]));
	const joining = entries.filter((e) => !byPerson.get(e.personId) || byPerson.get(e.personId)!.removed_at);
	if (joining.length && (!options.join || joining.some((e) => e.presence !== "attended")))
		deny(
			options.join ? "invalid_subject" : "unavailable",
			options.join ? { personIds: joining.map((e) => e.personId) } : {},
		);
	requireLive(
		f,
		joining.map((e) => e.personId),
	);
	const people = new Map(f.people.map((p) => [p.id, p]));
	const updates: GuestRow[] = [],
		inserts: GuestRow[] = [],
		after: GuestRow[] = [];
	const before: Record<string, Presence | null> = {},
		changedTo: Record<string, Presence> = {};
	for (const e of entries) {
		const g = byPerson.get(e.personId);
		if (g && !g.removed_at && g.presence === e.presence) continue;
		before[e.personId] = g && !g.removed_at ? g.presence : null;
		changedTo[e.personId] = e.presence;
		if (g) {
			const next = { ...g, presence: e.presence, removed_at: null };
			updates.push(next);
			after.push({ ...next, revision: nextRevision(g.revision) });
		} else {
			const id = randomUUID(),
				p = people.get(e.personId)!;
			const row: GuestRow = {
				id,
				revision: "1",
				person_id: p.id,
				presence: e.presence,
				rsvp: "pending",
				has_card: false,
				removed_at: null,
				classification: null,
				classification_stage: null,
				classification_person_revision: null,
				classification_as_of: null,
				prior_vision_id: null,
				actual_occurrence_at: null,
				display_name: p.display_name,
				person_state: p.state,
			};
			inserts.push(row);
			after.push(row);
		}
	}
	const changed = after.length > 0;
	if (changed) {
		if (updates.length) audit.writes.push(updateRows(w.plant.id, updates));
		if (inserts.length) audit.writes.push(insertRows(w.plant.id, f.id, inserts));
		audit.writes.push(bumpAttendance(f, false));
	}
	return {
		value: c.attendanceMutationResult.parse({
			receiptId: audit.id,
			outcome: changed ? "changed" : "noop",
			meetingId: f.id,
			attendanceRevision: changed ? nextRevision(f.attendance_revision) : f.attendance_revision,
			attendees: (changed ? after : entries.map((e) => byPerson.get(e.personId)!)).map(attendee),
		}),
		subject: f.id,
		subjectType: "meeting",
		meetingId: f.id,
		action: "meetings.changed",
		kind: "edit",
		outcome: changed ? "changed" : "noop",
		before: { presence: before },
		after: { presence: changedTo },
		metadata: { event: "attendance_changed" },
	};
}

/**
 * Finalize or reconcile (REQ-MTG-012, REQ-MTG-020): the exact attended set, each newly attended Person's
 * classification snapshot, the prospect→attendee advance of a first Vision attendance (REQ-PPL-020), first-Vision
 * follow-ups and the evaluation task, and the source-corrected close of follow-ups that no longer apply. All of it joins
 * one write statement with the audit rows, or nothing changes. Later meetings that this meeting now precedes are
 * reclassified as returning and lose their open first-Vision follow-up.
 */
async function settle(
	tx: Tx,
	w: Writer,
	audit: AuditWrite,
	reminders: TaskReminders,
	mode: "finalize" | "reconcile",
	input: {
		meetingId: string;
		attendeeIds: readonly string[];
		expectedRevision: string;
		followUpAssigneeId: string | null;
		evaluationAssigneeId: string | null;
		reason: string | null;
	},
) {
	const f = await lockAttendance(tx, w, input.meetingId, input.attendeeIds, {
		assignees: [input.followUpAssigneeId, input.evaluationAssigneeId].filter((a) => a !== null),
	});
	if (f.status === "cancelled" || f.voided) deny("status_transition");
	const vision = f.type === "vision_meeting";
	const current = attendedIds(f),
		finalSet = new Set(input.attendeeIds);
	const added = input.attendeeIds.filter((id) => !current.includes(id)),
		removed = current.filter((id) => !finalSet.has(id));
	const same = !added.length && !removed.length;
	if (mode === "reconcile" && !f.finalized_at) deny("status_transition");
	// An unchanged finalize, also a concurrent second one, shows the earlier result without a new change.
	const noop = f.finalized_at !== null && same;
	if (mode === "finalize" && f.finalized_at && !same) deny("status_transition");
	if (!noop && f.attendance_revision !== input.expectedRevision) deny("conflict");
	// Newly attended People must be live Persons of this church now; finalized history keeps everyone else.
	const fresh = mode === "finalize" && !f.finalized_at ? [...input.attendeeIds] : added;
	if (!noop) requireLive(f, fresh);

	const people = new Map(f.people.map((p) => [p.id, p]));
	const byPerson = new Map(f.guests.map((g) => [g.person_id, g]));
	const occurredAt = f.occurred_at;
	const rows: RowWrite[] = [],
		inserts: RowWrite[] = [];
	// The result parses these with the contract below.
	const classifications: z.input<typeof c.finalizationResult>["classifications"] = [];
	const stageChanges: { personId: string; from: Stage; to: Stage; revision: string; position: string }[] = [];
	const closing = new Set<string>();
	const obligations = new Map(
		f.obligations.filter((o) => o.kind === "follow_up").map((o) => [o.person_id!, o] as const),
	);
	for (const personId of input.attendeeIds) {
		const g = byPerson.get(personId),
			p = people.get(personId);
		const prior = f.earlier[personId] ?? null;
		if (!fresh.includes(personId)) {
			classifications.push({
				personId,
				classification: g?.classification ?? classify(p?.stage ?? "prospect", prior),
				firstVision: prior === null,
				priorVisionId: g?.prior_vision_id ?? prior,
			});
			continue;
		}
		const stage = p!.stage;
		const cls = classify(stage, prior);
		classifications.push({
			personId,
			classification: cls,
			firstVision: prior === null,
			priorVisionId: prior,
		});
		const snapshot = {
			presence: "attended" as const,
			removed_at: null,
			classification: cls,
			classification_stage: stage,
			classification_person_revision: p!.revision,
			classification_as_of: f.now,
			prior_vision_id: prior,
			actual_occurrence_at: occurredAt,
		};
		if (g) rows.push({ ...g, ...snapshot });
		else inserts.push({ id: randomUUID(), revision: "1", person_id: personId, ...snapshot });
		if (vision && stage === "prospect" && !noop)
			stageChanges.push({
				personId,
				from: "prospect",
				to: "attendee",
				revision: p!.revision,
				// Into another pipeline column: the person goes to its end with a fresh key (D68).
				position: freshPosition(personId),
			});
		// A Person who now has an earlier attended Vision no longer owes a first-Vision follow-up here.
		if (vision && prior && obligations.get(personId)) closing.add(obligations.get(personId)!.id);
	}
	for (const personId of removed) {
		const g = byPerson.get(personId)!;
		rows.push({ ...g, presence: "absent" });
		const o = obligations.get(personId);
		if (vision && o) closing.add(o.id);
	}
	// Later meetings this one now precedes, or no longer precedes. A later meeting that becomes a Person's first Vision
	// owes that Person's follow-up, created in the same producer call; a duty that exists already stays as it is.
	const laterRows: RowWrite[] = [];
	const laterWork = new Map<string, { origin: { at: string; date: string; zone: string }; personIds: string[] }>();
	for (const l of f.later) {
		if (fresh.includes(l.person_id) && l.prior_vision_id !== f.id) {
			laterRows.push({
				...l,
				prior_vision_id: f.id,
				classification: l.classification === "core_group" ? "core_group" : "returning",
			});
			if (vision && l.prior_vision_id === null && l.follow_up) closing.add(l.follow_up);
		} else if (removed.includes(l.person_id) && l.prior_vision_id === f.id) {
			laterRows.push({
				...l,
				prior_vision_id: l.next_first,
				classification: l.classification === "core_group" ? "core_group" : l.next_first ? "returning" : "first_time",
			});
			if (vision && !l.next_first && people.get(l.person_id)?.state === "live") {
				const entry = laterWork.get(l.meeting_id) ?? {
					origin: { at: l.meeting_at.toISOString(), date: l.meeting_date, zone: l.meeting_zone },
					personIds: [],
				};
				entry.personIds.push(l.person_id);
				laterWork.set(l.meeting_id, entry);
			}
		}
	}

	const cmd = { ...audit, actor: { accountId: w.accountId, plantId: w.plant.id } };
	if (!noop) {
		const allRows = [...rows, ...laterRows];
		if (allRows.length) audit.writes.push(updateRows(w.plant.id, allRows));
		if (inserts.length) audit.writes.push(insertRows(w.plant.id, f.id, inserts));
		audit.writes.push(bumpAttendance(f, true));
		if (stageChanges.length) {
			audit.writes.push(
				sql`UPDATE person p SET stage = 'attendee', pipeline_position = v.position, revision = p.revision + 1
					FROM jsonb_to_recordset(${JSON.stringify(stageChanges.map((s) => ({ id: s.personId, position: s.position, revision: s.revision })))}::jsonb)
						AS v(id uuid, position numeric, revision bigint)
					WHERE p.id = v.id AND p.tenant_id = ${w.plant.id}::uuid AND p.revision = v.revision AND p.stage = 'prospect'`,
				columnsChanged(w.plant.id, ["prospect", "attendee"]),
			);
			for (const s of stageChanges)
				audit.events.push({
					id: randomUUID(),
					tenant_id: w.plant.id,
					actor_id: w.accountId,
					subject_type: "person",
					subject_id: s.personId,
					action: "people.stage_changed",
					kind: "stage_change",
					before_value: { stage: s.from },
					after_value: { stage: s.to },
					before_revision: s.revision,
					after_revision: nextRevision(s.revision),
					metadata: { cause: "first_actual_vision_attendance", meetingId: f.id },
				});
		}
	}
	// Generated work: a follow-up for each live first-Vision attendee and the evaluation task, even with no attendees.
	// An existing duty keeps its task and owner, so it is named without an assignee to check again.
	const work: z.infer<typeof c.generatedWork>[] = [];
	const after: (() => Promise<unknown>)[] = [];
	const known = (id: string) => f.obligations.find((o) => o.id === id);
	// The real owner of each existing duty: this meeting's duties and the locked follow-up tasks of the People involved,
	// which include later meetings' follow-ups.
	const owners = new Map<string, string | null>(f.obligations.map((o) => [o.id, o.assignee_id]));
	for (const t of lockedTasks.parse(f.tasks ?? [])) owners.set(t.obligation_id, t.assignee_id);
	const ownerOf = (id: string) => owners.get(id) ?? null;
	// What every screen shows for an owner (REQ-TSK-012): the stored assignee with whether they may own the work.
	// Built once per assignee from the producer facts the lock statement read: a follow-up owner follows REQ-TSK-012,
	// an evaluation owner needs only a seat.
	const ownerFacts = ownerFactsRow.parse(f.obligation_facts);
	const viewOf = (id: string | null, kind: "follow_up" | "evaluation"): z.infer<typeof followUpOwner> | null => {
		if (!id) return null;
		const reason = kind === "follow_up" ? (ownerFacts.reasons[id] ?? null) : id in ownerFacts.seats ? null : "no_seat";
		return followUpOwner.parse({
			accountId: id,
			displayName: ownerFacts.names[id] ?? "",
			eligible: reason === null,
			reason,
		});
	};
	if (vision && noop)
		for (const o of f.obligations)
			work.push(
				c.generatedWork.parse({
					meetingId: f.id,
					kind: o.kind === "follow_up" ? "first_vision_follow_up" : "meeting_evaluation",
					personId: o.person_id,
					obligationId: o.id,
					taskId: null,
					outcome: "existing",
					assigneeId: o.assignee_id,
					needsOwner: o.assignee_id === null,
					owner: viewOf(o.assignee_id, o.kind),
				}),
			);
	else if (vision) {
		const evaluation = f.obligations.find((o) => o.kind === "evaluation");
		const ensured = await generated(() =>
			ensureMeetingObligations(
				tx,
				cmd,
				reminders,
				{
					meetings: [
						{
							meetingId: f.id,
							origin: { at: occurredAt.toISOString(), date: f.local_date, zone: f.timezone },
							followUps: input.attendeeIds
								.filter((id) => !f.earlier[id] && people.get(id)?.state === "live")
								.map((personId) => ({
									personId,
									assigneeId: obligations.has(personId) ? null : input.followUpAssigneeId,
								})),
							evaluation: { assigneeId: evaluation ? null : input.evaluationAssigneeId },
						},
						...[...laterWork].map(([meetingId, e]) => ({
							meetingId,
							origin: e.origin,
							followUps: e.personIds.map((personId) => ({ personId, assigneeId: null })),
							evaluation: null,
						})),
					],
				},
				f.obligation_facts,
			),
		);
		after.push(ensured.after);
		for (const e of ensured.value) {
			const assigneeId =
				e.outcome === "existing"
					? ownerOf(e.obligationId)
					: e.meetingId !== f.id
						? null
						: e.kind === "meeting_evaluation"
							? input.evaluationAssigneeId
							: input.followUpAssigneeId;
			const owner = viewOf(assigneeId, e.kind === "meeting_evaluation" ? "evaluation" : "follow_up");
			work.push(c.generatedWork.parse({ ...e, assigneeId, needsOwner: assigneeId === null, owner }));
		}
	}
	if (closing.size && !noop) {
		const closed = await generated(() =>
			applyManagedStatus(
				tx,
				cmd,
				reminders,
				{
					obligationIds: [...closing],
					status: "no_longer_needed",
					reason: input.reason ?? "Source corrected: attendance changed",
				},
				f.tasks,
			),
		);
		if (closed.after) after.push(closed.after);
		for (const t of closed.value.tasks)
			if (t.outcome === "changed")
				work.push(
					c.generatedWork.parse({
						meetingId: f.obligations.some((o) => o.id === t.obligationId)
							? f.id
							: f.later.find((l) => l.follow_up === t.obligationId)?.meeting_id,
						kind: "first_vision_follow_up",
						personId:
							known(t.obligationId)?.person_id ?? f.later.find((l) => l.follow_up === t.obligationId)?.person_id,
						obligationId: t.obligationId,
						taskId: t.taskId,
						outcome: "closed",
						assigneeId: ownerOf(t.obligationId),
						needsOwner: false,
						owner: viewOf(ownerOf(t.obligationId), "follow_up"),
					}),
				);
	}
	const revision = noop ? f.attendance_revision : nextRevision(f.attendance_revision);
	const value = c.finalizationResult.parse({
		receiptId: audit.id,
		outcome: noop ? "noop" : "changed",
		meetingId: f.id,
		attendanceRevision: revision,
		finalizedAt: (f.finalized_at ?? f.now).toISOString(),
		attendeeIds: [...input.attendeeIds],
		added: noop ? [] : added,
		removed: noop ? [] : removed,
		classifications,
		stageChanges: stageChanges.map((s) => ({ personId: s.personId, from: s.from, to: s.to })),
		work,
	});
	const change: Change<typeof value> = {
		value,
		subject: f.id,
		subjectType: "meeting",
		meetingId: f.id,
		action: "meetings.finalized",
		kind: mode === "finalize" && !f.finalized_at ? "finalize" : "reconcile",
		outcome: noop ? "noop" : "changed",
		before: { attendeeIds: [...current].sort() },
		after: { attendeeIds: [...input.attendeeIds].sort() },
		reason: input.reason,
		metadata: { event: mode === "finalize" ? "attendance_finalized" : "attendance_reconciled" },
	};
	return {
		change,
		after: async () => {
			for (const a of after) await a();
		},
	};
}

const evaluationFacts = z.object({
	id: z.uuid(),
	type: c.meetingType,
	status: c.meetingStatus,
	finalized: z.boolean(),
	local_date: z.string(),
	today: z.string(),
	scores: z.array(z.number().int()).nullable(),
	notes: z.string().nullable(),
	evaluated_on: z.string().nullable(),
	evaluated_at: date.nullable(),
	corrected_at: date.nullable(),
	revision: z.string().nullable(),
	corrections: z.number().int(),
	evaluator: z.uuid().nullable(),
	obligation: z.uuid().nullable(),
	now: date,
});
type EvaluationFacts = z.infer<typeof evaluationFacts>;
/** The meeting's evaluation, its evaluator and correction count from audit history, and its evaluation duty. */
export const evaluationColumns = sql`m.id, m.type, m.status, m.finalized_at IS NOT NULL AS finalized,
	m.local_date::text AS local_date, (clock_timestamp() AT TIME ZONE m.timezone)::date::text AS today,
	m.evaluation_scores AS scores, m.evaluation_notes AS notes, m.evaluated_on::text AS evaluated_on, m.evaluated_at,
	m.evaluation_corrected_at AS corrected_at, m.evaluation_revision::text AS revision,
	(SELECT count(*)::int FROM audit_event a WHERE a.tenant_id = m.plant_id AND a.subject_id = m.id
		AND a.metadata->>'event' = 'evaluation_corrected' AND a.kind <> 'noop') AS corrections,
	(SELECT a.actor_id FROM audit_event a WHERE a.tenant_id = m.plant_id AND a.subject_id = m.id
		AND a.metadata->>'event' = 'evaluation_recorded' AND a.kind <> 'noop' ORDER BY a.occurred_at, a.id LIMIT 1) AS evaluator,
	(SELECT b.id FROM obligation b WHERE b.meeting_id = m.id AND b.kind = 'evaluation') AS obligation,
	clock_timestamp() AS now`;
export function evaluationOf(e: EvaluationFacts, notes: boolean): z.infer<typeof c.evaluation> | null {
	if (!e.scores || !e.evaluated_at || !e.evaluated_on || !e.revision) return null;
	const scores = Object.fromEntries(c.evaluationFactors.map((k, i) => [k, e.scores![i]])) as z.infer<typeof c.scores>;
	return c.evaluation.parse({
		evaluationId: e.id,
		meetingId: e.id,
		factorVersion: c.factorVersion,
		scores,
		average: c.averageOf(scores),
		notes: notes ? e.notes : null,
		evaluatedOn: e.evaluated_on,
		recordedAt: e.evaluated_at.toISOString(),
		evaluator: e.evaluator ? { kind: "current_account", accountId: e.evaluator } : { kind: "former_account" },
		revision: e.revision,
		corrections: { count: e.corrections, lastAt: e.corrected_at?.toISOString() ?? null },
	});
}
export const parseEvaluationFacts = (row: unknown) => evaluationFacts.parse(row);
/** The evaluation facts and the evaluation task (row lock), in one statement. */
async function lockEvaluation(tx: Tx, w: Writer, meetingId: string) {
	const r = await tx.execute(sql`SELECT ${evaluationColumns}, ${managedTasks(
		w.plant.id,
		sql`ARRAY(SELECT b.id FROM obligation b WHERE b.meeting_id = ${meetingId}::uuid AND b.kind = 'evaluation')`,
	)} AS tasks FROM meeting m WHERE m.plant_id = ${w.plant.id}::uuid
		AND m.id = ${meetingId}::uuid AND m.retired_at IS NULL FOR UPDATE OF m`);
	if (!r.rows[0]) deny();
	const row = r.rows[0] as Record<string, unknown>;
	return { ...evaluationFacts.parse(row), tasks: row.tasks };
}
const scoreArray = (s: z.infer<typeof c.scores>) => sql`${sql.param(c.evaluationFactors.map((k) => s[k]))}::int[]`;

/** The attendance, finalization, evaluation and attendee-note commands. `reminders` is WP-031's task reminder port. */
export function createAttendanceWriter(deps: { reminders: TaskReminders }) {
	const presence = <S extends z.ZodType<{ requestKey: string; input: { meetingId: string } }>>(
		operation: MeetingWrite,
		schema: S,
		entries: (input: z.output<S>["input"]) => { personId: string; presence: Presence }[],
		join: boolean,
	) =>
		async function (tx: Tx, ctx: MeetingsContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(schema, raw);
				return command(
					tx,
					ctx,
					operation,
					input,
					(w, audit) => setPresence(tx, w, audit, input.input.meetingId, entries(input.input), { join }),
					{ member: true },
				);
			});
		};
	const settlement = (mode: "finalize" | "reconcile") =>
		async function (tx: Tx, ctx: MeetingsContext, raw: unknown) {
			return reply(tx, async () => {
				const input =
					mode === "finalize" ? parse(c.finalizeAttendanceRequest, raw) : parse(c.reconcileAttendanceRequest, raw);
				let after: (() => Promise<unknown>) | undefined;
				const value = await command(
					tx,
					ctx,
					mode === "finalize" ? "meetings.finalizeAttendance" : "meetings.reconcileAttendance",
					input,
					async (w, audit) => {
						const i = input.input;
						const r = await settle(tx, w, audit, deps.reminders, mode, {
							meetingId: i.meetingId,
							attendeeIds: i.attendeeIds,
							expectedRevision: input.expectedRevision,
							followUpAssigneeId: i.followUpAssigneeId,
							evaluationAssigneeId: "evaluationAssigneeId" in i ? i.evaluationAssigneeId : null,
							reason: "reason" in i ? i.reason : null,
						});
						after = r.after;
						return r.change;
					},
					{ member: true },
				);
				await after?.();
				return value;
			});
		};
	return {
		setAttendance: presence(
			"meetings.setAttendance",
			c.setAttendanceRequest,
			(i: z.infer<typeof c.setAttendanceRequest>["input"]) => [{ personId: i.personId, presence: i.presence }],
			false,
		),
		checkIn: presence(
			"meetings.checkIn",
			c.checkInRequest,
			(i: z.infer<typeof c.checkInRequest>["input"]) => [{ personId: i.personId, presence: "attended" }],
			true,
		),
		clearAttendance: presence(
			"meetings.clearAttendance",
			c.clearAttendanceRequest,
			(i: z.infer<typeof c.clearAttendanceRequest>["input"]) => [{ personId: i.personId, presence: "absent" }],
			false,
		),
		captureAttendanceBatch: presence(
			"meetings.captureAttendanceBatch",
			c.captureAttendanceBatchRequest,
			(i: z.infer<typeof c.captureAttendanceBatchRequest>["input"]) => i.entries,
			true,
		),
		finalizeAttendance: settlement("finalize"),
		reconcileAttendance: settlement("reconcile"),
		/**
		 * The one human Vision evaluation (REQ-MTG-014): eight scores, the server's average, the evaluator and instant in
		 * history, and completion of the evaluation task in the same statement. A second submission sees the first.
		 */
		async recordEvaluation(tx: Tx, ctx: MeetingsContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.recordEvaluationRequest, raw);
				let after: (() => Promise<unknown>) | undefined;
				const value = await command(tx, ctx, "meetings.recordEvaluation", input, async (w, audit) => {
					const i = input.input;
					const e = await lockEvaluation(tx, w, i.meetingId);
					if (e.type !== "vision_meeting") deny("wrong_meeting_type");
					const existing = evaluationOf(e, true);
					if (existing)
						return {
							value: c.evaluationMutationResult.parse({
								receiptId: audit.id,
								outcome: "noop",
								evaluation: existing,
								taskCompleted: false,
							}),
							subject: e.id,
							subjectType: "meeting",
							meetingId: e.id,
							action: "meetings.changed",
							kind: "create",
							outcome: "noop",
							metadata: { event: "evaluation_recorded" },
						};
					if (!e.finalized || e.status === "cancelled") deny("status_transition");
					// The window binds a date the client sends. The server's own default (today in the meeting's zone) always
					// saves: finalize accepts a meeting before its local date, so it may be evaluated before it too.
					const on = i.evaluatedOn ?? e.today;
					if (i.evaluatedOn && (on > e.today || on < e.local_date))
						deny("invalid_input", { issues: [{ path: "input.evaluatedOn", problem: "outside_meeting_to_today" }] });
					audit.writes.push(sql`UPDATE meeting SET evaluation_scores = ${scoreArray(i.scores)},
						evaluation_notes = ${i.notes}, evaluated_on = ${on}::date, evaluated_at = ${e.now.toISOString()}::timestamptz,
						evaluation_revision = 1 WHERE id = ${e.id}::uuid AND evaluated_at IS NULL`);
					let taskCompleted = false;
					if (e.obligation) {
						const done = await generated(() =>
							applyManagedStatus(
								tx,
								{ ...audit, actor: { accountId: w.accountId, plantId: w.plant.id } },
								deps.reminders,
								{ obligationIds: [e.obligation!], status: "complete" },
								e.tasks,
							),
						);
						taskCompleted = done.value.outcome === "changed";
						after = done.after;
					}
					const evaluation = evaluationOf(
						{
							...e,
							scores: c.evaluationFactors.map((k) => i.scores[k]),
							notes: i.notes,
							evaluated_on: on,
							evaluated_at: e.now,
							revision: "1",
							evaluator: w.accountId,
						},
						true,
					)!;
					return {
						value: c.evaluationMutationResult.parse({
							receiptId: audit.id,
							outcome: "changed",
							evaluation,
							taskCompleted,
						}),
						subject: e.id,
						subjectType: "meeting",
						meetingId: e.id,
						action: "meetings.changed",
						kind: "create",
						before: null,
						// Scores and their average are meeting facts; note text stays out of history (audit.md).
						after: { ...evaluation.scores, average: evaluation.average, notes: i.notes !== null, revision: "1" },
						metadata: { event: "evaluation_recorded" },
					};
				});
				await after?.();
				return value;
			});
		},
		/**
		 * A reviewed correction (REQ-MTG-015): only the changed factors or notes, the reviewed revision and a reason. It
		 * appends old and new values to history, recomputes the average and never completes or reopens a task.
		 */
		async correctEvaluation(tx: Tx, ctx: MeetingsContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.correctEvaluationRequest, raw);
				return command(tx, ctx, "meetings.correctEvaluation", input, async (w, audit) => {
					const i = input.input;
					const e = await lockEvaluation(tx, w, i.meetingId);
					const before = evaluationOf(e, true);
					if (!before) deny();
					if (before.revision !== input.expectedRevision) deny("conflict");
					const scores = { ...before.scores, ...i.changes };
					const notes = i.notes === undefined ? before.notes : i.notes;
					const changedKeys = c.evaluationFactors.filter((k) => scores[k] !== before.scores[k]);
					const notesChanged = notes !== before.notes;
					const changed = changedKeys.length > 0 || notesChanged;
					const after = changed
						? c.evaluation.parse({
								...before,
								scores,
								notes,
								average: c.averageOf(scores),
								revision: nextRevision(before.revision),
								corrections: { count: before.corrections.count + 1, lastAt: e.now.toISOString() },
							})
						: before;
					if (changed)
						audit.writes
							.push(sql`UPDATE meeting SET evaluation_scores = ${scoreArray(scores)}, evaluation_notes = ${notes},
							evaluation_revision = evaluation_revision + 1, evaluation_corrected_at = ${e.now.toISOString()}::timestamptz
							WHERE id = ${e.id}::uuid AND evaluation_revision = ${before.revision}::bigint`);
					return {
						value: c.evaluationMutationResult.parse({
							receiptId: audit.id,
							outcome: changed ? "changed" : "noop",
							evaluation: after,
							taskCompleted: false,
						}),
						subject: e.id,
						subjectType: "meeting",
						meetingId: e.id,
						action: "meetings.corrected",
						kind: "correct",
						outcome: changed ? "changed" : "noop",
						before: {
							...Object.fromEntries(changedKeys.map((k) => [k, before.scores[k]])),
							average: before.average,
							revision: before.revision,
						},
						after: {
							...Object.fromEntries(changedKeys.map((k) => [k, scores[k]])),
							average: after.average,
							revision: after.revision,
						},
						reason: i.reason,
						metadata: { event: "evaluation_corrected", notesChanged },
					};
				});
			});
		},
		/**
		 * An Owner or Admin note on a Person who attended this meeting (REQ-MTG-017). The server derives the meeting type
		 * and link from the attended guest row; the note joins the Person's history with its author and instant.
		 */
		async addAttendeeNote(tx: Tx, ctx: MeetingsContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.addAttendeeNoteRequest, raw);
				return command(tx, ctx, "meetings.addAttendeeNote", input, async (w, audit) => {
					const i = input.input;
					const r = await tx.execute(sql`SELECT m.id AS meeting_id, m.type, g.id AS guest_id, clock_timestamp() AS now
						FROM meeting m JOIN participation g ON g.meeting_id = m.id AND g.person_id = ${i.personId}::uuid
							AND g.presence = 'attended' AND g.removed_at IS NULL
						JOIN person p ON p.id = g.person_id AND p.tenant_id = m.plant_id AND p.state = 'live'
						WHERE m.plant_id = ${w.plant.id}::uuid AND m.id = ${i.meetingId}::uuid AND m.retired_at IS NULL
						FOR SHARE OF m, g, p`);
					if (!r.rows[0]) deny();
					const row = z
						.object({ meeting_id: z.uuid(), type: c.meetingType, guest_id: z.uuid(), now: date })
						.parse(r.rows[0]);
					const noteId = randomUUID();
					audit.writes
						.push(sql`INSERT INTO person_note (id, tenant_id, plant_id, person_id, author_id, participation_id,
						body, occurred_at, recorded_at) VALUES (${noteId}::uuid, ${w.plant.id}::uuid, ${w.plant.id}::uuid,
						${i.personId}::uuid, ${w.accountId}::uuid, ${row.guest_id}::uuid, ${i.text},
						${row.now.toISOString()}::timestamptz, ${row.now.toISOString()}::timestamptz)`);
					return {
						value: c.attendeeNoteResult.parse({
							receiptId: audit.id,
							outcome: "changed",
							noteId,
							personId: i.personId,
							meetingId: row.meeting_id,
							meetingType: row.type,
							text: i.text,
							authorId: w.accountId,
							recordedAt: row.now.toISOString(),
						}),
						subject: i.personId,
						subjectType: "person",
						meetingId: row.meeting_id,
						action: "people.updated",
						kind: "create",
						before: null,
						after: null,
						metadata: { category: "note", noteId, guestId: row.guest_id },
					};
				});
			});
		},
	};
}
export type AttendanceWriter = ReturnType<typeof createAttendanceWriter>;
