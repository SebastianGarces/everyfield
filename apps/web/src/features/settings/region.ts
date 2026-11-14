"use server";

import { requestDatabase } from "@/server/database";
import { command, current } from "@/server/organizations";
import { getViewer } from "@/server/request-context";
import { correctReportingLocationRequest } from "@everyfield/contracts/organizations";
import type { RegionArea } from "@everyfield/contracts/oversight";
import { readReportingLocation, suggestRegions } from "@everyfield/domain/organizations";
import { z } from "zod";

// The church settings' reporting Region (WP-047b, REQ-PI-044): the plant's reporting city, state and country, and the
// official OMB 23-01 metro or micro area its Owner or Admin picked for it. Suggestions come only from the official
// list; a save goes through organizations.correctReportingLocation, which accepts only an offered area and refuses a
// Member and every organization seat.

export type Locality = { city: string | null; stateProvince: string | null; country: string | null };
export type RegionRead =
	| {
			status: "ok";
			revision: string;
			canEdit: boolean;
			locality: Locality;
			region: RegionArea | null;
			/** The installed official list, or null when none is installed (the picker then says so). */
			referenceVersionId: string | null;
	  }
	| { status: "denied" }
	| { status: "lost" };
export type RegionSuggestion = { regionItemId: string; area: RegionArea };

async function plantSeat() {
	const v = await getViewer();
	const authority = v?.status === "active" ? v.authority : null;
	const context = authority?.actor.context;
	if (!authority || context?.kind !== "seat" || context.owner.kind !== "plant") return null;
	return { authority, plant: context.owner };
}

export async function readRegion(): Promise<RegionRead> {
	const seat = await plantSeat();
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
const locality = z.strictObject({ city: text, stateProvince: text, country: text });

export async function suggestRegion(raw: Locality): Promise<RegionSuggestion[] | null> {
	const seat = await plantSeat();
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

export type RegionSave = { status: "ok" } | { status: "conflict" } | { status: "refused"; code: string };
export async function saveRegion(input: {
	requestKey: string;
	expectedRevision: string;
	locality: Locality;
	referenceVersionId: string;
	regionItemId: string | null;
}): Promise<RegionSave> {
	const seat = await plantSeat();
	const m = current();
	const place = locality.safeParse(input.locality);
	if (!seat || !m) return { status: "refused", code: "unavailable" };
	if (!place.success) return { status: "refused", code: "invalid_input" };
	const request = correctReportingLocationRequest.safeParse({
		requestKey: input.requestKey,
		expectedRevision: input.expectedRevision,
		input: {
			plant: seat.plant,
			locality: place.data,
			referenceVersionId: input.referenceVersionId,
			regionItemId: input.regionItemId,
		},
	});
	if (!request.success) return { status: "refused", code: "invalid_input" };
	const reply = await command(m, seat.authority, seat.plant, (tx, session, selected) =>
		m.adapter["organizations.correctReportingLocation"](tx, session, selected, request.data),
	);
	if (reply.status === "ok") return { status: "ok" };
	return reply.code === "stale_revision" || reply.code === "conflict"
		? { status: "conflict" }
		: { status: "refused", code: reply.code };
}
