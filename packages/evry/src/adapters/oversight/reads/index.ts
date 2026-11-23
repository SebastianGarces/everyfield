import { dayText } from "@everyfield/contracts/common";
import * as C from "@everyfield/contracts/oversight";
import { getPlant, listPlants, placedIn, readIntelligence, readLocationHistory } from "@everyfield/domain/oversight";
import { z } from "zod";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { organizationSeat } from "../../native.ts";

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
		"One linked plant as its page in this organization shows it, by its plantId from oversight.listPlants: totals only for each category it shares (people by stage, open and overdue tasks, recent meetings, ministry teams), Not shared for the rest, its Launch status, readiness and latest published summary, and how many concerns its released assessment raised by lens. Never a person's name, note, interview, care record or an assessment's words: oversight shows totals only",
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

const LEVEL_NAME: Record<C.Level, string> = {
	region: "Region",
	state: "State",
	country: "Country",
	portfolio: "Whole portfolio",
};
const NO_REGION = "No Region set";
const plantHref = (id: string) => `/network/plants/${id}`;
const plantLink = (p: { plantId: string; name: string }) => `[${p.name}](${plantHref(p.plantId)})`;
const viewHref = (level: C.Level, runId: string | null) =>
	`/network/intelligence?level=${level}${runId ? `&run=${runId}` : ""}`;
const runText = (instant: string, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone }).format(new Date(instant));
const fold = (s: string) =>
	s
		.normalize("NFKD")
		.toLowerCase()
		.replace(/\b(the|region|area|metro|micro|state|of)\b/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
const COUNTRY = /^(?:us|usa|u s|u s a|america|united states(?: america)?)$/;
function placeMatches(group: C.IntelligenceGroup, place: string) {
	const want = fold(place);
	if (!want) return true;
	const label = fold(group.key === "portfolio" ? "Whole portfolio" : group.label);
	if (COUNTRY.test(want)) return group.key === "US";
	if (/^(?:whole )?portfolio$|^all(?: our)?(?: plants)?$/.test(want)) return group.key === "portfolio";
	return label.includes(want) || group.key.toLowerCase() === `us:${want}`;
}
function noPatternNote(level: C.Level, g: C.IntelligenceGroup) {
	if (g.placement !== "placed")
		return level === "region"
			? "These plants have no Region set, so they aren't in a Region group. They still count at the state, country and whole-portfolio levels."
			: "These plants have no location at this level. They still count at the larger levels.";
	const sharing = g.rows.filter((r) => r.status === "shared").length;
	if (sharing === 0) return "No plant here shares findings, so there's no pattern.";
	return sharing === 1
		? "Only one plant here shares findings, and one plant alone isn't a pattern."
		: "No two plants here share the same recorded result, so there's no pattern.";
}
const groupPlants = (g: C.IntelligenceGroup) =>
	g.rows.map((r) => (r.status === "shared" ? r.name : `${r.name} (${NOT_SHARED})`)).join(", ");
const groupLinks = (g: C.IntelligenceGroup) =>
	g.rows.map((r) => (r.status === "shared" ? plantLink(r) : `${plantLink(r)} (${NOT_SHARED})`)).join(", ");
const groupLabel = (g: C.IntelligenceGroup) => (g.key === "portfolio" ? "Whole portfolio" : g.label);

function patternRow(level: C.Level, g: C.IntelligenceGroup, p: C.IntelligencePattern, href: string, change?: string) {
	const text = C.patternText(p);
	return {
		kind: "item" as const,
		id: `${change ? "change" : "pattern"}:${level}:${g.key}:${p.key}`,
		label: text.title,
		fields: {
			row: change ? "change" : "pattern",
			...(change && { change }),
			level: LEVEL_NAME[level],
			group: groupLabel(g),
			pattern: text.lines.join(" "),
			plants: p.plants.map((x) => x.name).join(", "),
			plantLinks: p.plants.map(plantLink).join(", "),
			nextStep: text.nextStep,
			evidence: text.evidence,
			href,
		},
	};
}

const historyInput = z.strictObject({
	level: C.level.optional(),
	place: z.string().trim().min(1).max(120).optional(),
	runId: z.uuid().optional(),
	changes: z.boolean().optional(),
});
export const readIntelligenceHistory: ReadAdapter<z.infer<typeof historyInput>> = {
	operation: "organizationIntelligence.readHistory",
	description:
		"Network Intelligence for any run and place, as its page shows it with ?level= and ?run=: give level (region, state, country or portfolio; leave it out for every level, to follow one pattern across them), place to keep only one named group (a Region such as Dallas-Fort Worth, a state such as Texas, a country such as US, or Whole portfolio), runId for an earlier run (default the latest; every run is listed as a run row), and changes: true for the patterns that appeared or went away in each group since the run before it. Each level groups the plants on its own. Group rows name every plant in the group, Not shared ones included, and say why there is no pattern; pattern rows give the rubric's words with the plants they name. A pattern always names two or more plants. Each row has plantLinks and href to link the plants and the page view. No scores, weights or rankings",
	input: historyInput,
	allowed: organizationSeat,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const levels = input.level ? [input.level] : C.LEVELS;
		const runId = input.runId ?? null;
		const rows: SourceRow[] = [];
		const facts: SourceResult["facts"] = {};
		for (const level of levels) {
			const view = await readIntelligence(tx, actor.authority, { level, runId });
			if (!view) {
				if (runId) return { ...result("organizationIntelligence.readHistory", [], {}), status: "not_found", total: 0 };
				return unavailable();
			}
			const latest = view.run !== null && view.history[0]?.runId === view.run.runId;
			const shownId = view.run && !latest ? view.run.runId : null;
			if (level === levels[0]) {
				Object.assign(facts, {
					organization: view.organizationName,
					ranOn: view.run ? runText(view.run.ranAt, view.timeZone) : null,
					runId: view.run?.runId ?? null,
					latest,
				});
				rows.push(
					...view.history.map((h, i) => ({
						kind: "item" as const,
						id: h.runId,
						label: runText(h.ranAt, view.timeZone),
						fields: {
							row: "run",
							latest: i === 0,
							shown: h.runId === view.run?.runId,
							href: viewHref(level, i ? h.runId : null),
						},
					})),
				);
			}
			if (level === "region" && view.geographyReleases.length)
				facts.regionSource = `Regions from ${view.geographyReleases.map((r) => r.credit).join("; ")}.`;
			const href = viewHref(level, shownId);
			const groups = view.groups.filter((g) => !input.place || placeMatches(g, input.place));
			let earlier: C.IntelligenceView | null = null;
			const shown = view.run;
			if (input.changes && shown) {
				const at = view.history.findIndex((h) => h.runId === shown.runId);
				const before = view.history[at + 1];
				earlier = before ? await readIntelligence(tx, actor.authority, { level, runId: before.runId }) : null;
				facts.earlierRanOn = earlier?.run ? runText(earlier.run.ranAt, earlier.timeZone) : null;
				facts.earlierRunId = earlier?.run?.runId ?? null;
			}
			for (const g of groups) {
				rows.push({
					kind: "item",
					id: `group:${level}:${g.key}`,
					label: groupLabel(g),
					fields: {
						row: "group",
						level: LEVEL_NAME[level],
						plants: groupPlants(g),
						plantLinks: groupLinks(g),
						patterns: g.patterns.length ? g.patterns.map((p) => C.patternText(p).title).join("; ") : null,
						noPattern: g.patterns.length ? null : noPatternNote(level, g),
						href,
					},
				});
				rows.push(...g.patterns.map((p) => patternRow(level, g, p, href)));
				if (!earlier) continue;
				const before = earlier.groups.find((x) => x.key === g.key)?.patterns ?? [];
				const now = new Set(g.patterns.map((p) => p.key));
				const then = new Set(before.map((p) => p.key));
				rows.push(
					...g.patterns.filter((p) => !then.has(p.key)).map((p) => patternRow(level, g, p, href, "Appeared")),
					...before.filter((p) => !now.has(p.key)).map((p) => patternRow(level, g, p, href, "Went away")),
				);
			}
			if (input.place && !groups.length)
				facts.placeNotFound = `${input.place} isn't a ${LEVEL_NAME[level]} group in this run. Groups: ${view.groups.map(groupLabel).join("; ")}`;
		}
		return result("organizationIntelligence.readHistory", rows, {
			...facts,
			patternRule: "A pattern needs two or more distinct plants with the same rule theme in a group.",
		});
	},
};

export const readPlantLocations: ReadAdapter<Record<string, never>> = {
	operation: "organizationIntelligence.readLocations",
	description:
		"Where each linked plant is placed for Network Intelligence now, as its oversight page shows it: city, state or province, country and reporting Region (No Region set when there is none), the groups it counts in (a plant with no Region set still counts in its state, its country and the Whole portfolio), whether it shares Plant Intelligence findings (Not shared when it doesn't) and href to its page; regionView links the page's Region view. Never a street address or coordinates",
	input: z.strictObject({}),
	allowed: organizationSeat,
	async invoke(tx, actor): Promise<SourceResult> {
		const directory = (await listPlants(tx, actor.authority)) ?? unavailable();
		const rows: SourceRow[] = [];
		for (const p of directory.plants.slice(0, PLANTS)) {
			const view = (await getPlant(tx, actor.authority, p.plantId)) ?? unavailable();
			rows.push({
				kind: "item",
				id: p.plantId,
				label: p.name,
				fields: {
					city: p.city,
					stateProvince: p.stateProvince,
					country: p.country,
					region: p.region ? C.regionLabel(p.region) : NO_REGION,
					countsIn: placedIn(p).join(", "),
					findings: view.assessment.status === "withheld" ? NOT_SHARED : "Shared",
					href: plantHref(p.plantId),
				},
			});
		}
		return {
			...result("organizationIntelligence.readLocations", rows, {
				organization: directory.organizationName,
				regionView: viewHref("region", null),
			}),
			total: directory.plants.length,
			completeness: directory.plants.length > PLANTS ? "partial" : "complete",
		};
	},
};

export const readPlantLocationHistory: ReadAdapter<{ plantId: string }> = {
	operation: "organizationIntelligence.readLocationHistory",
	description:
		"One linked plant's saved locations for Network Intelligence, newest first, by its plantId from organizationIntelligence.readLocations: each location's city, state or province, country and reporting Region, the date it took effect and the Network Intelligence runs that used it. An earlier run keeps the location it used then; only runs after a correction use the new one. Only the plant's Owner or Admin can change it. Never a street address or coordinates",
	input: z.strictObject({ plantId: z.uuid() }),
	allowed: organizationSeat,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const history = await readLocationHistory(tx, actor.authority, input.plantId);
		if (!history)
			return { ...result("organizationIntelligence.readLocationHistory", [], {}), status: "not_found", total: 0 };
		const when = (at: string) => runText(at, history.timeZone);
		return result(
			"organizationIntelligence.readLocationHistory",
			history.locations.map((l, i) => ({
				kind: "item",
				id: `${history.plantId}:${l.effectiveAt}`,
				label: [l.city, l.stateProvince, l.country].filter(Boolean).join(", ") || "No location",
				fields: {
					region: l.region ? C.regionLabel(l.region) : NO_REGION,
					effective: when(l.effectiveAt),
					current: i === 0,
					runs: l.runs.length ? l.runs.map(when).join("; ") : "No run has used it yet",
				},
			})),
			{
				plant: history.name,
				plantId: history.plantId,
				href: plantHref(history.plantId),
				saved: history.locations.length,
				rule: "An earlier Network Intelligence run keeps the location it used then; only runs after a correction use the new one.",
			},
		);
	},
};

export const OVERSIGHT_READS = [
	listOverseenPlants,
	readOverseenPlant,
	readNetworkIntelligence,
	readIntelligenceHistory,
	readPlantLocations,
	readPlantLocationHistory,
] as const;
