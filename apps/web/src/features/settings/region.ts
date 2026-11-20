"use server";

import { command, current } from "../organizations/mount";
import { correctReportingLocationRequest } from "@everyfield/contracts/organizations";
import type { RegionArea } from "@everyfield/contracts/oversight";
import { getViewer } from "@/server/request-context";
import { z } from "zod";
import { locality, plantSeat } from "./region-reads";

export type Locality = { city: string | null; stateProvince: string | null; country: string | null };
export type RegionRead =
	| {
			status: "ok";
			revision: string;
			canEdit: boolean;
			locality: Locality;
			region: RegionArea | null;
			referenceVersionId: string | null;
	  }
	| { status: "denied" }
	| { status: "lost" };
export type RegionSuggestion = { regionItemId: string; area: RegionArea };

export type RegionSave = { status: "ok" } | { status: "conflict" } | { status: "refused"; code: string };
const regionSave = z.object({
	requestKey: z.unknown(),
	expectedRevision: z.unknown(),
	locality,
	referenceVersionId: z.unknown(),
	regionItemId: z.unknown(),
});

export async function saveRegion(raw: unknown): Promise<RegionSave> {
	const seat = plantSeat(await getViewer());
	const input = regionSave.safeParse(raw);
	if (!seat) return { status: "refused", code: "unavailable" };
	if (!input.success) return { status: "refused", code: "invalid_input" };
	const { locality: place, ...rest } = input.data;
	const m = current();
	const request = correctReportingLocationRequest.safeParse({
		requestKey: rest.requestKey,
		expectedRevision: rest.expectedRevision,
		input: {
			plant: seat.plant,
			locality: place,
			referenceVersionId: rest.referenceVersionId,
			regionItemId: rest.regionItemId,
		},
	});
	if (!request.success) return { status: "refused", code: "invalid_input" };
	const reply = await command(m, seat.authority, seat.plant, (tx, session, selected) =>
		m.adapter["organizations.correctReportingLocation"](tx, session, selected, request.data),
	);
	if (reply.status === "ok") return { status: "ok" };
	return reply.code === "stale_revision" ? { status: "conflict" } : { status: "refused", code: reply.code };
}
