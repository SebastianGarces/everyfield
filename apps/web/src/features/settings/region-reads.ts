import { requestDatabase } from "@/server/database";
import { seatOf, type Viewer } from "@/server/request-context";
import { readReportingLocation, suggestRegions } from "@everyfield/domain/organizations";
import "server-only";
import { z } from "zod";
import type { RegionRead, RegionSuggestion } from "./region";
import { LOST, transient } from "../../server/platform/transient.ts";

export async function readRegion(session: Viewer): Promise<RegionRead> {
	const seat = seatOf(session);
	if (!seat) return { status: "denied" };
	const db = requestDatabase();
	return transient(
		{ component: "settings", outcome: "region_read_failed" },
		async () => {
			const r = await readReportingLocation(db, seat.authority);
			return r ? { status: "ok", ...r } : { status: "denied" };
		},
		LOST,
	);
}

const text = z
	.string()
	.trim()
	.max(200)
	.nullable()
	.transform((v) => v || null);
export const locality = z.strictObject({ city: text, stateProvince: text, country: text });

export async function suggestRegion(session: Viewer, raw: unknown): Promise<RegionSuggestion[] | null> {
	const seat = seatOf(session);
	const place = locality.safeParse(raw);
	if (!seat || !place.success) return null;
	const db = requestDatabase();
	return transient(
		{ component: "settings", outcome: "region_suggest_failed" },
		() => suggestRegions(db, seat.authority, place.data),
		null,
	);
}
