import type { meetingSummary } from "@everyfield/contracts/meetings";
import type { MeetingsReply } from "@everyfield/contracts/meetings";
import type { Transaction } from "@everyfield/db/client";
import { meetingsReader } from "@everyfield/domain/meetings";
import { z } from "zod";
import type { EvryActor } from "../../context/actor.ts";
import { EvryRefusal } from "../../context/errors.ts";
import type { SourceRow } from "../../catalog/types.ts";

// What the meetings reads and reviewed writes share: who may use them, the short id schema and the one meeting row.

/**
 * An id from an earlier result, as the meetings tools take it. Its pattern and name are all it says, on purpose: every
 * tool schema reaches the model on every call, and z.uuid()'s pattern alone is about 170 characters. The native
 * request parses the exact uuid before any statement runs.
 */
export const id = z.string().regex(/^[0-9a-f-]{36}$/);
export const meetingId = id;
export const personId = id;
export const venueId = id;
/** A church-local date. */
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Any current seat of the selected church: Meetings reads are open to Members (REQ-MTG-001). */
export const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
/** The Owner or Admin of the selected church: the native floor of every report and most meeting changes. */
export const ownerOrAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");

/** A native read's value, or the refusal Evry shows. A missing, foreign or hidden record reads as not found. */
export function value<T>(reply: MeetingsReply<T>): T | null {
	if (reply.status === "ok") return reply.value;
	if (reply.error.code === "invalid_input") throw new EvryRefusal("invalid_input");
	if (reply.error.code === "unavailable") return null;
	throw new EvryRefusal("source_unavailable");
}

/** A meeting's detail through the native get, or null when it is missing, foreign or hidden. */
export async function meeting(db: Pick<Transaction, "execute">, actor: EvryActor, meetingId: string) {
	const m = value(await meetingsReader.get(db, actor.authority, { meetingId }));
	return m?.status === "available" ? m.meeting : null;
}

const part = (at: Date, zone: string, options: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat("en-US", { ...options, timeZone: zone }).format(at);
/** "Thu, Oct 15, 2026, 7:00 PM CDT": the church-local date, time and zone of an instant. */
export function localWhen(instant: string, zone: string) {
	const at = new Date(instant);
	return `${part(at, zone, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}, ${part(at, zone, {
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	})}`;
}

export const TYPE_LABEL: Record<string, string> = {
	vision_meeting: "Vision meeting",
	orientation: "Orientation",
	team_meeting: "Team meeting",
	prelaunch_practice: "Pre-launch practice",
};
/** RSVP in the words a planter uses. An RSVP is an answer to the invitation, never attendance. */
export const RSVP: Record<string, string> = { confirmed: "yes", declined: "no", pending: "no answer" };

type Summary = z.infer<typeof meetingSummary>;
/** The one meeting row: its church-local date, time and zone, venue, status and RSVP counts. */
export function meetingRow(m: Summary, extra: Record<string, string | boolean | null> = {}): SourceRow {
	return {
		kind: "meeting",
		id: m.id,
		label: m.displayTitle,
		fields: {
			type: m.type,
			status: m.status,
			when: localWhen(m.startsAt, m.zone),
			date: m.localDate,
			time: m.localTime,
			zone: m.zone,
			venue: m.venue?.name ?? null,
			team: m.team?.name ?? null,
			guests: String(m.guestCount),
			rsvpYes: String(m.confirmedCount),
			...extra,
		},
	};
}
