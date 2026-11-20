import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { instant, localDate } from "../../../packages/contracts/src/common/time.ts";
import * as c from "../../../packages/contracts/src/intelligence/index.ts";
import {
	checkDraft,
	draftWithin,
	NO_PROGRESS,
	type DraftProgress,
	type Drafter,
} from "../../../packages/domain/src/intelligence/index.ts";
import { insightsOf } from "../../../packages/domain/src/intelligence/assessment.ts";
import {
	scriptedAssessmentDrafter,
	scriptedDraft,
	scriptedLanguageJudge,
} from "../../../packages/evry/src/runtime/scripted-assessment.ts";

const root = new URL("../../../", import.meta.url);
const fact = (key: string, value: c.FactEntry["value"], status: string | null = null): c.FactEntry => ({
	key,
	label: key,
	value,
	status,
});
const input: c.ModelInput = {
	phase: 1,
	asOf: instant.parse("2026-10-13T16:00:00.000Z"),
	today: localDate.parse("2026-10-13"),
	rubric: "v1",
	facts: [
		fact("committedAdults.status", "unknown", "unknown"),
		fact("committedAdults.count", null, "unknown"),
		fact("committedAdults.atLeast", 29, "unknown"),
		fact("committedAdults.target", 30),
		fact("committedAdults.needsClassifying", 1),
		fact("growth.status", "on_track", "on_track"),
		fact("growth.daysSince", 5, "on_track"),
		fact("growth.current", 1),
		fact("growth.stalledDays", 28),
		fact("vision.status", "on_target", "on_target"),
		fact("vision.lastHeldOn", "2026-10-03", "on_target"),
		fact("vision.daysSince", 10, "on_target"),
		fact("vision.targetDays", 14),
		fact("coverage.status", "not_met", "not_met"),
		fact("coverage.filled", 2, "not_met"),
		fact("coverage.slots", 8),
		fact("training.status", "unknown", "unknown"),
		fact("followUps.status", "unknown", "unknown"),
		fact("humanRecords.interviews", 2),
		fact("humanRecords.interviewsLatestOn", "2026-10-03"),
	],
	passages: [],
};
const point = (body: string, citations: string[]) => ({
	title: "A point to look at",
	body,
	urgency: "watch" as const,
	citations,
});
const draft = (focus: string, citations: string[]) => ({
	summary: "This looks at your launch progress in Phase 1.",
	focus: point(focus, citations),
	supporting: [
		point("2 of 8 ministry responsibilities have someone in them.", ["coverage.filled", "coverage.slots"]),
		point("2 interviews recorded, latest Oct 3.", ["humanRecords.interviews", "humanRecords.interviewsLatestOn"]),
	],
	positives: [],
});
const rules = (focus: string, citations: string[]) => checkDraft(draft(focus, citations), input).map((v) => v.rule);

test("the plant rubric versions are pinned to the exact preserved bytes", () => {
	for (const [version, pin] of Object.entries(c.PLANT_RUBRICS))
		assert.equal(
			createHash("sha256")
				.update(readFileSync(new URL(pin.path, root)))
				.digest("hex"),
			pin.sha256,
			version,
		);
	assert.equal(c.ACTIVE_PLANT_RUBRIC, "v1");
});

test("AC:PI-CASE-012 a grounded draft passes: every number and date is a cited fact, and the Unknown count is said to be unknown", () => {
	assert.deepEqual(
		rules("Your committed-adult count is unknown. 1 of the people need a classification.", [
			"committedAdults.status",
			"committedAdults.needsClassifying",
		]),
		[],
	);
	assert.deepEqual(checkDraft(scriptedDraft(input), input), []);
});

test("AC:PI-CASE-012 an Unknown committed-adult count stated or compared with 30 is rejected, never published", () => {
	const cites = ["committedAdults.status", "committedAdults.target"];
	for (const said of [
		"You're at 30 committed adults.",
		"You're below 30 committed adults.",
		"Your committed adults are short of 30.",
		"You have 29 committed adults.",
		"Your committed adults target is met.",
	])
		assert.ok(rules(said, cites).includes("unknown_as_known"), said);
	assert.deepEqual(rules("You have at least 29 committed adults.", ["committedAdults.atLeast"]), []);
});

test("AC:PI-CASE-012 a number or date the cited facts do not hold is invented", () => {
	const cites = ["coverage.filled", "coverage.slots"];
	assert.deepEqual(rules("3 of 8 ministry responsibilities have someone.", cites), ["invented_number"]);
	assert.deepEqual(rules("2 of 8 ministry responsibilities have someone.", cites), []);
	assert.deepEqual(rules("2 of 8 ministry responsibilities have someone.", ["coverage.status"]), [
		"invented_number",
		"invented_number",
	]);
	assert.deepEqual(rules("Your last Vision meeting was on Oct 4.", ["vision.lastHeldOn"]), ["invented_date"]);
	assert.deepEqual(rules("Your last Vision meeting was on 2026-10-03.", ["vision.lastHeldOn"]), []);
});

test("AC:PI-CASE-012 every point needs a citation the run offered", () => {
	assert.deepEqual(rules("Keep going with your plans this month.", []), ["missing_citation"]);
	assert.deepEqual(rules("Keep going with your plans this month.", ["passage:7"]), ["invented_citation"]);
	assert.deepEqual(
		checkDraft({ summary: "Short" }, input).map((v) => v.rule),
		["shape"],
	);
});

test("notes, scores, check-ins, judgments, readiness verdicts and action claims are each rejected by name", () => {
	const cites = ["coverage.status"];
	const cases: [string, c.DraftRule][] = [
		["Her interview notes mention a concern.", "private_content"],
		["Their 4 C's scores are low.", "private_content"],
		["Your check-ins look hard this month.", "private_content"],
		["You seem to be struggling this season.", "private_content"],
		["The team shows real character.", "judgment"],
		["A healthy church is forming here.", "judgment"],
		["Your doctrine is sound.", "judgment"],
		["The team seems spiritually ready.", "judgment"],
		["You're ready to launch.", "readiness_verdict"],
		["You should move to Phase 2 now.", "readiness_verdict"],
		["I've created a task for each open responsibility.", "action_claim"],
		["A message has been sent to your team.", "action_claim"],
		["I moved your church to the next phase.", "action_claim"],
	];
	for (const [said, rule] of cases) assert.ok(rules(said, cites).includes(rule), `${said} -> ${rule}`);
});

test("AC:PI-CASE-013 a run stays within four attempts per draft, three drafts and 60,000 input and 12,000 output tokens", async () => {
	const down = scriptedAssessmentDrafter({ failures: 99 });
	const reserved: number[] = [];
	const failed = await draftWithin(down, input, undefined, async (p) => (reserved.push(p.usage.attempts), true));
	assert.deepEqual(
		[failed.reason, failed.progress.drafts.length, failed.progress.usage.attempts, down.calls.length],
		["attempts", 0, 4, 4],
	);
	assert.deepEqual(reserved, [1, 2, 3, 4]);
	assert.equal(failed.progress.usage.outputTokens, 12_000, "four uncertain calls are charged their full allowance");

	const wrong = scriptedAssessmentDrafter({ script: (d) => ({ ...d, focus: { ...d.focus, citations: [] } }) });
	const invalid = await draftWithin(wrong, input);
	assert.deepEqual(
		[invalid.reason, invalid.progress.drafts.length, wrong.calls.length, invalid.published],
		["invalid_drafts", 3, 3, null],
	);
	assert.deepEqual(
		wrong.calls.map((call) => call.feedback.length > 0),
		[false, true, true],
	);

	const passage = (n: number): c.Passage => ({
		key: `passage:${n}`,
		articleId: "00000000-0000-4000-8000-000000000001" as never,
		revisionId: "00000000-0000-4000-8000-000000000002" as never,
		sourceKind: "global",
		sourceId: "00000000-0000-0000-0000-000000000000",
		title: "Building commitment",
		slug: "core-group-commitment",
		section: null,
		phase: 1,
		text: "x".repeat(1600),
		textHash: "0".repeat(64),
		version: { release: "methodology-2026.10", activation: 1, revision: 1 },
	});
	const large = { ...input, passages: Array.from({ length: 12 }, (_, i) => passage(i + 1)) };
	let sent = 0;
	const heavy: Drafter = {
		id: "heavy",
		async draft(call) {
			sent++;
			const billed = Buffer.byteLength(JSON.stringify({ input: call.input, feedback: call.feedback }));
			return { output: {}, usage: { inputTokens: billed, outputTokens: call.maxOutputTokens } };
		},
	};
	const spent = await draftWithin(heavy, large);
	assert.deepEqual([spent.reason, sent, spent.progress.drafts.length], ["budget", 2, 2]);
	assert.ok(spent.progress.usage.inputTokens <= c.ASSESSMENT_BUDGET.inputTokens);
	assert.ok(spent.progress.usage.outputTokens <= c.ASSESSMENT_BUDGET.outputTokens);
	assert.deepEqual(
		spent.progress.drafts.at(-1)!.violations,
		checkDraft({}, large),
		"an exhausted run keeps the final draft's own violations",
	);
	const lost = scriptedAssessmentDrafter();
	const stopped = await draftWithin(lost, input, undefined, async () => false);
	assert.deepEqual([stopped.reason, lost.calls.length], ["lost_claim", 0]);
});

test("AC:PI-PROVIDER-001 429, 503, 503 then 200 are four accounted dispatches in one draft, resumed across waits; a fifth is never sent", async () => {
	const drafter = scriptedAssessmentDrafter({
		busy: [{ status: 429, retryAfterSeconds: 20 }, { status: 503 }, { status: 503 }],
	});
	let progress: DraftProgress = NO_PROGRESS;
	const waits: (number | null)[] = [];
	for (let i = 0; i < 3; i++) {
		const step = await draftWithin(drafter, input, progress);
		assert.equal(step.reason, "busy");
		waits.push(step.retryAfterMs);
		progress = step.progress;
	}
	assert.deepEqual(waits, [20_000, null, null]);
	const done = await draftWithin(drafter, input, progress);
	assert.deepEqual([done.reason, done.progress.usage.attempts, drafter.calls.length], [null, 4, 4]);
	assert.ok(done.published);

	const down = scriptedAssessmentDrafter({ busy: Array.from({ length: 8 }, () => ({ status: 503 as const })) });
	progress = NO_PROGRESS;
	for (let i = 0; i < 4; i++) progress = (await draftWithin(down, input, progress)).progress;
	const exhausted = await draftWithin(down, input, progress);
	assert.deepEqual([exhausted.reason, exhausted.progress.usage.attempts, down.calls.length], ["attempts", 4, 4]);
});

test("AC:PI-URGENCY-001 model urgency positive, info, watch and urgent store as info, low, medium and high; critical is never produced", () => {
	assert.deepEqual(c.SEVERITY, { positive: "info", info: "low", watch: "medium", urgent: "high" });
	const d = scriptedDraft({ ...input, passages: [] });
	const urgent = { ...d, focus: { ...d.focus, urgency: "urgent" as const } };
	assert.deepEqual(
		insightsOf(urgent).map((i) => [i.ordinal, i.role, i.severity]),
		[
			[0, "focus", "high"],
			[1, "supporting", c.SEVERITY[d.supporting[0].urgency]],
			[2, "supporting", c.SEVERITY[d.supporting[1].urgency]],
			...d.positives.map((p, n) => [3 + n, "positive", c.SEVERITY[p.urgency]]),
		],
	);
	assert.ok(!Object.values(c.SEVERITY).includes("critical" as never));
});

test("the scripted judge grades plain, warm and useful wording and lists hype and pressure as failures", () => {
	const grounded = scriptedDraft(input);
	const g = scriptedLanguageJudge(grounded);
	assert.deepEqual(g.failures, []);
	assert.ok(c.languagePasses(g));
	const pushy = { ...grounded, summary: `${grounded.summary} Amazing progress! You must act now.` };
	const bad = scriptedLanguageJudge(pushy);
	assert.deepEqual(bad.failures, [
		{ rule: "hype", quote: "Amazing" },
		{ rule: "hype", quote: "!" },
		{ rule: "pressure", quote: "You must" },
		{ rule: "pressure", quote: "act now" },
	]);
	assert.equal(c.languagePasses(bad), false);
});
