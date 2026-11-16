import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError } from "../../../packages/evry/node_modules/ai/dist/index.js";
import { languagePasses } from "../../../packages/contracts/src/intelligence/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import {
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { meteredAssessment } from "../../../packages/evry/src/runtime/assessment-model.ts";
import { paidModel } from "../../../packages/evry/src/runtime/model.ts";
import { callCostMicroUsd } from "../../../packages/evry/src/runtime/spend.ts";
import { scriptedAssessmentDrafter, scriptedDraft } from "../../../packages/evry/src/runtime/scripted-assessment.ts";
import { ok } from "../../support/fixture.mts";
import { CANARY, church, type Church } from "./assessment-church.mts";

type Reply = { text: string; usage?: { input: number; output: number } } | Error;
function fakeProvider(reply: (params: LanguageModelV4CallOptions, n: number) => Reply, during?: () => Promise<void>) {
	const requests: LanguageModelV4CallOptions[] = [];
	const hook = during && AsyncResource.bind(during);
	const model: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "gpt-6-luna",
		supportedUrls: {},
		async doGenerate(params) {
			requests.push(params);
			await hook?.();
			const r = reply(params, requests.length);
			if (r instanceof Error) throw r;
			return {
				content: [{ type: "text", text: r.text }],
				finishReason: { unified: "stop", raw: "stop" },
				usage: {
					inputTokens: { total: r.usage?.input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: r.usage?.output, text: undefined, reasoning: undefined },
				},
				warnings: [],
			};
		},
		async doStream() {
			throw Error("the assessment never streams");
		},
	};
	return { model, requests };
}
const sent = (params: LanguageModelV4CallOptions) => {
	const user = params.prompt.find((m) => m.role === "user")!;
	return JSON.parse((user.content[0] as { text: string }).text);
};
const grounded = (params: LanguageModelV4CallOptions) => scriptedDraft(sent(params).input);

const CAP = 20_000_000;
const { spend } = paidModel({ EVRY_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-test-not-a-key" })!;
const metered = (model: LanguageModelV4) =>
	meteredAssessment(c.db, model, "gpt-6-luna", { ...spend, capMicroUsd: CAP });

let c: Church;
const assessments = createAssessments();
const job = createAssessmentJob();
before(async () => {
	c = await church("t380p");
	await c.release("methodology-2026.10");
});
after(() => c?.database.close());

const counter = async () =>
	Number((await c.one(sql`SELECT coalesce(sum(charged_micro_usd),0)::bigint AS n FROM model_spend`)).n);
const setCounter = async (micro: number) => {
	await c.admin.execute(sql`DELETE FROM model_spend`);
	if (micro)
		await c.admin.execute(sql`INSERT INTO model_spend(month,charged_micro_usd)
			VALUES(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,${micro})`);
};
async function run(p, drafter) {
	const requestId = randomUUID();
	ok(await assessments.requestRefresh(c.db, p.actor, { requestId }));
	await runAssessmentBatch(job, c.db, drafter, 5);
	return c.one(sql`SELECT * FROM assessment_run WHERE plant_id=${p.id} AND demand_key=${"manual/" + requestId}`);
}
const view = async (p) => ok(await assessments.readAssessment(c.db, p.actor, {}));

test("INV-spend: each paid draft call reserves its worst case in the month's counter first, then settles to its usage", async () => {
	const p = await c.harvest("Metered Grace");
	await setCounter(0);
	const seen: number[] = [];
	let usage: { input: number; output: number } | undefined = { input: 1000, output: 500 };
	const fake = fakeProvider(
		(params) => ({ text: JSON.stringify(grounded(params)), usage }),
		async () => void seen.push(await counter()),
	);
	const paid = metered(fake.model);
	const first = await run(p, paid.drafter);
	assert.deepEqual([first.outcome, first.model, fake.requests.length], ["published", "gpt-6-luna", 1]);
	const settled = callCostMicroUsd(spend.price, 1000, 500);
	assert.ok(seen[0]! > settled, "the worst case was reserved before the provider saw the call");
	assert.equal(await counter(), settled, "the reservation settled to the reported usage");
	assert.equal(paid.charged(), settled);
	const rows = await c.rows(sql`SELECT month::text AS month FROM model_spend`);
	assert.equal(rows.length, 1, "one row for the month, the one Evry chat charges");

	usage = undefined;
	await run(p, paid.drafter);
	assert.equal(await counter(), seen[1], "a call that reports no usage keeps its whole reservation");
	assert.ok(seen[1]! > settled);
});

test("AC:PI-CASE-013 when the month's counter would pass the cap no call is sent, the run stores model_unavailable and the previous assessment stays", async () => {
	const p = await c.harvest("Capped Hope");
	assert.equal((await run(p, scriptedAssessmentDrafter())).outcome, "published");
	const previous = (await view(p)).current;
	await setCounter(CAP - 1);
	const fake = fakeProvider((params) => ({ text: JSON.stringify(grounded(params)), usage: { input: 1, output: 1 } }));
	const paid = metered(fake.model);
	const r = await run(p, paid.drafter);
	assert.equal(fake.requests.length, 0, "no provider call");
	assert.deepEqual([r.outcome, r.reason, r.drafts, r.result], ["failed", "model_unavailable", [], null]);
	assert.equal(await counter(), CAP - 1, "a refused reservation charges nothing");
	const v = await view(p);
	assert.deepEqual(v.current, previous, "the previous published assessment stays current");
	assert.equal(v.current.ageDays, 0);
	assert.equal(v.newest.state, "failed");
});

test("AC:PI-CASE-013 a real draft that invents a number is rejected and its violations go back to the model; a failing draft never publishes", async () => {
	const p = await c.harvest("Feedback Chapel");
	await setCounter(0);
	const invent = (params: LanguageModelV4CallOptions) =>
		JSON.stringify(grounded(params)).replace("show 30 committed adults", "show 31 committed adults");
	const fake = fakeProvider((params, n) => ({
		text: n === 1 ? invent(params) : JSON.stringify(grounded(params)),
		usage: { input: 900, output: 400 },
	}));
	const r = await run(p, metered(fake.model).drafter);
	assert.equal(r.outcome, "published");
	assert.deepEqual(
		r.drafts.map((d) => [d.ordinal, [...new Set(d.violations.map((v) => v.rule))]]),
		[
			[1, ["invented_number"]],
			[2, []],
		],
	);
	assert.deepEqual(sent(fake.requests[0]!).feedback, []);
	assert.deepEqual(sent(fake.requests[1]!).feedback, r.drafts[0].violations, "draft 2 was sent draft 1's violations");
	assert.match((await view(p)).current.focus.body + JSON.stringify(r.result), /30 committed adults/);

	const before = (await view(p)).current;
	const always = fakeProvider((params) => ({ text: invent(params), usage: { input: 900, output: 400 } }));
	const failed = await run(p, metered(always.model).drafter);
	assert.deepEqual([failed.outcome, failed.reason, failed.drafts.length], ["failed", "invalid_drafts", 3]);
	assert.deepEqual((await view(p)).current, before);
	const prose = fakeProvider((params, n) => ({
		text: n === 1 ? "Here is your assessment." : JSON.stringify(grounded(params)),
	}));
	const shaped = await run(p, metered(prose.model).drafter);
	assert.deepEqual(
		shaped.drafts.map((d) => d.violations.map((v) => v.rule)),
		[["shape"], []],
	);
});

test("AC:PI-CASE-013 a paid draft keeps the run budget: four uncertain attempts per draft, and a busy provider defers", async () => {
	const p = await c.harvest("Budget Bible");
	await setCounter(0);
	const down = fakeProvider(() => Error("connection reset"));
	const r = await run(p, metered(down.model).drafter);
	assert.deepEqual([r.outcome, r.reason, r.attempts, down.requests.length], ["failed", "attempts", 4, 4]);
	assert.ok(r.input_tokens <= 60_000 && r.output_tokens <= 12_000);

	const busy = fakeProvider(
		() =>
			new APICallError({
				message: "rate limited",
				url: "https://provider.invalid",
				requestBodyValues: {},
				statusCode: 429,
				responseHeaders: { "retry-after": "30" },
			}),
	);
	const deferred = await run(p, metered(busy.model).drafter);
	assert.deepEqual([deferred.outcome, deferred.reason, busy.requests.length], ["deferred", "busy", 1]);
});

test("AC:PI-PURPOSE-001 the provider request holds only the run's facts, passages and violations, never notes, scores or check-ins", async () => {
	const p = await c.harvest("Private Pines");
	await setCounter(0);
	const fake = fakeProvider((params, n) => ({
		text: n === 1 ? JSON.stringify({ summary: "Short." }) : JSON.stringify(grounded(params)),
		usage: { input: 900, output: 400 },
	}));
	const r = await run(p, metered(fake.model).drafter);
	assert.equal(fake.requests.length, 2);
	for (const request of fake.requests) {
		const text = JSON.stringify(request);
		for (const secret of [CANARY, "not_qualified", "struggling", "Adult 0"]) assert.ok(!text.includes(secret), secret);
		const body = sent(request);
		assert.deepEqual(Object.keys(body).sort(), ["feedback", "input"]);
		assert.deepEqual(body.input, r.model_input, "the input is exactly the stored model input");
		assert.deepEqual(
			request.prompt.map((m) => m.role),
			["system", "user"],
		);
	}
});

test("AC:PI-CASE-027 the paid judge grades plain, warm and useful wording, lists hype and pressure, and never passes a reply it can't read", async () => {
	await setCounter(0);
	const p = await c.harvest("Judged Grace");
	const draft = (await run(p, scriptedAssessmentDrafter())).drafts[0].output;
	const replies = [
		JSON.stringify({ plain: 5, warm: 4, useful: 4, failures: [] }),
		JSON.stringify({ plain: 4, warm: 4, useful: 3, failures: [{ rule: "hype", quote: "Amazing progress!" }] }),
		"The wording is lovely, a clear pass.",
		JSON.stringify({ plain: 9, warm: 4, useful: 4, failures: [] }),
	];
	const fake = fakeProvider((_, n) => ({ text: replies[n - 1]!, usage: { input: 700, output: 60 } }));
	const paid = metered(fake.model);
	const graded = await paid.judge(draft);
	assert.deepEqual(graded, { status: "graded", grade: { plain: 5, warm: 4, useful: 4, failures: [] } });
	const hype = await paid.judge(draft);
	assert.equal(hype.status === "graded" && languagePasses(hype.grade), false, "hype fails the language evaluation");
	assert.deepEqual(hype.status === "graded" && hype.grade.failures, [{ rule: "hype", quote: "Amazing progress!" }]);
	for (const unreadable of [await paid.judge(draft), await paid.judge(draft)]) {
		assert.equal(unreadable.status, "judge_failed");
		assert.match(unreadable.status === "judge_failed" ? unreadable.detail : "", /^unparseable reply/);
	}
	assert.deepEqual(sent(fake.requests[0]!), { draft }, "the judge is sent only the draft");
	assert.equal(await counter(), 4 * callCostMicroUsd(spend.price, 700, 60), "each judge call is metered");
	await setCounter(CAP);
	assert.deepEqual(await paid.judge(draft), { status: "judge_failed", detail: "model_unavailable" });
	assert.equal(fake.requests.length, 4, "no judge call past the cap");
});
