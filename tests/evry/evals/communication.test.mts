// The Communication evals (WP-028 slice 2, MAIL51-009): when the planter asks Evry to draft, schedule, move, cancel or
// replace an email, Evry picks the matching reviewed operation with sensible input; a schedule request on a message
// that is not saved proposes the draft first; "send it now" proposes nothing. Labelled requests
// (communication.cases.json) are scored against the real model's recorded streams (communication.recorded.json). The
// model gets Evry's real system prompt, read tools and propose_change tool; reads are answered from the fixture below
// and a proposal only returns a stub, so nothing is saved. A recording is keyed by the exact call the provider
// receives, so a changed prompt, tool list or limit has no recording and fails here until it is scored again:
//
//   EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/communication.test.mts
//
// Recording makes a few small paid calls inside the G-SPEND cap (D77). CI replays the file.
//   AC:EVRY-CONTEXT-BOUNDS tool selection: each request picks the operation of its case, with its input.
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
import { proposeChangeTool, readTools } from "../../../packages/evry/src/runtime/tools.ts";
import type { EvryActor } from "../../../packages/evry/src/context/actor.ts";

type Case = {
	text: string;
	operation: string;
	expect: "propose" | "draftFirst" | "none";
	input?: {
		groups?: string[];
		subjectMentions?: string;
		communicationId?: "draft" | "friday";
		sendAt?: string;
		bodyMentions?: string;
	};
	rubric: Record<string, string>;
};
type Recorded = { model: string; recordedAt: string; streams: Record<string, LanguageModelV4StreamPart[]> };
const CASES = new URL("communication.cases.json", import.meta.url);
const RECORDED = new URL("communication.recorded.json", import.meta.url);
const cases: Case[] = JSON.parse(readFileSync(CASES, "utf8"));
const record = process.env.EVRY_EVAL_RECORD === "1";
const recorded: Recorded = record
	? { model: process.env.EVRY_MODEL ?? "", recordedAt: new Date().toISOString(), streams: {} }
	: JSON.parse(readFileSync(RECORDED, "utf8"));

const PLANT = "5b6d1f0e-0000-4000-8000-000000000001";
const DRAFT = "5b6d1f0e-0000-4000-8000-0000000000d1";
const FRIDAY = "5b6d1f0e-0000-4000-8000-0000000000d2";
const SATURDAY = "5b6d1f0e-0000-4000-8000-0000000000d3";
const owner = {
	authority: {} as never,
	accountId: randomUUID(),
	session: randomUUID(),
	owner: { kind: "plant", id: PLANT },
	contextKind: "plant",
	role: "owner",
	seatId: null,
	selfPersonId: null,
} as unknown as EvryActor;
// Tuesday, 3 November 2026 (14:00 UTC): "Friday" is 2026-11-06 and "Saturday" is 2026-11-07.
const NOW = new Date("2026-11-03T14:00:00Z");

// The church's messages: one saved draft that nobody has scheduled, a message set for Friday 9:00 and one for Saturday 12:00.
const MESSAGES = [
	{ id: DRAFT, label: "Sunday's interest meeting", state: "draft", sendsAt: null, handedOff: false },
	{
		id: FRIDAY,
		label: "Friday volunteer reminder",
		state: "scheduled",
		sendsAt: "Fri 2026-11-06 09:00",
		handedOff: true,
	},
	{ id: SATURDAY, label: "Saturday cookout", state: "scheduled", sendsAt: "Sat 2026-11-07 12:00", handedOff: true },
];
function answerList(input: { subject?: string; state?: string; sendOn?: string }, resultId: number) {
	const rows = MESSAGES.filter(
		(m) =>
			(!input.state || m.state === input.state) &&
			(!input.subject || m.label.toLowerCase().includes(input.subject.toLowerCase())) &&
			(!input.sendOn || m.sendsAt?.includes(input.sendOn)),
	).map((m) => ({
		kind: "message",
		id: m.id,
		label: m.label,
		fields: { state: m.state, sendsAt: m.sendsAt, zone: "America/Chicago", handedOff: m.handedOff },
	}));
	return {
		resultId,
		operation: "communication.list",
		status: rows.length ? "available" : "not_found",
		rows,
		total: rows.length,
		page: 1,
		next: null,
		completeness: "complete",
		exclusions: ["message bodies", "email addresses", "sent messages"],
	};
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
		throw Error("A communication eval call changed: record and score it again (see the top of this file)");
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

type Proposal = { operation: string; input: any };
/** One request, as the runtime asks it: the real system prompt, read tools and propose tool, up to five model steps. */
async function converse(model: LanguageModelV4, text: string) {
	const reads: { operation: string; input: any }[] = [];
	const proposals: Proposal[] = [];
	let n = 0;
	const tools = readTools(owner, async (adapter, input) => {
		reads.push({ operation: adapter.operation, input });
		return answerList(input as never, ++n);
	});
	tools.propose_change = proposeChangeTool(owner, async (call) => {
		proposals.push(call as Proposal);
		return { proposalId: randomUUID(), status: "awaiting_approval", rows: [] };
	})!;
	const context = compileContext({
		actor: owner,
		catalog: readCatalog(owner),
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
		stopWhen: stepCountIs(5),
		maxRetries: 0,
		maxOutputTokens: LIMITS.outputTokensPerCall,
		onError: () => undefined,
	});
	return { reads, proposals, answer: await run.text };
}

const SEND_OPERATIONS = /sendReviewed|dispatchAttempt|executeResend|retryProvenFailed/;
const ID = { draft: DRAFT, friday: FRIDAY };

test("AC:EVRY-CONTEXT-BOUNDS email requests pick the matching reviewed operation; a schedule on an unsaved composition proposes the draft first; send now proposes nothing", async () => {
	assert.ok(cases.length >= 9);
	const model = evalModel();
	const failures: string[] = [];
	for (const c of cases) {
		const { proposals, answer } = await converse(model, c.text);
		const ops = proposals.map((p) => p.operation);
		if (ops.some((op) => SEND_OPERATIONS.test(op))) failures.push(`${c.text}: proposed a send (${ops.join(", ")})`);
		if (c.expect === "none") {
			if (ops.length) failures.push(`${c.text}: proposed ${ops.join(", ")}`);
			if (/\b(i|it)\s+(have\s+)?(sent|scheduled)\b/i.test(answer))
				failures.push(`${c.text}: claimed it sent mail: "${answer}"`);
			continue;
		}
		const first = proposals[0];
		if (!first || first.operation !== c.operation) {
			failures.push(`${c.text}: proposed ${ops.join(", ") || "nothing"}, wanted ${c.operation}`);
			continue;
		}
		if (c.expect === "draftFirst" && ops.includes("communication.scheduleReviewed"))
			failures.push(`${c.text}: proposed a schedule for a message that is not saved`);
		const want = c.input ?? {};
		const got = first.input ?? {};
		if (want.groups && !want.groups.every((g) => got.audience?.groups?.includes(g)))
			failures.push(`${c.text}: audience ${JSON.stringify(got.audience)} lacks ${want.groups}`);
		if (
			want.subjectMentions &&
			!String(got.subject ?? "")
				.toLowerCase()
				.includes(want.subjectMentions)
		)
			failures.push(`${c.text}: subject "${got.subject}" does not mention ${want.subjectMentions}`);
		if (want.communicationId && got.communicationId !== ID[want.communicationId])
			failures.push(`${c.text}: wrong message ${got.communicationId}`);
		if (want.sendAt && got.sendAt !== want.sendAt)
			failures.push(`${c.text}: sendAt ${got.sendAt}, wanted ${want.sendAt}`);
		if (want.bodyMentions && !String(got.body ?? "").includes(want.bodyMentions))
			failures.push(`${c.text}: body "${got.body}" does not mention ${want.bodyMentions}`);
		// A sentence that says Evry made the change, with no word that makes it a plan or a denial, claims too much.
		const done = "(?:saved|sent|scheduled|cancell?ed|moved|replaced)";
		const claims = answer
			.split(/(?<=[.!?])\s+/)
			.filter(
				(part) =>
					new RegExp(
						`\\b(?:I(?:'ve| have)?|we)\\s+${done}\\b|\\b(?:has|have) been ${done}\\b|\\b(?:is|are) now ${done}\\b`,
						"i",
					).test(part) && !/\b(nothing|not|yet|until|before|awaiting|can't|cannot)\b/i.test(part),
			);
		if (claims.length) failures.push(`${c.text}: claimed the change was made before approval: "${claims.join(" ")}"`);
	}
	if (record) writeFileSync(RECORDED, JSON.stringify(recorded, null, "\t") + "\n");
	assert.deepEqual(failures, []);
});
