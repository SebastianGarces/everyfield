import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { MEMBER_INTELLIGENCE } from "../catalog/catalog.ts";
import { INTELLIGENCE_RULES, OVERSIGHT_RULES } from "../context/compile.ts";

// The scripted model's Plant Intelligence and oversight requests (WP-073, WP-074), for local previews and tests only.
// It answers through the same tools a model gets: committed adults, the scorecard, the assessment and what changed as
// Plant Intelligence reads them, team health, a review card for a refresh, feedback or a task from a suggestion, and
// for an organization seat its plants, one plant's totals and Network Intelligence patterns. Every number it says is
// one a read returned. A reply the tools never serve is the product's own sentence from compile.ts, quoted only when
// the prompt holds it, so the evals test the text the real model is given.

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind?: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & {
	operation?: string;
	status?: string;
	total?: number | null;
	rows?: Row[];
	facts?: Record<string, unknown>;
	proposalId?: string;
};

const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];
function turnOutputs(prompt: Prompt): Output[] {
	const start = prompt.findLastIndex((m) => m.role === "user");
	return prompt
		.slice(start + 1)
		.flatMap((m) =>
			m.role === "tool"
				? m.content.flatMap((p) =>
						p.type === "tool-result" && p.output.type === "json" ? [p.output.value as Output] : [],
					)
				: [],
		);
}
const systemText = (prompt: Prompt) => prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const ADULTS = /\bcommitted adults?\b|\bare we at 30\b/i;
const HEALTH = /\bhow healthy\b|\b(?:core )?team health\b|\bhealth of (?:our|the) (?:core )?team\b/i;
const EXPLAIN = /\bexplain\b.*\bassessment\b|\bwhat does (?:the|this week'?s) assessment say\b/i;
const CHANGED = /\bwhat(?:'s| has)? changed since\b|\bwhat moved\b/i;
/** "turn the follow-up suggestion into tasks", "turn the second suggestion into a task". */
const TO_TASKS = /\bturn (?:the |our )?(.+?) suggestions? into (?:a )?tasks?\b/i;
const REFRESH = /\brefresh (?:the |our )?(?:plant intelligence )?assessment\b/i;
const FEEDBACK = /\b(?:this|the) (?:finding|focus|suggestion) (?:wasn't|was not|isn't|is not) (useful|helpful)\b/i;
const USEFUL = /\b(?:this|the) (?:finding|focus|suggestion) (?:was|is) (useful|helpful)\b/i;
const PLANTS = /\bhow are (?:our|my|the) plants doing\b/i;
const PEOPLE_AT = /\b(?:list|show|who are|name) (?:me )?(?:all )?the people (?:at|in) (.+?)(?: plant)?\s*[?.!]?$/i;
const PATTERNS = /\bpatterns?\b.*?\b(?:across|in|among) (?:our |the )?(.+?) plants\b/i;
const NEAR_LAUNCH = /\bclose to launch(?:ing)?\b|\bnear(?:ing)? launch\b/i;
const REGION = /^(.+?) is in the (.+?) region\b/i;
const CHANNEL = /\bsend my oversight digest (?:by |to (?:my |the )?)(email|bell|in-app)\b/i;
const ORDINALS = ["first", "second", "third"];
const SPIRITUAL = /\bpray|prayer|theolog|scripture|biblical|spiritual\b/i;

const fieldsOf = (out: Output | undefined) => out?.facts ?? {};
const lastOf = (outputs: Output[], operation: string) => outputs.findLast((o) => o.operation === operation);
const proposed = (outputs: Output[]) => outputs.some((o) => typeof o.proposalId === "string");
const REVIEW = "I prepared a review. Nothing changes until you approve it.";

function adultsAnswer(f: Record<string, unknown>) {
	const measured = `as Plant Intelligence measured it on ${String(f.measuredOn)}`;
	const known = Number(f.known);
	if (f.exact === null || f.exact === undefined)
		return `You have at least ${plural(known, "committed adult", "committed adults")}, ${measured}. ${plural(Number(f.needsClassifying), "more person with a commitment needs", "more people with a commitment need")} an adult or child classification. ${INTELLIGENCE_RULES.unclassified} Only signed commitments count, not a People stage. See ${String(f.screen)}.`;
	const exact = Number(f.exact);
	const verdict =
		f.criterion === "met"
			? `You're at ${f.target}: the committed-adult criterion is met.`
			: `That's ${plural(Number(f.target) - exact, "adult", "adults")} short of ${f.target}, so the criterion isn't met yet.`;
	return `You have ${plural(exact, "committed adult", "committed adults")}, ${measured}. ${verdict} Only signed commitments count, not a People stage. See ${String(f.screen)}.`;
}

function plantStep(options: LanguageModelV4CallOptions, text: string, system: string, outputs: Output[]) {
	const tools = options.tools ?? [];
	const has = (name: string) => tools.some((t) => t.name === name);
	const can = (operation: string) =>
		JSON.stringify(tools.find((t) => t.name === "propose_change") ?? {}).includes(`"${operation}"`);
	const reads = has("intelligence_read");
	const asked = [ADULTS, HEALTH, EXPLAIN, CHANGED, TO_TASKS, REFRESH, FEEDBACK, USEFUL].some((r) => r.test(text));
	if (!asked) return null;
	if (proposed(outputs)) return say(REVIEW);
	// A Member's seat has no Plant Intelligence: the screen's own words, and who asks for a refresh.
	if (!reads) {
		if (
			(REFRESH.test(text) || FEEDBACK.test(text) || USEFUL.test(text)) &&
			system.includes(INTELLIGENCE_RULES.ownerOnly)
		)
			return say(INTELLIGENCE_RULES.ownerOnly);
		return system.includes(MEMBER_INTELLIGENCE) ? say(MEMBER_INTELLIGENCE) : null;
	}
	const read = (operation: string, input: unknown = {}) => call("intelligence_read", { operation, input });

	if (ADULTS.test(text)) {
		const out = lastOf(outputs, "intelligence.readCommittedAdultCohort");
		return out ? say(adultsAnswer(fieldsOf(out))) : read("intelligence.readCommittedAdultCohort");
	}
	if (REFRESH.test(text))
		return can("intelligence.requestRefresh")
			? call("propose_change", { operation: "intelligence.requestRefresh", input: {} })
			: say(INTELLIGENCE_RULES.ownerOnly);
	const assessment = lastOf(outputs, "intelligence.readAssessment");
	if (FEEDBACK.test(text) || USEFUL.test(text)) {
		if (!assessment) return read("intelligence.readAssessment");
		if (assessment.status === "not_found") return say("There's no assessment yet, so there's no finding to rate.");
		return call("propose_change", {
			operation: "intelligence.submitFeedback",
			input: { ordinal: 0, rating: FEEDBACK.test(text) ? "not_useful" : "useful" },
		});
	}
	if (HEALTH.test(text)) {
		const card = lastOf(outputs, "intelligence.readScorecard");
		if (!card) return read("intelligence.readScorecard");
		const teams = lastOf(outputs, "teams.aggregateHealth");
		if (!teams && has("teams_read")) return call("teams_read", { operation: "teams.aggregateHealth", input: {} });
		const f = fieldsOf(card);
		if (card.status === "not_found")
			return say(`There's no published assessment yet, so I have no scorecard to quote. See ${String(f.screen)}.`);
		const lenses = (card.rows ?? [])
			.filter((r) => r.kind === "item")
			.map(
				(r) =>
					`- **${r.label}**: ${String(r.fields.standing)} (${String(r.fields.evidence).toLowerCase()} evidence${r.fields.facts ? `; ${String(r.fields.facts)}` : ""})`,
			);
		const lines = [`Your latest assessment, measured ${String(f.measuredOn)}, gives this scorecard:`, ...lenses];
		const t = teams?.facts;
		if (t) {
			const percent = (v: unknown) => (v === null || v === undefined ? "Unknown" : `${String(v)}%`);
			const measured = (teams.rows ?? []).map(
				(r) =>
					`- **${r.label}**: composite ${String(r.fields.composite)}, staffing ${percent(r.fields.staffingPercent)}, training ${percent(r.fields.trainingPercent)}, attendance ${percent(r.fields.attendancePercent)} (${r.fields.windowFrom ? `team meetings ${String(r.fields.windowFrom)} to ${String(r.fields.windowTo)}` : "no team meetings measured yet"})`,
			);
			lines.push(
				"",
				`Measured ministry health: composite ${String(t.composite)}, from ${String(t.measuredMinistries)} of ${String(t.ministries)} ministries measured.`,
				...measured,
			);
		}
		lines.push(
			"",
			`These are the assessment's and the measured facts' own words, not my opinion. See ${String(f.screen)}.`,
		);
		return say(lines.join("\n"));
	}
	if (EXPLAIN.test(text)) {
		if (!assessment) return read("intelligence.readAssessment");
		const f = fieldsOf(assessment);
		if (assessment.status === "not_found") return say(`There's no published assessment yet. See ${String(f.screen)}.`);
		return say(
			[
				`Here is the assessment measured ${String(f.measuredOn)}: ${String(f.summary)}`,
				...(assessment.rows ?? []).map(
					(r) =>
						`- **${r.label}** (${String(r.fields.severity)}): ${String(r.fields.body)} Cites: ${String(r.fields.cites)}.`,
				),
				"",
				`See ${String(f.screen)}.`,
			].join("\n"),
		);
	}
	if (CHANGED.test(text)) {
		const delta = lastOf(outputs, "intelligence.readAssessmentDelta");
		if (!delta) return read("intelligence.readAssessmentDelta");
		const f = fieldsOf(delta);
		if (delta.status === "not_found") return say(`There's no published assessment yet. See ${String(f.screen)}.`);
		if (f.firstAssessment) return say("This is your first assessment, so there's nothing earlier to compare it with.");
		const rows = delta.rows ?? [];
		if (!rows.length) return say(`Nothing measured changed between ${String(f.previous)} and ${String(f.measuredOn)}.`);
		return say(
			[
				`Since the assessment of ${String(f.previous)}, the one measured ${String(f.measuredOn)} shows:`,
				...rows.map((r) => `- **${r.label}**: ${String(r.fields.before)} → ${String(r.fields.after)}`),
				"",
				`See ${String(f.screen)}.`,
			].join("\n"),
		);
	}
	const tasks = TO_TASKS.exec(text);
	if (tasks) {
		if (!assessment) return read("intelligence.readAssessment");
		if (assessment.status === "not_found")
			return say("There's no assessment yet, so there are no suggestions to turn into tasks.");
		const which = tasks[1]!.toLowerCase();
		const suggestions = (assessment.rows ?? []).filter((r) => r.fields.role !== "positive");
		const n = ORDINALS.indexOf(which);
		const words = which.split(/[^a-z]+/).filter((w) => w.length > 3);
		const point =
			n >= 0
				? suggestions[n]
				: suggestions.find((r) => words.some((w) => `${r.label} ${String(r.fields.body)}`.toLowerCase().includes(w)));
		if (!point) return say("I can't find that suggestion in your latest assessment.");
		if (SPIRITUAL.test(`${point.label} ${String(point.fields.body)}`)) return say(INTELLIGENCE_RULES.noSpiritualTasks);
		const search =
			words[0] ??
			point.label
				.split(/\s+/)
				.find((w) => w.length > 3)!
				.toLowerCase();
		const listed = lastOf(outputs, "tasks.list");
		if (!listed) return call("tasks_read", { operation: "tasks.list", input: { search } });
		const existing = listed.rows ?? [];
		if (existing.length)
			return say(
				`You already have a task for this suggestion ("${point.label}"): **${existing[0]!.label}**. I won't add a duplicate.`,
			);
		return can("tasks.create")
			? call("propose_change", { operation: "tasks.create", input: { title: point.label } })
			: say("Only an Owner or Admin can add tasks here.");
	}
	return null;
}

function organizationStep(options: LanguageModelV4CallOptions, text: string, system: string, outputs: Output[]) {
	const tools = options.tools ?? [];
	if (!tools.some((t) => t.name === "oversight_read")) return null;
	const can = (operation: string) =>
		JSON.stringify(tools.find((t) => t.name === "propose_change") ?? {}).includes(`"${operation}"`);
	const read = (operation: string, input: unknown = {}) => call("oversight_read", { operation, input });
	const plants = lastOf(outputs, "oversight.listPlants");
	const named = (name: string) =>
		(plants?.rows ?? []).find((r) => r.label.toLowerCase().includes(name.toLowerCase().replace(/^the\s+/, "")));
	const cadence = /\bsend my oversight digest (daily|weekly)\b/i;
	const asked = [CHANNEL, cadence, REGION, PEOPLE_AT, PATTERNS, PLANTS, NEAR_LAUNCH].some((r) => r.test(text));
	if (!asked) return null;
	if (proposed(outputs)) return say(REVIEW);

	const channel = CHANNEL.exec(text);
	if (channel) {
		if (!can("notifications.setPreferences"))
			return say(
				"Only an Owner or Admin of this organization gets the oversight digest, so there's nothing to change.",
			);
		const email = channel[1]!.toLowerCase() === "email";
		return call("propose_change", {
			operation: "notifications.setPreferences",
			input: {
				choices: [
					{ category: "oversight_digest", channel: "email", enabled: email },
					{ category: "oversight_digest", channel: "in_app", enabled: !email },
				],
			},
		});
	}
	if (cadence.test(text) && !can("notifications.oversightDigestCadence.set"))
		return say("Only an Owner or Admin of this organization gets the oversight digest, so there's nothing to change.");
	const region = REGION.exec(text);
	if (region) {
		if (!plants) return read("oversight.listPlants");
		const plant = named(region[1]!.trim());
		if (!plant) return say(`I can't find ${region[1]} among your plants.`);
		return say(OVERSIGHT_RULES.plantRegion(plant.label, String(plant.fields.region ?? "not set yet")));
	}
	const people = PEOPLE_AT.exec(text);
	if (people) {
		if (!plants) return read("oversight.listPlants");
		const plant = named(people[1]!.trim());
		if (!plant) return say(`I can't find ${people[1]} among your plants.`);
		const view = lastOf(outputs, "oversight.getPlant");
		if (!view) return read("oversight.getPlant", { plantId: plant.id });
		const f = view.rows?.[0]?.fields ?? {};
		const breakdown =
			typeof f.coreGroup === "number"
				? ` (core group ${String(f.coreGroup)}, launch team ${String(f.launchTeam)}, leaders ${String(f.leaders)})`
				: "";
		return say(
			[
				OVERSIGHT_RULES.totalsOnly,
				`- **${plant.label}** people: ${String(f.people)}${breakdown}`,
				`- Tasks: ${String(f.tasks)}`,
				`- Meetings: ${String(f.meetings)}`,
				`- Ministry teams: ${String(f.ministryTeams)}`,
			].join("\n"),
		);
	}
	const patterns = PATTERNS.exec(text);
	if (patterns && /\bpatterns?\b/i.test(text)) {
		const out = lastOf(outputs, "organizationIntelligence.read");
		if (!out) return read("organizationIntelligence.read", { level: "state" });
		const where = patterns[1]!.trim();
		const rows = (out.rows ?? []).filter((r) => String(r.fields.group).toLowerCase() === where.toLowerCase());
		if (!out.facts?.ranOn) return say("Network Intelligence hasn't run yet, so there are no patterns to show.");
		if (!rows.length)
			return say(
				`Network Intelligence shows no pattern across your ${where} plants. A pattern needs two or more plants with the same finding, so one plant alone isn't a pattern.`,
			);
		return say(
			[
				`Network Intelligence (run ${String(out.facts.ranOn)}) shows this across your ${where} plants:`,
				...rows.map(
					(r) =>
						`- **${r.label}**: ${String(r.fields.pattern)} Plants: ${String(r.fields.plants)}. Suggested next step: ${String(r.fields.nextStep)}`,
				),
				"",
				OVERSIGHT_RULES.noRanking,
			].join("\n"),
		);
	}
	if (PLANTS.test(text) || NEAR_LAUNCH.test(text)) {
		if (!plants) return read("oversight.listPlants");
		const rows = plants.rows ?? [];
		if (NEAR_LAUNCH.test(text)) {
			const near = rows.filter(
				(r) => typeof r.fields.daysToLaunch === "number" && r.fields.daysToLaunch >= 0 && r.fields.daysToLaunch <= 60,
			);
			const unshared = rows.filter((r) => r.fields.launch === "Not shared").map((r) => r.label);
			return say(
				[
					near.length
						? `From the Launch readiness your plants share, these have Launch Sunday within 60 days:`
						: "None of the plants that share Launch readiness has Launch Sunday within 60 days.",
					...near.map(
						(r) =>
							`- **${r.label}**: ${plural(Number(r.fields.daysToLaunch), "day", "days")} to Launch Sunday, ${String(r.fields.milestones)}${r.fields.publishedSummary ? `. Published summary: ${String(r.fields.publishedSummary)}` : ""}`,
					),
					...(unshared.length ? ["", `Not shared: ${unshared.join(", ")}.`] : []),
				].join("\n"),
			);
		}
		return say(
			[
				`Here is how your ${plural(rows.length, "plant", "plants")} look on your oversight pages:`,
				...rows.map((r) => {
					const launch =
						r.fields.launch === "Not shared"
							? "Launch: Not shared"
							: `Launch: ${String(r.fields.launch)}${r.fields.plannedDate ? ` (${String(r.fields.plannedDate)})` : ""}, ${String(r.fields.milestones)}`;
					return `- **${r.label}**: health ${String(r.fields.health)}. ${launch}.`;
				}),
				"",
				OVERSIGHT_RULES.noRanking,
			].join("\n"),
		);
	}
	return null;
}

/** The scripted model's Plant Intelligence and oversight step, or null when the request is not one of them. */
export function intelligenceStep(options: LanguageModelV4CallOptions, text: string) {
	const system = systemText(options.prompt);
	const outputs = turnOutputs(options.prompt);
	return organizationStep(options, text, system, outputs) ?? plantStep(options, text, system, outputs);
}
