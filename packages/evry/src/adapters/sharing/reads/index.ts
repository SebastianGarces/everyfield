import { readPlantSharing } from "@everyfield/domain/organizations";
import { z } from "zod";
import type { ReadAdapter, SourceResult } from "../../../catalog/types.ts";
import { plantSeat } from "../../native.ts";

// What the church shares with each organization it is connected to, read through the same native read the Settings >
// Sharing section uses. An Owner or Admin sees every category and whether it is shared; a Member sees only the
// connections, since Owners and Admins choose.

/** Each sharing category in the Sharing section's words. */
export const CATEGORY_LABEL = {
	people: "People totals",
	meetings: "Meetings",
	tasks: "Tasks",
	ministry_teams: "Ministry teams",
	wiki: "Wiki",
	activity: "Activity updates",
	shared_findings: "Plant Intelligence findings",
} as const;
export type Category = keyof typeof CATEGORY_LABEL;
export const CATEGORIES = Object.keys(CATEGORY_LABEL) as [Category, ...Category[]];

export const SHARING_READS = [
	{
		operation: "privacy.getSharing",
		description:
			"The organizations this church is connected to (a sending church or network) and what it shares with each",
		input: z.strictObject({
			organization: z.string().trim().min(1).max(200).optional().describe("Words from the organization's name"),
		}),
		allowed: plantSeat,
		async invoke(tx, actor, input): Promise<SourceResult> {
			actor.authority.observe(tx);
			const connections = await readPlantSharing(tx, actor.authority);
			const words = input.organization?.toLowerCase();
			const rows = Object.entries(connections).flatMap(([relationshipId, { sharing }]) => {
				if ("view" in sharing && (sharing.view === "plant_administration" || sharing.view === "plant_member")) {
					if (words && !sharing.organizationDisplayName.toLowerCase().includes(words)) return [];
					const shared =
						sharing.view === "plant_administration"
							? CATEGORIES.filter((c) => sharing.choices[c]).map((c) => CATEGORY_LABEL[c])
							: null;
					return [
						{
							kind: "connection" as const,
							id: relationshipId,
							label: sharing.organizationDisplayName,
							fields: {
								organizationId: sharing.organization.id,
								organizationKind:
									sharing.organization.organizationKind === "sending_network" ? "network" : "sending church",
								shared: shared ? (shared.length ? shared.join(", ") : "nothing") : null,
							},
						},
					];
				}
				return [];
			});
			return {
				operation: "privacy.getSharing",
				status: words && !rows.length ? "not_found" : "available",
				rows,
				total: rows.length,
				page: 1,
				next: null,
				completeness: "complete",
				exclusions: [],
			};
		},
	} satisfies ReadAdapter<{ organization?: string }>,
] as const;
