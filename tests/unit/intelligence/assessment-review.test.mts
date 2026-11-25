import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
	demandKind,
	draftRule,
	failureCause,
	reviewRun,
} from "../../../packages/contracts/src/intelligence/assessment.ts";
import { CAUSE, count, DEMAND, RULE, timeLabel } from "../../../apps/web/src/features/assessment-review/model.ts";
import { mount } from "../evry/fake-dom.mts";

const at = (path: string) => new URL(`../../../apps/web/src/${path}`, import.meta.url).href;
let answer: unknown;
mock.module(at("server/sign-in.ts"), {
	namedExports: {
		signIn: () => {
			throw Error("sign in");
		},
	},
});
mock.module(at("features/assessment-review/server.ts"), {
	namedExports: { assessments: {}, run: async () => answer },
});
const { ReviewListPage, ReviewRunPage, reviewMetadata } =
	await import("../../../apps/web/src/features/assessment-review/routes.tsx");

const uuid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const AT = "2026-11-01T12:00:00.000Z";
const CANARY = "Adult 01 signed in March";
const PRIVATE = {
	facts: { committedAdults: CANARY },
	input: CANARY,
	prompt: CANARY,
	text: CANARY,
	draft: CANARY,
	draftText: CANARY,
	summary: CANARY,
	note: CANARY,
	detail: CANARY,
	message: CANARY,
	plantId: CANARY,
	city: CANARY,
	reason: CANARY,
	result: CANARY,
};
const runOf = (cause: (typeof failureCause.options)[number], n: number) =>
	reviewRun.parse({
		runId: uuid(n),
		plantName: "Stone Bridge",
		demand: demandKind.options[n % demandKind.options.length],
		asOf: AT,
		settledAt: AT,
		outcome: "failed",
		cause,
		violations: draftRule.options.map((rule) => ({ rule, where: `insight.${rule}` })),
		drafts: 3,
		usage: { attempts: 1234, inputTokens: 5678, outputTokens: 91011 },
		streak: [0, 1, 2].map((s) => ({ runId: uuid(100 + s), settledAt: AT, cause })),
	});
const runs = failureCause.options.map(runOf);
const padded = (run: ReturnType<typeof runOf>) => ({
	...run,
	...PRIVATE,
	violations: run.violations.map((v) => ({ ...v, ...PRIVATE })),
	usage: { ...run.usage, ...PRIVATE },
	streak: run.streak.map((s) => ({ ...s, ...PRIVATE })),
});
async function seen(element: unknown) {
	const page = await mount(() => element, {});
	const lines = page.lines();
	await page.unmount();
	return lines;
}
const runPage = () => ReviewRunPage({ params: Promise.resolve({ runId: uuid(0) }) });

test("AC:PI-CASE-028 INV-privacy: a run held for review refuses any field beyond the plant's name, causes, rules and counters", () => {
	const run = runs[0]!;
	assert.deepEqual(reviewRun.parse(run), run);
	for (const key of Object.keys(PRIVATE)) {
		const extra = { [key]: CANARY };
		for (const bad of [
			{ ...run, ...extra },
			{ ...run, usage: { ...run.usage, ...extra } },
			{ ...run, violations: [{ ...run.violations[0], ...extra }] },
			{ ...run, streak: [{ ...run.streak[0], ...extra }] },
		])
			assert.equal(reviewRun.safeParse(bad).success, false, key);
	}
});

test("AC:PI-CASE-028 INV-privacy: the review list shows each plant's name, last failure and cause, and nothing else a reply holds", async () => {
	answer = { status: "ok", value: runs.map(padded) };
	assert.deepEqual(await seen(await ReviewListPage()), [
		"Assessment review",
		"Plants whose last three scheduled assessments failed. Each keeps showing its last good assessment.",
		"Held assessments",
		...runs.flatMap((run) => [run.plantName, `Last failed ${timeLabel(AT)}`, CAUSE[run.cause].label]),
	]);
});

test("AC:PI-CASE-028 INV-privacy: the run page shows the plant's name, the cause, the rules and the counters, and nothing else a reply holds", async () => {
	for (const run of runs) {
		answer = { status: "ok", value: padded(run) };
		assert.deepEqual(await seen(await runPage()), [
			"Breadcrumb",
			"Assessment review",
			"Run",
			run.plantName,
			"Cause",
			CAUSE[run.cause].label,
			CAUSE[run.cause].detail,
			...run.violations.flatMap((v) => [RULE[v.rule], v.where]),
			"Run",
			"Why it ran",
			DEMAND[run.demand],
			"As of",
			timeLabel(AT),
			"Ended",
			timeLabel(AT),
			"Drafts",
			"3",
			"Provider attempts",
			count(1234),
			"Input tokens",
			count(5678),
			"Output tokens",
			count(91011),
			"Failed in a row",
			...run.streak.flatMap(() => [timeLabel(AT), CAUSE[run.cause].label]),
		]);
	}
	assert.deepEqual(reviewMetadata, { title: "Assessment review", robots: { index: false, follow: false } });
});
