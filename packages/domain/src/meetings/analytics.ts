import * as c from "@everyfield/contracts/meetings";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { attendee, evaluationColumns, evaluationOf, guestRow, parseEvaluationFacts } from "./attendance.ts";
import type { MeetingsReply } from "@everyfield/contracts/meetings";
import { deny, one, parse, read, type Reader } from "./core.ts";
import { displayTitle } from "./rows.ts";

// Attendance reads, the evaluation and its history, and the meeting reports (REQ-MTG-010/014/015/016). Each read is
// one statement whose first part is the reader's live access (C13, C27, C32: live_session, no locks). Reports read
// every meeting in their window in that one statement; they may pass one second on a large church and say so.

const date = z.coerce.date();

/**
 * Parses the request, then runs `query` (over plant `plant`) only while the reader's session, seat, role and lifecycle
 * are live in the same statement; a reader who lost access, or a missing meeting, reads nothing.
 */
function gated<S extends z.ZodType, T>(
	db: Reader,
	authority: RequestActor,
	admin: boolean,
	schema: S,
	raw: unknown,
	query: (plant: SQL, input: z.output<S>) => SQL,
	body: (row: Record<string, unknown>, input: z.output<S>, viewer: { admin: boolean }) => T,
): Promise<MeetingsReply<T>> {
	return read(authority, async (v) => {
		const input = parse(schema, raw);
		// The live role decides what a privileged field shows, not the role the viewer lookup saw (C13).
		const { row, admin: live } = await one(db, v, query(sql`${v.plantId}::uuid`, input), admin);
		if (!row) deny();
		return body(row, input, { admin: live });
	});
}
const meeting = (plant: SQL, meetingId: string) =>
	sql`m.plant_id = ${plant} AND m.id = ${meetingId}::uuid AND m.retired_at IS NULL`;
const here = sql`coalesce(m.actual_occurrence_at, m.starts_at)`;
const at = (alias: string) => sql.raw(`coalesce(${alias}.actual_occurrence_at, ${alias}.starts_at)`);
/** Attended Persons of meeting alias `m`, each once, with their finalized classification. */
const tally = sql`(SELECT json_build_object('attended', count(DISTINCT g.person_id),
	'first_time', count(DISTINCT g.person_id) FILTER (WHERE g.classification = 'first_time'),
	'returning', count(DISTINCT g.person_id) FILTER (WHERE g.classification = 'returning'),
	'core_group', count(DISTINCT g.person_id) FILTER (WHERE g.classification = 'core_group'))
	FROM participation g WHERE g.meeting_id = m.id AND g.presence = 'attended' AND g.removed_at IS NULL)`;
const tallyRow = z.object({
	attended: z.number().int(),
	first_time: z.number().int(),
	returning: z.number().int(),
	core_group: z.number().int(),
});
const counts = (t: z.infer<typeof tallyRow>) => ({
	first_time: t.first_time,
	returning: t.returning,
	core_group: t.core_group,
});
/** Earlier evaluations of the same type: strictly before this meeting's instant, never itself, the 50 most recent. */
const baselineSql = sql`(SELECT coalesce(json_agg(e.evaluation_scores), '[]') FROM (SELECT o.evaluation_scores
	FROM meeting o WHERE o.plant_id = m.plant_id AND o.type = m.type AND o.evaluation_scores IS NOT NULL
	AND o.retired_at IS NULL AND o.id <> m.id AND ${at("o")} < ${here}
	ORDER BY ${at("o")} DESC, o.id DESC LIMIT 50) e)`;
/** The previous finalized meeting of the same type, by occurrence: its attended count, or null when none. */
const previousSql = sql`(SELECT (SELECT count(DISTINCT g.person_id) FROM participation g WHERE g.meeting_id = o.id
	AND g.presence = 'attended' AND g.removed_at IS NULL)::int FROM meeting o WHERE o.plant_id = m.plant_id
	AND o.type = m.type AND o.finalized_at IS NOT NULL AND o.retired_at IS NULL AND o.occurrence_voided_at IS NULL
	AND o.id <> m.id AND (${at("o")}, o.id) < (${here}, m.id) ORDER BY ${at("o")} DESC, o.id DESC LIMIT 1)`;
const progressSql = sql`(SELECT json_build_object(
	'total', count(*) FILTER (WHERE b.kind = 'follow_up'),
	'complete', count(*) FILTER (WHERE b.kind = 'follow_up' AND t.status = 'complete'),
	'closed', count(*) FILTER (WHERE b.kind = 'follow_up' AND (t.status = 'no_longer_needed' OR t.id IS NULL)),
	'open', count(*) FILTER (WHERE b.kind = 'follow_up' AND t.status NOT IN ('complete', 'no_longer_needed')),
	'needs_owner', count(*) FILTER (WHERE b.kind = 'follow_up' AND t.status NOT IN ('complete', 'no_longer_needed')
		AND t.assignee_id IS NULL),
	'evaluation', (SELECT json_build_object('task_id', et.id, 'status', coalesce(et.status, 'deleted'),
		'needs_owner', et.assignee_id IS NULL) FROM obligation eb LEFT JOIN task et ON et.obligation_id = eb.id
		AND et.deleted_at IS NULL WHERE eb.meeting_id = m.id AND eb.kind = 'evaluation' LIMIT 1))
	FROM obligation b LEFT JOIN task t ON t.obligation_id = b.id AND t.deleted_at IS NULL WHERE b.meeting_id = m.id)`;
const progressRow = z.object({
	total: z.number().int(),
	complete: z.number().int(),
	closed: z.number().int(),
	open: z.number().int(),
	needs_owner: z.number().int(),
	evaluation: z.object({ task_id: z.uuid().nullable(), status: z.string(), needs_owner: z.boolean() }).nullable(),
});
const progress = (meetingId: string, p: z.infer<typeof progressRow>) =>
	c.taskProgress.parse({
		meetingId,
		followUps: { total: p.total, open: p.open, complete: p.complete, closed: p.closed, needsOwner: p.needs_owner },
		evaluation: p.evaluation
			? { taskId: p.evaluation.task_id, status: p.evaluation.status, needsOwner: p.evaluation.needs_owner }
			: null,
	});

/** Tenths of a point: exact arithmetic for rounded averages. */
const tenths = (scores: readonly number[]) => Math.round((scores.reduce((a, b) => a + b, 0) * 10) / scores.length);
/**
 * REQ-MTG-016: the baseline is the mean of the earlier meetings' rounded averages, rounded to one decimal; the delta is
 * the current rounded average minus that rounded baseline. No earlier evaluation leaves both unknown, never zero.
 */
export function compare(meetingId: string, current: number[] | null, earlier: number[][], corrected: boolean) {
	const now = current ? tenths(current) : null;
	const base = earlier.length ? Math.round(earlier.map(tenths).reduce((a, b) => a + b, 0) / earlier.length) : null;
	return c.evaluationComparison.parse({
		meetingId,
		current: now === null ? { status: "unknown" } : { status: "known", value: now / 10 },
		baseline: base === null ? { status: "unknown" } : { status: "known", value: base / 10, count: earlier.length },
		delta: now === null || base === null ? { status: "unknown" } : { status: "known", value: (now - base) / 10 },
		corrected,
	});
}
/** Growth over the previous meeting: unknown without one, unavailable (not infinite) after a meeting of zero. */
export function growthOf(attended: number, previous: number | null) {
	if (previous === null) return { status: "unknown" as const };
	if (previous === 0) return { status: "unavailable" as const, difference: attended };
	return {
		status: "known" as const,
		difference: attended - previous,
		percent: Math.round(((attended - previous) * 1000) / previous) / 10,
	};
}
const window = (i: z.infer<typeof c.reportRequest>) =>
	sql`m.type = ANY(${sql.param([...new Set(i.types)])}::text[]) AND (${i.from}::date IS NULL OR m.local_date >= ${i.from}::date)
		AND (${i.to}::date IS NULL OR m.local_date <= ${i.to}::date)`;
const windowOf = (i: z.infer<typeof c.reportRequest>) => ({ types: [...new Set(i.types)], from: i.from, to: i.to });
const pointRow = z.object({
	id: z.uuid(),
	type: c.meetingType,
	title: z.string().nullable(),
	vision_number: z.number().int().nullable(),
	occurred_at: date,
	local_date: z.string(),
});
const point = (p: z.infer<typeof pointRow>) => ({
	meetingId: p.id,
	type: p.type,
	displayTitle: displayTitle(p),
	occurredAt: p.occurred_at.toISOString(),
	localDate: p.local_date,
});
const pointColumns = sql`m.id, m.type, m.title, m.vision_number, ${here} AS occurred_at, m.local_date::text AS local_date`;
/** Meetings that count in reports: finalized, not deleted, voided or cancelled. */
const counted = sql`m.finalized_at IS NOT NULL AND m.retired_at IS NULL AND m.occurrence_voided_at IS NULL
	AND m.status <> 'cancelled'`;

export const attendanceReader = {
	/**
	 * The guest list with presence and finalized classification, by name; members read it too. It also says whether the
	 * viewer may mark attendance here, by the write's rule: a live Owner or Admin, or the live current leader of this
	 * team meeting's team (REQ-MTG-010, C74, C79). The write still decides; this only lets the screen show the controls.
	 */
	async listAttendance(db: Reader, authority: RequestActor, raw: unknown) {
		return gated(
			db,
			authority,
			false,
			c.attendanceListRequest,
			raw,
			(plant, i) => sql`SELECT m.attendance_revision::text AS attendance_revision, m.finalized_at,
				(m.type = 'team_meeting' AND EXISTS (SELECT FROM team t JOIN person lp ON lp.id = t.leader_person_id
					WHERE t.id = m.team_id AND t.plant_id = m.plant_id AND t.archived_at IS NULL AND lp.state = 'live'
					AND lp.linked_account_id = ${authority.actor.accountId}::uuid)) AS leads,
				m.finalized_revision::text AS finalized_revision,
				(SELECT count(*)::int FROM participation g WHERE g.meeting_id = m.id AND g.removed_at IS NULL) AS matched,
				(SELECT coalesce(json_agg(x ORDER BY x.n), '[]') FROM (SELECT g.id, g.revision::text AS revision, g.person_id,
					g.presence, coalesce(g.rsvp, 'pending') AS rsvp, g.card_response IS NOT NULL AS has_card, g.removed_at,
					g.classification, g.classification_stage,
					g.classification_person_revision::text AS classification_person_revision, g.classification_as_of,
					g.prior_vision_id, g.actual_occurrence_at, p.display_name, p.state AS person_state,
					row_number() OVER (ORDER BY p.display_name, g.id) AS n
					FROM participation g JOIN person p ON p.id = g.person_id WHERE g.meeting_id = m.id AND g.removed_at IS NULL
					ORDER BY p.display_name, g.id LIMIT ${i.limit} OFFSET ${(i.page - 1) * i.limit}) x) AS items
				FROM meeting m WHERE ${meeting(plant, i.meetingId)}`,
			(row, i, viewer) => {
				const f = z
					.object({
						attendance_revision: z.string(),
						leads: z.boolean(),
						finalized_at: date.nullable(),
						finalized_revision: z.string().nullable(),
						matched: z.number().int(),
						items: z.array(guestRow),
					})
					.parse(row);
				return c.attendanceList.parse({
					meetingId: i.meetingId,
					attendanceRevision: f.attendance_revision,
					finalized: f.finalized_at ? { at: f.finalized_at.toISOString(), revision: f.finalized_revision } : null,
					items: f.items.map(attendee),
					matched: f.matched,
					returned: f.items.length,
					page: i.page,
					next: i.page * i.limit < f.matched ? i.page + 1 : null,
					completeness: "complete",
					viewerCanMarkAttendance: viewer.admin || f.leads,
				});
			},
		);
	},
	/** Presence and classification counts of the current guest list; attended Persons count once. */
	async attendanceSummary(db: Reader, authority: RequestActor, raw: unknown) {
		return gated(
			db,
			authority,
			true,
			c.meetingRequest,
			raw,
			(plant, i) => sql`SELECT m.attendance_revision::text AS attendance_revision, m.finalized_at,
				m.finalized_revision::text AS finalized_revision, ${tally} AS tally,
				(SELECT json_build_object('guests', count(*), 'absent', count(*) FILTER (WHERE g.presence = 'absent'),
					'excused', count(*) FILTER (WHERE g.presence = 'excused'))
					FROM participation g WHERE g.meeting_id = m.id AND g.removed_at IS NULL) AS presence
				FROM meeting m WHERE ${meeting(plant, i.meetingId)}`,
			(row, i) => {
				const f = z
					.object({
						attendance_revision: z.string(),
						finalized_at: date.nullable(),
						finalized_revision: z.string().nullable(),
						tally: tallyRow,
						presence: z.object({ guests: z.number().int(), absent: z.number().int(), excused: z.number().int() }),
					})
					.parse(row);
				return c.attendanceSummary.parse({
					meetingId: i.meetingId,
					attendanceRevision: f.attendance_revision,
					finalized: f.finalized_at ? { at: f.finalized_at.toISOString(), revision: f.finalized_revision } : null,
					guests: f.presence.guests,
					attended: f.tally.attended,
					absent: f.presence.absent,
					excused: f.presence.excused,
					classifications: counts(f.tally),
				});
			},
		);
	},
	/** The Vision evaluation; notes only for Owner and Admin. */
	async getEvaluation(db: Reader, authority: RequestActor, raw: unknown) {
		return gated(
			db,
			authority,
			false,
			c.meetingRequest,
			raw,
			(plant, i) => sql`SELECT ${evaluationColumns} FROM meeting m WHERE ${meeting(plant, i.meetingId)}`,
			(row, i, v) => {
				const e = evaluationOf(parseEvaluationFacts(row), v.admin);
				return c.evaluationResult.parse(
					e ? { status: "available", evaluation: e } : { status: "none", meetingId: i.meetingId },
				);
			},
		);
	},
	/** The original evaluation and every correction, oldest first, from audit history. */
	async evaluationHistory(db: Reader, authority: RequestActor, raw: unknown) {
		return gated(
			db,
			authority,
			true,
			c.meetingRequest,
			raw,
			(plant, i) => sql`SELECT (SELECT coalesce(json_agg(json_build_object('event', a.metadata->>'event',
					'at', a.occurred_at, 'actor', a.actor_id, 'before', a.before_value, 'after', a.after_value,
					'reason', a.reason, 'notes_changed', coalesce((a.metadata->>'notesChanged')::boolean, false))
					ORDER BY a.occurred_at, a.id), '[]') FROM audit_event a WHERE a.tenant_id = m.plant_id
					AND a.subject_id = m.id AND a.kind <> 'noop'
					AND a.metadata->>'event' IN ('evaluation_recorded', 'evaluation_corrected')) AS entries
				FROM meeting m WHERE ${meeting(plant, i.meetingId)}`,
			(row, i) => {
				const entries = z
					.array(
						z.object({
							event: z.enum(["evaluation_recorded", "evaluation_corrected"]),
							at: date,
							actor: z.uuid().nullable(),
							before: z.record(z.string(), z.unknown()).nullable(),
							after: z.record(z.string(), z.unknown()),
							reason: z.string().nullable(),
							notes_changed: z.boolean(),
						}),
					)
					.parse(row.entries);
				const factors = (v: Record<string, unknown> | null) =>
					v ? Object.fromEntries(c.evaluationFactors.filter((k) => k in v).map((k) => [k, v[k]])) : null;
				return c.evaluationHistory.parse({
					meetingId: i.meetingId,
					entries: entries.map((e) => ({
						kind: e.event === "evaluation_recorded" ? "recorded" : "corrected",
						at: e.at.toISOString(),
						actor: e.actor ? { kind: "current_account", accountId: e.actor } : { kind: "former_account" },
						before: factors(e.before),
						after: factors(e.after),
						average: { before: (e.before?.average as number | undefined) ?? null, after: e.after.average },
						notesChanged: e.event === "evaluation_recorded" ? e.after.notes === true : e.notes_changed,
						reason: e.reason,
						revision: e.after.revision,
					})),
				});
			},
		);
	},
	/** Report: evaluation averages across meetings in the window, oldest first. */
	async evaluationTrend(db: Reader, authority: RequestActor, raw: unknown) {
		return gated(
			db,
			authority,
			true,
			c.reportRequest,
			raw,
			(plant, i) => sql`SELECT (SELECT coalesce(json_agg(x ORDER BY x.occurred_at, x.id), '[]') FROM
				(SELECT ${pointColumns}, m.evaluation_scores AS scores, m.evaluation_corrected_at IS NOT NULL AS corrected
				FROM meeting m WHERE m.plant_id = ${plant} AND ${window(i)} AND m.evaluation_scores IS NOT NULL
				AND m.retired_at IS NULL ORDER BY ${here} DESC, m.id DESC LIMIT ${i.limit}) x) AS points`,
			(row, i) =>
				c.evaluationTrend.parse({
					window: windowOf(i),
					points: z
						.array(pointRow.extend({ scores: z.array(z.number().int()), corrected: z.boolean() }))
						.parse(row.points)
						.map((p) => ({ ...point(p), average: tenths(p.scores) / 10, corrected: p.corrected })),
				}),
		);
	},
	/** This meeting's evaluation against the baseline of earlier evaluations (REQ-MTG-016). */
	async compareEvaluation(db: Reader, authority: RequestActor, raw: unknown) {
		return gated(
			db,
			authority,
			true,
			c.meetingRequest,
			raw,
			(plant, i) => sql`SELECT m.evaluation_scores AS scores,
				m.evaluation_corrected_at IS NOT NULL AS corrected, ${baselineSql} AS earlier
				FROM meeting m WHERE ${meeting(plant, i.meetingId)}`,
			(row, i) => {
				const f = z
					.object({
						scores: z.array(z.number().int()).nullable(),
						corrected: z.boolean(),
						earlier: z.array(z.array(z.number().int())),
					})
					.parse(row);
				return compare(i.meetingId, f.scores, f.earlier, f.corrected);
			},
		);
	},
	/** Report: attended Persons per finalized meeting with new versus returning and growth, oldest first. */
	async attendanceTrend(db: Reader, authority: RequestActor, raw: unknown) {
		return gated(
			db,
			authority,
			true,
			c.reportRequest,
			raw,
			(plant, i) => sql`SELECT (SELECT coalesce(json_agg(x ORDER BY x.occurred_at, x.id), '[]') FROM
				(SELECT ${pointColumns}, ${tally} AS tally, ${previousSql} AS previous FROM meeting m
				WHERE m.plant_id = ${plant} AND ${window(i)} AND ${counted}
				ORDER BY ${here} DESC, m.id DESC LIMIT ${i.limit}) x) AS points`,
			(row, i) =>
				c.attendanceTrend.parse({
					window: windowOf(i),
					points: z
						.array(pointRow.extend({ tally: tallyRow, previous: z.number().int().nullable() }))
						.parse(row.points)
						.map((p) => ({
							...point(p),
							attended: p.tally.attended,
							classifications: counts(p.tally),
							growth: growthOf(p.tally.attended, p.previous),
						})),
				}),
		);
	},
	/** Report: totals for the window. Averages without a finalized or evaluated meeting are unknown, not zero. */
	async summaryStats(db: Reader, authority: RequestActor, raw: unknown) {
		return gated(
			db,
			authority,
			true,
			c.reportRequest,
			raw,
			(plant, i) => sql`WITH w AS (SELECT m.* FROM meeting m WHERE m.plant_id = ${plant} AND ${window(i)}
					AND m.retired_at IS NULL AND m.occurrence_voided_at IS NULL AND m.status <> 'cancelled'
					AND ${here} <= clock_timestamp()),
				a AS (SELECT g.person_id, g.classification FROM w m JOIN participation g ON g.meeting_id = m.id
					WHERE m.finalized_at IS NOT NULL AND g.presence = 'attended' AND g.removed_at IS NULL)
				SELECT (SELECT count(*)::int FROM w) AS held,
				(SELECT count(*)::int FROM w WHERE finalized_at IS NOT NULL) AS finalized,
				(SELECT count(*)::int FROM a) AS attendances, (SELECT count(DISTINCT person_id)::int FROM a) AS unique_attendees,
				(SELECT count(*)::int FROM a WHERE classification = 'first_time') AS first_time,
				(SELECT count(*)::int FROM a WHERE classification = 'returning') AS returning,
				(SELECT coalesce(json_agg(evaluation_scores), '[]') FROM w WHERE evaluation_scores IS NOT NULL) AS evaluations`,
			(row, i) => {
				const f = z
					.object({
						held: z.number().int(),
						finalized: z.number().int(),
						attendances: z.number().int(),
						unique_attendees: z.number().int(),
						first_time: z.number().int(),
						returning: z.number().int(),
						evaluations: z.array(z.array(z.number().int())),
					})
					.parse(row);
				const evaluated = f.evaluations.map(tenths);
				return c.summaryStats.parse({
					window: windowOf(i),
					held: f.held,
					finalized: f.finalized,
					attendances: f.attendances,
					uniqueAttendees: f.unique_attendees,
					averageAttendance: f.finalized
						? { status: "known", value: Math.round((f.attendances * 10) / f.finalized) / 10 }
						: { status: "unknown" },
					firstTime: f.first_time,
					returning: f.returning,
					averageEvaluation: evaluated.length
						? {
								status: "known",
								value: Math.round(evaluated.reduce((a, b) => a + b, 0) / evaluated.length) / 10,
							}
						: { status: "unknown" },
				});
			},
		);
	},
	/** The follow-ups and evaluation task this meeting generated, by state. */
	async linkedTaskProgress(db: Reader, authority: RequestActor, raw: unknown) {
		return gated(
			db,
			authority,
			true,
			c.meetingRequest,
			raw,
			(plant, i) => sql`SELECT ${progressSql} AS progress FROM meeting m WHERE ${meeting(plant, i.meetingId)}`,
			(row, i) => progress(i.meetingId, progressRow.parse(row.progress)),
		);
	},
	/** One meeting's analytics: attendance, growth, evaluation comparison and generated work. */
	async readAnalytics(db: Reader, authority: RequestActor, raw: unknown) {
		return gated(
			db,
			authority,
			true,
			c.meetingRequest,
			raw,
			(plant, i) => sql`SELECT m.type, m.finalized_at IS NOT NULL AS finalized, ${tally} AS tally,
				${previousSql} AS previous, m.evaluation_scores AS scores, m.evaluation_corrected_at IS NOT NULL AS corrected,
				${baselineSql} AS earlier, ${progressSql} AS progress
				FROM meeting m WHERE ${meeting(plant, i.meetingId)}`,
			(row, i) => {
				const f = z
					.object({
						type: c.meetingType,
						finalized: z.boolean(),
						tally: tallyRow,
						previous: z.number().int().nullable(),
						scores: z.array(z.number().int()).nullable(),
						corrected: z.boolean(),
						earlier: z.array(z.array(z.number().int())),
						progress: progressRow,
					})
					.parse(row);
				return c.meetingAnalytics.parse({
					meetingId: i.meetingId,
					type: f.type,
					attended: f.finalized ? { status: "known", value: f.tally.attended } : { status: "unknown" },
					classifications: f.finalized ? counts(f.tally) : null,
					growth: f.finalized ? growthOf(f.tally.attended, f.previous) : { status: "unknown" },
					evaluation: f.type === "vision_meeting" ? compare(i.meetingId, f.scores, f.earlier, f.corrected) : null,
					tasks: progress(i.meetingId, f.progress),
				});
			},
		);
	},
};
