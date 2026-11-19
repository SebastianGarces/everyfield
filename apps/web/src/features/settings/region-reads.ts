import { requestDatabase } from "@/server/database";
import type { getViewer } from "@/server/request-context";
import { readReportingLocation, suggestRegions } from "@everyfield/domain/organizations";
import "server-only";
import { z } from "zod";
import type { RegionRead, RegionSuggestion } from "./region";

type Session = Awaited<ReturnType<typeof getViewer>>;

export function plantSeat(v: Session) {
	const authority = v?.status === "active" ? v.authority : null;
	const context = authority?.actor.context;
	if (!authority || context?.kind !== "seat" || context.owner.kind !== "plant") return null;
	return { authority, plant: context.owner };
}

export async function readRegion(session: Session): Promise<RegionRead> {
	const seat = plantSeat(session);
	const db = requestDatabase();
	if (!seat) return { status: "denied" };
	if (!db) return { status: "lost" };
	try {
		const r = await readReportingLocation(db, seat.authority);
		return r ? { status: "ok", ...r } : { status: "denied" };
	} catch (error) {
		console.error(JSON.stringify({ component: "settings", outcome: "region_read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

const text = z
	.string()
	.trim()
	.max(200)
	.nullable()
	.transform((v) => v || null);
export const locality = z.strictObject({ city: text, stateProvince: text, country: text });

export async function suggestRegion(session: Session, raw: unknown): Promise<RegionSuggestion[] | null> {
	const seat = plantSeat(session);
	const db = requestDatabase();
	const place = locality.safeParse(raw);
	if (!seat || !db || !place.success) return null;
	try {
		return await suggestRegions(db, seat.authority, place.data);
	} catch (error) {
		console.error(JSON.stringify({ component: "settings", outcome: "region_suggest_failed", error: String(error) }));
		return null;
	}
}
