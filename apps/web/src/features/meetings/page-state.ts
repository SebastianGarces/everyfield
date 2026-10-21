import type * as c from "@everyfield/contracts/meetings";
import type { z } from "zod";
import type { Detail, Guest, Rsvp } from "./model.ts";
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
};
export type Change =
	| { kind: "own"; rsvp: Rsvp }
	| { kind: "guest"; guest: Guest }
	| { kind: "removeGuest"; guestId: string }
	| { kind: "card"; personId: string; card: CardEntry | null }
	| { kind: "agenda"; agenda: Detail["agenda"] };

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
	}
}
