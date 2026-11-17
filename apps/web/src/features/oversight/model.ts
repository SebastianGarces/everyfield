import type {
	Health,
	IntelligenceRow,
	LaunchState,
	Level,
	PERSON_STAGES,
	MilestoneProgress,
	PlantDirectoryRow,
	PlantPath,
	PlantSections,
	Preparation,
	ReleasedAssessment,
	RuleId,
	SectionKey,
} from "@everyfield/contracts/oversight";
import { lensLabel, regionLabel, RULE_IDS } from "@everyfield/contracts/oversight";
import type { Stage } from "@everyfield/ui/display";
import { SHORT_NAME } from "../phases/model.ts";

export type OrganizationKind = "sending_church" | "sending_network";

export const HOME_HEADING: Record<OrganizationKind, string> = {
	sending_church: "Your plants",
	sending_network: "Plants",
};

export const phaseLabel = (phase: number) => `${phase} · ${SHORT_NAME[phase] ?? ""}`;

export function locality(row: Pick<PlantDirectoryRow, "city" | "stateProvince" | "country">): string | null {
	const parts = [row.city, row.stateProvince].filter(Boolean);
	if (parts.length) return parts.join(", ");
	return row.country;
}

const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const calendarDate = (date: string) => DAY.format(new Date(`${date}T00:00:00Z`));
export const launchLabel = (date: string | null) => (date ? calendarDate(date) : "Not set");

export function progressText(progress: MilestoneProgress): string | null {
	switch (progress.status) {
		case "reached":
			return `Reached ${calendarDate(progress.date)}`;
		case "not_reached":
			return "Not reached yet";
		case "withdrawn":
			return "No longer offered";
		case "withheld":
			return null;
	}
}
export function pathText(path: PlantPath): { label: string; value: string; detail: string | null; set: boolean } {
	if (path.kind === "launch_sunday")
		return { label: "Launch Sunday", value: launchLabel(path.date), detail: null, set: path.date !== null };
	return { label: "Milestone", value: path.name ?? "Chosen milestone", detail: progressText(path.progress), set: true };
}
export function chosenText(path: Extract<PlantPath, { kind: "milestone" }>, plantName: string): string {
	if (path.chosenBy) return `chosen by ${path.chosenBy}`;
	return path.progress.status === "withdrawn"
		? "chosen by another organization"
		: `chosen by another organization ${plantName} is linked with`;
}

export function provenanceLabel(row: Pick<PlantDirectoryRow, "provenance">): string {
	const p = row.provenance;
	return p.kind === "direct" ? "Directly" : `Through ${listOf(p.sendingChurches)}`;
}
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

export const SECTIONS: readonly { key: SectionKey; label: string }[] = [
	{ key: "people", label: "People" },
	{ key: "meetings", label: "Meetings" },
	{ key: "tasks", label: "Tasks" },
	{ key: "ministryTeams", label: "Ministry teams" },
	{ key: "wiki", label: "Wiki reading" },
];

export function sharedCount(sections: PlantSections): number {
	return SECTIONS.filter(({ key }) => ["shared", "empty"].includes(sections[key].status)).length;
}

type PersonStage = (typeof PERSON_STAGES)[number];
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

export const HEALTH: Record<Health, { label: string; status: Status }> = {
	limited_visibility: { label: "Limited visibility", status: "unknown" },
	launch_readiness: { label: "Launch readiness", status: "attention" },
	watch: { label: "Watch", status: "attention" },
	on_track: { label: "On track", status: "positive" },
	not_assessed: { label: "Not yet assessed", status: "measured" },
};

export const regionText = (row: Pick<PlantDirectoryRow, "region">) => (row.region ? regionLabel(row.region) : null);

export const LAUNCH_STATE: Record<LaunchState, { label: string; status: Status }> = {
	not_set: { label: "Not set", status: "unknown" },
	scheduled: { label: "Scheduled", status: "measured" },
	moved: { label: "Moved", status: "measured" },
	postponed: { label: "Postponed", status: "unknown" },
	overdue: { label: "Overdue", status: "attention" },
	completed: { label: "Launched", status: "positive" },
};

export function gapText(p: Preparation): string | null {
	const parts = [
		p.unfilledRoles ? `${plural(p.unfilledRoles, "required role")} unfilled` : null,
		p.outstandingTraining ? `${plural(p.outstandingTraining, "required training")} not done` : null,
	].filter((x) => x !== null);
	return parts.length ? parts.join(" and ") : null;
}
export function daysText(days: number): string {
	if (days === 0) return "Launch Sunday is today";
	if (days === 1) return "Launch Sunday is tomorrow";
	return `Launch Sunday is in ${days} days`;
}

export type OrganizationView = "plants" | "churches" | "intelligence";
export const VIEWS: Record<
	OrganizationKind,
	{ label: string; tabs: { view: OrganizationView; href: string; label: string }[] }
> = {
	sending_network: {
		label: "Network views",
		tabs: [
			{ view: "plants", href: "/network", label: "Plants" },
			{ view: "churches", href: "/network/sending-churches", label: "Sending churches" },
			{ view: "intelligence", href: "/network/intelligence", label: "Network Intelligence" },
		],
	},
	sending_church: {
		label: "Views",
		tabs: [
			{ view: "plants", href: "/network", label: HOME_HEADING.sending_church },
			{ view: "intelligence", href: "/network/intelligence", label: "Intelligence" },
		],
	},
};

export type IntelligenceWords = {
	title: string;
	levels: Record<Level, string>;
	howItWorks: string;
	notRun: string;
	refused: string;
	failed: string;
};
const PRIVACY = (rubric: string) =>
	`${rubric} reads only counts and dates each plant shares with you: launch dates, unfilled roles, overdue follow-ups, when its newest committed adult signed and required training, plus the concerns of its released Plant Intelligence assessment. It never names a person, ranks or scores plants. A plant that doesn't share counts as Not shared, never as zero.`;
export function intelligenceWords(kind: OrganizationKind, organizationName: string): IntelligenceWords {
	const church = kind === "sending_church";
	const title = church ? `${organizationName} Intelligence` : "Network Intelligence";
	return {
		title,
		levels: {
			region: "Region",
			state: "State",
			country: "Country",
			portfolio: church ? HOME_HEADING[kind] : "Whole portfolio",
		},
		howItWorks: PRIVACY(church ? "Everyfield's rubric v1" : "Everyfield's network rubric v1"),
		notRun: `${title} hasn't run yet`,
		refused: `Only Owners and Admins can refresh ${title}.`,
		failed: `We couldn't run ${title}. Nothing was changed. Try again in a moment.`,
	};
}

type Shared = Extract<IntelligenceRow, { status: "shared" }>;
type Label = { label: string; status: Status };
const UNKNOWN = (what: string): Label => ({ label: `${what} unknown`, status: "unknown" });
const RESULT: { [R in RuleId]: Record<Shared["results"][R], Label> } = {
	"NIR-03": {
		gap: { label: "Gap near launch", status: "attention" },
		clear: { label: "No near-launch gap", status: "measured" },
		unknown: UNKNOWN("Launch"),
	},
	"NIR-04": {
		gap: { label: "Overdue follow-ups", status: "attention" },
		clear: { label: "No overdue follow-ups", status: "measured" },
		unknown: UNKNOWN("Follow-ups"),
	},
	"NIR-05": {
		slowed: { label: "Growth slowed", status: "attention" },
		stalled: { label: "Growth stalled", status: "attention" },
		clear: { label: "No growth slowdown", status: "measured" },
		unknown: UNKNOWN("Growth"),
	},
	"NIR-06": {
		gap: { label: "Training outstanding", status: "attention" },
		clear: { label: "Required training complete", status: "measured" },
		unknown: UNKNOWN("Training"),
	},
};
export function resultLabels(row: IntelligenceRow): Label[] {
	if (row.status === "not_shared") return [{ label: "Not shared", status: "unknown" }];
	return RULE_IDS.map((id) => (RESULT[id] as Record<string, Label>)[row.results[id]]!);
}

export function concernLenses(a: ReleasedAssessment): string | null {
	if (a.status !== "released" || !a.concerns.length) return null;
	const names = [...new Set(a.concerns.map((c) => (c.lens ? lensLabel(c.lens) : "Launch progress")))];
	return `${names.length === 1 ? "Concern" : "Concerns"}: ${names.join(", ")}`;
}

export const runLabel = (instant: string, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone }).format(new Date(instant));
export const dayOf = (instant: string, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(new Date(instant));
