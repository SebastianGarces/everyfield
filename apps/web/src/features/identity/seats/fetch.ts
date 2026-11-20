import { readsFrom } from "../../../components/get-reads.ts";
import type { GET } from "./read.ts";
import { FailedRead } from "../../../components/read-failed.ts";

const get = readsFrom<typeof GET>("/settings/seats/read");

async function answered<T>(read: Promise<T>): Promise<Exclude<T, { status: "lost" } | { status: "failed" }>> {
	const r = await read;
	if (typeof r === "object" && r !== null && "status" in r && r.status === "failed") throw new FailedRead("seats");
	if (typeof r === "object" && r !== null && "status" in r && r.status === "lost") throw new Error("seats read lost");
	return r as Exclude<T, { status: "lost" } | { status: "failed" }>;
}

export async function readSeats() {
	const r = await answered(get("seats"));
	return r.status === "refused" ? ({ status: "unavailable" } as const) : r;
}
export const readSeatsPage = (list: "seats" | "invitations", after: string) => answered(get("page", { list, after }));
export const readRemovalReview = (seatId: string) => answered(get("removal", { seatId }));
