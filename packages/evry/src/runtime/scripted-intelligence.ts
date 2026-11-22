import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { MEMBER_INTELLIGENCE } from "../catalog/catalog.ts";
import { INTELLIGENCE_RULES, OVERSIGHT_RULES } from "../context/compile.ts";

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
		const which = (tasks[1] ?? "").toLowerCase();
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
				.find((w) => w.length > 3)
				?.toLowerCase();
		const listed = lastOf(outputs, "tasks.list");
		if (!listed) return call("tasks_read", { operation: "tasks.list", input: { search } });
		const existing = listed.rows ?? [];
		if (existing.length)
			return say(
				`You already have a task for this suggestion ("${point.label}"): **${existing[0]?.label}**. I won't add a duplicate.`,
			);
		return can("tasks.create")
			? call("propose_change", { operation: "tasks.create", input: { title: point.label } })
			: say("Only an Owner or Admin can add tasks here.");
	}
	return null;
}

const RANK =
	/\bwhich (?:state|region|country|plant|place)s? (?:is|are) doing (?:the )?best\b|\brank (?:our|the|my) (?:regions|states|plants|countries|places)\b/i;
const REGION_PATTERNS = /\bpatterns?\b.*?\bin the (.+?) region\b/i;
const ALL_PLANTS = /\bpatterns? across all (?:of )?our plants(?: in (?:the )?(.+?))?\s*[?.!]*$/i;
const WHERE_PATTERN = /\bwhere does the (.+?) pattern show up\b/i;
const WHERE_PLANTS = /\bwhere are (?:our|my|the) plants\b/i;
const WHICH_REGION = /\bwhich region is (.+?) in\b/i;
const NO_REGION = /\bwhich plants have no region\b/i;
const REGION_CHANGED = /\bhas (.+?)['’]s region changed\b/i;
const EARLIER = /\bwhat did network intelligence show for (.+?) in the (?:earlier|previous) run\b/i;
const CHANGED_IN = /\bwhat changed in (.+?) since the (?:last|previous|earlier) run\b/i;
const PLACE_ASKS = [
	RANK,
	REGION_PATTERNS,
	ALL_PLANTS,
	WHERE_PATTERN,
	WHERE_PLANTS,
	WHICH_REGION,
	NO_REGION,
	REGION_CHANGED,
];

const HISTORY = "organizationIntelligence.readHistory";
const LOCATIONS = "organizationIntelligence.readLocations";
const LOCATION_HISTORY = "organizationIntelligence.readLocationHistory";
const listed = (items: string[]) =>
	items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const levelOf = (place: string) =>
	/\bregion\b/i.test(place)
		? "region"
		: /^(?:the )?(?:us|usa|u\.s\.?|united states)$/i.test(place.trim())
			? "country"
			: /\bportfolio\b|^all\b/i.test(place)
				? "portfolio"
				: "state";
const rowsOf = (out: Output | undefined, kind: string) => (out?.rows ?? []).filter((r) => r.fields.row === kind);
const fieldText = (r: Row, key: string) => String(r.fields[key] ?? "");
const placeOf = (r: Row) =>
	[r.fields.city, r.fields.stateProvince, r.fields.country].filter((x) => typeof x === "string" && x).join(", ");
const findingsNote = (r: Row) => (r.fields.findings === "Not shared" ? " Findings: Not shared." : "");

function groupLines(out: Output) {
	const patterns = rowsOf(out, "pattern");
	return rowsOf(out, "group").flatMap((g) => {
		const own = patterns.filter((p) => p.fields.group === g.label && p.fields.level === g.fields.level);
		return [
			`**${g.label}** (${fieldText(g, "level")} view): [Open it in Network Intelligence](${fieldText(g, "href")})`,
			`Plants in this group: ${fieldText(g, "plantLinks")}`,
			...(own.length
				? own.map(
						(p) =>
							`- **${p.label}**: ${fieldText(p, "pattern")} Plants: ${fieldText(p, "plantLinks")}. Suggested next step: ${fieldText(p, "nextStep")}`,
					)
				: [fieldText(g, "noPattern")]),
			"",
		];
	});
}

function placeStep(
	text: string,
	outputs: Output[],
	read: (operation: string, input?: unknown) => LanguageModelV4Content[],
) {
	if (RANK.test(text)) return say(OVERSIGHT_RULES.noPlaceRanking);
	const history = outputs.filter((o) => o.operation === HISTORY);
	const locations = lastOf(outputs, LOCATIONS);
	const ranOn = (out: Output) => String(out.facts?.ranOn ?? "");
	const notRun = "Network Intelligence hasn't run yet, so there are no groups or patterns to show.";
	const plantNamed = (name: string) =>
		(locations?.rows ?? []).find((r) => r.label.toLowerCase().includes(name.trim().toLowerCase()));

	const region = REGION_PATTERNS.exec(text);
	if (region) {
		const place = (region[1] ?? "").trim();
		if (!history.length) return read(HISTORY, { level: "region", place });
		const out = history[0]!;
		if (!out.facts?.ranOn) return say(notRun);
		if (out.facts.placeNotFound) return say(String(out.facts.placeNotFound));
		if (!locations) return read(LOCATIONS);
		const unplaced = (locations.rows ?? []).filter((r) => r.fields.region === "No Region set");
		return say(
			[
				`Network Intelligence, run ${ranOn(out)}:`,
				"",
				...groupLines(out),
				String(out.facts.regionSource ?? ""),
				...(unplaced.length
					? [
							"",
							"These plants have no Region set, so they aren't in any Region group. They still count at the larger levels:",
							...unplaced.map(
								(r) =>
									`- [${r.label}](${fieldText(r, "href")})${r.fields.findings === "Not shared" ? " (Not shared)" : ""} still counts in ${listed(fieldText(r, "countsIn").split(", "))}.`,
							),
						]
					: []),
			].join("\n"),
		);
	}

	const all = ALL_PLANTS.exec(text);
	if (all) {
		const place = (all[1] ?? "").trim();
		const level = place ? levelOf(place) : "portfolio";
		if (!history.length) return read(HISTORY, { level, place: place || "Whole portfolio" });
		const out = history[0]!;
		if (!out.facts?.ranOn) return say(notRun);
		if (out.facts.placeNotFound) return say(String(out.facts.placeNotFound));
		return say(
			[`Network Intelligence, run ${ranOn(out)}:`, "", ...groupLines(out), OVERSIGHT_RULES.noRanking].join("\n"),
		);
	}

	const pattern = WHERE_PATTERN.exec(text);
	if (pattern) {
		if (!history.length) return read(HISTORY, {});
		const out = history[0]!;
		if (!out.facts?.ranOn) return say(notRun);
		const words = (pattern[1] ?? "")
			.toLowerCase()
			.split(/[^a-z]+/)
			.filter((w) => w && !["the", "a", "an"].includes(w));
		const matches = (r: Row) => words.every((w) => r.label.toLowerCase().includes(w));
		const holds = rowsOf(out, "pattern").filter(matches);
		if (!holds.length)
			return say(`Network Intelligence shows no ${pattern[1]} pattern at any level in the run of ${ranOn(out)}.`);
		const title = holds[0]!.label;
		const without = rowsOf(out, "group").filter(
			(g) => !holds.some((p) => p.fields.group === g.label && p.fields.level === g.fields.level),
		);
		return say(
			[
				`In Network Intelligence (run ${ranOn(out)}), **${title}** holds in:`,
				...holds.map(
					(p) =>
						`- ${fieldText(p, "level")}, [${fieldText(p, "group")}](${fieldText(p, "href")}): ${fieldText(p, "plantLinks")}`,
				),
				"",
				"It doesn't hold in:",
				...without.map(
					(g) =>
						`- ${fieldText(g, "level")}, ${g.label}: ${fieldText(g, "noPattern") || "a different pattern holds here."}`,
				),
				"",
				"Each level groups the plants on its own, never by adding up smaller groups.",
			].join("\n"),
		);
	}

	if (WHERE_PLANTS.test(text) || WHICH_REGION.test(text) || NO_REGION.test(text) || REGION_CHANGED.test(text)) {
		if (!locations) return read(LOCATIONS);
		const rows = locations.rows ?? [];
		if (!rows.length) return say("No plant is linked to this organization, so there are no plant locations to show.");
		const regionView = `See how they group in [Network Intelligence's Region view](${String(locations.facts?.regionView)}).`;
		const which = WHICH_REGION.exec(text) ?? REGION_CHANGED.exec(text);
		if (which) {
			const plant = plantNamed(which[1] ?? "");
			if (!plant) return say(`I can't find ${which[1]} among your plants.`);
			if (WHICH_REGION.test(text))
				return say(
					plant.fields.region === "No Region set"
						? `[${plant.label}](${fieldText(plant, "href")}) is in ${placeOf(plant)} and has no Region set. It still counts in ${listed(fieldText(plant, "countsIn").split(", "))}. ${regionView}`
						: `[${plant.label}](${fieldText(plant, "href")}) is in ${placeOf(plant)}. Its reporting Region is ${fieldText(plant, "region")}. ${regionView}`,
				);
			const saved = lastOf(outputs, LOCATION_HISTORY);
			if (!saved) return read(LOCATION_HISTORY, { plantId: plant.id });
			const kept = saved.rows ?? [];
			const link = `[${plant.label}](${fieldText(plant, "href")})`;
			if (!kept.length)
				return say(`${link} has no saved location yet, so it has no Region set and its Region hasn't changed.`);
			return say(
				[
					kept.length === 1
						? `${link} has one saved location, so its Region hasn't changed:`
						: `${link} has ${kept.length} saved locations, newest first:`,
					...kept.map(
						(l) =>
							`- ${l.label}, Region ${fieldText(l, "region")}. Took effect ${fieldText(l, "effective")}. Network Intelligence runs that used it: ${fieldText(l, "runs")}.`,
					),
					"",
					`${OVERSIGHT_RULES.earlierRunLocation} Only ${plant.label}'s Owner or Admin can change its location and Region.`,
				].join("\n"),
			);
		}
		if (NO_REGION.test(text)) {
			const none = rows.filter((r) => r.fields.region === "No Region set");
			if (!none.length) return say("Every plant has a Region set.");
			return say(
				[
					"These plants have no Region set:",
					...none.map(
						(r) =>
							`- [${r.label}](${fieldText(r, "href")}) (${placeOf(r)})${r.fields.findings === "Not shared" ? ", Not shared" : ""}: still counts in ${listed(fieldText(r, "countsIn").split(", "))}.`,
					),
					"",
					"A plant with no Region set still counts at the state, country and whole-portfolio levels. Only each plant's Owner or Admin can set its Region.",
					regionView,
				].join("\n"),
			);
		}
		return say(
			[
				`Here is where your ${plural(rows.length, "plant is", "plants are")} placed for Network Intelligence:`,
				...rows.map(
					(r) =>
						`- [${r.label}](${fieldText(r, "href")}): ${placeOf(r)}. Region: ${fieldText(r, "region")}.${findingsNote(r)}`,
				),
				"",
				regionView,
			].join("\n"),
		);
	}

	const earlier = EARLIER.exec(text);
	if (earlier) {
		const place = (earlier[1] ?? "").trim();
		const level = levelOf(place);
		if (!history.length) return read(HISTORY, { level, place });
		const runs = rowsOf(history[0], "run");
		const before = runs[1];
		if (!before) return say(runs.length ? "There's only one Network Intelligence run so far." : notRun);
		if (history.length < 2) return read(HISTORY, { level, place, runId: before.id });
		const out = history[1]!;
		if (out.facts?.placeNotFound) return say(String(out.facts.placeNotFound));
		return say(
			[`In the earlier run, on ${ranOn(out)}, Network Intelligence showed:`, "", ...groupLines(out)].join("\n"),
		);
	}

	const changed = CHANGED_IN.exec(text);
	if (changed) {
		const place = (changed[1] ?? "").trim();
		const level = levelOf(place);
		if (!history.length) return read(HISTORY, { level, place, changes: true });
		const out = history[0]!;
		if (!out.facts?.ranOn) return say(notRun);
		if (!out.facts.earlierRunId)
			return say("There's only one Network Intelligence run so far, so nothing has changed yet.");
		const group = rowsOf(out, "group")[0];
		const changes = rowsOf(out, "change");
		const earlierHref = `/network/intelligence?level=${level}&run=${String(out.facts.earlierRunId)}`;
		return say(
			[
				`Between the run on [${String(out.facts.earlierRanOn)}](${earlierHref}) and the latest run on [${ranOn(out)}](${group ? fieldText(group, "href") : `/network/intelligence?level=${level}`}), in **${group?.label ?? place}**:`,
				...(changes.length
					? changes.map((c) => `- ${fieldText(c, "change")}: **${c.label}**. Plants: ${fieldText(c, "plantLinks")}.`)
					: ["No pattern appeared or went away."]),
				...(group ? ["", `Plants in this group now: ${fieldText(group, "plantLinks")}`] : []),
			].join("\n"),
		);
	}
	return null;
}

function organizationStep(options: LanguageModelV4CallOptions, text: string, system: string, outputs: Output[]) {
	const tools = options.tools ?? [];
	if (!tools.some((t) => t.name === "oversight_read")) return null;
	if (
		JSON.stringify(tools.find((t) => t.name === "oversight_read")).includes(LOCATIONS) &&
		[...PLACE_ASKS, EARLIER, CHANGED_IN].some((r) => r.test(text))
	) {
		if (proposed(outputs)) return say(REVIEW);
		return placeStep(text, outputs, (operation, input = {}) => call("oversight_read", { operation, input }));
	}
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
		const email = channel[1]?.toLowerCase() === "email";
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
		const plant = named((region[1] ?? "").trim());
		if (!plant) return say(`I can't find ${region[1]} among your plants.`);
		return say(OVERSIGHT_RULES.plantRegion(plant.label, String(plant.fields.region ?? "not set yet")));
	}
	const people = PEOPLE_AT.exec(text);
	if (people) {
		if (!plants) return read("oversight.listPlants");
		const plant = named((people[1] ?? "").trim());
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
	if (patterns) {
		const out = lastOf(outputs, "organizationIntelligence.read");
		if (!out) return read("organizationIntelligence.read", { level: "state" });
		const where = (patterns[1] ?? "").trim();
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

export function intelligenceStep(options: LanguageModelV4CallOptions, text: string) {
	const system = systemText(options.prompt);
	const outputs = turnOutputs(options.prompt);
	return organizationStep(options, text, system, outputs) ?? plantStep(options, text, system, outputs);
}
