import "server-only";
import { redirect } from "next/navigation";
import { getViewer, seatOf, type PlantSeat } from "./request-context.ts";

export function signIn(returnTo: string): never {
	redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
}

export async function requireSeat(returnTo: string): Promise<PlantSeat | null> {
	const v = await getViewer();
	if (v.status === "unauthenticated") signIn(returnTo);
	return seatOf(v);
}
