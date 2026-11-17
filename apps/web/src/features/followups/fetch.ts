import type { Account, ContactHistory, Coverage, HandoffPlan, ObligationPage, Outcome, Owners } from "./model.ts";
import type { CallRead, PersonFollowUps } from "./server.ts";
import { createRead } from "../../components/read.tsx";
import { assigneeOptions } from "../tasks/fetch.ts";

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

const lost = () => ({ status: "lost" }) as const;
export const ownerList = createRead(() => get<Account[]>({ what: "owners" }), { failed: lost, fresh: 30_000 });
export const seatList = createRead(() => assigneeOptions(), { failed: lost, fresh: 30_000 });
export const prefetchOwners = () => ownerList.get();
export const forgetOwners = () => ownerList.forget();
export const seedOwners = (value: Account[]) => ownerList.seed({ status: "ok", value });
export const prefetchSeats = () => seatList.get();

export function warmOn(read: () => unknown) {
	return {
		onPointerEnter: (e: { pointerType: string }) => void (e.pointerType === "mouse" && read()),
		onTouchStart: () => void read(),
		onFocus: (e: { currentTarget: Element }) => void (e.currentTarget.matches(":focus-visible") && read()),
	};
}
