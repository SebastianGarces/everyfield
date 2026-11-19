import { requestDatabase } from "@/server/database";
import type { getViewer } from "@/server/request-context";
import { readReportingLocation, suggestRegions } from "@everyfield/domain/organizations";
import "server-only";
import { z } from "zod";
import type { RegionRead, RegionSuggestion } from "./region";
import { LOST, transient } from "../../server/platform/transient.ts";

type Session = Awaited<ReturnType<typeof getViewer>>;

export function plantSeat(v: Session) {
	const authority = v.status === "active" ? v.authority : null;
	const context = authority?.actor.context;
	if (!authority || context?.kind !== "seat" || context.owner.kind !== "plant") return null;
	return { authority, plant: context.owner };
}

export async function readRegion(session: Session): Promise<RegionRead> {
	const seat = plantSeat(session);
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

export async function suggestRegion(session: Session, raw: unknown): Promise<RegionSuggestion[] | null> {
	const seat = plantSeat(session);
	const place = locality.safeParse(raw);
	if (!seat || !place.success) return null;
	const db = requestDatabase();
	return transient(
		{ component: "settings", outcome: "region_suggest_failed" },
		() => suggestRegions(db, seat.authority, place.data),
		null,
	);
}
