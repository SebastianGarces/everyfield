// The follow-up evals (WP-059): when the signed-in user asks who to follow up with, Evry never suggests the user's own
// row. Labelled requests (followups.cases.json) are scored against the real model's recorded streams
// (followups.recorded.json). The model gets Evry's real system prompt and read tools; each read is answered from the
// fixture below, whose person rows come from the real shared row helper, so the signed-in user's row carries
// `you: true` as in production. Daniel Reyes (the planter, linked to the account) is the strongest follow-up candidate:
// no next step, longest inactive, uncovered. One case signs in Lena Park, a different linked member, on the same fixture.
// A recording is keyed by the exact call the provider receives, so a changed prompt, tool list or limit has no
// recording and fails here until it is scored again on the real model:
//
//   EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/followups.test.mts
//
// Recording makes a few small paid calls inside the G-SPEND cap (D77). CI replays the file.
//   AC:EVRY-CONTEXT-BOUNDS tool selection: each request picks the operation of its case.
//   Answer correctness: a follow-up answer never names the signed-in user and names another candidate; the count
//   answer includes the user.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { stepCountIs, streamText } from "../../../packages/evry/node_modules/ai/dist/index.js";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { compileContext } from "../../../packages/evry/src/context/compile.ts";
import { LIMITS } from "../../../packages/evry/src/context/limits.ts";
import { selectQualifiedModel } from "../../../packages/evry/src/runtime/model.ts";
import { readTools } from "../../../packages/evry/src/runtime/tools.ts";
import { personRow } from "../../../packages/evry/src/catalog/person-row.ts";
import type { EvryActor } from "../../../packages/evry/src/context/actor.ts";

type Case = {
	text: string;
	operation: string;
	alsoAccepted?: string[];
	actor?: "lena";
	expect: "followUp" | "count";
	rubric: Record<string, string>;
};
type Recorded = { model: string; recordedAt: string; streams: Record<string, LanguageModelV4StreamPart[]> };
const CASES = new URL("followups.cases.json", import.meta.url);
const RECORDED = new URL("followups.recorded.json", import.meta.url);
const cases: Case[] = JSON.parse(readFileSync(CASES, "utf8"));
const record = process.env.EVRY_EVAL_RECORD === "1";
const recorded: Recorded = record
	? { model: process.env.EVRY_MODEL ?? "", recordedAt: new Date().toISOString(), streams: {} }
	: JSON.parse(readFileSync(RECORDED, "utf8"));

const PLANT = "5b6d1f0e-0000-4000-8000-000000000001";
const DANIEL = "5b6d1f0e-0000-4000-8000-0000000000c1";
const LENA = "5b6d1f0e-0000-4000-8000-0000000000c2";
const MARIA = "5b6d1f0e-0000-4000-8000-0000000000c3";
const TOM = "5b6d1f0e-0000-4000-8000-0000000000c4";
const PRIYA = "5b6d1f0e-0000-4000-8000-0000000000c5";
// A plant actor, the only fields the catalog, the prompt and the row helper read.
const actorOf = (role: "owner" | "admin", selfPersonId: string) =>
	({
		authority: {} as never,
		accountId: randomUUID(),
		session: randomUUID(),
		owner: { kind: "plant", id: PLANT },
		contextKind: "plant",
		role,
		seatId: null,
		selfPersonId,
	}) as unknown as EvryActor;
const daniel = actorOf("owner", DANIEL);
const lena = actorOf("admin", LENA);
const NOW = new Date("2026-11-02T14:00:00Z");

// Daniel Reyes (the planter) and Lena Park (an admin) are both linked to their accounts and both the strongest
// candidates: no next step, longest inactive, uncovered. Maria, Tom and Priya are the other candidates.
const PEOPLE = [
	{
		id: DANIEL,
		name: "Daniel Reyes",
		city: "Lakewood",
		stage: "following_up",
		inactivity: "alert",
		coverage: "uncovered",
	},
	{ id: LENA, name: "Lena Park", city: "Lakewood", stage: "attendee", inactivity: "alert", coverage: "uncovered" },
	{ id: MARIA, name: "Maria Lopez", city: "Parma", stage: "prospect", inactivity: "warning", coverage: "uncovered" },
	{ id: TOM, name: "Tom Baker", city: "Euclid", stage: "attendee", inactivity: "none", coverage: "covered" },
	{ id: PRIYA, name: "Priya Shah", city: "Lakewood", stage: "interviewed", inactivity: "warning", coverage: "covered" },
];
const result = (operation: string, rows: object[]) => ({
	operation,
	status: rows.length ? "available" : "not_found",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
});
/** What the reads return for the fixture, in the shape the model gets (a resultId first). */
function answerRead(who: EvryActor, operation: string, input: any, resultId: number) {
	const found = PEOPLE.filter(
		(p) => !input?.search || p.name.toLowerCase().includes(String(input.search).toLowerCase()),
	);
	const rows =
		operation === "people.listPeople"
			? found.map((p) => personRow(who, p.id, p.name, { city: p.city, stage: p.stage }))
			: operation === "people.getPipelineData"
				? found.map((p) =>
						personRow(who, p.id, p.name, {
							city: p.city,
							stage: p.stage,
							column: p.stage,
							inactivity: p.inactivity,
							coverage: p.coverage,
						}),
					)
				: [];
	return { resultId, ...result(operation, rows) };
}

/** What the provider observes of one call: a different value is a different call. */
const callKey = ({
	prompt,
	tools,
	toolChoice,
	reasoning,
	maxOutputTokens,
	providerOptions,
}: LanguageModelV4CallOptions) =>
	createHash("sha256")
		.update(JSON.stringify({ prompt, tools, toolChoice, reasoning, maxOutputTokens, providerOptions }))
		.digest("hex")
		.slice(0, 16);

function evalModel(): LanguageModelV4 {
	if (record) {
		const real = selectQualifiedModel({ ...process.env, EVRY_SCRIPTED_MODEL: "" });
		if (real.status !== "qualified") throw Error("Recording needs EVRY_MODEL and OPENAI_API_KEY");
		return {
			...real.model,
			async doStream(options) {
				const out = await real.model.doStream(options);
				const parts: LanguageModelV4StreamPart[] = [];
				recorded.streams[callKey(options)] = parts;
				return {
					...out,
					stream: out.stream.pipeThrough(
						new TransformStream({
							transform(part, controller) {
								parts.push(part);
								controller.enqueue(part);
							},
						}),
					),
				};
			},
		};
	}
	const missing = (): never => {
		throw Error("A follow-up eval call changed: record and score it again (see the top of this file)");
	};
	return {
		specificationVersion: "v4",
		provider: "recorded",
		modelId: recorded.model,
		supportedUrls: {},
		doGenerate: missing,
		async doStream(options) {
			const parts = recorded.streams[callKey(options)] ?? missing();
			return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
		},
	};
}

/** One request, as the runtime asks it: the real system prompt and read tools, up to four model steps. */
async function converse(model: LanguageModelV4, who: EvryActor, text: string) {
	const calls: { operation: string; input: any }[] = [];
	let n = 0;
	const tools = readTools(who, async (adapter, input) => {
		calls.push({ operation: adapter.operation, input });
		return answerRead(who, adapter.operation, input, ++n);
	});
	const context = compileContext({
		actor: who,
		catalog: readCatalog(who),
		history: [],
		text,
		references: [],
		now: NOW,
	});
	const run = streamText({
		model,
		system: context.system,
		messages: context.messages,
		tools,
		stopWhen: stepCountIs(4),
		maxRetries: 0,
		maxOutputTokens: LIMITS.outputTokensPerCall,
		onError: () => undefined,
	});
	return { calls, answer: await run.text };
}

test("AC:EVRY-CONTEXT-BOUNDS follow-up requests pick the right read, never suggest the signed-in user and still count them", async () => {
	assert.ok(cases.length >= 5);
	const model = evalModel();
	const failures: string[] = [];
	for (const c of cases) {
		const who = c.actor === "lena" ? lena : daniel;
		const me = c.actor === "lena" ? "Lena" : "Daniel";
		const { calls, answer } = await converse(model, who, c.text);
		const ops = calls.map((x) => x.operation);
		if (!ops.some((op) => [c.operation, ...(c.alsoAccepted ?? [])].includes(op)))
			failures.push(`${c.text}: called ${ops.join(", ") || "nothing"}`);
		if (c.expect === "followUp") {
			const points = {
				// Naming the user is fine only when Evry says the row is "you"; a line or sentence that names the user as a
				// candidate fails.
				notYou: !answer
					.split(/\n|(?<=[.!?])\s/)
					.some((part) => new RegExp(me, "i").test(part) && !/\b(you|your|yours)\b/i.test(part)),
				namesOther: ["Lena", "Daniel", "Maria", "Tom", "Priya"].some((n) => n !== me && answer.includes(n)),
			};
			for (const [point, ok] of Object.entries(points))
				if (!ok) failures.push(`${c.text} (${me}): rubric ${point} failed in "${answer}"`);
		} else if (!/\b(5|five)\b/i.test(answer)) failures.push(`${c.text}: rubric countsYou failed in "${answer}"`);
	}
	if (record) writeFileSync(RECORDED, JSON.stringify(recorded, null, "\t") + "\n");
	assert.deepEqual(failures, []);
});
