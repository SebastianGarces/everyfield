import type { SectionResult } from "@everyfield/contracts/settings";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { NativePorts } from "../../../proposals/types.ts";
import type { WriteTx } from "@everyfield/domain/access";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { anySeat, plantAdmin, scheduleText } from "../../native.ts";

async function section(
	tx: WriteTx,
	actor: EvryActor,
	native: NativePorts | null,
	raw: unknown,
): Promise<SectionResult | null> {
	if (!native) throw new EvryRefusal("source_unavailable");
	actor.authority.observe(tx);
	const reply = await native.settings.getOwnSection(tx, actor.authority, raw);
	return reply.status === "ok" ? reply.value : null;
}

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
		const found =
			value.section === "account"
				? await section(tx, actor, native, { section: "account" })
				: plantAdmin(actor)
					? await section(tx, actor, native, { section: "plant", plant: actor.owner })
					: null;
		const rows: SourceRow[] = found ? settingRows(found) : [];
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
