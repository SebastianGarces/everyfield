// The assessment draft check, the run budget and the scripted model selection (WP-042), with no database: the run's own
// model input is the whole truth a draft is checked against.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as c from "../../../packages/contracts/src/intelligence/index.ts";
import { checkDraft, draftWithin } from "../../../packages/domain/src/intelligence/index.ts";
import {
	scriptedAssessmentDrafter,
	scriptedDraft,
	scriptedLanguageJudge,
	selectAssessmentDrafter,
} from "../../../packages/evry/src/runtime/scripted-assessment.ts";

const root = new URL("../../../", import.meta.url);
const fact = (key: string, value: c.FactEntry["value"], status: string | null = null): c.FactEntry => ({
	key,
	label: key,
	value,
	status,
});
/** A Phase 1 input with an Unknown committed-adult count (29 known, 1 to classify) and two ministry roles of eight. */
const input: c.ModelInput = {
	phase: 1,
	asOf: "2026-10-13T16:00:00.000Z",
	today: "2026-10-13",
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
const point = (body: string, citations: string[]) => ({ title: "A point to look at", body, citations });
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
	// A number is grounded only by a fact the same point cites.
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
	// A provider that never answers: four attempts on the first draft, then the run defers.
	const down = scriptedAssessmentDrafter({ failures: 99 });
	const failed = await draftWithin(down, input);
	assert.deepEqual(
		[failed.reason, failed.drafts.length, failed.usage.attempts, down.calls.length],
		["attempts", 0, 4, 4],
	);

	// Three invalid drafts and no more.
	const wrong = scriptedAssessmentDrafter({ script: (d) => ({ ...d, focus: { ...d.focus, citations: [] } }) });
	const invalid = await draftWithin(wrong, input);
	assert.deepEqual(
		[invalid.reason, invalid.drafts.length, wrong.calls.length, invalid.published],
		["invalid_drafts", 3, 3, null],
	);
	assert.deepEqual(
		wrong.calls.map((call) => call.feedback.length > 0),
		[false, true, true],
	);

	// A large input: each call's input bound is about 22,000 tokens, so a third call would pass 60,000 and is never sent.
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
	const heavy = {
		id: "heavy",
		async draft(call) {
			sent++;
			// A byte-level tokenizer bills at most one token per input byte.
			const billed = Buffer.byteLength(JSON.stringify({ input: call.input, feedback: call.feedback }));
			return { output: {}, usage: { inputTokens: billed, outputTokens: call.maxOutputTokens } };
		},
	};
	const spent = await draftWithin(heavy, large);
	assert.deepEqual([spent.reason, sent, spent.drafts.length], ["budget", 2, 2]);
	assert.ok(spent.usage.inputTokens <= c.ASSESSMENT_BUDGET.inputTokens, String(spent.usage.inputTokens));
	assert.ok(spent.usage.outputTokens <= c.ASSESSMENT_BUDGET.outputTokens);
});

test("only the scripted model can run an assessment; no environment selects a paid one", () => {
	assert.deepEqual(selectAssessmentDrafter({}), { status: "unavailable" });
	const paid = { EVRY_MODEL: "gpt-6-luna", OPENAI_API_KEY: "test-key", EVRY_MONTHLY_CAP_USD: "20" };
	assert.deepEqual(selectAssessmentDrafter(paid), { status: "unavailable" });
	assert.deepEqual(selectAssessmentDrafter({ ...paid, EVRY_SCRIPTED_MODEL: "1", VERCEL_ENV: "production" }), {
		status: "unavailable",
	});
	const scripted = selectAssessmentDrafter({ ...paid, EVRY_SCRIPTED_MODEL: "1" });
	assert.equal(scripted.status === "qualified" && scripted.drafter.id, "assessment-scripted");
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
