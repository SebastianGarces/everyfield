import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { counted, dayText } from "@everyfield/contracts/common";
import { captured, INTELLIGENCE_RULES, MEMBER_INTELLIGENCE, OVERSIGHT_RULES, PIPELINE_RULES } from "@everyfield/evry";

type Row = { kind?: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & {
	operation?: string;
	status?: string;
	rows?: Row[];
	facts?: Record<string, unknown>;
	proposalId?: string;
	refusal?: string;
	error?: string;
};
type Step = LanguageModelV4Content[] | null;

const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];
const propose = (operation: string, input: unknown) => call("propose_change", { operation, input });

function turnOutputs(prompt: LanguageModelV4CallOptions["prompt"]): Output[] {
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

type Turn = {
	text: string;
	system: string;
	last: Output | undefined;
	of(operation: string): Output | undefined;
	all(operation: string): Output[];
	offers(operation: string): boolean;
};
function ownerOnly(t: Turn): Step {
	const rule = /Only an Owner or Admin can [^.]+\./.exec(t.system)?.[0];
	return rule ? say(rule) : null;
}
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const holds = (label: string, hint: string) =>
	hint
		.toLowerCase()
		.split(/[^a-z0-9-]+/)
		.filter((w) => w && !["the", "our", "my", "a", "program", "church", "pattern"].includes(w))
		.every((w) => label.toLowerCase().includes(w));
const text = (v: unknown) => String(v ?? "");
const rows = (out: Output | undefined, part?: string) =>
	(out?.rows ?? []).filter((r) => part === undefined || r.fields.part === part || r.fields.row === part);
const QUOTED = `["'‘“]([^"'’”]+)["'’”]`;
const DAY = String.raw`(\d{4}-\d{2}-\d{2})`;
const NAME = String.raw`([A-Z][\w'-]*(?: [A-Z][\w'-]*)*?)`;
const CARD = "I prepared a review card. Nothing changes until you approve it.";

const HISTORY = "organizationIntelligence.readHistory";
const CHURCHES = /\bwhich sending churches do we oversee\b/i;
const CHURCH = /\b(?:details of|tell me about) (?:the )?sending church (.+?)\s*[?.!]*$/i;
const OVER_TIME = /\bhow has (.+?)['’]s assessment changed over time\b/i;
const PLANT_RUN = /\bwhat did (.+?)['’]s (?:last|latest|earlier) assessment say\b/i;
const REFRESH_PLANT = /\brefresh (?!our\b|the\b|plant\b|network\b)(.+?)['’]s assessment\b/i;
const REFRESH_NETWORK = /\brefresh network intelligence\b/i;
const RATE = /\brate the (.+?) pattern in (.+?) (useful|not useful)\b/i;

const concernsLine = (r: Row) => `Now: health ${text(r.fields.health)}, released concerns ${text(r.fields.concerns)}.`;

function oversightStep(t: Turn): Step {
	const read = (operation: string, input: unknown = {}) => call("oversight_read", { operation, input });
	if (!t.offers("oversight.listPlants")) return null;
	const church = CHURCH.exec(t.text);
	if (CHURCHES.test(t.text) || church) {
		if (!t.offers("oversight.listSendingChurches"))
			return say("Only a network's Sending churches page lists sending churches, so there is nothing to show here.");
		const list = t.of("oversight.listSendingChurches");
		if (!list) return read("oversight.listSendingChurches");
		if (church) {
			const found = rows(list).find((r) => holds(r.label, captured(church, 1)));
			if (!found) return say(`No sending church called ${church[1]} is linked to your network.`);
			const detail = t.of("oversight.getSendingChurch");
			if (!detail) return read("oversight.getSendingChurch", { churchId: found.id });
			const plants = rows(detail);
			return say(
				[
					`[${text(detail.facts?.church)}](${text(detail.facts?.href)}) has ${counted(plants.length, "plant")} linked to both of you:`,
					...plants.map(
						(p) =>
							`- [${p.label}](${text(p.fields.href)}): health ${text(p.fields.health)}, ${p.fields.launchSunday ? `Launch Sunday ${text(p.fields.launchSunday)}` : `${text(p.fields.milestone)}, ${text(p.fields.milestoneProgress)}`}, linked: ${text(p.fields.linked)}.`,
					),
				].join("\n"),
			);
		}
		const churches = rows(list);
		return say(
			[
				`Your network has ${counted(churches.length, "linked sending church", "linked sending churches")}:`,
				...churches.map((c) => `- [${c.label}](${text(c.fields.href)}): ${counted(Number(c.fields.plants), "plant")}`),
				`Pending invitations: ${text(list.facts?.pendingInvitations)}.`,
			].join("\n"),
		);
	}
	const plants = t.of("oversight.listPlants");
	const plantNamed = (name: string) => rows(plants).find((r) => holds(r.label, name));
	const refreshed = REFRESH_PLANT.exec(t.text);
	if (refreshed || REFRESH_NETWORK.test(t.text)) {
		if (!t.offers("organizationIntelligence.requestRefresh")) return say(OVERSIGHT_RULES.refreshOwnerOnly);
		if (t.last?.proposalId)
			return say(
				refreshed
					? `${CARD} It refreshes Network Intelligence from what plants share now. Only ${refreshed[1]} can ask for its own assessment.`
					: CARD,
			);
		if (!refreshed) return propose("organizationIntelligence.requestRefresh", {});
		if (!plants) return read("oversight.listPlants");
		const plant = plantNamed(captured(refreshed, 1));
		if (!plant) return say(`I can't find ${refreshed[1]} among your plants.`);
		return propose("organizationIntelligence.requestRefresh", { plantId: plant.id });
	}
	const rate = RATE.exec(t.text);
	if (rate && t.offers("organizationIntelligence.submitFeedback")) {
		if (t.last?.refusal) return say(t.last.refusal);
		if (t.last?.proposalId) return say(CARD);
		const place = captured(rate, 2).trim();
		const history = t.of(HISTORY);
		if (!history) return read(HISTORY, { level: "state", place });
		const pattern = rows(history, "pattern").find((r) => holds(r.label, captured(rate, 1)));
		if (!pattern) return say(`Network Intelligence shows no ${rate[1]} pattern in ${place} that you can rate.`);
		return propose("organizationIntelligence.submitFeedback", {
			runId: history.facts?.runId,
			patternKey: pattern.fields.patternKey,
			rating: same(captured(rate, 3), "useful") ? "useful" : "not_useful",
		});
	}
	const asked = OVER_TIME.exec(t.text) ?? PLANT_RUN.exec(t.text);
	if (!asked) return null;
	if (!plants) return read("oversight.listPlants");
	const plant = plantNamed(captured(asked, 1));
	if (!plant) return say(`I can't find ${asked[1]} among your plants.`);
	const view = t.of("oversight.getPlant");
	if (!view) return read("oversight.getPlant", { plantId: plant.id });
	const histories = t.all(HISTORY);
	const runs = rows(histories[0], "run").slice(0, 3);
	if (!histories.length) return read(HISTORY, { level: "portfolio" });
	const next = runs[histories.length];
	if (next) return read(HISTORY, { level: "portfolio", runId: next.id });
	const [now] = rows(view);
	return say(
		[
			OVERSIGHT_RULES.releasedOnly,
			`**${plant.label}**. ${now ? concernsLine(now) : ""}`,
			...histories.map((h) => {
				const named = rows(h, "pattern").filter((p) => text(p.fields.plants).split(", ").includes(plant.label));
				return `- Network Intelligence run ${text(h.facts?.ranOn)}: ${named.length ? named.map((p) => p.label).join("; ") : "no pattern names it"}.`;
			}),
		].join("\n"),
	);
}

const TRENDS = /\bhow have our assessments changed over time\b/i;
const RUN = /\bwhat did (?:our|the) (earlier|previous|latest) assessment say\b/i;
const START = /\bwhere (?:do|should) we start\b/i;
const OWN = /\bwhat rating did i give\b/i;
const REGION = /\bour reporting region is wrong\b|\bchange our reporting region\b/i;
const REGION_TO = /\b(?:it should be|to) ([A-Z][\w .'-]+?)(?:, ([A-Z]{2}|[A-Z][a-z]+(?: [A-Z][a-z]+)?))?\s*[.!?]*$/;

function plantStep(t: Turn): Step {
	const read = (operation: string, input: unknown = {}) => call("intelligence_read", { operation, input });
	if (t.offers("oversight.listPlants")) return null;
	if (REGION.test(t.text)) {
		if (!t.offers("geography.listReportingRegionCandidates")) return ownerOnly(t);
		if (t.last?.refusal) return say(t.last.refusal);
		if (t.last?.proposalId) return say(CARD);
		const to = REGION_TO.exec(t.text);
		const stated = to ? { city: captured(to, 1), ...(to[2] && { stateProvince: to[2] }) } : {};
		const list = t.of("geography.listReportingRegionCandidates");
		if (!list) return call("geography_read", { operation: "geography.listReportingRegionCandidates", input: stated });
		const found = rows(list);
		const [only] = found;
		if (!only)
			return say(
				`The official Region list has no Region for ${text(list.facts?.place)}, so there is nothing to change it to. Nothing changed.`,
			);
		if (found.length > 1)
			return say(
				`More than one Region fits ${text(list.facts?.place)}: ${found.map((r) => r.label).join("; ")}. Which one is it?`,
			);
		return propose("organizations.correctReportingLocation", { ...stated, regionItemId: only.id });
	}
	const run = RUN.exec(t.text);
	if (!(TRENDS.test(t.text) || run || START.test(t.text) || OWN.test(t.text))) return null;
	if (!t.offers("intelligence.readAssessmentHistory"))
		return t.system.includes(MEMBER_INTELLIGENCE) ? say(MEMBER_INTELLIGENCE) : say(INTELLIGENCE_RULES.ownerOnly);
	const newer = (out: Output) => (out.facts?.newer ? `${text(out.facts.newer)} ${text(out.facts.published)}` : "");
	if (START.test(t.text)) {
		const out = t.of("intelligence.readColdStartGuidance");
		if (!out) return read("intelligence.readColdStartGuidance");
		const f = out.facts ?? {};
		if (f.assessed) return say(`You have an assessment, measured ${text(f.measuredOn)}. See ${text(f.screen)}.`);
		return say(
			[
				`**${text(f.title)}.** ${text(f.body)} ${text(f.results)}`,
				...rows(out).map((r, n) => `${n + 1}. [${r.label}](${text(r.fields.href)}): ${text(r.fields.detail)}`),
				...(f.noSteps ? [text(f.noSteps)] : []),
			].join("\n"),
		);
	}
	if (OWN.test(t.text)) {
		const out = t.of("intelligence.readOwnFeedback");
		if (!out) return read("intelligence.readOwnFeedback");
		if (!rows(out).length) return say("You gave no rating to a Plant Intelligence finding.");
		return say(
			[
				"Your ratings:",
				...rows(out).map(
					(r) =>
						`- **${r.label}** (assessment measured ${text(r.fields.assessment)}): ${text(r.fields.rating)}${r.fields.comment ? `, "${text(r.fields.comment)}"` : ""}, rated ${text(r.fields.ratedOn)}`,
				),
			].join("\n"),
		);
	}
	const history = t.of("intelligence.readAssessmentHistory");
	if (!history) return read("intelligence.readAssessmentHistory");
	const runs = rows(history);
	if (!runs.length) return say("No assessment has been published yet.");
	if (TRENDS.test(t.text))
		return say(
			[
				...(newer(history) ? [newer(history)] : []),
				"Your published assessments, newest first:",
				...runs.map(
					(r) =>
						`- ${r.label} (${text(r.fields.phase)}): ${Object.entries(r.fields)
							.filter(([k]) => k !== "latest" && k !== "phase")
							.map(([k, v]) => `${k} ${text(v)}`)
							.join(", ")}`,
				),
				`See ${text(history.facts?.screen)}.`,
			].join("\n"),
		);
	const chosen = run && same(captured(run, 1), "latest") ? runs[0] : runs[1];
	if (!chosen) return say("There is only one published assessment, so there is no earlier one.");
	const out = t.of("intelligence.readAssessmentRun");
	if (!out) return read("intelligence.readAssessmentRun", { runId: chosen.id });
	const f = out.facts ?? {};
	return say(
		[
			...(newer(out) ? [newer(out)] : []),
			`The assessment measured ${text(f.measuredOn)} (Phase ${text(f.phase)}): ${text(f.summary)}`,
			...rows(out)
				.filter((r) => r.fields.role)
				.map(
					(r) =>
						`- **${r.label}** (${text(r.fields.severity)}): ${text(r.fields.body)} Cites: ${text(r.fields.cites)}.`,
				),
			...rows(out)
				.filter((r) => r.fields.standing)
				.map((r) => `- ${r.label}: ${text(r.fields.standing)}`),
			...rows(out)
				.filter((r) => r.kind === "criterion")
				.map((r) => `- ${r.label}: ${text(r.fields.status)}`),
		].join("\n"),
	);
}

const GOALS = /\bwhat are our sending goals\b/i;
const CONVERSATIONS = /\bhow many leadership conversations\b/i;
const ADD_GOAL =
	/\badd a sending goal:? develop (\d+) leaders and plant (\d+) churches by (\d{4}) because (.+?)(?:,? counting from (\d{4}-\d{2}-\d{2}))?\s*[.]?$/i;
const EDIT_GOAL = /\bchange our (\d{4}) goal to (\d+) leaders(?:,? counting from (\d{4}-\d{2}-\d{2}))?/i;
const RENAME = /\brename the (.+?) stage to (.+?)(?: and |\s*[.]?$)/i;
const ADD_STAGE = /\badd a stage called (.+?) after (.+?)(?: and |\s*[.]?$)/i;
const REMOVE_STAGE = /\bremove the (.+?) stage\b/i;
const REORDER = /\bput the (.+?) stage before (.+?)(?: and |\s*[.]?$)/i;

function pipelineStages(t: Turn, board: Output) {
	const now = rows(board).filter((r) => r.kind === "stage");
	const stages: { stageId?: string; label: string; kind?: string }[] = now.map((r) => ({
		stageId: r.id,
		label: r.label,
	}));
	const remove: string[] = [];
	const at = (label: string) => stages.findIndex((s) => same(s.label, label));
	const renamed = RENAME.exec(t.text);
	if (renamed) {
		const s = stages[at(captured(renamed, 1))];
		if (s) s.label = captured(renamed, 2).trim();
	}
	const moved = REORDER.exec(t.text);
	if (moved) {
		const [s] = stages.splice(at(captured(moved, 1)), 1);
		if (s) stages.splice(at(captured(moved, 2)), 0, s);
	}
	const added = ADD_STAGE.exec(t.text);
	if (added) stages.splice(at(captured(added, 2)) + 1, 0, { label: captured(added, 1).trim() });
	const gone = REMOVE_STAGE.exec(t.text);
	if (gone) {
		const [s] = stages.splice(at(captured(gone, 1)), 1);
		if (s?.stageId) remove.push(s.stageId);
	}
	return { stages, ...(remove.length && { remove }) };
}

function goalStep(t: Turn): Step {
	const read = (operation: string) => call("pipeline_read", { operation, input: {} });
	if (GOALS.test(t.text)) {
		const out = t.of("pipeline.readGoals");
		if (!out) return read("pipeline.readGoals");
		return say(
			[
				`Your sending goals as of ${dayText(text(out.facts?.asOf))}:`,
				...rows(out).map(
					(r) =>
						`- **${r.label}**: ${text(r.fields.rationale)} Counting from ${dayText(text(r.fields.countingFrom))}: ${r.fields.counts ? text(r.fields.counts) : "no counts chosen"}.`,
				),
				`Plants sent: ${text(out.facts?.plantsSent)}.`,
			].join("\n"),
		);
	}
	if (CONVERSATIONS.test(t.text)) {
		const out = t.of("pipeline.readConversationCounts");
		if (!out) return read("pipeline.readConversationCounts");
		const line = (period: string) =>
			rows(out)
				.filter((r) => r.fields.period === period)
				.map((r) => `${r.label}: ${text(r.fields.count)}`)
				.join(", ");
		return say(`Leadership conversations by month: ${line("month")}. By quarter: ${line("quarter")}.`);
	}
	const add = ADD_GOAL.exec(t.text);
	const edit = EDIT_GOAL.exec(t.text);
	const stages = [RENAME, ADD_STAGE, REMOVE_STAGE, REORDER].some((r) => r.test(t.text));
	if (!(add || edit || stages)) return null;
	if (!t.offers(stages ? "pipeline.saveStages" : "pipeline.saveGoal")) return ownerOnly(t);
	if (t.last?.refusal) return say(t.last.refusal);
	if (t.last?.proposalId) return say(CARD);
	if (stages) {
		const board = t.of("pipeline.listPeople");
		return board ? propose("pipeline.saveStages", pipelineStages(t, board)) : read("pipeline.listPeople");
	}
	if (add)
		return propose("pipeline.saveGoal", {
			leaderTarget: Number(add[1]),
			plantTarget: Number(add[2]),
			targetYear: Number(add[3]),
			rationale: captured(add, 4),
			...(add[5] && { countingFrom: add[5] }),
		});
	const goals = t.of("pipeline.readGoals");
	if (!goals) return read("pipeline.readGoals");
	const goal = rows(goals).find((r) => text(r.fields.targetYear) === edit?.[1]);
	if (!goal || !edit) return say(`You have no sending goal for ${edit?.[1]}.`);
	return propose("pipeline.saveGoal", {
		goalId: goal.id,
		leaderTarget: Number(edit[2]),
		...(edit[3] && { countingFrom: edit[3] }),
	});
}

const ENROLL = new RegExp(
	String.raw`\benroll ${NAME} in the (.+?) in the (.+? cohort) from ${DAY} to ${DAY}(?:,? next meeting ${DAY} at (\d{2}:\d{2}))?`,
	"i",
);
const PROGRESS = new RegExp(String.raw`\bwhat milestones has ${NAME} finished in the (.+?)\s*[?.!]*$`, "i");
const COHORT = new RegExp(String.raw`\bchange ${NAME}['’]s cohort in the (.+?) to (.+?)\s*[.]?$`, "i");
const END = new RegExp(String.raw`\bchange ${NAME}['’]s expected end in the (.+?) to ${DAY}`, "i");
const MEETING = new RegExp(String.raw`\bset ${NAME}['’]s next meeting in the (.+?) to ${DAY} at (\d{2}:\d{2})`, "i");
const STAGE = new RegExp(String.raw`\bchange ${NAME}['’]s program stage in the (.+?) to (.+?)\s*[.]?$`, "i");
const APPLY = new RegExp(String.raw`\bapply the (?:new|current) version of the (.+?) to ${NAME}\s*[.!]?$`, "i");
const CONFIRM = new RegExp(String.raw`\bconfirm ${NAME}['’]s milestone ${QUOTED} in the (.+?)\s*[.!]?$`, "i");
const RECORD = new RegExp(String.raw`\brecord that ${NAME} finished ${QUOTED} in the (.+?) on ${DAY}`, "i");

const END_AS = new RegExp(
	String.raw`\b(?:[Mm]ark|[Ee]nd) ${NAME}(?:['’]s enrollment)?(?: in the (.+?))? as (completed|withdrawn)\s*[.!]?$`,
);
const ENDED = new RegExp(
	String.raw`(?:^|[.,] |\band )${NAME} (?:has )?(finished|completed|dropped out of|withdrew from) the (.+?)\s*[.!]?$`,
);
const LEFT = new RegExp(String.raw`(?:^|[.,] |\band )${NAME} (?:has )?(dropped out|withdrew)\s*[.!]?$`);
const END_OPEN = new RegExp(String.raw`\b[Ee]nd ${NAME}['’]s enrollment in the (.+?)\s*[.!]?$`);

type Asked = {
	program: string | null;
	person: string;
	operation: string | null;
	ends?: true;
	input(e: Output): object | string;
};
function askedEnd(t: string): Asked | null {
	const as = END_AS.exec(t);
	const said = ENDED.exec(t) ?? LEFT.exec(t);
	const open = as ? null : END_OPEN.exec(t);
	const m = as ?? said ?? open;
	if (!m) return null;
	const words = as?.[3] ?? said?.[2];
	return {
		person: captured(m, 1),
		program: (as ? as[2] : said ? said[3] : open?.[2]) ?? null,
		operation: "development.updateEnrollment",
		ends: true,
		input: () =>
			words ? { outcome: /^(finished|completed)/.test(words) ? "completed" : "withdrawn" } : PIPELINE_RULES.unclearEnd,
	};
}
function askedEnrollment(t: string): Asked | null {
	const m = (r: RegExp) => r.exec(t);
	const progress = m(PROGRESS);
	if (progress)
		return { person: captured(progress, 1), program: captured(progress, 2), operation: null, input: () => ({}) };
	const changes = (r: RegExp, of: (x: RegExpExecArray, e: Output) => object | string): Asked | null => {
		const x = m(r);
		return (
			x && {
				person: captured(x, 1),
				program: captured(x, 2),
				operation: "development.updateEnrollment",
				input: (e) => {
					const c = of(x, e);
					return typeof c === "string" ? c : { changes: c };
				},
			}
		);
	};
	const apply = m(APPLY);
	if (apply)
		return {
			person: captured(apply, 2),
			program: captured(apply, 1),
			operation: "development.applyVersion",
			input: () => ({}),
		};
	const milestone = (e: Output, title: string) => rows(e, "milestone").find((r) => same(r.label, title));
	const confirm = m(CONFIRM);
	if (confirm)
		return {
			person: captured(confirm, 1),
			program: captured(confirm, 3),
			operation: "development.confirmMilestone",
			input: (e) => {
				const found = milestone(e, captured(confirm, 2));
				return found ? { milestoneId: found.id } : `There is no milestone called ${captured(confirm, 2)}.`;
			},
		};
	const record = m(RECORD);
	if (record)
		return {
			person: captured(record, 1),
			program: captured(record, 3),
			operation: "development.completeMilestone",
			input: (e) => {
				const found = milestone(e, captured(record, 2));
				return found
					? { milestoneId: found.id, completedOn: record[4] }
					: `There is no milestone called ${captured(record, 2)}.`;
			},
		};
	return (
		changes(COHORT, (x) => ({ cohort: captured(x, 3) })) ??
		changes(END, (x) => ({ expectedEndOn: captured(x, 3) })) ??
		changes(MEETING, (x) => ({ nextMeetingAt: `${captured(x, 3)}T${captured(x, 4)}:00` })) ??
		changes(STAGE, (x, e) => {
			const stage = rows(e, "stage").find((r) => same(r.label, captured(x, 3)));
			return stage ? { stageId: stage.id } : `That version has no stage called ${captured(x, 3)}.`;
		}) ??
		askedEnd(t)
	);
}

function programStep(t: Turn): Step {
	const read = (input: object) => call("pipeline_read", { operation: "development.readProgram", input });
	const enroll = ENROLL.exec(t.text);
	const asked = askedEnrollment(t.text);
	if (!(enroll || asked)) return null;
	if (t.last?.refusal) return say(t.last.refusal);
	if (t.last?.proposalId) return say(CARD);
	if (enroll && !t.offers("development.enroll")) return ownerOnly(t);
	const outs = t.all("development.readProgram");
	const list = outs.find((o) => !o.facts?.programId);
	if (!list) return read({});
	if (asked && asked.program === null)
		return say(
			`Which program? ${text(list.facts?.organization)} has ${rows(list, "program")
				.map((r) => r.label)
				.join(", ")}. Nothing was prepared.`,
		);
	const hint = enroll ? captured(enroll, 2) : (asked?.program ?? "");
	const program = rows(list, "program").find((r) => holds(`${r.label} ${text(r.fields.kind)}`, hint));
	if (!program)
		return say(
			`${text(list.facts?.organization)} has no program like that. Its programs: ${rows(list, "program")
				.map((r) => r.label)
				.join(", ")}.`,
		);
	const detail = outs.find((o) => o.facts?.programId && !o.facts.enrollmentId);
	if (!detail) return read({ programId: program.id, enrolled: true });
	const who = enroll ? captured(enroll, 1) : (asked?.person ?? "");
	const named = (part: string) => rows(detail, part).find((r) => r.label.toLowerCase().startsWith(who.toLowerCase()));
	if (enroll) {
		const person = named("candidate");
		if (!person) return say(`No one called ${who} is in your pipeline.`);
		return propose("development.enroll", {
			programId: program.id,
			personId: person.id,
			cohort: captured(enroll, 3),
			startedOn: captured(enroll, 4),
			expectedEndOn: captured(enroll, 5),
			...(enroll[6] && { nextMeetingAt: `${enroll[6]}T${enroll[7]}:00` }),
		});
	}
	if (!asked) return null;
	const enrollment = named("enrollment");
	if (!enrollment) return say(`I can't see an enrollment for ${who} in ${program.label}.`);
	const alike = rows(detail, "enrollment").filter(
		(r) => r.fields.status === "Active" && r.label.toLowerCase().startsWith(who.toLowerCase()),
	);
	if (asked.ends && alike.length > 1)
		return say(`Which person: ${alike.map((r) => r.label).join(" or ")}? Nothing was prepared.`);
	const e = outs.find((o) => o.facts?.enrollmentId);
	if (!e) return read({ enrollmentId: enrollment.id });
	if (!asked.operation)
		return say(
			[
				`${enrollment.label} in ${program.label}, Version ${text(e.facts?.version)}, stage ${text(e.facts?.stage)}:`,
				...rows(e, "milestone").map((r) => `- ${r.label}: ${text(r.fields.progress)}`),
			].join("\n"),
		);
	if (e.facts?.directedByYou !== true)
		return say(
			`${PIPELINE_RULES.enrollmentDirectorOnly} ${program.label} is directed by ${text(e.facts?.director)}, so I prepared nothing.`,
		);
	if (asked.ends && e.facts.status !== "Active")
		return say(
			`${enrollment.label}'s enrollment in ${program.label} has ended as ${text(e.facts.status)}. Nothing was prepared.`,
		);
	const input = asked.input(e);
	return typeof input === "string" ? say(input) : propose(asked.operation, { enrollmentId: enrollment.id, ...input });
}

export function networkStep(options: LanguageModelV4CallOptions, asked: string): Step {
	const tools = JSON.stringify(options.tools ?? []);
	const outputs = turnOutputs(options.prompt);
	const t: Turn = {
		text: asked,
		system: options.prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n"),
		last: outputs.at(-1),
		of: (operation) => outputs.findLast((o) => o.operation === operation),
		all: (operation) => outputs.filter((o) => o.operation === operation),
		offers: (operation) => tools.includes(`"${operation}"`),
	};
	const step =
		oversightStep(t) ?? plantStep(t) ?? (t.offers("pipeline.listPeople") ? (goalStep(t) ?? programStep(t)) : null);
	if (step && t.last?.error) return say(`I couldn't do that (${t.last.error}). Nothing was prepared.`);
	return step;
}
