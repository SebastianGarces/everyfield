import type { Account, ContactHistory, Coverage, HandoffPlan, ObligationPage, Outcome, Owners } from "./model.ts";
import type { CallRead, PersonFollowUps } from "./server.ts";
import { createRead } from "../../components/read.tsx";
import { assigneeOptions } from "../tasks/fetch.ts";

// The browser side of read.ts. A network failure or a server error reads as lost, so the screen can offer a retry.
async function get<T>(params: Record<string, string>): Promise<Outcome<T>> {
	try {
		const r = await fetch(`/follow-ups/read?${new URLSearchParams(params)}`, { cache: "no-store" });
		return r.ok ? ((await r.json()) as Outcome<T>) : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}

export const loadHistory = (person: string, page: number, task?: string) =>
	get<ContactHistory>({ what: "history", person, page: String(page), ...(task ? { task } : {}) });
/** A meeting's follow-ups with their owners: what Correct attendance pre-fills "Follow-up calls go to" from. */
export const loadMeetingFollowUps = (meeting: string) =>
	get<ObligationPage>({ what: "obligations", meeting, page: "1" });
export const loadPersonFollowUps = (person: string) => get<PersonFollowUps>({ what: "person", person });
export const loadDuties = (person: string, page: number) => get<Owners>({ what: "duties", person, page: String(page) });
export const loadObligations = (person: string, page: number) =>
	get<ObligationPage>({ what: "obligations", person, page: String(page) });
export const loadCoverage = (show: string, page: number) =>
	get<Coverage>({ what: "coverage", show, page: String(page) });
export const loadCall = (id: string) => get<CallRead>({ what: "call", id });
export const loadPlan = (from: string) => get<HandoffPlan>({ what: "plan", from });

/**
 * The eligible owners and the seats a handoff can start from, read on the first sign of intent (a pointer over, a touch
 * on or keyboard focus reaching the control that needs them), so the list is there when the menu or dialog opens (C76).
 * One read is kept for 30 seconds and shared by every caller; a failed read is never reused, so the next intent retries.
 */
const lost = () => ({ status: "lost" }) as const;
export const ownerList = createRead(() => get<Account[]>({ what: "owners" }), { failed: lost, fresh: 30_000 });
export const seatList = createRead(() => assigneeOptions(), { failed: lost, fresh: 30_000 });
export const prefetchOwners = () => ownerList.get();
/** After a save names an owner as not eligible, or owners changed, the next read asks again. */
export const forgetOwners = () => ownerList.forget();
export const seedOwners = (value: Account[]) => ownerList.seed({ status: "ok", value });
export const prefetchSeats = () => seatList.get();

/** Intent handlers that warm `read` before a click: mouse hover, touch, or keyboard focus (not a mouse click's focus). */
export function warmOn(read: () => unknown) {
	return {
		onPointerEnter: (e: { pointerType: string }) => void (e.pointerType === "mouse" && read()),
		onTouchStart: () => void read(),
		onFocus: (e: { currentTarget: Element }) => void (e.currentTarget.matches(":focus-visible") && read()),
	};
}
