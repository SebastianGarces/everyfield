import * as c from "@everyfield/contracts/meetings";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { appendPerson } from "../people/people.ts";
import { command, deny, next, parse, reply, type Change, type MeetingsContext, type Tx, type Writer } from "./core.ts";
import { meetingColumns, meetingRow, plantMeeting, type MeetingRow } from "./rows.ts";

/** One guest with the Person and inviter it names. Lists and every guest write read these columns. */
export const guestColumns = sql`g.id, g.revision::text AS revision, coalesce(g.rsvp, 'pending') AS rsvp, g.rsvp_source,
	g.rsvp_at, g.presence, g.card_response, g.card_notes, g.card_occurred_at, g.card_recorded_at, g.removed_at,
	g.rsvp_token_open, g.inviter_person_id,
	p.id AS person_id, p.display_name AS person_name, p.state AS person_state,
	i.display_name AS inviter_name, i.state AS inviter_state
	FROM participation g JOIN person p ON p.id = g.person_id LEFT JOIN person i ON i.id = g.inviter_person_id`;
const state = z.enum(["live", "retired", "merged"]);
export const guestRow = z.object({
	id: z.uuid(),
	revision: z.string(),
	rsvp: c.rsvp,
	rsvp_source: c.rsvpSource.nullable(),
	rsvp_at: z.coerce.date().nullable(),
	presence: c.presence,
	card_response: c.cardResponse.nullable(),
	card_notes: z.string().nullable(),
	card_occurred_at: z.coerce.date().nullable(),
	card_recorded_at: z.coerce.date().nullable(),
	removed_at: z.coerce.date().nullable(),
	rsvp_token_open: z.boolean(),
	inviter_person_id: z.uuid().nullable(),
	person_id: z.uuid(),
	person_name: z.string(),
	person_state: state,
	inviter_name: z.string().nullable(),
	inviter_state: state.nullable(),
});
export type GuestRow = z.infer<typeof guestRow>;
export const guest = (g: GuestRow) =>
	c.guest.parse({
		id: g.id,
		revision: g.revision,
		person: { personId: g.person_id, displayName: g.person_name, state: g.person_state },
		inviter: g.inviter_person_id
			? { personId: g.inviter_person_id, displayName: g.inviter_name, state: g.inviter_state }
			: null,
		rsvp: g.rsvp,
		rsvpSource: g.rsvp_source,
		rsvpAt: g.rsvp_at?.toISOString() ?? null,
		presence: g.presence,
		hasCard: g.card_response !== null,
	});
export const card = (g: GuestRow, notes: boolean) =>
	g.card_response === null
		? null
		: c.card.parse({
				guestId: g.id,
				personId: g.person_id,
				response: g.card_response,
				notes: notes ? g.card_notes : null,
				occurredAt: (g.card_occurred_at ?? g.card_recorded_at)!.toISOString(),
				recordedAt: g.card_recorded_at!.toISOString(),
				attended: g.presence === "attended",
				revision: g.revision,
			});

/**
 * The meeting (shared lock) and the named guest (row lock) in one statement, with the command's extra facts. The
 * Person is a parameter or, for an own reply, the session account's own live Person in this church.
 */
async function lockGuest(tx: Tx, w: Writer, meetingId: string, person: SQL, extra: SQL = sql`NULL::json`) {
	const r = await tx.execute(sql`SELECT ${meetingColumns},
			(SELECT row_to_json(x) FROM (SELECT ${guestColumns} WHERE g.meeting_id = m.id AND g.person_id = ${person}
				FOR UPDATE OF g) x) AS guest,
			${extra} AS extra, clock_timestamp() AS now
		FROM meeting m WHERE ${plantMeeting(w.plant.id, meetingId)} AND m.retired_at IS NULL FOR SHARE OF m`);
	if (!r.rows[0]) deny();
	const row = r.rows[0] as Record<string, unknown>;
	return {
		m: meetingRow.parse(row),
		g: guestRow.nullable().parse(row.guest),
		extra: row.extra,
		now: z.coerce.date().parse(row.now),
	};
}
const current = (g: GuestRow | null) => {
	if (!g || g.removed_at) deny();
	return g;
};
const expected = (g: GuestRow, revision: string) => {
	if (g.revision !== revision) deny("conflict");
};
const personState = (id: string | null) =>
	sql`(SELECT state FROM person WHERE id = ${id}::uuid AND tenant_id = m.plant_id FOR SHARE)`;
/** Whether the inviter's own chain of inviters on this meeting reaches the guest: a referral cycle. */
const cycle = (meetingId: string, personId: string, inviterId: string | null) =>
	sql`EXISTS (WITH RECURSIVE chain(pid) AS (
		SELECT inviter_person_id FROM participation WHERE meeting_id = ${meetingId}::uuid AND person_id = ${inviterId}::uuid AND removed_at IS NULL
		UNION SELECT g.inviter_person_id FROM participation g JOIN chain ON g.person_id = chain.pid
			WHERE g.meeting_id = ${meetingId}::uuid AND g.removed_at IS NULL)
		SELECT FROM chain WHERE pid = ${personId}::uuid)`;
const rsvpFacts = (g: GuestRow) => ({ rsvp: g.rsvp, rsvpSource: g.rsvp_source, tokenOpen: g.rsvp_token_open });

type GuestChange = { value: unknown; g: GuestRow; m: MeetingRow };
function guestChange<T>(
	{ value, g, m }: GuestChange & { value: T },
	rest: Omit<Change<T>, "value" | "subject" | "subjectType" | "meetingId">,
): Change<T> {
	return { value, subject: g.id, subjectType: "participation", meetingId: m.id, ...rest };
}
const answer = (receiptId: string, outcome: "changed" | "noop", g: GuestRow) =>
	c.guestMutationResult.parse({ receiptId, outcome, guest: guest(g) });

/** Sets the one canonical RSVP and closes the guest's open token, so an old link cannot overwrite it (REQ-MTG-008/009). */
function setRsvp(g: GuestRow, rsvp: z.infer<typeof c.rsvp>, source: z.infer<typeof c.rsvpSource>, now: Date) {
	const at = rsvp === "pending" ? null : now.toISOString();
	return {
		after: { ...g, rsvp, rsvp_source: source, rsvp_at: at ? new Date(at) : null, rsvp_token_open: false, revision: next(g.revision) },
		write: sql`UPDATE participation SET rsvp = ${rsvp}, rsvp_source = ${source}, rsvp_at = ${at}::timestamptz,
			rsvp_token_open = false, revision = revision + 1 WHERE id = ${g.id}::uuid AND revision = ${g.revision}::bigint`,
	};
}

export const guestsWriter = {
	/** Adds an existing live Person as a guest, invited and absent; inviting a current guest again changes nothing. */
	async inviteGuest(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.inviteGuestRequest, raw);
			return command(tx, ctx, "meetings.inviteGuest", input, async (w, audit) => {
				const { meetingId, personId, inviterPersonId } = input.input;
				const { m, g, extra } = await lockGuest(
					tx,
					w,
					meetingId,
					sql`${personId}::uuid`,
					sql`json_build_object('person', ${personState(personId)}, 'inviter', ${personState(inviterPersonId)},
						'cycle', ${cycle(meetingId, personId, inviterPersonId)},
						'names', (SELECT json_object_agg(id, display_name) FROM person WHERE id IN (${personId}::uuid, ${inviterPersonId}::uuid)))`,
				);
				const f = z
					.object({
						person: z.string().nullable(),
						inviter: z.string().nullable(),
						cycle: z.boolean(),
						names: z.record(z.string(), z.string()).nullable(),
					})
					.parse(extra);
				if (g && !g.removed_at)
					return guestChange(
						{ value: answer(audit.id, "noop", g), g, m },
						{ action: "meetings.changed", kind: "create", outcome: "noop" },
					);
				if (f.person !== "live" || (inviterPersonId && f.inviter !== "live") || f.cycle) deny("invalid_subject");
				const id = g?.id ?? randomUUID();
				const after: GuestRow = {
					id,
					revision: g ? next(g.revision) : "1",
					rsvp: "pending",
					rsvp_source: null,
					rsvp_at: null,
					presence: g?.presence ?? "absent",
					card_response: null,
					card_notes: null,
					card_occurred_at: null,
					card_recorded_at: null,
					removed_at: null,
					rsvp_token_open: false,
					inviter_person_id: inviterPersonId,
					person_id: personId,
					person_name: f.names?.[personId] ?? "",
					person_state: "live",
					inviter_name: inviterPersonId ? (f.names?.[inviterPersonId] ?? null) : null,
					inviter_state: inviterPersonId ? "live" : null,
				};
				audit.writes.push(
					g
						? sql`UPDATE participation SET removed_at = NULL, rsvp = 'pending', rsvp_source = NULL, rsvp_at = NULL,
							inviter_person_id = ${inviterPersonId}::uuid, revision = revision + 1
							WHERE id = ${g.id}::uuid AND revision = ${g.revision}::bigint`
						: sql`INSERT INTO participation (id, plant_id, meeting_id, person_id, inviter_person_id, roster_member, rsvp, presence)
							VALUES (${id}::uuid, ${w.plant.id}::uuid, ${m.id}::uuid, ${personId}::uuid, ${inviterPersonId}::uuid, false,
								'pending', 'absent')`,
				);
				return guestChange(
					{ value: answer(audit.id, "changed", after), g: after, m },
					{
						action: "meetings.changed",
						kind: g ? "restore" : "create",
						before: g ? { removed: true } : null,
						after: { personId, inviterPersonId, rsvp: "pending" },
					},
				);
			});
		});
	},
	/**
	 * Takes a guest off the current list and clears the current card; the row, its history, notes and follow-up stay.
	 * Reminders read the current list when they run, and the guest's open token closes.
	 */
	async removeGuest(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.removeGuestRequest, raw);
			return command(tx, ctx, "meetings.removeGuest", input, async (w, audit) => {
				const { m, g, now } = await lockGuest(tx, w, input.input.meetingId, sql`${input.input.personId}::uuid`);
				if (!g) deny();
				if (g.removed_at)
					return guestChange(
						{ value: answer(audit.id, "noop", g), g, m },
						{ action: "meetings.changed", kind: "remove", outcome: "noop" },
					);
				expected(g, input.expectedRevision);
				const after: GuestRow = {
					...g,
					removed_at: now,
					rsvp_token_open: false,
					card_response: null,
					card_notes: null,
					card_occurred_at: null,
					card_recorded_at: null,
					revision: next(g.revision),
				};
				audit.writes.push(sql`UPDATE participation SET removed_at = ${now.toISOString()}::timestamptz, rsvp_token_open = false,
					card_response = NULL, card_notes = NULL, card_occurred_at = NULL, card_recorded_at = NULL, card_author_id = NULL,
					revision = revision + 1 WHERE id = ${g.id}::uuid AND revision = ${g.revision}::bigint`);
				return guestChange(
					{ value: answer(audit.id, "changed", after), g: after, m },
					{
						action: "meetings.changed",
						kind: "remove",
						before: { removed: false, card: g.card_response },
						after: { removed: true, card: null },
					},
				);
			});
		});
	},
	/** Records who invited the guest: a live Person of this church, never the guest or a referral cycle (REQ-MTG-019). */
	async setInviter(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.setInviterRequest, raw);
			return command(tx, ctx, "meetings.setInviter", input, async (w, audit) => {
				const { meetingId, personId, inviterPersonId } = input.input;
				const { m, g: found, extra } = await lockGuest(
					tx,
					w,
					meetingId,
					sql`${personId}::uuid`,
					sql`json_build_object('inviter', ${personState(inviterPersonId)}, 'cycle', ${cycle(meetingId, personId, inviterPersonId)},
						'name', (SELECT display_name FROM person WHERE id = ${inviterPersonId}::uuid))`,
				);
				const g = current(found);
				expected(g, input.expectedRevision);
				const f = z.object({ inviter: z.string().nullable(), cycle: z.boolean(), name: z.string().nullable() }).parse(extra);
				if (g.inviter_person_id === inviterPersonId)
					return guestChange(
						{ value: answer(audit.id, "noop", g), g, m },
						{ action: "meetings.changed", kind: "assign", outcome: "noop" },
					);
				if (inviterPersonId && (f.inviter !== "live" || f.cycle)) deny("invalid_subject");
				const after: GuestRow = {
					...g,
					inviter_person_id: inviterPersonId,
					inviter_name: f.name,
					inviter_state: inviterPersonId ? "live" : null,
					revision: next(g.revision),
				};
				audit.writes.push(sql`UPDATE participation SET inviter_person_id = ${inviterPersonId}::uuid, revision = revision + 1
					WHERE id = ${g.id}::uuid AND revision = ${g.revision}::bigint`);
				return guestChange(
					{ value: answer(audit.id, "changed", after), g: after, m },
					{
						action: "meetings.changed",
						kind: "assign",
						before: { inviterPersonId: g.inviter_person_id },
						after: { inviterPersonId },
					},
				);
			});
		});
	},
	/** Owner/Admin sets Confirmed or Declined, or resets to Pending; attendance, cards and contacts stay as they are. */
	async correctRsvp(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.correctRsvpRequest, raw);
			return command(tx, ctx, "meetings.correctRsvp", input, async (w, audit) => {
				const { m, g: found, now } = await lockGuest(tx, w, input.input.meetingId, sql`${input.input.personId}::uuid`);
				const g = current(found);
				expected(g, input.expectedRevision);
				const rsvp = input.input.rsvp ?? "pending";
				const noop = g.rsvp === rsvp && !g.rsvp_token_open;
				const set = setRsvp(g, rsvp, "admin", now);
				if (!noop) audit.writes.push(set.write);
				const after = noop ? g : set.after;
				return guestChange(
					{ value: answer(audit.id, noop ? "noop" : "changed", after), g: after, m },
					{
						action: "meetings.rsvp_recorded",
						kind: "correct",
						outcome: noop ? "noop" : "changed",
						before: rsvpFacts(g),
						after: rsvpFacts(after),
					},
				);
			});
		});
	},
	/**
	 * The signed-in member answers for their own account-linked live Person on this guest list. No caller-sent Person or
	 * account: the statement finds the guest from the session's account.
	 */
	async saveOwnRsvp(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.saveOwnRsvpRequest, raw);
			return command(
				tx,
				ctx,
				"meetings.saveOwnRsvp",
				input,
				async (w, audit) => {
					const { m, g: found, now } = await lockGuest(
						tx,
						w,
						input.input.meetingId,
						sql`(SELECT id FROM person WHERE tenant_id = m.plant_id AND linked_account_id = ${w.accountId}::uuid AND state = 'live')`,
					);
					const g = current(found);
					if (!["planning", "ready", "in_progress"].includes(m.status)) deny("status_transition");
					const noop = g.rsvp === input.input.rsvp && g.rsvp_source === "own" && !g.rsvp_token_open;
					const set = setRsvp(g, input.input.rsvp, "own", now);
					if (!noop) audit.writes.push(set.write);
					const after = noop ? g : set.after;
					return guestChange(
						{ value: answer(audit.id, noop ? "noop" : "changed", after), g: after, m },
						{
							action: "meetings.rsvp_recorded",
							kind: "edit",
							outcome: noop ? "noop" : "changed",
							before: rsvpFacts(g),
							after: rsvpFacts(after),
						},
					);
				},
				{ member: true },
			);
		});
	},
	createGuestContact: contact("meetings.createGuestContact", c.createGuestContactRequest),
	createWalkInContact: contact("meetings.createWalkInContact", c.createWalkInContactRequest),
	/** Owner/Admin records or corrects the one Vision response card of a guest. */
	async recordCard(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.recordCardRequest, raw);
			return command(tx, ctx, "meetings.recordCard", input, async (w, audit) => {
				const { m, g: found, now } = await lockGuest(tx, w, input.input.meetingId, sql`${input.input.personId}::uuid`);
				if (m.type !== "vision_meeting") deny("wrong_meeting_type");
				const g = current(found);
				expected(g, input.expectedRevision);
				const { response, notes } = input.input;
				const occurredAt = input.input.occurredAt ? new Date(input.input.occurredAt) : now;
				if (occurredAt > now) deny("invalid_input", { issues: [{ path: "occurredAt", problem: "in_the_future" }] });
				const after: GuestRow = {
					...g,
					card_response: response,
					card_notes: notes,
					card_occurred_at: occurredAt,
					card_recorded_at: now,
					revision: next(g.revision),
				};
				audit.writes.push(sql`UPDATE participation SET card_response = ${response}, card_notes = ${notes},
					card_occurred_at = ${occurredAt.toISOString()}::timestamptz, card_recorded_at = ${now.toISOString()}::timestamptz,
					card_author_id = ${w.accountId}::uuid, revision = revision + 1
					WHERE id = ${g.id}::uuid AND revision = ${g.revision}::bigint`);
				return guestChange(
					{ value: c.cardMutationResult.parse({ receiptId: audit.id, outcome: "changed", guestId: g.id, card: card(after, true) }), g: after, m },
					{
						action: "meetings.response_recorded",
						kind: g.card_response ? "correct" : "create",
						// Prayer and question notes stay out of history; only whether there were any.
						before: { response: g.card_response, notes: g.card_notes !== null },
						after: { response, notes: notes !== null },
					},
				);
			});
		});
	},
	/** Clears the card back to no card, which reads as unknown; history keeps the correction. */
	async clearCard(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.clearCardRequest, raw);
			return command(tx, ctx, "meetings.clearCard", input, async (w, audit) => {
				const { m, g: found } = await lockGuest(tx, w, input.input.meetingId, sql`${input.input.personId}::uuid`);
				if (m.type !== "vision_meeting") deny("wrong_meeting_type");
				const g = current(found);
				expected(g, input.expectedRevision);
				const noop = g.card_response === null;
				if (!noop)
					audit.writes.push(sql`UPDATE participation SET card_response = NULL, card_notes = NULL, card_occurred_at = NULL,
						card_recorded_at = NULL, card_author_id = NULL, revision = revision + 1
						WHERE id = ${g.id}::uuid AND revision = ${g.revision}::bigint`);
				const after = noop ? g : { ...g, card_response: null, card_notes: null, revision: next(g.revision) };
				return guestChange(
					{ value: c.cardMutationResult.parse({ receiptId: audit.id, outcome: noop ? "noop" : "changed", guestId: g.id, card: null }), g: after, m },
					{
						action: "meetings.response_recorded",
						kind: "correct",
						outcome: noop ? "noop" : "changed",
						before: { response: g.card_response, notes: g.card_notes !== null },
						after: { response: null, notes: false },
						reason: input.input.reason,
					},
				);
			});
		});
	},
};

/**
 * A new named contact and its guest row in one write (REQ-MTG-011): the People minimal create (prospect, from a meeting
 * guest list, no surname, account, adulthood or commitment), then the guest, absent or attended. A failed or foreign
 * meeting refuses before anything is written, so no orphan contact remains. One audit row names the new Person.
 */
function contact(
	operation: "meetings.createGuestContact" | "meetings.createWalkInContact",
	schema: typeof c.createGuestContactRequest | typeof c.createWalkInContactRequest,
) {
	return async (tx: Tx, ctx: MeetingsContext, raw: unknown) =>
		reply(tx, async () => {
			const input = parse(schema, raw);
			return command(tx, ctx, operation, input, async (w, audit) => {
				const i = input.input;
				const attended = "attendance" in i ? i.attendance === "attended" : true;
				const { m } = await lockGuest(tx, w, i.meetingId, sql`NULL::uuid`);
				const person = appendPerson(
					tx,
					{ selected: { kind: "plant", id: w.plant.id } as never },
					{
						displayName: i.displayName,
						email: i.email,
						phone: i.phone,
						country: i.country,
						stage: "prospect",
						source: "meeting_guest_list",
						adultClassification: "unknown",
					},
					audit.writes,
				);
				const id = randomUUID();
				audit.writes.push(sql`INSERT INTO participation (id, plant_id, meeting_id, person_id, roster_member, rsvp, presence)
					VALUES (${id}::uuid, ${w.plant.id}::uuid, ${m.id}::uuid, ${person.id}::uuid, false, 'pending',
						${attended ? "attended" : "absent"})`);
				const g: GuestRow = {
					id,
					revision: "1",
					rsvp: "pending",
					rsvp_source: null,
					rsvp_at: null,
					presence: attended ? "attended" : "absent",
					card_response: null,
					card_notes: null,
					card_occurred_at: null,
					card_recorded_at: null,
					removed_at: null,
					rsvp_token_open: false,
					inviter_person_id: null,
					person_id: person.id,
					person_name: person.display_name,
					person_state: "live",
					inviter_name: null,
					inviter_state: null,
				};
				return {
					value: c.guestContactResult.parse({ receiptId: audit.id, outcome: "changed", guest: guest(g), personCreated: true }),
					subject: person.id,
					subjectType: "person",
					meetingId: m.id,
					action: "people.created",
					kind: "create",
					before: null,
					after: {
						displayName: person.display_name,
						email: person.email,
						phone: person.phone,
						country: person.country,
						stage: person.stage,
						source: person.source,
					},
					metadata: { guestId: id, attended },
				};
			});
		});
}
export type { GuestChange };
