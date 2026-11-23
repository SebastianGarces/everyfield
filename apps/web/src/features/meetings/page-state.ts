import type * as c from "@everyfield/contracts/meetings";
import type { z } from "zod";
import type { Attendance, Attendee, Detail, Guest, Rsvp } from "./model.ts";
import type { MeetingPageData } from "./server.ts";

export type CardEntry = z.infer<typeof c.card>;

export const PENDING = "pending-";
export type PendingGuest = Omit<Guest, "id" | "revision" | "person" | "inviter"> & {
	id: `${typeof PENDING}${string}`;
	revision: null;
	person: { personId: string | null; displayName: string; state: "live" };
	inviter: { personId: string; displayName: string; state: "live" } | null;
};
export type GuestRow = Guest | PendingGuest;
export const isPending = (g: GuestRow): g is PendingGuest => g.revision === null;

export type PageView = {
	guests: GuestRow[] | null;
	cards: CardEntry[] | null;
	own: MeetingPageData["own"];
	agenda: Detail["agenda"];
	attendance: Attendance | null;
};
export type Change =
	| { kind: "own"; rsvp: Rsvp }
	| { kind: "guest"; guest: GuestRow }
	| { kind: "removeGuest"; guestId: string }
	| { kind: "roster"; add: PendingGuest[]; removePersonIds: string[] }
	| { kind: "card"; personId: string; card: CardEntry | null }
	| { kind: "agenda"; agenda: Detail["agenda"] };

export function withAttendees<V extends { guests: Guest[] | null; attendance: Attendance | null }>(
	v: V,
	attendees: Attendee[],
	attendanceRevision: string,
): V {
	const by = new Map(attendees.map((a) => [a.person.personId, a]));
	const known = new Set(v.attendance?.items.map((a) => a.person.personId));
	return {
		...v,
		guests:
			v.guests?.map((g) => {
				const a = by.get(g.person.personId);
				return a ? { ...g, presence: a.presence, revision: a.revision as Guest["revision"] } : g;
			}) ?? null,
		attendance: v.attendance && {
			...v.attendance,
			attendanceRevision: attendanceRevision as Attendance["attendanceRevision"],
			items: [
				...v.attendance.items.map((a) => by.get(a.person.personId) ?? a),
				...attendees.filter((a) => !known.has(a.person.personId)),
			],
		},
	};
}
export function withAttendanceRevision<V extends { attendance: Attendance | null }>(
	v: V,
	revision: string | undefined,
): V {
	return revision && v.attendance
		? { ...v, attendance: { ...v.attendance, attendanceRevision: revision as Attendance["attendanceRevision"] } }
		: v;
}
export const attendeeOf = (g: Guest): Attendee =>
	({
		guestId: g.id,
		revision: g.revision,
		person: g.person,
		presence: g.presence,
		rsvp: g.rsvp,
		hasCard: g.hasCard,
		classification: null,
		classificationStage: null,
		priorVisionId: null,
	}) as Attendee;

export function applyChange(v: PageView, change: Change): PageView {
	switch (change.kind) {
		case "own":
			return {
				...v,
				guests:
					v.guests?.map((g) =>
						g.id === v.own?.guestId ? { ...g, rsvp: change.rsvp, rsvpSource: "own" as const } : g,
					) ?? null,
				own: v.own ? { ...v.own, rsvp: change.rsvp } : null,
			};
		case "guest": {
			const g = change.guest;
			const guests = v.guests ?? [];
			const known = guests.some((x) => x.id === g.id);
			return { ...v, guests: known ? guests.map((x) => (x.id === g.id ? g : x)) : [...guests, g] };
		}
		case "removeGuest":
			return { ...v, guests: v.guests?.filter((g) => g.id !== change.guestId) ?? null };
		case "roster": {
			const gone = new Set(change.removePersonIds);
			return {
				...v,
				guests: v.guests && [
					...v.guests.filter((g) => !g.person.personId || !gone.has(g.person.personId)),
					...change.add,
				],
			};
		}
		case "card":
			return {
				...v,
				cards: [
					...(v.cards ?? []).filter((x) => x.personId !== change.personId),
					...(change.card ? [change.card] : []),
				],
			};
		case "agenda":
			return { ...v, agenda: change.agenda };
	}
}
