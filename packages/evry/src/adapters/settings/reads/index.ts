import { regionLabel } from "@everyfield/contracts/oversight";
import { readReportingLocation, suggestRegions } from "@everyfield/domain/organizations";
import { reportingLocality } from "@everyfield/contracts/organizations";
import type { WriteTx } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import type { SectionResult } from "@everyfield/contracts/settings";
import { z } from "zod";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { anySeat, plantAdmin, scheduleText } from "../../native.ts";

const input = z.strictObject({
	section: z
		.enum(["church", "account"])
		.describe("church: the church profile, inactivity days and church digest; account: the user's own account"),
});
export const getSection: ReadAdapter<z.infer<typeof input>> = {
	operation: "settings.getSection",
	description:
		"Read settings as Settings shows them: the church's profile, time zone, inactivity days and church digest (Owner or Admin only), or the user's own account name, sign-in email and time zone. Not found for the church section means this seat can't read it: say only an Owner or Admin can.",
	input,
	allowed: anySeat,
	async invoke(tx, actor, value, native): Promise<SourceResult> {
		if (!native) throw new EvryRefusal("source_unavailable");
		actor.authority.observe(tx);
		const request =
			value.section === "account"
				? { section: "account" }
				: plantAdmin(actor)
					? { section: "plant", plant: actor.owner }
					: null;
		const reply = request && (await native.settings.getOwnSection(tx, actor.authority, request));
		const rows = reply?.status === "ok" ? settingRows(reply.value) : [];
		return {
			operation: "settings.getSection",
			status: rows.length ? "available" : "not_found",
			rows,
			total: rows.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: [],
		};
	},
};

function settingRows(found: SectionResult): SourceRow[] {
	if (found.section === "account")
		return [
			{
				kind: "setting",
				id: "account",
				label: found.name,
				fields: {
					name: found.name,
					email: found.email,
					timeZone: found.personalTimezone.status === "confirmed" ? found.personalTimezone.timeZone : null,
				},
			},
		];
	if (found.section !== "plant") return [];
	const { profile, timeZone, inactivity, digest } = found.values;
	return [
		{ kind: "setting", id: "profile", label: profile.name, fields: { ...profile, timeZone } },
		{ kind: "setting", id: "inactivity", label: "Inactivity days", fields: { ...inactivity } },
		{
			kind: "setting",
			id: "digest",
			label: "Church digest",
			fields: { schedule: scheduleText(digest), timeZone },
		},
	];
}

export const SETTINGS_READS = [getSection] as const;

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
