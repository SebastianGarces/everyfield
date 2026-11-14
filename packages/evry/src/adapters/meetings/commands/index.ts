import { localDateTime, resolveCalendar, timeZone } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/meetings";
import type { MeetingsReply } from "@everyfield/contracts/meetings";
import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import {
	attendanceReader,
	createAttendanceWriter,
	guestsWriter,
	meetingsReader,
	meetingsWriter,
	MeetingsRefusal,
	previewMeetingsWrite,
	rosterReader,
	rosterWriter,
	venuesReader,
	venuesWriter,
	type AttendanceWriter,
	type MeetingsContext,
} from "@everyfield/domain/meetings";
import { checkForDuplicates, PeopleReadContext } from "@everyfield/domain/people";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";
import { id, inPlant, localWhen, meetingId, ownerOrAdmin, personId, RSVP, TYPE_LABEL, value, venueId } from "../shared.ts";

// The Meetings reviewed writes (WP-066). The model only proposes. Each review reads the target through the native
// Meetings reads, saves the native command's exact request (with the revision the review showed) and runs that same
// command once in a transaction that rolls back (previewMeetingsWrite, C73), so the card shows exactly what it will do
// now: the change and every task, stage advance or reminder it generates, with nothing saved. On approval the executor
// runs the native command once under the approver's live seat, with the effect key as its request key; a target that
// changed since refuses (conflict) instead of being overwritten. Public RSVP tokens and notification planning stay
// native and are not tools.

type Reader = Pick<Transaction, "execute">;
type Target = { kind: "meeting" | "venue"; id: string; label: string };
type Change = { field: string; before: unknown; after: unknown };
type Writers = {
	meetings: typeof meetingsWriter;
	guests: typeof guestsWriter;
	attendance: AttendanceWriter;
	roster: typeof rosterWriter;
	venues: typeof venuesWriter;
};
const writers = (reminders: TaskReminders): Writers => ({
	meetings: meetingsWriter,
	guests: guestsWriter,
	attendance: createAttendanceWriter({ reminders }),
	roster: rosterWriter,
	venues: venuesWriter,
});
/** A preview rolls back, so the reminders a generated task would plan are never planned. */
const previewWriters = writers(async () => undefined);

/** What a review prepared: the target, the native request without its request key, and facts the card shows. */
type Prepared<F = unknown> = { target: Target | null; args: Record<string, unknown>; facts: F };

const change = (field: string, before: unknown, after: unknown): Change => ({
	field,
	before: before ?? null,
	after: after ?? null,
});
const created = (field: string, after: unknown): Change => change(field, null, after);

/** The plain reason a review cannot be approved as asked, from the native refusal the preview returned. */
const REFUSAL: Record<string, string> = {
	unavailable: "An Owner or Admin has to make this change.",
	conflict: "This changed while Evry was preparing it. Ask Evry to prepare it again.",
	venue_archived: "That venue is archived. Restore it or choose another venue.",
	team_unavailable: "That ministry is archived or not in this church.",
	wrong_meeting_type: "Only a Vision meeting has this.",
	status_transition: "This meeting's status does not allow that change.",
	nonexistent_local_time: "That time does not exist on that day, because the clocks change. Pick another time.",
	ambiguous_local_time: "That time happens twice on that day, because the clocks change. Pick another time.",
	invalid_subject: "Someone named here is not a current person in this church.",
	owner_ineligible: "The chosen owner can't own this follow-up.",
	token_closed: "This meeting no longer takes RSVPs.",
};
/** The member floor's refusal: a seated Member may do this only for their own ministry's team meeting. */
const MEMBER_REFUSAL = "An Owner or Admin, or the leader of this meeting's ministry, has to make this change.";

const meetingLive = (actor: EvryActor, meeting: string) =>
	sql`EXISTS(SELECT FROM meeting m WHERE m.id=${meeting}::uuid AND m.plant_id=${actor.owner.id}::uuid AND m.retired_at IS NULL)`;
const venueLive = (actor: EvryActor, venue: string) =>
	sql`EXISTS(SELECT FROM venue v WHERE v.id=${venue}::uuid AND v.plant_id=${actor.owner.id}::uuid)`;

/**
 * One reviewed write. `prepare` reads the target through the native reads and builds the native request; `run` is the
 * native command; `changes` turns the previewed answer into the card's rows; `inspect` may read, inside the rolled-back
 * preview, what the command generated (the titles of the tasks a finalize creates).
 */
function write<I, F, V>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	allowed?: (actor: EvryActor) => boolean;
	/** Members may propose it: the native command's own floor (a team leader, the guest themself) decides. */
	member?: true;
	prepare(db: Reader, actor: EvryActor, input: NoInfer<I>): Promise<Prepared<F> | null>;
	run(w: Writers, tx: Transaction, ctx: MeetingsContext, request: unknown): Promise<MeetingsReply<V>>;
	changes(previewed: { prepared: Prepared<F>; value: V; seen: unknown }): Change[];
	/** The rows a card shows when the preview refused, so the person still sees what was asked. */
	asked?(prepared: Prepared<F>): Change[];
	inspect?(tx: Transaction, value: NoInfer<V>): Promise<unknown>;
	/** The revision the receipt names: the changed record's new revision. */
	revision(value: NoInfer<V>): string;
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: spec.allowed ?? (spec.member ? inPlant : ownerOrAdmin),
		async review(actor, input, context) {
			const db = context.db;
			const prepared = await spec.prepare(db, actor, input);
			if (!prepared) return null;
			const reply = await previewMeetingsWrite(db, actor.authority, async (tx, ctx) => {
				const r = await spec.run(previewWriters, tx, ctx, { requestKey: randomUUID(), ...prepared.args });
				if (r.status !== "ok") return r;
				return { status: "ok" as const, value: { value: r.value, seen: await spec.inspect?.(tx, r.value) } };
			});
			if (reply.status !== "ok" && reply.error.code === "invalid_input") throw new EvryRefusal("invalid_input");
			if (reply.status !== "ok" && reply.error.code === "required_write_failed")
				throw new EvryRefusal("source_unavailable");
			const review =
				reply.status === "ok"
					? {
							target: prepared.target,
							changes: spec.changes({ prepared, value: reply.value.value, seen: reply.value.seen }),
						}
					: {
							target: prepared.target,
							changes: spec.asked?.(prepared) ?? [],
							refusal:
								reply.error.code === "unavailable" && spec.member
									? MEMBER_REFUSAL
									: (REFUSAL[reply.error.code] ?? REFUSAL.unavailable),
						};
			const live = !prepared.target
				? sql``
				: sql`WHERE ${prepared.target.kind === "meeting" ? meetingLive(actor, prepared.target.id) : venueLive(actor, prepared.target.id)}`;
			return sql`SELECT ${JSON.stringify(review)}::jsonb AS review, ${JSON.stringify(prepared.args)}::jsonb AS args ${live}`;
		},
		async execute(tx, context, args, effectKey, reminders): Promise<EffectResult> {
			const request = { ...z.object({}).loose().parse(args), requestKey: effectKey };
			try {
				const reply = await spec.run(writers(reminders), tx, context, request);
				if (reply.status !== "ok") return { refused: reply.error.code };
				const v = reply.value as V & { receiptId: string };
				return { receiptId: v.receiptId, revision: spec.revision(v) };
			} catch (error) {
				// Inside the executor's bound write a native refusal is thrown; the executor rolls the transaction back.
				if (error instanceof MeetingsRefusal) return { refused: error.code };
				throw error;
			}
		},
	};
}

// --- Shared reads and shapes --------------------------------------------------------------------------------------

type Detail = z.infer<typeof c.meetingDetail>;
async function meeting(db: Reader, actor: EvryActor, meetingId: string): Promise<Detail | null> {
	const m = value(await meetingsReader.get(db, actor.authority, { meetingId }));
	return m?.status === "available" ? m.meeting : null;
}
const meetingTarget = (m: Pick<Detail, "id" | "displayTitle">): Target => ({
	kind: "meeting",
	id: m.id,
	label: m.displayTitle,
});
type Facts = Pick<
	Detail,
	"displayTitle" | "type" | "startsAt" | "zone" | "venue" | "status" | "notes" | "occurrence" | "retiredAt"
>;
const STATUS: Record<string, string> = {
	planning: "Planning",
	ready: "Ready",
	in_progress: "In progress",
	completed: "Completed",
	cancelled: "Cancelled",
};
const venueText = (v: Facts["venue"]) => (v ? (v.address ? `${v.name}, ${v.address}` : v.name) : null);
/** A meeting's facts as the card shows them, in the church's own zone. */
const shown = (m: Facts) => ({
	title: m.displayTitle,
	when: localWhen(m.startsAt, m.zone),
	venue: venueText(m.venue),
	status: STATUS[m.status] ?? m.status,
	notes: m.notes,
	held: m.occurrence.heldAt ? localWhen(m.occurrence.heldAt, m.zone) : null,
	voided: m.occurrence.voidedAt ? "Voided" : null,
	removed: m.retiredAt ? "Removed from Meetings" : null,
});
/** The facts that differ between two versions of a meeting. */
function meetingDiff(before: Facts, after: Facts): Change[] {
	const a = shown(before),
		b = shown(after);
	return (Object.keys(b) as (keyof typeof b)[]).filter((k) => a[k] !== b[k]).map((k) => change(k, a[k], b[k]));
}
/** A wall time the person entered, resolved in the meeting's zone the way the native command resolves one. */
function instantOf(local: string, zone: string) {
	const r = resolveCalendar(localDateTime.parse(`${local}:00`), timeZone.parse(zone), "entered");
	if (r.kind !== "resolved") throw new EvryRefusal("invalid_input");
	return r.occurrence.instant;
}

type GuestFacts = { m: Detail; guests: z.infer<typeof c.guestList>["guests"] };
async function guestFacts(db: Reader, actor: EvryActor, meetingId: string): Promise<GuestFacts | null> {
	const m = await meeting(db, actor, meetingId);
	const list = m && value(await meetingsReader.listGuests(db, actor.authority, { meetingId }));
	return m && list ? { m, guests: list.guests } : null;
}
const guestOf = (f: GuestFacts, person: string) => f.guests.find((g) => g.person.personId === person) ?? null;
type GuestResult = z.infer<typeof c.guestMutationResult>;
const guestRevision = (v: { guest: { revision: string } }) => v.guest.revision;
const meetingRevision = (v: { meeting: { revision: string } }) => v.meeting.revision;

/** A meeting command on the meeting's own revision: the target and the native request for this meeting now. */
async function onMeeting(db: Reader, actor: EvryActor, id: string, input: Record<string, unknown> = {}) {
	const m = await meeting(db, actor, id);
	if (!m) return null;
	return {
		target: meetingTarget(m),
		args: { expectedRevision: m.revision, input: { meetingId: m.id, ...input } },
		facts: m,
	} satisfies Prepared<Detail>;
}
type MeetingResult = z.infer<typeof c.meetingMutationResult>;
type AgendaResult = { receiptId: string; agenda: z.infer<typeof c.agendaResult> };
type KitItem = z.infer<typeof c.kitItem>;
const diffed = ({ prepared, value: v }: { prepared: Prepared<Detail>; value: MeetingResult }) =>
	meetingDiff(prepared.facts, v.meeting);
const reason = c.reason;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clock = z.string().regex(/^\d{2}:\d{2}$/);

// --- Meetings -----------------------------------------------------------------------------------------------------

const scheduleInput = z.strictObject({
	type: c.meetingType,
	title: z.string().trim().min(1).max(200).optional(),
	date: day,
	time: clock,
	venueId: venueId.optional(),
	teamId: id.optional(),
	subtype: c.meetingSubtype.optional(),
	notes: z.string().trim().min(1).max(5000).optional(),
	guestIds: z.array(personId).max(200).optional(),
});
export const schedule = write({
	operation: "meetings.schedule",
	description:
		"A new meeting at a church-local date and 24-hour time, at a saved venue from venues.list. \"Next <weekday>\" can mean this week's or the following week's: ask which date (name both) before proposing.",
	input: scheduleInput,
	member: true,
	async prepare(db, actor, i) {
		const venue = i.venueId ? value(await venuesReader.get(db, actor.authority, { venueId: i.venueId })) : null;
		if (i.venueId && venue?.status !== "available") return null;
		return {
			target: null,
			args: {
				input: {
					type: i.type,
					...(i.title ? { title: i.title } : {}),
					date: i.date,
					time: i.time,
					venue: i.venueId ? { kind: "existing", venueId: i.venueId } : { kind: "none" },
					...(i.teamId ? { teamId: i.teamId } : {}),
					...(i.subtype ? { subtype: i.subtype } : {}),
					...(i.notes ? { notes: i.notes } : {}),
					guests: i.guestIds ?? [],
				},
			},
			facts: { type: i.type, date: i.date, time: i.time, venue: venue?.status === "available" ? venue.venue : null },
		};
	},
	run: (w, tx, ctx, r) => w.meetings.schedule(tx, ctx, r),
	asked: ({ facts }) => [
		created("type", TYPE_LABEL[facts.type]),
		created("when", `${facts.date} ${facts.time}`),
		created("venue", facts.venue?.name ?? null),
	],
	changes: ({ value: v }: { value: MeetingResult }) => {
		const m = v.meeting;
		return [
			created("type", TYPE_LABEL[m.type]),
			created("title", m.displayTitle),
			created("when", localWhen(m.startsAt, m.zone)),
			created("venue", venueText(m.venue)),
			...(m.team ? [created("team", m.team.name)] : []),
			created("status", STATUS[m.status]),
			...(m.guestCount ? [created("guests", String(m.guestCount))] : []),
			...(m.agenda.sections.length
				? [created("agenda", m.agenda.sections.map((s) => `${s.title} (${s.minutes} min)`))]
				: []),
			...(m.kit ? [created("kit", `${m.kit.total} checklist items to prepare`)] : []),
			...(m.notes ? [created("notes", m.notes)] : []),
		];
	},
	revision: meetingRevision,
});

const editInput = z.strictObject({
	meetingId,
	title: z.string().trim().max(200).nullable().optional(),
	notes: z.string().trim().max(5000).nullable().optional(),
	date: day.optional(),
	time: clock.optional(),
	venueId: venueId.nullable().optional(),
});
export const edit = write({
	operation: "meetings.edit",
	description:
		"Change a meeting's title, notes, date and time, or venue (null: none).",
	input: editInput,
	async prepare(db, actor, i) {
		const m = await meeting(db, actor, i.meetingId);
		if (!m) return null;
		const patch = {
			...(i.title !== undefined ? { title: i.title } : {}),
			...(i.notes !== undefined ? { notes: i.notes } : {}),
			...(i.date || i.time ? { date: i.date ?? m.localDate, time: i.time ?? m.localTime } : {}),
			...(i.venueId !== undefined
				? { venue: i.venueId === null ? { kind: "none" } : { kind: "existing", venueId: i.venueId } }
				: {}),
		};
		return { target: meetingTarget(m), args: { expectedRevision: m.revision, input: { meetingId: m.id, patch } }, facts: m };
	},
	run: (w, tx, ctx, r) => w.meetings.edit(tx, ctx, r),
	changes: diffed,
	revision: meetingRevision,
});

export const changeStatus = write({
	operation: "meetings.changeStatus",
	description:
		"Move a meeting to another status, such as cancelled.",
	input: z.strictObject({ meetingId, to: c.meetingStatus }),
	prepare: (db, actor, i) => onMeeting(db, actor, i.meetingId, { to: i.to }),
	run: (w, tx, ctx, r) => w.meetings.changeStatus(tx, ctx, r),
	changes: diffed,
	asked: ({ facts, args }) => [
		change("status", STATUS[facts.status], STATUS[String((args.input as { to: string }).to)]),
	],
	revision: meetingRevision,
});

export const deleteMeeting = write({
	operation: "meetings.delete",
	description:
		"Delete a meeting from Meetings, with the reason. Owner or Admin only.",
	input: z.strictObject({ meetingId, reason }),
	prepare: (db, actor, i) => onMeeting(db, actor, i.meetingId, { reason: i.reason }),
	run: (w, tx, ctx, r) => w.meetings.delete(tx, ctx, r),
	changes: (p: { prepared: Prepared<Detail>; value: MeetingResult }) => [
		...diffed(p),
		created("reason", (p.prepared.args.input as { reason: string }).reason),
	],
	revision: meetingRevision,
});

const localStamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
export const completePractice = write({
	operation: "meetings.completePractice",
	description:
		"Record a pre-launch practice as held, at a church-local time (default: as scheduled).",
	input: z.strictObject({ meetingId, heldAt: localStamp.optional() }),
	async prepare(db, actor, i) {
		const m = await meeting(db, actor, i.meetingId);
		if (!m) return null;
		const occurredAt = i.heldAt ? instantOf(i.heldAt, m.zone) : m.startsAt;
		return onMeeting(db, actor, i.meetingId, { occurredAt });
	},
	run: (w, tx, ctx, r) => w.meetings.completePractice(tx, ctx, r),
	changes: diffed,
	revision: meetingRevision,
});

export const correctPracticeOccurrence = write({
	operation: "meetings.correctPracticeOccurrence",
	description:
		"Correct whether a pre-launch practice was held, with the reason.",
	input: z.strictObject({ meetingId, state: z.enum(["completed", "not_completed"]), heldAt: localStamp.optional(), reason }),
	async prepare(db, actor, i) {
		const m = await meeting(db, actor, i.meetingId);
		if (!m) return null;
		const occurredAt =
			i.state === "completed" ? (i.heldAt ? instantOf(i.heldAt, m.zone) : (m.occurrence.heldAt ?? m.startsAt)) : undefined;
		return onMeeting(db, actor, i.meetingId, {
			state: i.state,
			...(occurredAt ? { occurredAt } : {}),
			reason: i.reason,
		});
	},
	run: (w, tx, ctx, r) => w.meetings.correctPracticeOccurrence(tx, ctx, r),
	changes: (p: { prepared: Prepared<Detail>; value: MeetingResult }) => [
		...diffed(p),
		created("reason", (p.prepared.args.input as { reason: string }).reason),
	],
	revision: meetingRevision,
});

export const correctOccurrence = write({
	operation: "meetings.correctOccurrence",
	description:
		"Void a held meeting that should not count, or restore it, with the reason.",
	input: z.strictObject({ meetingId, voided: z.boolean(), reason }),
	prepare: (db, actor, i) => onMeeting(db, actor, i.meetingId, { voided: i.voided, reason: i.reason }),
	run: (w, tx, ctx, r) => w.meetings.correctOccurrence(tx, ctx, r),
	changes: (p: { prepared: Prepared<Detail>; value: MeetingResult }) => [
		...diffed(p),
		created("reason", (p.prepared.args.input as { reason: string }).reason),
	],
	revision: meetingRevision,
});

export const replaceAgenda = write({
	operation: "meetings.replaceAgenda",
	description:
		"Replace a meeting's agenda with the sections the person gives, in order.",
	input: z.strictObject({
		meetingId,
		sections: z
			.array(z.strictObject({ title: z.string().trim().min(1).max(120), minutes: z.int().min(0).max(600) }))
			.max(40),
	}),
	async prepare(db, actor, i) {
		const m = await meeting(db, actor, i.meetingId);
		if (!m) return null;
		// A section that keeps its title keeps its id; a new one gets a fresh id.
		const ids = new Map(m.agenda.sections.map((s) => [s.title, s.id]));
		const sections = i.sections.map((s) => ({ id: ids.get(s.title) ?? randomUUID(), ...s }));
		return onMeeting(db, actor, i.meetingId, { sections });
	},
	run: (w, tx, ctx, r) => w.meetings.replaceAgenda(tx, ctx, r),
	changes: ({ prepared, value: v }: { prepared: Prepared<Detail>; value: AgendaResult }) => [
		change(
			"agenda",
			prepared.facts.agenda.sections.map((s) => `${s.title} (${s.minutes} min)`),
			v.agenda.sections.map((s) => `${s.title} (${s.minutes} min)`),
		),
	],
	revision: (v) => v.agenda.revision,
});

export const populateKit = write({
	operation: "meetings.populateKit",
	description: "Add the standard kit checklist to a Vision meeting without one.",
	input: z.strictObject({ meetingId }),
	prepare: (db, actor, i) => onMeeting(db, actor, i.meetingId),
	run: (w, tx, ctx, r) => w.meetings.populateKit(tx, ctx, r),
	changes: ({ value: v }: { value: MeetingResult }) => [
		created("kit", v.meeting.kit ? `${v.meeting.kit.total} checklist items to prepare` : null),
	],
	revision: meetingRevision,
});

export const updateKitItem = write({
	operation: "meetings.updateKitItem",
	description:
		"Check or uncheck a kit item from meetings.listKit, or set who brings it.",
	input: z.strictObject({
		meetingId,
		itemId: id,
		checked: z.boolean().optional(),
		assigneePersonId: personId.nullable().optional(),
		notes: z.string().trim().max(1000).nullable().optional(),
	}),
	async prepare(db, actor, i) {
		const m = await meeting(db, actor, i.meetingId);
		const kit = m && value(await meetingsReader.listKit(db, actor.authority, { meetingId: i.meetingId }));
		const k = kit?.items.find((x) => x.id === i.itemId);
		if (!m || !k) return null;
		const patch = {
			...(i.checked !== undefined ? { checked: i.checked } : {}),
			...(i.assigneePersonId !== undefined ? { assigneePersonId: i.assigneePersonId } : {}),
			...(i.notes !== undefined ? { notes: i.notes } : {}),
		};
		return {
			target: meetingTarget(m),
			args: { expectedRevision: k.revision, input: { meetingId: m.id, itemId: k.id, patch } },
			facts: k,
		};
	},
	run: (w, tx, ctx, r) => w.meetings.updateKitItem(tx, ctx, r),
	changes: ({ prepared, value: v }: { prepared: Prepared<KitItem>; value: z.infer<typeof c.kitMutationResult> }) => {
		const before = prepared.facts,
			after = v.items.find((x) => x.id === before.id)!;
		const yes = (b: boolean) => (b ? "Checked" : "Not checked");
		return [
			created("item", before.text),
			...(before.checked !== after.checked ? [change("checked", yes(before.checked), yes(after.checked))] : []),
			...(before.assignee?.personId !== after.assignee?.personId
				? [change("bringer", before.assignee?.displayName, after.assignee?.displayName)]
				: []),
			...(before.notes !== after.notes ? [change("notes", before.notes, after.notes)] : []),
		];
	},
	revision: (v) => v.items[0]?.revision ?? "1",
});

// --- Guests -------------------------------------------------------------------------------------------------------

export const inviteGuest = write({
	operation: "meetings.inviteGuest",
	description:
		"Add a person in People to a meeting's guest list. Sends nothing.",
	input: z.strictObject({ meetingId, personId, inviterPersonId: personId.optional() }),
	async prepare(db, actor, i) {
		const m = await meeting(db, actor, i.meetingId);
		if (!m) return null;
		return {
			target: meetingTarget(m),
			args: { input: { meetingId: m.id, personId: i.personId, inviterPersonId: i.inviterPersonId ?? null } },
			facts: m,
		};
	},
	run: (w, tx, ctx, r) => w.guests.inviteGuest(tx, ctx, r),
	changes: ({ value: v }: { value: GuestResult }) => [
		created("guest", v.guest.person.displayName),
		created("rsvp", RSVP[v.guest.rsvp]),
		...(v.guest.inviter ? [created("invitedBy", v.guest.inviter.displayName)] : []),
		...(v.outcome === "noop" ? [created("note", "Already on the guest list: nothing changes.")] : []),
	],
	revision: guestRevision,
});

/** A guest command on the guest row's own revision. */
async function onGuest(db: Reader, actor: EvryActor, meetingId: string, person: string, input: object = {}) {
	const f = await guestFacts(db, actor, meetingId);
	const g = f && guestOf(f, person);
	if (!f || !g) return null;
	return {
		target: meetingTarget(f.m),
		args: { expectedRevision: g.revision, input: { meetingId: f.m.id, personId: person, ...input } },
		facts: g,
	};
}
type Guest = z.infer<typeof c.guest>;

export const removeGuest = write({
	operation: "meetings.removeGuest",
	description: "Take a guest off a meeting's guest list.",
	input: z.strictObject({ meetingId, personId }),
	prepare: (db, actor, i) => onGuest(db, actor, i.meetingId, i.personId),
	run: (w, tx, ctx, r) => w.guests.removeGuest(tx, ctx, r),
	changes: ({ prepared }: { prepared: Prepared<Guest>; value: GuestResult }) => [
		change("guest", prepared.facts.person.displayName, "Removed from the guest list"),
	],
	revision: guestRevision,
});

export const setInviter = write({
	operation: "meetings.setInviter",
	description: "Set who invited a guest, or null.",
	input: z.strictObject({ meetingId, personId, inviterPersonId: personId.nullable() }),
	prepare: (db, actor, i) => onGuest(db, actor, i.meetingId, i.personId, { inviterPersonId: i.inviterPersonId }),
	run: (w, tx, ctx, r) => w.guests.setInviter(tx, ctx, r),
	changes: ({ prepared, value: v }: { prepared: Prepared<Guest>; value: GuestResult }) => [
		created("guest", prepared.facts.person.displayName),
		change("invitedBy", prepared.facts.inviter?.displayName, v.guest.inviter?.displayName),
	],
	revision: guestRevision,
});

const answer = z.enum(["yes", "no", "no answer"]);
const RSVP_VALUE = { yes: "confirmed", no: "declined", "no answer": null } as const;
export const correctRsvp = write({
	operation: "meetings.correctRsvp",
	description:
		"Correct a guest's RSVP as they told the planter.",
	input: z.strictObject({ meetingId, personId, rsvp: answer }),
	prepare: (db, actor, i) => onGuest(db, actor, i.meetingId, i.personId, { rsvp: RSVP_VALUE[i.rsvp] }),
	run: (w, tx, ctx, r) => w.guests.correctRsvp(tx, ctx, r),
	changes: ({ prepared, value: v }: { prepared: Prepared<Guest>; value: GuestResult }) => [
		created("guest", prepared.facts.person.displayName),
		change("rsvp", RSVP[prepared.facts.rsvp], RSVP[v.guest.rsvp]),
	],
	revision: guestRevision,
});

export const saveOwnRsvp = write({
	operation: "meetings.saveOwnRsvp",
	description: "Save the user's own RSVP.",
	input: z.strictObject({ meetingId, rsvp: z.enum(["yes", "no"]) }),
	member: true,
	async prepare(db, actor, i) {
		const m = await meeting(db, actor, i.meetingId);
		if (!m) return null;
		return { target: meetingTarget(m), args: { input: { meetingId: m.id, rsvp: RSVP_VALUE[i.rsvp] } }, facts: m };
	},
	run: (w, tx, ctx, r) => w.guests.saveOwnRsvp(tx, ctx, r),
	changes: ({ value: v }: { value: GuestResult }) => [created("yourRsvp", RSVP[v.guest.rsvp])],
	revision: guestRevision,
});

const contactInput = {
	meetingId,
	displayName: z.string().trim().min(1).max(255),
	email: z.string().max(320).optional(),
	phone: z.string().trim().min(1).max(40).optional(),
};
type Contact = { displayName: string; email?: string; phone?: string };
type ContactFacts = { m: Detail; duplicates: string[] };
/** The meeting and the People duplicate hints for a new contact, from the native People duplicate check. */
async function onContact(db: Reader, actor: EvryActor, i: Contact & { meetingId: string }, extra: object = {}) {
	const m = await meeting(db, actor, i.meetingId);
	if (!m) return null;
	const hints = await checkForDuplicates(db as Transaction, new PeopleReadContext(actor.authority), {
		displayName: i.displayName,
		...(i.email ? { email: i.email } : {}),
		...(i.phone ? { phone: i.phone } : {}),
	});
	const duplicates =
		hints.status === "ok"
			? hints.value.items.map((h) => `${h.displayName} (${h.match === "exact" ? "same email or phone" : "same name"})`)
			: [];
	return {
		target: meetingTarget(m),
		args: {
			input: { meetingId: m.id, displayName: i.displayName, email: i.email ?? null, phone: i.phone ?? null, ...extra },
		},
		facts: { m, duplicates },
	} satisfies Prepared<ContactFacts>;
}
type ContactResult = z.infer<typeof c.guestContactResult>;
const contactChanges = (
	{ prepared, value: v }: { prepared: Prepared<ContactFacts>; value: ContactResult },
	attendance: string,
) => {
	const input = prepared.args.input as { displayName: string; email: string | null; phone: string | null };
	return [
		created("newPerson", v.guest.person.displayName),
		...(input.email ? [created("email", input.email)] : []),
		...(input.phone ? [created("phone", input.phone)] : []),
		created("stage", "prospect"),
		created("attendance", attendance),
		created(
			"possibleDuplicates",
			prepared.facts.duplicates.length ? prepared.facts.duplicates : "None found in People",
		),
	];
};
const contactAsked = ({ prepared }: { prepared: Prepared<ContactFacts> }) => [
	created("newPerson", (prepared.args.input as { displayName: string }).displayName),
];

export const createGuestContact = write({
	operation: "meetings.createGuestContact",
	description:
		"Add a new person to People and to a meeting's guest list.",
	input: z.strictObject({ ...contactInput, attended: z.boolean().optional() }),
	prepare: (db, actor, i) => onContact(db, actor, i, { attendance: i.attended ? "attended" : "not_recorded" }),
	run: (w, tx, ctx, r) => w.guests.createGuestContact(tx, ctx, r),
	changes: (p: { prepared: Prepared<ContactFacts>; value: ContactResult }) =>
		contactChanges(p, (p.prepared.args.input as { attendance: string }).attendance === "attended" ? "attended" : "not recorded"),
	asked: (p) => contactAsked({ prepared: p }),
	revision: guestRevision,
});

export const createWalkInContact = write({
	operation: "meetings.createWalkInContact",
	description:
		"Record a walk-in: a new person in People who attended this meeting. Use only the name and contact given.",
	input: z.strictObject(contactInput),
	prepare: (db, actor, i) => onContact(db, actor, i),
	run: (w, tx, ctx, r) => w.guests.createWalkInContact(tx, ctx, r),
	changes: (p: { prepared: Prepared<ContactFacts>; value: ContactResult }) => contactChanges(p, "attended (walk-in)"),
	asked: (p) => contactAsked({ prepared: p }),
	revision: guestRevision,
});

const CARD = c.cardResponse;
export const recordCard = write({
	operation: "meetings.recordCard",
	description: "Record a guest's response card.",
	input: z.strictObject({ meetingId, personId, response: CARD, notes: z.string().trim().max(2000).optional() }),
	prepare: (db, actor, i) =>
		onGuest(db, actor, i.meetingId, i.personId, { response: i.response, notes: i.notes ?? null }),
	run: (w, tx, ctx, r) => w.guests.recordCard(tx, ctx, r),
	changes: ({ prepared, value: v }: { prepared: Prepared<Guest>; value: z.infer<typeof c.cardMutationResult> }) => [
		created("guest", prepared.facts.person.displayName),
		created("card", v.card?.response.replaceAll("_", " ") ?? null),
		...(v.card?.notes ? [created("cardNote", v.card.notes)] : []),
	],
	revision: (v) => v.card?.revision ?? "1",
});

export const clearCard = write({
	operation: "meetings.clearCard",
	description: "Clear a guest's response card, with the reason.",
	input: z.strictObject({ meetingId, personId, reason }),
	prepare: (db, actor, i) => onGuest(db, actor, i.meetingId, i.personId, { reason: i.reason }),
	run: (w, tx, ctx, r) => w.guests.clearCard(tx, ctx, r),
	changes: ({ prepared }: { prepared: Prepared<Guest>; value: z.infer<typeof c.cardMutationResult> }) => [
		created("guest", prepared.facts.person.displayName),
		change("card", "Recorded", "Cleared"),
		created("reason", (prepared.args.input as { reason: string }).reason),
	],
	revision: () => "1",
});

export const copyTeamRoster = write({
	operation: "meetings.copyTeamRoster",
	description:
		"Update a team meeting's guests from its ministry.",
	input: z.strictObject({ meetingId }),
	async prepare(db, actor, i) {
		const m = await meeting(db, actor, i.meetingId);
		const p = m && value(await rosterReader.previewRosterImport(db, actor.authority, i));
		if (!m || !p) return null;
		return {
			target: meetingTarget(m),
			args: {
				input: { meetingId: m.id, add: p.add.map((x) => x.personId), remove: p.remove.map((x) => x.personId) },
			},
			facts: p,
		};
	},
	run: (w, tx, ctx, r) => w.roster.copyTeamRoster(tx, ctx, r),
	changes: ({ prepared }: { prepared: Prepared<z.infer<typeof c.rosterPreview>>; value: z.infer<typeof c.rosterUpdateResult> }) => [
		created("add", prepared.facts.add.map((x) => x.displayName)),
		created("remove", prepared.facts.remove.map((x) => x.displayName)),
	],
	revision: () => "1",
});

// --- Attendance ---------------------------------------------------------------------------------------------------

type AttendanceFacts = { m: Detail; list: z.infer<typeof c.attendanceList> };
async function attendanceFacts(db: Reader, actor: EvryActor, meetingId: string) {
	const m = await meeting(db, actor, meetingId);
	const list = m && value(await attendanceReader.listAttendance(db, actor.authority, { meetingId, limit: 500 }));
	return m && list ? { m, list } : null;
}
const nameIn = (f: AttendanceFacts, person: string) =>
	f.list.items.find((g) => g.person.personId === person)?.person.displayName ?? null;
const PRESENCE: Record<string, string> = { attended: "Attended", absent: "Absent", excused: "Excused" };
type AttendanceResult = z.infer<typeof c.attendanceMutationResult>;
const presenceChanges = ({ prepared, value: v }: { prepared: Prepared<AttendanceFacts>; value: AttendanceResult }) =>
	v.attendees.map((a) => {
		const before = prepared.facts.list.items.find((g) => g.person.personId === a.person.personId);
		return change(`presence:${a.person.displayName}`, before ? PRESENCE[before.presence] : "Not a guest yet", PRESENCE[a.presence]);
	});
const attendanceRevisionOf = (v: { attendanceRevision: string }) => v.attendanceRevision;
async function onAttendance(db: Reader, actor: EvryActor, meetingId: string, input: object) {
	const f = await attendanceFacts(db, actor, meetingId);
	if (!f) return null;
	return { target: meetingTarget(f.m), args: { input: { meetingId: f.m.id, ...input } }, facts: f };
}

export const setAttendance = write({
	operation: "meetings.setAttendance",
	description: "Set one guest's presence.",
	input: z.strictObject({ meetingId, personId, presence: c.presence }),
	member: true,
	prepare: (db, actor, i) => onAttendance(db, actor, i.meetingId, { personId: i.personId, presence: i.presence }),
	run: (w, tx, ctx, r) => w.attendance.setAttendance(tx, ctx, r),
	changes: presenceChanges,
	revision: attendanceRevisionOf,
});
export const checkIn = write({
	operation: "meetings.checkIn",
	description: "Check a person in People in as attended.",
	input: z.strictObject({ meetingId, personId }),
	member: true,
	prepare: (db, actor, i) => onAttendance(db, actor, i.meetingId, { personId: i.personId }),
	run: (w, tx, ctx, r) => w.attendance.checkIn(tx, ctx, r),
	changes: presenceChanges,
	revision: attendanceRevisionOf,
});
export const clearAttendance = write({
	operation: "meetings.clearAttendance",
	description: "Set a guest back to absent.",
	input: z.strictObject({ meetingId, personId }),
	member: true,
	prepare: (db, actor, i) => onAttendance(db, actor, i.meetingId, { personId: i.personId }),
	run: (w, tx, ctx, r) => w.attendance.clearAttendance(tx, ctx, r),
	changes: presenceChanges,
	revision: attendanceRevisionOf,
});
export const captureAttendanceBatch = write({
	operation: "meetings.captureAttendanceBatch",
	description: "Set several guests' presence at once.",
	input: z.strictObject({
		meetingId,
		entries: z.array(z.strictObject({ personId, presence: c.presence })).min(1).max(500),
	}),
	member: true,
	prepare: (db, actor, i) => onAttendance(db, actor, i.meetingId, { entries: i.entries }),
	run: (w, tx, ctx, r) => w.attendance.captureAttendanceBatch(tx, ctx, r),
	changes: presenceChanges,
	revision: attendanceRevisionOf,
});

type Finalization = z.infer<typeof c.finalizationResult>;
const STAGE: Record<string, string> = {
	prospect: "Prospect",
	attendee: "Attendee",
	core_group: "Core group",
	launch_team: "Launch team",
	leader: "Leader",
};
/** Each generated task as Tasks will list it: its title and who owns it. */
async function generatedTasks(tx: Transaction, v: Finalization) {
	const ids = v.work.flatMap((w) => (w.taskId && w.outcome === "created" ? [w.taskId] : []));
	if (!ids.length) return [];
	const r = await tx.execute(
		sql`SELECT id,title FROM task WHERE id=ANY(${sql.param(ids)}::uuid[]) ORDER BY array_position(${sql.param(ids)}::uuid[],id)`,
	);
	const titles = new Map(z.array(z.object({ id: z.string(), title: z.string() })).parse(r.rows).map((t) => [t.id, t.title]));
	return v.work.flatMap((w) =>
		w.taskId && titles.has(w.taskId)
			? [`${titles.get(w.taskId)}${w.needsOwner ? " (needs an owner)" : ""}`]
			: [],
	);
}
/** The finalize or correction card: every attendance mark, stage advance and task it creates. */
function settlementChanges({
	prepared,
	value: v,
	seen,
}: {
	prepared: Prepared<AttendanceFacts>;
	value: Finalization;
	seen: unknown;
}): Change[] {
	const names = new Map(v.attendees.map((a) => [a.person.personId as string, a.person.displayName]));
	for (const g of prepared.facts.list.items) names.set(g.person.personId, g.person.displayName);
	const name = (p: string) => names.get(p) ?? "A person";
	const first = new Set(v.classifications.filter((x) => x.firstVision).map((x) => x.personId as string));
	return [
		created(
			"attended",
			v.attendeeIds.map((p) => `${name(p)}${first.has(p) && prepared.facts.m.type === "vision_meeting" ? " (first Vision)" : ""}`),
		),
		...(v.removed.length ? [created("noLongerAttended", v.removed.map(name))] : []),
		...(v.stageChanges.length
			? [created("stage", v.stageChanges.map((x) => `${name(x.personId)}: ${STAGE[x.from]} → ${STAGE[x.to]}`))]
			: []),
		created("tasks", (seen as string[]).length ? seen : "No new tasks"),
		created("finalized", "Attendance is final once approved"),
	];
}
export const finalizeAttendance = write({
	operation: "meetings.finalizeAttendance",
	description:
		"Finalize attendance: attendeeIds is everyone who attended, marked yet or not. The review lists the tasks it creates.",
	input: z.strictObject({ meetingId, attendeeIds: z.array(personId).max(500) }),
	member: true,
	async prepare(db, actor, i) {
		const f = await attendanceFacts(db, actor, i.meetingId);
		if (!f) return null;
		return {
			target: meetingTarget(f.m),
			args: { expectedRevision: f.list.attendanceRevision, input: { meetingId: f.m.id, attendeeIds: i.attendeeIds } },
			facts: f,
		};
	},
	run: (w, tx, ctx, r) => w.attendance.finalizeAttendance(tx, ctx, r),
	inspect: generatedTasks,
	changes: settlementChanges,
	asked: ({ facts, args }) => [
		created(
			"attended",
			((args.input as { attendeeIds: string[] }).attendeeIds ?? []).map((p) => nameIn(facts, p) ?? "A person"),
		),
	],
	revision: attendanceRevisionOf,
});
export const reconcileAttendance = write({
	operation: "meetings.reconcileAttendance",
	description:
		"Correct a finalized meeting's attendance: the full corrected set and the reason.",
	input: z.strictObject({
		meetingId,
		attendeeIds: z.array(personId).max(500),
		reason: z.string().trim().min(1).max(500),
	}),
	member: true,
	async prepare(db, actor, i) {
		const f = await attendanceFacts(db, actor, i.meetingId);
		if (!f) return null;
		return {
			target: meetingTarget(f.m),
			args: {
				expectedRevision: f.list.attendanceRevision,
				input: { meetingId: f.m.id, attendeeIds: i.attendeeIds, reason: i.reason },
			},
			facts: f,
		};
	},
	run: (w, tx, ctx, r) => w.attendance.reconcileAttendance(tx, ctx, r),
	inspect: generatedTasks,
	changes: (p: { prepared: Prepared<AttendanceFacts>; value: Finalization; seen: unknown }) => [
		...settlementChanges(p).filter((x) => x.field !== "finalized"),
		created("reason", (p.prepared.args.input as { reason: string }).reason),
	],
	revision: attendanceRevisionOf,
});

const score = z.int().min(1).max(5);
const scoresInput = z.strictObject(
	Object.fromEntries(c.evaluationFactors.map((f) => [f, score])) as Record<(typeof c.evaluationFactors)[number], typeof score>,
);
export const recordEvaluation = write({
	operation: "meetings.recordEvaluation",
	description:
		"Record the planter's own 1-5 scores for a finalized Vision meeting, exactly as given. Never score it yourself.",
	input: z.strictObject({ meetingId, scores: scoresInput, notes: z.string().trim().min(1).max(5000).optional() }),
	async prepare(db, actor, i) {
		const m = await meeting(db, actor, i.meetingId);
		if (!m) return null;
		return {
			target: meetingTarget(m),
			args: { input: { meetingId: m.id, scores: i.scores, notes: i.notes ?? null } },
			facts: m,
		};
	},
	run: (w, tx, ctx, r) => w.attendance.recordEvaluation(tx, ctx, r),
	changes: ({ value: v }: { value: z.infer<typeof c.evaluationMutationResult> }) => [
		...c.evaluationFactors.map((f) => created(f, String(v.evaluation.scores[f]))),
		created("average", String(v.evaluation.average)),
		...(v.evaluation.notes ? [created("notes", v.evaluation.notes)] : []),
		...(v.taskCompleted ? [created("tasks", ["The meeting's evaluation task is marked complete"])] : []),
	],
	asked: ({ args }) =>
		Object.entries((args.input as { scores: Record<string, number> }).scores).map(([f, n]) => created(f, String(n))),
	revision: (v) => v.evaluation.revision,
});
export const correctEvaluation = write({
	operation: "meetings.correctEvaluation",
	description: "Correct recorded scores as the planter gives them, with the reason.",
	input: z.strictObject({
		meetingId,
		changes: scoresInput.partial(),
		notes: z.string().trim().min(1).max(5000).nullable().optional(),
		reason: z.string().trim().min(1).max(500),
	}),
	async prepare(db, actor, i) {
		const m = await meeting(db, actor, i.meetingId);
		const e = m && value(await attendanceReader.getEvaluation(db, actor.authority, { meetingId: i.meetingId }));
		if (!m || e?.status !== "available") return null;
		return {
			target: meetingTarget(m),
			args: {
				expectedRevision: e.evaluation.revision,
				input: {
					meetingId: m.id,
					changes: i.changes,
					...(i.notes !== undefined ? { notes: i.notes } : {}),
					reason: i.reason,
				},
			},
			facts: e.evaluation,
		};
	},
	run: (w, tx, ctx, r) => w.attendance.correctEvaluation(tx, ctx, r),
	changes: ({ prepared, value: v }: { prepared: Prepared<z.infer<typeof c.evaluation>>; value: z.infer<typeof c.evaluationMutationResult> }) => [
		...c.evaluationFactors
			.filter((f) => prepared.facts.scores[f] !== v.evaluation.scores[f])
			.map((f) => change(f, String(prepared.facts.scores[f]), String(v.evaluation.scores[f]))),
		change("average", String(prepared.facts.average), String(v.evaluation.average)),
		created("reason", (prepared.args.input as { reason: string }).reason),
	],
	revision: (v) => v.evaluation.revision,
});

export const addAttendeeNote = write({
	operation: "meetings.addAttendeeNote",
	description: "Add a note about an attendee.",
	input: z.strictObject({ meetingId, personId, text: z.string().trim().min(1).max(5000) }),
	async prepare(db, actor, i) {
		const f = await guestFacts(db, actor, i.meetingId);
		if (!f) return null;
		return {
			target: meetingTarget(f.m),
			args: { input: { meetingId: f.m.id, personId: i.personId, text: i.text } },
			facts: guestOf(f, i.personId)?.person.displayName ?? null,
		};
	},
	run: (w, tx, ctx, r) => w.attendance.addAttendeeNote(tx, ctx, r),
	changes: ({ prepared, value: v }: { prepared: Prepared<string | null>; value: z.infer<typeof c.attendeeNoteResult> }) => [
		created("person", prepared.facts),
		created("note", v.text),
	],
	revision: () => "1",
});

// --- Venues -------------------------------------------------------------------------------------------------------

const venueFields = {
	name: z.string().trim().min(1).max(120),
	address: z.string().trim().min(1).max(500),
	capacity: z.int().min(1).max(100_000).nullable(),
	costDescription: z.string().trim().max(500).nullable(),
	notes: z.string().trim().max(2000).nullable(),
};
const venuePatch = z.strictObject(venueFields).partial();
type Venue = z.infer<typeof c.venue>;
const VENUE_FIELDS = ["name", "address", "capacity", "costDescription", "notes", "active"] as const;
const venueShown = (v: Venue) => ({ ...v, capacity: v.capacity === null ? null : String(v.capacity), active: v.active ? "Active" : "Archived" });
const venueDiff = (before: Venue | null, after: Venue) => {
	const a = before ? venueShown(before) : null,
		b = venueShown(after);
	return VENUE_FIELDS.filter((k) => (a ? a[k] !== b[k] : b[k] !== null && k !== "active")).map((k) =>
		change(k, a?.[k], b[k]),
	);
};
const venueTarget = (v: Venue): Target => ({ kind: "venue", id: v.id, label: v.name });
async function onVenue(db: Reader, actor: EvryActor, venue: string, input: object = {}) {
	const v = value(await venuesReader.get(db, actor.authority, { venueId: venue }));
	if (v?.status !== "available") return null;
	return {
		target: venueTarget(v.venue),
		args: { expectedRevision: v.venue.revision, input: { venueId: v.venue.id, ...input } },
		facts: v.venue,
	};
}
type VenueResult = z.infer<typeof c.venueMutationResult>;
const venueChanges = ({ prepared, value: v }: { prepared: Prepared<Venue>; value: VenueResult }) =>
	venueDiff(prepared.facts, v.venue);
const venueRevision = (v: VenueResult) => v.venue.revision;

export const createVenue = write({
	operation: "venues.create",
	description: "Save a new venue.",
	input: z.strictObject({
		...venueFields,
		capacity: venueFields.capacity.optional(),
		costDescription: venueFields.costDescription.optional(),
		notes: venueFields.notes.optional(),
	}),
	async prepare(_db, _actor, i) {
		return { target: null, args: { input: { ...i } }, facts: null };
	},
	run: (w, tx, ctx, r) => w.venues.create(tx, ctx, r),
	changes: ({ value: v }: { value: VenueResult }) => venueDiff(null, v.venue),
	revision: venueRevision,
});
export const editVenue = write({
	operation: "venues.edit",
	description: "Change a saved venue.",
	input: z.strictObject({ venueId, patch: venuePatch }),
	prepare: (db, actor, i) => onVenue(db, actor, i.venueId, { patch: i.patch }),
	run: (w, tx, ctx, r) => w.venues.edit(tx, ctx, r),
	changes: venueChanges,
	revision: venueRevision,
});
export const correctVenue = write({
	operation: "venues.correct",
	description: "Correct a saved venue, with the reason.",
	input: z.strictObject({ venueId, patch: venuePatch, reason }),
	prepare: (db, actor, i) => onVenue(db, actor, i.venueId, { patch: i.patch, reason: i.reason }),
	run: (w, tx, ctx, r) => w.venues.correct(tx, ctx, r),
	changes: (p: { prepared: Prepared<Venue>; value: VenueResult }) => [
		...venueChanges(p),
		created("reason", (p.prepared.args.input as { reason: string }).reason),
	],
	revision: venueRevision,
});
export const archiveVenue = write({
	operation: "venues.archive",
	description: "Archive a saved venue.",
	input: z.strictObject({ venueId, reason: reason.optional() }),
	prepare: (db, actor, i) => onVenue(db, actor, i.venueId, i.reason ? { reason: i.reason } : {}),
	run: (w, tx, ctx, r) => w.venues.archive(tx, ctx, r),
	changes: venueChanges,
	revision: venueRevision,
});
export const restoreVenue = write({
	operation: "venues.restore",
	description: "Restore an archived venue.",
	input: z.strictObject({ venueId }),
	prepare: (db, actor, i) => onVenue(db, actor, i.venueId),
	run: (w, tx, ctx, r) => w.venues.restore(tx, ctx, r),
	changes: venueChanges,
	revision: venueRevision,
});

/** The installed Meetings reviewed writes, keyed by operation. */
export const MEETINGS_COMMANDS = {
	"meetings.schedule": schedule,
	"meetings.edit": edit,
	"meetings.changeStatus": changeStatus,
	"meetings.delete": deleteMeeting,
	"meetings.completePractice": completePractice,
	"meetings.correctPracticeOccurrence": correctPracticeOccurrence,
	"meetings.correctOccurrence": correctOccurrence,
	"meetings.replaceAgenda": replaceAgenda,
	"meetings.populateKit": populateKit,
	"meetings.updateKitItem": updateKitItem,
	"meetings.inviteGuest": inviteGuest,
	"meetings.removeGuest": removeGuest,
	"meetings.setInviter": setInviter,
	"meetings.correctRsvp": correctRsvp,
	"meetings.saveOwnRsvp": saveOwnRsvp,
	"meetings.createGuestContact": createGuestContact,
	"meetings.createWalkInContact": createWalkInContact,
	"meetings.recordCard": recordCard,
	"meetings.clearCard": clearCard,
	"meetings.copyTeamRoster": copyTeamRoster,
	"meetings.setAttendance": setAttendance,
	"meetings.checkIn": checkIn,
	"meetings.clearAttendance": clearAttendance,
	"meetings.captureAttendanceBatch": captureAttendanceBatch,
	"meetings.finalizeAttendance": finalizeAttendance,
	"meetings.reconcileAttendance": reconcileAttendance,
	"meetings.recordEvaluation": recordEvaluation,
	"meetings.correctEvaluation": correctEvaluation,
	"meetings.addAttendeeNote": addAttendeeNote,
	"venues.create": createVenue,
	"venues.edit": editVenue,
	"venues.correct": correctVenue,
	"venues.archive": archiveVenue,
	"venues.restore": restoreVenue,
} as const;
