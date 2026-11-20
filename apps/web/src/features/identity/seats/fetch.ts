import { getReads } from "../../../components/get-reads.ts";
import type { GET } from "./read.ts";

const get = getReads<typeof GET>("/settings/seats/read");

async function answered<T>(read: Promise<T>): Promise<Exclude<T, { status: "lost" }>> {
	const r = await read;
	if (typeof r === "object" && r !== null && "status" in r && r.status === "lost") throw new Error("seats read lost");
	return r as Exclude<T, { status: "lost" }>;
}

export async function readSeats() {
	const r = await answered(get("seats"));
	return r.status === "refused" ? ({ status: "unavailable" } as const) : r;
}
export const readSeatsPage = (list: "seats" | "invitations", after: string) => answered(get("page", { list, after }));
export const readRemovalReview = (seatId: string) => answered(get("removal", { seatId }));
