import type {
	Health,
	IntelligenceRow,
	LaunchState,
	Level,
	PERSON_STAGES,
	PlantDirectoryRow,
	PlantSections,
	Preparation,
	SectionKey,
} from "@everyfield/contracts/oversight";
import { NEAR_LAUNCH_DAYS, regionLabel } from "@everyfield/contracts/oversight";
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
const calendarDate = (date: string) => DAY.format(new Date(`${date}T00:00:00Z`));
export const launchLabel = (date: string | null) => (date ? calendarDate(date) : "Not set");

/** The directory's Linked column: "Directly" or "Through Grace Austin". */
export function provenanceLabel(row: Pick<PlantDirectoryRow, "provenance">): string {
	const p = row.provenance;
	return p.kind === "direct" ? "Directly" : `Through ${listOf(p.sendingChurches)}`;
}
/** The same in a sentence: "Linked directly" or "Linked through Grace Austin". */
export function linkedLabel(row: Pick<PlantDirectoryRow, "provenance">): string {
	const p = row.provenance;
	return p.kind === "direct" ? "Linked directly" : `Linked through ${listOf(p.sendingChurches)}`;
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

type Status = "positive" | "measured" | "attention" | "risk" | "unknown";

/**
 * The home's health value. Not yet assessed is never On track: On track and Watch come from released assessments
 * (WP-044), and a plant that shares nothing about it is Limited visibility.
 */
export const HEALTH: Record<Health, { label: string; status: Status }> = {
	limited_visibility: { label: "Limited visibility", status: "unknown" },
	launch_readiness: { label: "Launch readiness", status: "attention" },
	not_assessed: { label: "Not yet assessed", status: "measured" },
};

/** The official reporting Region, "Austin-Round Rock-San Marcos, TX (metro area)", or null when unresolved. */
export const regionText = (row: Pick<PlantDirectoryRow, "region">) => (row.region ? regionLabel(row.region) : null);

export const LAUNCH_STATE: Record<LaunchState, { label: string; status: Status }> = {
	not_set: { label: "Not set", status: "unknown" },
	scheduled: { label: "Scheduled", status: "measured" },
	moved: { label: "Moved", status: "measured" },
	postponed: { label: "Postponed", status: "unknown" },
	overdue: { label: "Overdue", status: "attention" },
	completed: { label: "Launched", status: "positive" },
};

/** "1 required role unfilled and 2 required trainings not done", or null without a recorded gap. */
export function gapText(p: Preparation): string | null {
	const parts = [
		p.unfilledRoles ? `${plural(p.unfilledRoles, "required role")} unfilled` : null,
		p.outstandingTraining ? `${plural(p.outstandingTraining, "required training")} not done` : null,
	].filter((x) => x !== null);
	return parts.length ? parts.join(" and ") : null;
}
/** "Launch Sunday is in 30 days", "is tomorrow", "is today". */
export function daysText(days: number): string {
	if (days === 0) return "Launch Sunday is today";
	if (days === 1) return "Launch Sunday is tomorrow";
	return `Launch Sunday is in ${days} days`;
}
export const NEAR_LAUNCH_WINDOW = NEAR_LAUNCH_DAYS;

export const LEVEL_LABEL: Record<Level, string> = {
	region: "Region",
	state: "State",
	country: "Country",
	portfolio: "Whole portfolio",
};

/** A plant's NIR-03 result as its row says it. Not shared says nothing else at all. */
export function resultLabel(row: IntelligenceRow): { label: string; status: Status } {
	if (row.status === "not_shared") return { label: "Not shared", status: "unknown" };
	if (row.result === "gap") return { label: "Gap near launch", status: "attention" };
	if (row.result === "clear") return { label: "No near-launch gap", status: "measured" };
	return { label: "Unknown", status: "unknown" };
}

/** A run's time in the organization's time zone, "Nov 14, 2026, 8:03 AM". */
export const runLabel = (instant: string, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(instant));
/** A published instant as the plant's calendar day, "Nov 14, 2026". */
export const dayOf = (instant: string, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(new Date(instant));
