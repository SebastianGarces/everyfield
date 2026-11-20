import type * as c from "@everyfield/contracts/followups";
import type { z } from "zod";
import type { Outcome } from "@everyfield/contracts/common";
import type { Account, ContactHistory, Coverage, HandoffPlan, ObligationPage, Owners } from "./model.ts";
import type { CallRead, PersonFollowUps } from "./server.ts";
import { readsFrom, type ReadFailure } from "../../components/get-reads.ts";
import { createRead } from "../../components/read.tsx";
import { assigneeOptions } from "../tasks/fetch.ts";
import type { GET } from "./read.ts";

const get = readsFrom<typeof GET>("/follow-ups/read");

export const loadHistory = (
	personId: string,
	page: number,
	taskId?: string,
): Promise<Outcome<ContactHistory> | ReadFailure> => get("history", { personId, page, ...(taskId ? { taskId } : {}) });
export const loadMeetingFollowUps = (meetingId: string): Promise<Outcome<ObligationPage> | ReadFailure> =>
	get("obligations", { meetingId, page: 1 });
export const loadPersonFollowUps = (personId: string): Promise<Outcome<PersonFollowUps> | ReadFailure> =>
	get("person", { personId });
export const loadDuties = (personId: string, page: number): Promise<Outcome<Owners> | ReadFailure> =>
	get("duties", { personId, page });
export const loadObligations = (personId: string, page: number): Promise<Outcome<ObligationPage> | ReadFailure> =>
	get("obligations", { personId, page });
export const loadCoverage = (
	coverage: z.input<typeof c.followUpCoverageRequest>["coverage"],
	page: number,
): Promise<Outcome<Coverage> | ReadFailure> => get("coverage", { coverage, page });
export const loadCall = (id: string): Promise<Outcome<CallRead> | ReadFailure> => get("call", id);
export const loadPlan = (fromAccountId: string): Promise<Outcome<HandoffPlan> | ReadFailure> =>
	get("plan", { fromAccountId });

const lost = () => ({ status: "lost" }) as const;
export const ownerList = createRead((): Promise<Outcome<Account[]> | ReadFailure> => get("owners"), {
	failed: lost,
	fresh: 30_000,
});
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
