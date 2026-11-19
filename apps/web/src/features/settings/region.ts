"use server";

import { command, current } from "../organizations/mount";
import { correctReportingLocationRequest } from "@everyfield/contracts/organizations";
import type { RegionArea } from "@everyfield/contracts/oversight";
import { getViewer } from "@/server/request-context";
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
export async function saveRegion(input: {
	requestKey: string;
	expectedRevision: string;
	locality: Locality;
	referenceVersionId: string;
	regionItemId: string | null;
}): Promise<RegionSave> {
	const seat = plantSeat(await getViewer());
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
