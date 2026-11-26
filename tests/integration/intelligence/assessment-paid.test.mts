import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
} from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import { fakeProvider, grounded, sent } from "./fake-provider.mts";
import { APICallError } from "../../../packages/evry/node_modules/ai/dist/index.js";
import { instant } from "../../../packages/contracts/src/common/index.ts";
import { draftOutput, languagePasses } from "../../../packages/contracts/src/intelligence/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import {
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
	type Drafter,
} from "../../../packages/domain/src/intelligence/index.ts";
import { meteredAssessment, paidAssessment } from "../../../packages/evry/src/runtime/assessment-model.ts";
import { paidModel } from "../../../packages/evry/src/runtime/model.ts";
import { callCostMicroUsd } from "../../../packages/evry/src/runtime/spend.ts";
import { scriptedAssessmentDrafter, scriptedDraft } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok } from "../../support/fixture.mts";
import { CANARY, church, type Church, type ChurchPlant, type StoredRun } from "./assessment-church.mts";

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
async function run(p: ChurchPlant, drafter: Drafter) {
	const requestId = randomUUID();
	ok(await assessments.requestRefresh(c.db, p.actor, { requestId }));
	await runAssessmentBatch(job, c.db, drafter, 5);
	return c.one<StoredRun>(
		sql`SELECT * FROM assessment_run WHERE plant_id=${p.id} AND demand_key=${"manual/" + requestId}`,
	);
}
const view = async (p: ChurchPlant) => ok(await assessments.readAssessment(c.db, p.actor, {}));

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
	assert.equal(v.current!.ageDays, 0);
	assert.equal(v.newest!.state, "failed");
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
	assert.deepEqual(sent(fake.requests[1]!).feedback, r.drafts[0]!.violations, "draft 2 was sent draft 1's violations");
	assert.match((await view(p)).current!.focus.body + JSON.stringify(r.result), /30 committed adults/);

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
	const draft = draftOutput.parse((await run(p, scriptedAssessmentDrafter())).drafts[0]!.output);
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

test("AC:ASMT-010 INV-spend: the shipped paid drafter sends one HTTP request per dispatch on 429 and 5xx, and with 1000 ms left a bad number and a bad citation use it up: no request starts past the deadline", async (t) => {
	const p = await c.harvest("Deadline Chapel");
	await setCounter(0);
	await c.admin.execute(sql`DELETE FROM job WHERE kind='assessment'`);
	let clockMs = Date.now() + 5000;
	const clocked = createAssessmentJob({ clock: { now: () => instant.parse(new Date(clockMs).toISOString()) } });
	let deadline = Infinity;
	const sentAt: number[] = [];
	const problems: string[] = [];
	type Draft = ReturnType<typeof scriptedDraft>;
	const reply = (status: number, body: object, headers: Record<string, string> = {}) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
	const busy = (status: number, retryAfter?: number) => () =>
		reply(
			status,
			{ error: { message: "busy", type: "server_error", param: null, code: null } },
			retryAfter === undefined ? {} : { "retry-after": String(retryAfter) },
		);
	const drafted = (tookMs: number, change: (text: string) => string) => (body: { input: { content: unknown }[] }) => {
		clockMs += tookMs;
		const content = body.input.at(-1)!.content as { text: string }[];
		const text = change(JSON.stringify(scriptedDraft(JSON.parse(content[0]!.text).input)));
		return reply(200, {
			id: "resp_1",
			object: "response",
			created_at: 1,
			model: "gpt-6-luna",
			output: [
				{ type: "message", role: "assistant", id: "m1", content: [{ type: "output_text", text, annotations: [] }] },
			],
			usage: { input_tokens: 900, output_tokens: 400 },
		});
	};
	const queue: ((body: never) => Response)[] = [];
	t.mock.method(globalThis, "fetch", async (_: unknown, init: { body: string }) => {
		sentAt.push(deadline - clockMs);
		const next = queue.shift();
		if (!next) {
			problems.push("an unplanned request");
			return reply(400, { error: { message: "unplanned", type: "x", param: null, code: null } });
		}
		return next(JSON.parse(init.body) as never);
	});
	const { drafter } = paidAssessment(c.db, { EVRY_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-test-not-a-key" })!;
	const requestId = randomUUID();
	ok(await assessments.requestRefresh(c.db, p.actor, { requestId }));
	const stored = () =>
		c.one<StoredRun & { deadline_at: string }>(
			sql`SELECT * FROM assessment_run WHERE plant_id=${p.id} AND demand_key=${"manual/" + requestId}`,
		);

	queue.push(busy(429, 60), busy(503, 3500));
	await runAssessmentBatch(clocked, c.db, drafter, 1);
	const first = await stored();
	deadline = new Date(first.deadline_at).getTime();
	assert.deepEqual([first.outcome, first.reason, first.attempts, sentAt.length], ["deferred", "busy", 1, 1]);
	clockMs += 60_000;
	await runAssessmentBatch(clocked, c.db, drafter, 1);
	const second = await stored();
	assert.deepEqual([second.outcome, second.reason, second.attempts, sentAt.length], ["deferred", "busy", 2, 2]);

	clockMs = deadline - 1000;
	const uncited = (text: string) => {
		const d = JSON.parse(text) as Draft;
		return JSON.stringify({ ...d, focus: { ...d.focus, citations: ["not.a.fact"] } });
	};
	queue.push(
		drafted(600, (text) => text.replace("show 30 committed adults", "show 31 committed adults")),
		drafted(600, uncited),
		drafted(0, (text) => text),
	);
	await runAssessmentBatch(clocked, c.db, drafter, 1);
	const last = await stored();
	assert.deepEqual([last.outcome, last.reason, last.attempts, last.result], ["failed", "deadline", 4, null]);
	const broke = last.drafts.map((d) => d.violations.map((v) => v.rule));
	assert.equal(broke.length, 2);
	assert.ok(broke[0]!.includes("invented_number") && broke[1]!.includes("invented_citation"), JSON.stringify(broke));
	assert.deepEqual(sentAt.slice(2), [1000, 400], "no request starts past the deadline");
	assert.equal(sentAt.length, last.attempts, "one request per dispatch: the SDK retries nothing");
	assert.deepEqual(problems, []);
	assert.equal((await view(p)).current, null);
});
