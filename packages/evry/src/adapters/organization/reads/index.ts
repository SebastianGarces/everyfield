import { owner } from "@everyfield/contracts/common";
import { z } from "zod";
import { EvryRefusal } from "../../../context/errors.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { organizationSeat } from "../../native.ts";

export const getProfile: ReadAdapter<Record<string, never>> = {
	operation: "organizations.getProfile",
	description:
		"Read this organization's own profile: its name, location, description, contact details, time zone and, for a network, its statement of faith",
	input: z.strictObject({}),
	allowed: organizationSeat,
	async invoke(tx, actor, _input, native): Promise<SourceResult> {
		if (!native) throw new EvryRefusal("source_unavailable");
		actor.authority.observe(tx);
		const found = await native.organizations["organizations.getProfile"](tx, actor.session, owner.parse(actor.owner), {
			organization: actor.owner,
		});
		const rows: SourceRow[] = [];
		if (found.status === "available") {
			const { gatheringMilestone: milestone, ...fields } = found.profile;
			rows.push({
				kind: "setting",
				id: "organization",
				label: fields.name,
				fields: {
					...fields,
					timeZone: found.timeZone,
					gatheringMilestone: milestone?.offered ? milestone.name : null,
				},
			});
		}
		return {
			operation: "organizations.getProfile",
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

export const PROFILE_READS = [getProfile] as const;
