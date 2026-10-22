import type * as tc from "@everyfield/contracts/tasks";
import type { z } from "zod";
import type { Account, ContactHistory, HandoffPlan, Outcome } from "./model.ts";
import type { CallRead, PersonFollowUps } from "./server.ts";

// The browser side of read.ts. A network failure or a server error reads as lost, so the screen can offer a retry.
async function get<T>(params: Record<string, string>): Promise<Outcome<T>> {
	try {
		const r = await fetch(`/follow-ups/read?${new URLSearchParams(params)}`, { cache: "no-store" });
		return r.ok ? ((await r.json()) as Outcome<T>) : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}

export const loadHistory = (person: string, page: number) =>
	get<ContactHistory>({ what: "history", person, page: String(page) });
export const loadPersonFollowUps = (person: string) => get<PersonFollowUps>({ what: "person", person });
export const loadCall = (id: string) => get<CallRead>({ what: "call", id });
export const loadPlan = (from: string) => get<HandoffPlan>({ what: "plan", from });
export const loadSeats = () => get<z.infer<typeof tc.assigneeOptions>>({ what: "seats" });

/**
 * The eligible owners, read once per page on the first sign of intent (a pointer over, a touch on or keyboard focus
 * reaching an Assign control), so the list is there when the menu opens (C76). A copy older than 30 seconds or a failed
 * read is read again on the next intent.
 */
let owners: { at: number; list: Promise<Outcome<Account[]>> } | null = null;
const OWNERS_FRESH_MS = 30_000;
export function prefetchOwners(): Promise<Outcome<Account[]>> {
	if (!owners || Date.now() - owners.at > OWNERS_FRESH_MS) {
		const list = get<Account[]>({ what: "owners" }).then((r) => {
			if (r.status !== "ok") owners = null;
			return r;
		});
		owners = { at: Date.now(), list };
	}
	return owners.list;
}
/** After a save names an owner as not eligible, the next read asks again. */
export function forgetOwners() {
	owners = null;
}
