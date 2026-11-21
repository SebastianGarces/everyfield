import "server-only";
import { redirect } from "next/navigation";
import type { RequestActor } from "@everyfield/domain/access";
import type { SitePath } from "@everyfield/contracts/identity";
import { getViewer, seatOf, type PlantSeat } from "./request-context.ts";

export function signIn(returnTo: SitePath): never {
	redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
}

export async function requireActor(returnTo: SitePath): Promise<RequestActor | null> {
	const v = await getViewer();
	if (v.status === "unauthenticated") signIn(returnTo);
	return v.authority;
}

export async function requireSeat(returnTo: SitePath): Promise<PlantSeat | null> {
	const v = await getViewer();
	if (v.status === "unauthenticated") signIn(returnTo);
	return seatOf(v);
}
