import { localDateTime, resolveCalendar, timeZone } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/meetings";
import { sql, type SQLWrapper } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { readRows } from "../operations/writes.ts";
import { z } from "zod";
import { command, deny, next, parse, reply, type MeetingsContext, type Tx, type Writer } from "./core.ts";
import { syncReminderJobs } from "./notifications.ts";
import { detail, facts, meetingColumns, meetingRow, plantMeeting, type MeetingRow } from "./rows.ts";

type VenueChoice = z.infer<typeof c.venueChoice>;

/** An entered wall time in the meeting's zone: a gap is refused, a fold needs the chosen offset (REQ-TSK-018). */
function resolve(date: string, time: string, zone: string, offsetSeconds?: number) {
	const r = resolveCalendar(localDateTime.parse(`${date}T${time}:00`), timeZone.parse(zone), "entered", offsetSeconds);
	if (r.kind === "gap") deny("nonexistent_local_time");
	if (r.kind === "fold") deny("ambiguous_local_time", { choices: [...r.choices] });
	if (r.kind === "invalid_offset")
		deny("invalid_input", { issues: [{ path: "offsetSeconds", problem: "not_an_offset_of_this_local_time" }] });
	return new Date(r.occurrence.instant);
}

const venueFacts = z.object({ id: z.uuid(), name: z.string(), address: z.string(), archived: z.boolean() }).nullable();
/** Reads the chosen saved venue in the fact statement; an archived one may stay only when it is already selected. */
const chosenVenue = (plantId: string, choice: VenueChoice | undefined) =>
	choice?.kind === "existing"
		? sql`(SELECT row_to_json(v) FROM (SELECT id, name, address, archived_at IS NOT NULL AS archived FROM venue
			WHERE id = ${sql.param(choice.venueId)}::uuid AND plant_id = ${sql.param(plantId)}::uuid FOR SHARE) v)`
		: sql`NULL::json`;
/** The meeting's copied location for a choice, plus the venue insert when the picker creates one with the meeting. */
function location(
	w: Writer,
	choice: VenueChoice,
	found: z.infer<typeof venueFacts>,
	current: Pick<MeetingRow, "venue_id" | "venue_name" | "venue_address"> | null,
	writes: SQLWrapper[],
) {
	if (choice.kind === "none") return { venue_id: null, venue_name: null, venue_address: null };
	if (choice.kind === "existing") {
		// An unchanged selection keeps its snapshot, even when that venue was archived since.
		if (current && current.venue_id === choice.venueId)
			return { venue_id: current.venue_id, venue_name: current.venue_name, venue_address: current.venue_address };
		if (!found) deny();
		if (found.archived) deny("venue_archived");
		return { venue_id: found.id, venue_name: found.name, venue_address: found.address };
	}
	const id = randomUUID(),
		v = choice.venue;
	writes.push(sql`INSERT INTO venue (id, plant_id, name, address, contact_name, phone, email, cost_description, capacity, notes)
		VALUES (${id}::uuid, ${w.plant.id}::uuid, ${v.name}, ${v.address}, ${v.contactName}, ${v.phone}, ${v.email},
			${v.costDescription}, ${v.capacity}, ${v.notes})`);
	return { venue_id: id, venue_name: v.name, venue_address: v.address };
}

/** The locked meeting and the clock, in one statement. Missing, foreign and retired meetings read the same. */
async function lockMeeting(tx: Tx, w: Writer, meetingId: string, extra = sql`NULL::json`) {
	const [row] = await readRows(
		tx,
		sql`SELECT ${meetingColumns}, ${extra} AS extra, clock_timestamp() AS now FROM meeting m
			WHERE ${plantMeeting(w.plant.id, meetingId)} AND m.retired_at IS NULL`,
		sql`FOR UPDATE OF m`,
		["now"],
	);
	if (!row) deny();
	return { m: meetingRow.parse(row), extra: row.extra, now: z.coerce.date().parse(row.now) };
}
function expected(m: MeetingRow, revision: string) {
	if (m.revision !== revision) deny("conflict");
}
/** The meeting update for a changed row, fenced by the revision the command read. */
function update(m: MeetingRow, set: SQLWrapper) {
	return sql`UPDATE meeting SET ${set}, revision = revision + 1 WHERE id = ${m.id}::uuid AND revision = ${m.revision}::bigint`;
}
/** The audit fields every meeting change shares; the caller names the action and kind. */
const meetingChange = <T>(m: MeetingRow, value: T, before: MeetingRow) => ({
	value,
	subject: m.id,
	subjectType: "meeting" as const,
	meetingId: m.id,
	before: facts(before),
	after: facts(m),
});

function changed(m: MeetingRow, patch: Partial<MeetingRow>): MeetingRow {
	return { ...m, ...patch, revision: next(m.revision) };
}
const result = (m: MeetingRow, outcome: "changed" | "noop", receiptId: string) =>
	c.meetingMutationResult.parse({ receiptId, outcome, meeting: detail(m) });

export const meetingsWriter = {
	async schedule(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.scheduleMeetingRequest, raw);
			return command(tx, ctx, "meetings.schedule", input, async (w, audit) => {
				const i = input.input,
					zone = await w.zone(),
					startsAt = resolve(i.date, i.time, zone, i.offsetSeconds);
				const r = await tx.execute(sql`SELECT
					(SELECT coalesce(max(vision_number), 0) + 1 FROM meeting WHERE plant_id = ${w.plant.id}::uuid) AS vision_number,
					${chosenVenue(w.plant.id, i.venue)} AS venue,
					ARRAY(SELECT id FROM person WHERE id = ANY(${sql.param(i.guests)}::uuid[]) AND tenant_id = ${w.plant.id}::uuid
						AND state = 'live' ORDER BY id FOR SHARE) AS guests,
					clock_timestamp() AS now`);
				const f = z
					.object({
						vision_number: z.number().int(),
						venue: venueFacts,
						guests: z.array(z.uuid()),
						now: z.coerce.date(),
					})
					.parse(r.rows[0]);
				if (f.guests.length !== i.guests.length) deny("invalid_subject");
				const vision = i.type === "vision_meeting",
					id = randomUUID();
				const place = location(w, i.venue, f.venue, null, audit.writes);
				const agenda = vision ? c.visionAgenda.sections.map((s) => ({ id: randomUUID(), ...s })) : [];
				const m: MeetingRow = {
					id,
					plant_id: w.plant.id,
					revision: "1",
					type: i.type,
					subtype: null,
					status: "planning",
					title: i.title?.trim() || null,
					notes: i.notes?.trim() || null,
					local_date: i.date,
					local_time: i.time,
					timezone: zone,
					starts_at: startsAt,
					vision_number: vision ? f.vision_number : null,
					...place,
					agenda,
					agenda_version: vision ? c.visionAgenda.version : null,
					kit_version: vision ? c.visionKit.version : null,
					actual_occurrence_at: null,
					occurrence_voided_at: null,
					retired_at: null,
					creator_id: w.accountId,
					guest_count: i.guests.length,
					confirmed_count: 0,
					kit_total: vision ? c.visionKit.items.length : 0,
					kit_checked: 0,
				};
				// The meeting, its copied venue, agenda, kit, guests and reminders commit together or not at all.
				audit.writes.push(sql`INSERT INTO meeting (id, plant_id, type, title, notes, creator_id, local_date, local_time,
					timezone, starts_at, resolver_version, venue_id, venue_name, venue_address, vision_number, status,
					attendance_revision, agenda, agenda_version, kit_version)
					VALUES (${id}::uuid, ${w.plant.id}::uuid, ${m.type}, ${m.title}, ${m.notes}, ${w.accountId}::uuid,
						${m.local_date}::date, ${m.local_time}::time, ${zone}, ${startsAt.toISOString()}::timestamptz, '1',
						${m.venue_id}::uuid, ${m.venue_name}, ${m.venue_address}, ${m.vision_number}::int, 'planning', 1,
						${JSON.stringify(agenda)}::jsonb, ${m.agenda_version}::int, ${m.kit_version}::int)`);
				if (vision) audit.writes.push(seedKit(w.plant.id, id));
				if (i.guests.length)
					audit.writes
						.push(sql`INSERT INTO participation (plant_id, meeting_id, person_id, roster_member, rsvp, presence)
						SELECT ${w.plant.id}::uuid, ${id}::uuid, p, false, 'pending', 'absent' FROM unnest(${sql.param(i.guests)}::uuid[]) p`);
				audit.writes.push(...syncReminderJobs(m, f.now));
				return {
					value: result(m, "changed", audit.id),
					subject: id,
					subjectType: "meeting",
					meetingId: id,
					action: "meetings.changed",
					kind: "create",
					before: null,
					after: { type: m.type, visionNumber: m.vision_number, guests: i.guests.length, ...facts(m) },
				};
			});
		});
	},
	async edit(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.editMeetingRequest, raw);
			return command(tx, ctx, "meetings.edit", input, async (w, audit) => {
				const p = input.input.patch;
				const {
					m: before,
					extra,
					now,
				} = await lockMeeting(tx, w, input.input.meetingId, chosenVenue(w.plant.id, p.venue));
				expected(before, input.expectedRevision);
				const writes: SQLWrapper[] = [];
				const place = p.venue ? location(w, p.venue, venueFacts.parse(extra), before, writes) : {};
				const when =
					p.date !== undefined && p.time !== undefined
						? {
								local_date: p.date,
								local_time: p.time,
								starts_at: resolve(p.date, p.time, before.timezone, p.offsetSeconds),
							}
						: {};
				const after = {
					...before,
					...(p.title !== undefined ? { title: p.title?.trim() || null } : {}),
					...(p.notes !== undefined ? { notes: p.notes?.trim() || null } : {}),
					...place,
					...when,
				};
				const same = JSON.stringify(facts(after)) === JSON.stringify(facts(before));
				const m = same ? before : changed(before, after);
				if (!same) {
					audit.writes.push(
						...writes,
						update(
							before,
							sql`title = ${m.title}, notes = ${m.notes}, venue_id = ${m.venue_id}::uuid, venue_name = ${m.venue_name},
								venue_address = ${m.venue_address}, local_date = ${m.local_date}::date, local_time = ${m.local_time}::time,
								starts_at = ${m.starts_at.toISOString()}::timestamptz`,
						),
						...syncReminderJobs(m, now),
					);
				}
				return {
					...meetingChange(m, result(m, same ? "noop" : "changed", audit.id), before),
					action: "meetings.changed",
					kind: "edit",
					outcome: same ? "noop" : "changed",
				};
			});
		});
	},
	async changeStatus(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.changeStatusRequest, raw);
			return command(tx, ctx, "meetings.changeStatus", input, async (w, audit) => {
				const { m: before, now } = await lockMeeting(tx, w, input.input.meetingId);
				expected(before, input.expectedRevision);
				const to = input.input.to,
					noop = before.status === to;
				// A practice is completed with when it was held, and reopened through its correction (REQ-KNOW-042).
				if (
					!noop &&
					(!c.statusTransitions[before.status].includes(to) ||
						(before.type === "prelaunch_practice" && (to === "completed" || before.status === "completed")))
				)
					deny("status_transition");
				const m = noop ? before : changed(before, { status: to });
				if (!noop) audit.writes.push(update(before, sql`status = ${to}`), ...syncReminderJobs(m, now));
				return {
					...meetingChange(m, result(m, noop ? "noop" : "changed", audit.id), before),
					action: "meetings.changed",
					kind: to === "completed" ? "complete" : before.status === "completed" ? "reopen" : "edit",
					outcome: noop ? "noop" : "changed",
				};
			});
		});
	},
	/** Removes the meeting from current lists with history; a genuine held practice still counts (REQ-KNOW-045). */
	async delete(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.deleteMeetingRequest, raw);
			return command(tx, ctx, "meetings.delete", input, async (w, audit) => {
				const { m: before, now } = await lockMeeting(tx, w, input.input.meetingId);
				expected(before, input.expectedRevision);
				const m = changed(before, { retired_at: now });
				audit.writes.push(
					update(before, sql`retired_at = ${now.toISOString()}::timestamptz`),
					...syncReminderJobs(m, now),
				);
				return {
					...meetingChange(m, result(m, "changed", audit.id), before),
					action: "meetings.changed",
					kind: "retire",
					reason: input.input.reason,
				};
			});
		});
	},
	/** One distinct held practice: actually happened, not in the future, no Vision effects (REQ-KNOW-041/042). */
	async completePractice(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.completePracticeRequest, raw);
			return command(tx, ctx, "meetings.completePractice", input, async (w, audit) => {
				const { m: before, now } = await lockMeeting(tx, w, input.input.meetingId);
				expected(before, input.expectedRevision);
				if (before.type !== "prelaunch_practice") deny("wrong_meeting_type");
				const heldAt = new Date(input.input.occurredAt);
				if (heldAt > now) deny("invalid_input", { issues: [{ path: "occurredAt", problem: "in_the_future" }] });
				if (before.status === "cancelled") deny("status_transition");
				const noop = before.status === "completed" && before.actual_occurrence_at?.getTime() === heldAt.getTime();
				const m = noop ? before : changed(before, { status: "completed", actual_occurrence_at: heldAt });
				if (!noop)
					audit.writes.push(
						update(before, sql`status = 'completed', actual_occurrence_at = ${heldAt.toISOString()}::timestamptz`),
						...syncReminderJobs(m, now),
					);
				return {
					...meetingChange(m, result(m, noop ? "noop" : "changed", audit.id), before),
					action: "meetings.finalized",
					kind: "complete",
					outcome: noop ? "noop" : "changed",
				};
			});
		});
	},
	/** Corrects whether and when a practice was held; history keeps the earlier facts. */
	async correctPracticeOccurrence(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.correctPracticeRequest, raw);
			return command(tx, ctx, "meetings.correctPracticeOccurrence", input, async (w, audit) => {
				const { m: before, now } = await lockMeeting(tx, w, input.input.meetingId);
				expected(before, input.expectedRevision);
				if (before.type !== "prelaunch_practice") deny("wrong_meeting_type");
				const heldAt = input.input.occurredAt ? new Date(input.input.occurredAt) : null;
				if (heldAt && heldAt > now)
					deny("invalid_input", { issues: [{ path: "occurredAt", problem: "in_the_future" }] });
				// Not held reopens the practice to planning without a held time.
				const patch = heldAt
					? { status: "completed" as const, actual_occurrence_at: heldAt }
					: { status: "planning" as const, actual_occurrence_at: null };
				const m = changed(before, patch);
				audit.writes.push(
					update(
						before,
						sql`status = ${patch.status}, actual_occurrence_at = ${heldAt?.toISOString() ?? null}::timestamptz`,
					),
					...syncReminderJobs(m, now),
				);
				return {
					...meetingChange(m, result(m, "changed", audit.id), before),
					action: "meetings.corrected",
					kind: "correct",
					reason: input.input.reason,
				};
			});
		});
	},
	/** Voids an invalid held occurrence, or restores it; archiving a genuine one is delete (REQ-KNOW-045). */
	async correctOccurrence(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.correctOccurrenceRequest, raw);
			return command(tx, ctx, "meetings.correctOccurrence", input, async (w, audit) => {
				const { m: before, now } = await lockMeeting(tx, w, input.input.meetingId);
				expected(before, input.expectedRevision);
				if (before.status !== "completed") deny("status_transition");
				const voided = input.input.voided;
				const noop = (before.occurrence_voided_at !== null) === voided;
				const m = noop ? before : changed(before, { occurrence_voided_at: voided ? now : null });
				if (!noop)
					audit.writes.push(
						update(before, sql`occurrence_voided_at = ${voided ? now.toISOString() : null}::timestamptz`),
					);
				return {
					...meetingChange(m, result(m, noop ? "noop" : "changed", audit.id), before),
					action: "meetings.corrected",
					kind: "correct",
					outcome: noop ? "noop" : "changed",
					reason: input.input.reason,
				};
			});
		});
	},
	/** Saves the whole agenda; a later default version never touches it (REQ-MTG-005). */
	async replaceAgenda(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.replaceAgendaRequest, raw);
			return command(tx, ctx, "meetings.replaceAgenda", input, async (w, audit) => {
				const { m: before } = await lockMeeting(tx, w, input.input.meetingId);
				expected(before, input.expectedRevision);
				const sections = input.input.sections,
					noop = JSON.stringify(sections) === JSON.stringify(before.agenda);
				const m = noop ? before : changed(before, { agenda: sections });
				if (!noop) audit.writes.push(update(before, sql`agenda = ${JSON.stringify(sections)}::jsonb`));
				const answer = c.agendaResult.parse({
					meetingId: m.id,
					revision: m.revision,
					sections,
					totalMinutes: sections.reduce((sum, s) => sum + s.minutes, 0),
					defaultVersion: m.agenda_version,
				});
				return {
					value: { receiptId: audit.id, outcome: noop ? "noop" : "changed", agenda: answer },
					subject: m.id,
					subjectType: "meeting",
					meetingId: m.id,
					action: "meetings.changed",
					kind: "edit",
					outcome: noop ? "noop" : "changed",
					before: { agenda: before.agenda.map((s) => `${s.title} ${s.minutes}`) },
					after: { agenda: sections.map((s) => `${s.title} ${s.minutes}`) },
				};
			});
		});
	},
	/** Seeds the canonical Vision kit once; repeating it changes nothing. Other types have no kit (REQ-MTG-006). */
	async populateKit(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.populateKitRequest, raw);
			return command(tx, ctx, "meetings.populateKit", input, async (w, audit) => {
				const { m: before } = await lockMeeting(tx, w, input.input.meetingId);
				if (before.type !== "vision_meeting") deny("wrong_meeting_type");
				const noop = before.kit_version !== null;
				if (!noop) expected(before, input.expectedRevision);
				const m = noop
					? before
					: changed(before, { kit_version: c.visionKit.version, kit_total: c.visionKit.items.length, kit_checked: 0 });
				if (!noop)
					audit.writes.push(update(before, sql`kit_version = ${c.visionKit.version}::int`), seedKit(w.plant.id, m.id));
				return {
					...meetingChange(m, result(m, noop ? "noop" : "changed", audit.id), before),
					action: "meetings.changed",
					kind: "create",
					outcome: noop ? "noop" : "changed",
					before: { kitVersion: before.kit_version },
					after: { kitVersion: m.kit_version },
				};
			});
		});
	},
	/** Checks, unchecks, assigns or annotates one kit item. A new assignee must be a live Person of this church. */
	async updateKitItem(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.updateKitItemRequest, raw);
			return command(tx, ctx, "meetings.updateKitItem", input, async (w, audit) => {
				const { itemId, patch } = input.input;
				const assignee = patch.assigneePersonId ?? null;
				const { m, extra } = await lockMeeting(
					tx,
					w,
					input.input.meetingId,
					sql`(SELECT json_build_object(
						'item', (SELECT row_to_json(i) FROM (SELECT k.id, k.revision::text AS revision, k.checked, k.assignee_person_id, k.notes
							FROM meeting_kit_item k WHERE k.id = ${itemId}::uuid AND k.meeting_id = m.id FOR UPDATE) i),
						'assignee', (SELECT row_to_json(a) FROM (SELECT id AS assignee_id, display_name AS assignee_name, state AS assignee_state
							FROM person WHERE id = ${assignee}::uuid AND tenant_id = m.plant_id FOR SHARE) a),
						'items', (SELECT json_agg(row_to_json(k) ORDER BY k.position) FROM (${kitColumns} WHERE k.meeting_id = m.id) k)))`,
				);
				if (m.type !== "vision_meeting") deny("wrong_meeting_type");
				const f = z
					.object({
						item: z
							.object({
								id: z.uuid(),
								revision: z.string(),
								checked: z.boolean(),
								assignee_person_id: z.uuid().nullable(),
								notes: z.string().nullable(),
							})
							.nullable(),
						assignee: kitRow.pick({ assignee_id: true, assignee_name: true, assignee_state: true }).nullable(),
						items: z.array(kitRow).nullable(),
					})
					.parse(extra);
				if (!f.item) deny();
				if (f.item.revision !== input.expectedRevision) deny("conflict");
				const before = { checked: f.item.checked, assigneePersonId: f.item.assignee_person_id, notes: f.item.notes };
				const after = {
					checked: patch.checked ?? before.checked,
					assigneePersonId: patch.assigneePersonId !== undefined ? assignee : before.assigneePersonId,
					notes: patch.notes !== undefined ? patch.notes || null : before.notes,
				};
				const reassigned = after.assigneePersonId !== before.assigneePersonId;
				if (reassigned && after.assigneePersonId && f.assignee?.assignee_state !== "live") deny("invalid_subject");
				const noop = JSON.stringify(before) === JSON.stringify(after);
				if (!noop)
					audit.writes.push(sql`UPDATE meeting_kit_item SET checked = ${after.checked},
						checked_at = CASE WHEN ${after.checked} THEN coalesce(checked_at, clock_timestamp()) END,
						assignee_person_id = ${after.assigneePersonId}::uuid, notes = ${after.notes}, revision = revision + 1
						WHERE id = ${itemId}::uuid AND revision = ${f.item.revision}::bigint`);
				const items = (f.items ?? []).map((k) =>
					kitItem(
						noop || k.id !== itemId
							? k
							: {
									...k,
									revision: next(k.revision),
									checked: after.checked,
									notes: after.notes,
									...(reassigned
										? (f.assignee ?? { assignee_id: null, assignee_name: null, assignee_state: null })
										: {}),
								},
					),
				);
				return {
					value: c.kitMutationResult.parse({
						receiptId: audit.id,
						outcome: noop ? "noop" : "changed",
						meetingId: m.id,
						items,
						checked: items.filter((i) => i.checked).length,
						total: items.length,
					}),
					subject: m.id,
					subjectType: "meeting",
					meetingId: m.id,
					action: "meetings.changed",
					kind:
						after.checked !== before.checked
							? after.checked
								? "tick"
								: "untick"
							: after.assigneePersonId !== before.assigneePersonId
								? "assign"
								: "edit",
					outcome: noop ? "noop" : "changed",
					before,
					after,
					metadata: { kitItemId: itemId },
				};
			});
		});
	},
};

function seedKit(plantId: string, meetingId: string) {
	const items = c.visionKit.items.map(([category, key, text], position) => ({ category, key, text, position }));
	return sql`INSERT INTO meeting_kit_item (plant_id, meeting_id, item_key, position, category, text)
		SELECT ${plantId}::uuid, ${meetingId}::uuid, i.key, i.position, i.category, i.text
		FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) i(key text, position int, category text, text text)
		ON CONFLICT (meeting_id, item_key) DO NOTHING`;
}

export const kitColumns = sql`SELECT k.id, k.position, k.revision::text AS revision, k.item_key, k.category, k.text,
	k.checked, k.notes, p.id AS assignee_id, p.display_name AS assignee_name, p.state AS assignee_state
	FROM meeting_kit_item k LEFT JOIN person p ON p.id = k.assignee_person_id`;
export const kitRow = z.object({
	id: z.uuid(),
	revision: z.string(),
	item_key: z.string(),
	category: c.kitCategory,
	text: z.string(),
	checked: z.boolean(),
	notes: z.string().nullable(),
	assignee_id: z.uuid().nullable(),
	assignee_name: z.string().nullable(),
	assignee_state: z.enum(["live", "retired", "merged"]).nullable(),
});
export function kitItem(k: z.infer<typeof kitRow>) {
	return c.kitItem.parse({
		id: k.id,
		revision: k.revision,
		key: k.item_key,
		category: k.category,
		text: k.text,
		assignee: k.assignee_id ? { personId: k.assignee_id, displayName: k.assignee_name, state: k.assignee_state } : null,
		checked: k.checked,
		notes: k.notes,
	});
}
