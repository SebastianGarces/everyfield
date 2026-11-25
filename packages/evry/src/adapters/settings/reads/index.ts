import { regionLabel } from "@everyfield/contracts/oversight";
import { readReportingLocation, suggestRegions } from "@everyfield/domain/organizations";
import { reportingLocality } from "@everyfield/contracts/organizations";
import type { WriteTx } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import { z } from "zod";
import type { ReadAdapter, SourceResult } from "../../../catalog/types.ts";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { plantAdmin } from "../../native.ts";

type Locality = { city: string | null; stateProvince: string | null; country: string | null };
export const placeText = (l: Locality) =>
	[l.city, l.stateProvince, l.country].filter(Boolean).join(", ") || "No location";
export const statedLocality = reportingLocality.partial();
type Stated = z.infer<typeof statedLocality>;

export async function regionCandidates(db: WriteTx | Database, actor: EvryActor, stated: Stated) {
	const saved = await readReportingLocation(db, actor.authority);
	if (!saved) throw new EvryRefusal("access_denied");
	const named = Object.keys(stated).length > 0;
	const locality: Locality = named
		? {
				city: stated.city ?? saved.locality.city,
				stateProvince: stated.stateProvince ?? (stated.city ? null : saved.locality.stateProvince),
				country: stated.country ?? saved.locality.country,
			}
		: saved.locality;
	const candidates = await suggestRegions(db, actor.authority, locality);
	if (!candidates) throw new EvryRefusal("access_denied");
	return { saved, locality, candidates };
}

export const listReportingRegionCandidates: ReadAdapter<Stated> = {
	operation: "geography.listReportingRegionCandidates",
	description:
		"The reporting Regions this church's place can have, as Settings > Church suggests them: for the place saved now, or for the city, state or province and country the user states. Each candidate row's id is its regionItemId. Facts give the place searched and the saved place and Region. No row means the official Region list has no Region for that place: say so plainly. More than one means the user has to choose. Owner or Admin",
	input: statedLocality,
	allowed: plantAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const { saved, locality, candidates } = await regionCandidates(tx, actor, input);
		return {
			operation: "geography.listReportingRegionCandidates",
			status: "available",
			rows: candidates.map((x) => ({
				kind: "item",
				id: x.regionItemId,
				label: regionLabel(x.area),
				fields: { region: regionLabel(x.area), saved: x.area.code === saved.region?.code },
			})),
			total: candidates.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: [],
			facts: {
				place: placeText(locality),
				city: locality.city,
				stateProvince: locality.stateProvince,
				country: locality.country,
				savedPlace: placeText(saved.locality),
				savedRegion: saved.region ? regionLabel(saved.region) : null,
				canEdit: saved.canEdit,
			},
		};
	},
};

export const GEOGRAPHY_READS = [listReportingRegionCandidates] as const;
