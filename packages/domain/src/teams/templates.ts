import { hash } from "../operations/canonical.ts";
import "server-only";

/** The generation a client must send. Version "1" is stale against this catalog. */
export const TEMPLATE_VERSION = "2";

export type CatalogRole = { key: string; name: string; leadership: boolean; responsibilityKey: string | null };
export type CatalogTeam = { key: string; name: string; roles: CatalogRole[] };

const lead = (key: string, name: string, responsibilityKey: string | null): CatalogRole => ({
	key,
	name,
	leadership: true,
	responsibilityKey,
});

/** Ten ministry templates. Leadership is the org-chart root. Administration has no starter role. */
export const TEMPLATES: CatalogTeam[] = [
	{
		key: "leadership",
		name: "Leadership",
		roles: [lead("senior_pastor", "Senior pastor", null), lead("launch_coordinator", "Launch coordinator", null)],
	},
	{ key: "worship", name: "Worship", roles: [lead("worship_lead", "Worship lead", "worship")] },
	{
		key: "childrens_ministry",
		name: "Children's ministry",
		roles: [lead("childrens_lead", "Children's lead", "children")],
	},
	{
		key: "assimilation",
		name: "Assimilation",
		roles: [lead("assimilation_lead", "Assimilation lead", "assimilation")],
	},
	{
		key: "small_groups",
		name: "Small groups",
		roles: [lead("small_groups_lead", "Small groups lead", "small_groups")],
	},
	{ key: "facilities", name: "Facilities", roles: [lead("facilities_lead", "Facilities lead", "facilities")] },
	{ key: "promotion", name: "Promotion", roles: [lead("promotion_lead", "Promotion lead", "promotion")] },
	{ key: "technology", name: "Technology", roles: [lead("technology_lead", "Technology lead", "technology")] },
	{ key: "prayer", name: "Prayer", roles: [lead("prayer_lead", "Prayer lead", "prayer")] },
	{ key: "administration", name: "Administration", roles: [] },
];

export function catalogTeam(key: string) {
	return TEMPLATES.find((team) => team.key === key);
}
export function catalogRole(teamKey: string, roleKey: string) {
	return catalogTeam(teamKey)?.roles.find((role) => role.key === roleKey);
}
/** A key outside this catalog refuses the whole import. Names never match a template. */
export function unknownSelection(selections: readonly { teamKey: string; roleKeys: readonly string[] }[]) {
	return selections.some((selection) => {
		const team = catalogTeam(selection.teamKey);
		return !team || selection.roleKeys.some((key) => !team.roles.some((role) => role.key === key));
	});
}
export function reviewDigest(input: {
	expectedVersion: string;
	mode: string;
	selections: readonly unknown[];
	lines: readonly unknown[];
}) {
	return hash({
		expectedVersion: input.expectedVersion,
		mode: input.mode,
		selections: input.selections,
		lines: input.lines,
	});
}
export function offerRemains(present: readonly { teamKey: string; roleKey: string }[]) {
	return TEMPLATES.some(
		(team) =>
			!present.some((row) => row.teamKey === team.key) ||
			team.roles.some((role) => !present.some((row) => row.teamKey === team.key && row.roleKey === role.key)),
	);
}
