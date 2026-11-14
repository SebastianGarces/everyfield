import * as C from "@everyfield/contracts/oversight";
import { getPlant, listPlants, readIntelligence } from "@everyfield/domain/oversight";
import { z } from "zod";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { organizationSeat } from "../../native.ts";
import { dayText } from "../../pipeline/reads/index.ts";

// Organization oversight as Evry reads it (WP-073: oversight.listPlants, oversight.getPlant with its Launch readiness
// and published summary, organizationIntelligence.read). Each calls the read the network's own pages make (/network,
// a plant's page, Network Intelligence) under the seat's live authority, so Evry sees what those pages show and nothing
// more (EVRY-ORG-CONTEXT). Every value is a count, a date, a fixed rule result, a plant's name or its published summary:
// never a person, a note, an interview, private care or an assessment's words. The lead planter's name the Plants page
// shows stays there. A plant that doesn't share Plant Intelligence findings reads as Not shared, never as zero, and
// plants are never ranked or scored against each other (network rubric v1).

const NOT_SHARED = "Not shared";
const HEALTH: Record<C.Health, string> = {
	limited_visibility: "Limited visibility",
	launch_readiness: "Launch readiness",
	watch: "Watch",
	on_track: "On track",
	not_assessed: "Not yet assessed",
};
const LAUNCH: Record<C.LaunchState, string> = {
	not_set: "Not set",
	scheduled: "Scheduled",
	moved: "Moved",
	postponed: "Postponed",
	overdue: "Overdue",
	completed: "Launched",
};
const place = (p: C.PlantDirectoryRow) => [p.city, p.stateProvince].filter(Boolean).join(", ") || null;
/** What oversight never holds, said in every result so the answer can say it too. */
const AGGREGATES_ONLY = "names, notes, interviews, private care and assessment text, which oversight never shows";

const result = (operation: string, rows: SourceRow[], facts: SourceResult["facts"]): SourceResult => ({
	operation,
	status: "available",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [AGGREGATES_ONLY],
	facts,
});
const unavailable = (): never => {
	throw new EvryRefusal("source_unavailable");
};

/** A plant's Launch as its page shows it: the shared status, readiness and published summary, or Not shared. */
function launchFields(view: C.PlantView): Record<string, string | number | null> {
	const l = view.launch;
	if (l.status === "withheld") return { launch: NOT_SHARED };
	return {
		launch: LAUNCH[l.state],
		plannedDate: l.plannedDate ? dayText(l.plannedDate) : null,
		milestones: l.milestones.total
			? `${l.milestones.completed} of ${l.milestones.total} readiness milestones complete`
			: "no readiness milestones yet",
		daysToLaunch: l.preparation.daysToLaunch,
		unfilledRoles: l.preparation.unfilledRoles,
		outstandingTraining: l.preparation.outstandingTraining,
	};
}

/** At most this many plants are read in one answer. */
const PLANTS = 25;
export const listOverseenPlants: ReadAdapter<Record<string, never>> = {
	operation: "oversight.listPlants",
	description:
		"The plants linked to this organization, by name, as its Plants page shows them: each plant's health (On track, Watch, Launch readiness, Limited visibility or Not yet assessed; Not shared when the plant doesn't share Plant Intelligence findings), its Launch status and readiness only when shared (milestones complete, days to Launch Sunday) with its latest published Launch summary, its place and its reporting Region. Counts and dates only, never a person. Never rank or score plants against each other",
	input: z.strictObject({}),
	allowed: organizationSeat,
	async invoke(tx, actor): Promise<SourceResult> {
		const directory = (await listPlants(tx, actor.authority)) ?? unavailable();
		const rows: SourceRow[] = [];
		for (const p of directory.plants.slice(0, PLANTS)) {
			const view = (await getPlant(tx, actor.authority, p.plantId)) ?? unavailable();
			const shared = view.assessment.status !== "withheld";
			rows.push({
				kind: "item",
				id: p.plantId,
				label: p.name,
				fields: {
					health: shared ? HEALTH[p.health] : NOT_SHARED,
					...launchFields(view),
					publishedSummary: view.summary?.body ?? null,
					place: place(p),
					region: p.region ? C.regionLabel(p.region) : null,
					phase: p.phase,
				},
			});
		}
		return {
			...result("oversight.listPlants", rows, { organization: directory.organizationName }),
			total: directory.plants.length,
			completeness: directory.plants.length > PLANTS ? "partial" : "complete",
		};
	},
};

const SECTION_TEXT = {
	people: (n: C.PlantSections["people"]) => (n.status === "shared" ? n.counts.total : null),
	tasks: (n: C.PlantSections["tasks"]) =>
		n.status === "shared" ? `${n.counts.open} open, ${n.counts.overdue} overdue` : null,
	meetings: (n: C.PlantSections["meetings"]) =>
		n.status === "shared" ? `${n.counts.meetings.length} recent meetings, ${n.counts.attendedTotal} attended` : null,
};
const sectionState = (s: { status: string }, value: string | number | null) =>
	s.status === "withheld"
		? NOT_SHARED
		: s.status === "empty"
			? "Nothing recorded"
			: s.status === "unavailable"
				? "Couldn't be loaded"
				: value;

export const readOverseenPlant: ReadAdapter<{ plantId: string }> = {
	operation: "oversight.getPlant",
	description:
		"One linked plant as its page in this organization shows it, by its plantId from oversight.listPlants: totals only for each category it shares (people by stage, open and overdue tasks, recent meetings, ministry teams), Not shared for the rest, its Launch status, readiness and latest published summary, and how many concerns its released assessment raised by lens. Never a person's name, note, interview, private care or an assessment's words: oversight shows totals only",
	input: z.strictObject({ plantId: z.uuid() }),
	allowed: organizationSeat,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const view = await getPlant(tx, actor.authority, input.plantId);
		if (!view) return { ...result("oversight.getPlant", [], {}), status: "not_found", total: 0 };
		const s = view.sections;
		const people = s.people.status === "shared" ? s.people.counts : null;
		const a = view.assessment;
		return result(
			"oversight.getPlant",
			[
				{
					kind: "item",
					id: view.plant.plantId,
					label: view.plant.name,
					fields: {
						health: a.status === "withheld" ? NOT_SHARED : HEALTH[view.plant.health],
						people: sectionState(s.people, SECTION_TEXT.people(s.people)),
						...(people && {
							coreGroup: people.byStage.core_group,
							launchTeam: people.byStage.launch_team,
							leaders: people.byStage.leader,
						}),
						tasks: sectionState(s.tasks, SECTION_TEXT.tasks(s.tasks)),
						meetings: sectionState(s.meetings, SECTION_TEXT.meetings(s.meetings)),
						ministryTeams: sectionState(
							s.ministryTeams,
							s.ministryTeams.status === "shared"
								? `${s.ministryTeams.counts.teams} teams, ${s.ministryTeams.counts.rolesFilled} of ${s.ministryTeams.counts.roles} roles filled`
								: null,
						),
						...launchFields(view),
						publishedSummary: view.summary?.body ?? null,
						concerns:
							a.status === "released"
								? a.concerns
										.map((x) => `${x.severity === "high" ? "Urgent" : "Watch"}: ${x.lens ?? "other"}`)
										.join("; ") || "None raised"
								: a.status === "withheld"
									? NOT_SHARED
									: "Not yet assessed",
						region: view.plant.region ? C.regionLabel(view.plant.region) : null,
					},
				},
			],
			{ totalsOnly: true },
		);
	},
};

const intelligenceInput = z.strictObject({
	/** The grouping the Network Intelligence page offers: Region, state, country or the whole portfolio. */
	level: C.level.optional(),
});
export const readNetworkIntelligence: ReadAdapter<z.infer<typeof intelligenceInput>> = {
	operation: "organizationIntelligence.read",
	description:
		"Network Intelligence as its page shows it for the latest run, grouped by level (region, state, country or portfolio; default state): each group's plants and its patterns (item rows), each the rubric's own words with the plants it names. A pattern always names two or more distinct plants; one plant alone is never a pattern. Plants that don't share findings are Not shared. No scores, weights or rankings",
	input: intelligenceInput,
	allowed: organizationSeat,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const level = input.level ?? "state";
		const view = (await readIntelligence(tx, actor.authority, { level, runId: null })) ?? unavailable();
		const rows: SourceRow[] = view.groups.flatMap((g) =>
			g.patterns.map((p) => {
				const text = C.patternText(p);
				return {
					kind: "item" as const,
					id: `${g.key}:${p.key}`,
					label: text.title,
					fields: {
						group: g.label,
						pattern: text.lines.join(" "),
						plants: p.plants.map((x) => x.name).join(", "),
						nextStep: text.nextStep,
						evidence: text.evidence,
						rule: p.rule,
					},
				};
			}),
		);
		return result("organizationIntelligence.read", rows, {
			organization: view.organizationName,
			level,
			ranOn: view.run
				? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: view.timeZone }).format(
						new Date(view.run.ranAt),
					)
				: null,
			groups: view.groups
				.map((g) => {
					const shared = g.rows.filter((r) => r.status === "shared").map((r) => r.name);
					const unshared = g.rows.filter((r) => r.status === "not_shared").map((r) => r.name);
					return `${g.label}: ${[...shared, ...unshared.map((n) => `${n} (Not shared)`)].join(", ")}`;
				})
				.join("; "),
			patternRule: "A pattern needs two or more distinct plants with the same rule theme in a group.",
		});
	},
};

/** The installed organization oversight reads. */
export const OVERSIGHT_READS = [listOverseenPlants, readOverseenPlant, readNetworkIntelligence] as const;
