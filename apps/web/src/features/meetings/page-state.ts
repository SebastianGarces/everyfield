import type * as c from "@everyfield/contracts/meetings";
import type { z } from "zod";
import type { Attendance, Attendee, Detail, Guest, Presence, Rsvp } from "./model.ts";
import type { MeetingPageData } from "./server.ts";

// The meeting page's optimistic changes. A write projects its change here at once; the page shows it in every place it
// appears (guest row, RSVP counts, own answer, card summary, agenda). When the write ends, the projection drops and
// the confirmed data (or the unchanged data after a failure) shows instead.

export type CardEntry = z.infer<typeof c.card>;
export type PageView = {
	guests: Guest[] | null;
	cards: CardEntry[] | null;
	own: MeetingPageData["own"];
	agenda: Detail["agenda"];
	attendance: Attendance | null;
};
export type Change =
	| { kind: "own"; rsvp: Rsvp }
	| { kind: "guest"; guest: Guest }
	| { kind: "removeGuest"; guestId: string }
	| { kind: "card"; personId: string; card: CardEntry | null }
	| { kind: "agenda"; agenda: Detail["agenda"] }
	| { kind: "presence"; personId: string; presence: Presence };

/** The guest list and the attendance list after a presence answer: each confirmed row and the new revision. */
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
/** A guest row as an attendance row before finalization: no classification yet. */
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

/** A guest row as the page knows it before the server answers: no link and no actions until it is saved. */
export const PENDING = "pending-";
export const isPending = (g: Pick<Guest, "id">) => g.id.startsWith(PENDING);

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
			const known = v.guests?.some((x) => x.id === g.id);
			return { ...v, guests: known ? v.guests!.map((x) => (x.id === g.id ? g : x)) : [...(v.guests ?? []), g] };
		}
		case "removeGuest":
			return { ...v, guests: v.guests?.filter((g) => g.id !== change.guestId) ?? null };
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
		case "presence":
			return {
				...v,
				guests:
					v.guests?.map((g) => (g.person.personId === change.personId ? { ...g, presence: change.presence } : g)) ??
					null,
				attendance: v.attendance && {
					...v.attendance,
					items: v.attendance.items.map((a) =>
						a.person.personId === change.personId ? { ...a, presence: change.presence } : a,
					),
				},
			};
	}
}
