import type { PERSON_STAGES, PlantDirectoryRow, PlantSections, SectionKey } from "@everyfield/contracts/oversight";
import type { Stage } from "@everyfield/ui/display";
import { SHORT_NAME } from "../phases/model.ts";

// The oversight pages' pure words: no React and no server code, so tests call it directly.

export type OrganizationKind = "sending_church" | "sending_network";

/** The home's heading: a sending church sees "Your plants", never the word "network" (Nora's call, Nov 13). */
export const HOME_HEADING: Record<OrganizationKind, string> = {
	sending_church: "Your plants",
	sending_network: "Plants",
};

/** "1 · Core group", the phase the church declared. */
export const phaseLabel = (phase: number) => `${phase} · ${SHORT_NAME[phase] ?? ""}`;

/** City and state, or whichever the plant gave; never a street. */
export function locality(row: Pick<PlantDirectoryRow, "city" | "stateProvince" | "country">): string | null {
	const parts = [row.city, row.stateProvince].filter(Boolean);
	if (parts.length) return parts.join(", ");
	return row.country;
}

const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
/** A plant-local calendar date as "Mar 14, 2027": the date itself, never shifted by a time zone. */
export const calendarDate = (date: string) => DAY.format(new Date(`${date}T00:00:00Z`));
export const launchLabel = (date: string | null) => (date ? calendarDate(date) : "Not set");

export function provenanceLabel(row: Pick<PlantDirectoryRow, "provenance">): string {
	const p = row.provenance;
	return p.kind === "direct" ? "Directly" : `Through ${listOf(p.sendingChurches)}`;
}

export const leadLabel = (row: Pick<PlantDirectoryRow, "leadPlanter">) => row.leadPlanter ?? "No lead planter named";

function listOf(names: readonly string[]): string {
	if (names.length <= 2) return names.join(" and ");
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export const plural = (n: number, one: string, many = `${one}s`) =>
	`${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The sharing sections in page order, with their names. */
export const SECTIONS: readonly { key: SectionKey; label: string }[] = [
	{ key: "people", label: "People" },
	{ key: "meetings", label: "Meetings" },
	{ key: "tasks", label: "Tasks" },
	{ key: "ministryTeams", label: "Ministry teams" },
	{ key: "wiki", label: "Wiki reading" },
];

/** How many sections this plant shares with the viewer, counting shared-but-empty ones. */
export function sharedCount(sections: PlantSections): number {
	return SECTIONS.filter(({ key }) => ["shared", "empty"].includes(sections[key].status)).length;
}

type PersonStage = (typeof PERSON_STAGES)[number];
/** The shared stage chip and colour for each pipeline stage. */
export const STAGE_OF: Record<PersonStage, Stage> = {
	prospect: "prospect",
	attendee: "attendee",
	following_up: "following",
	interviewed: "interviewed",
	core_group: "core",
	launch_team: "launch",
	leader: "leader",
};
