// One golden-set conversation, asked the way runTurn (packages/evry/src/runtime/turn.ts) asks it: evry.classifyRequest
// first (a pastoral or capabilities request gets the runtime's fixed answer and no tool), then the real system prompt
// (compileContext over the real catalog) with the same three kinds of model tool the turn gives this actor: the bounded
// read tools (readTools), select_returned_rows and propose_change. Reads are answered by the in-memory church
// (golden-church.mts); propose_change only prepares a review card, as in production, and nothing is ever applied.
// The tool definitions below copy turn.ts's descriptions and schemas, so a change there shows up here as a changed
// provider call with no recording.
//
// Each provider call is recorded by the hash of what the provider receives (prompt, tools, tool choice, reasoning,
// output limit, response format, provider options). Replay serves the recording and makes no network call.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
	generateText,
	Output,
	stepCountIs,
	streamText,
	tool,
	type ToolSet,
} from "../../../packages/evry/node_modules/ai/dist/index.js";
import { z } from "../../../packages/evry/node_modules/zod/index.js";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import type { SourceResult } from "../../../packages/evry/src/catalog/types.ts";
import {
	classifyRequest,
	compileContext,
	describeCatalog,
	PASTORAL_BOUNDARY,
} from "../../../packages/evry/src/context/compile.ts";
import { scrub } from "../../../packages/evry/src/context/errors.ts";
import { LIMITS } from "../../../packages/evry/src/context/limits.ts";
import { selectQualifiedModel, type Price } from "../../../packages/evry/src/runtime/model.ts";
import { callCostMicroUsd } from "../../../packages/evry/src/runtime/spend.ts";
import { readTools } from "../../../packages/evry/src/runtime/tools.ts";
import { allowedWrites, REVIEW_MINUTES } from "../../../packages/evry/src/proposals/store.ts";
import type { ConversationEvent } from "../../../packages/evry/src/conversations/store.ts";
import { ACTORS, NOW, answerRead, prepareReview, type ActorName } from "./golden-church.mts";

type Usage = { input: number; output: number };
type Call =
	| { kind: "stream"; parts: LanguageModelV4StreamPart[]; usage: Usage }
	| { kind: "generate"; content: LanguageModelV4Content[]; usage: Usage };
export type Recorded = {
	model: string;
	recordedAt: string;
	/** What the last recording run that made new calls paid, and what recording every call here afresh would cost. */
	spend: { newCalls: number; newMicroUsd: number; allCalls: number; allMicroUsd: number };
	calls: Record<string, Call>;
};

/** EVRY_EVAL_RECORD=1 records the calls a file does not hold yet (a new or changed case) and drops unused ones. */
export const recording = process.env.EVRY_EVAL_RECORD === "1";

/** What the provider observes of one call: a different value is a different call. */
export const callKey = ({
	prompt,
	tools,
	toolChoice,
	reasoning,
	maxOutputTokens,
	responseFormat,
	providerOptions,
}: LanguageModelV4CallOptions) =>
	createHash("sha256")
		.update(JSON.stringify({ prompt, tools, toolChoice, reasoning, maxOutputTokens, responseFormat, providerOptions }))
		.digest("hex")
		.slice(0, 16);

const usageOf = (u: LanguageModelV4Usage | undefined): Usage => ({
	input: u?.inputTokens.total ?? 0,
	output: u?.outputTokens.total ?? 0,
});
const zeroUsage: LanguageModelV4Usage = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
};

export class MissingRecording extends Error {}

const DELTAS = new Set(["text-delta", "reasoning-delta", "tool-input-delta"]);
function merged(parts: LanguageModelV4StreamPart[]) {
	const out: LanguageModelV4StreamPart[] = [];
	for (const part of parts) {
		const last = out.at(-1) as { type: string; id?: string; delta?: string } | undefined;
		const next = part as { type: string; id?: string; delta?: string };
		if (
			last &&
			DELTAS.has(next.type) &&
			last.type === next.type &&
			last.id === next.id &&
			!("providerMetadata" in next)
		)
			out[out.length - 1] = { ...last, delta: last.delta! + next.delta! } as LanguageModelV4StreamPart;
		else out.push(part);
	}
	return out;
}

/**
 * The recorded calls of one eval file, `<name>.recorded.json` in this folder. `model(keys)` serves recorded calls and,
 * only while recording, asks the real model for new ones; `save()` writes the calls this run used (a recording run only).
 */
export function recorder(name: string) {
	const file = new URL(`${name}.recorded.json`, import.meta.url);
	let loaded: Recorded | null = (() => {
		try {
			return JSON.parse(readFileSync(file, "utf8"));
		} catch {
			// No file yet: replay fails each call as unrecorded; a recording run starts one.
			return null;
		}
	})();
	const used = new Map<string, Call>();
	const fresh: Usage[] = [];
	let price: Price | null = null;
	let real: LanguageModelV4 | null = null;
	function realModel() {
		if (real) return real;
		const selected = selectQualifiedModel({ ...process.env, EVRY_SCRIPTED_MODEL: "" });
		if (selected.status !== "qualified" || !selected.spend)
			throw Error("Recording needs EVRY_MODEL and OPENAI_API_KEY");
		if (loaded && loaded.model !== selected.id)
			throw Error(`${name}.recorded.json holds ${loaded.model}; delete it to record on ${selected.id}`);
		price = selected.spend.price;
		return (real = selected.model);
	}

	/** The model for one conversation; each provider call's key is pushed to `keys`. */
	function model(keys: string[] = []): LanguageModelV4 {
		const known = (key: string) => used.get(key) ?? loaded?.calls[key];
		const missing = (key: string): never => {
			throw new MissingRecording(
				`no recording for provider call ${key} in ${name}.recorded.json: a prompt, catalog, tool schema or case changed. Record it again (tests/evry/evals/README.md)`,
			);
		};
		return {
			specificationVersion: "v4",
			provider: "recorded",
			modelId: loaded?.model ?? "recording",
			supportedUrls: {},
			async doGenerate(options) {
				const key = callKey(options);
				keys.push(key);
				let call = known(key);
				if (!call && recording) {
					const out = await realModel().doGenerate(options);
					call = { kind: "generate", content: out.content.filter((c) => c.type === "text"), usage: usageOf(out.usage) };
					fresh.push(call.usage);
				}
				if (!call || call.kind !== "generate") return missing(key);
				used.set(key, call);
				return {
					content: call.content,
					finishReason: { unified: "stop", raw: undefined },
					usage: zeroUsage,
					warnings: [],
				};
			},
			async doStream(options) {
				const key = callKey(options);
				keys.push(key);
				const call = known(key);
				if (call?.kind === "stream") {
					used.set(key, call);
					return { stream: new ReadableStream({ start: (c) => (call.parts.forEach((p) => c.enqueue(p)), c.close()) }) };
				}
				if (!recording) return missing(key);
				const out = await realModel().doStream(options);
				const parts: LanguageModelV4StreamPart[] = [];
				const saved: Call = { kind: "stream", parts, usage: { input: 0, output: 0 } };
				return {
					...out,
					stream: out.stream.pipeThrough(
						new TransformStream({
							transform(part, controller) {
								parts.push(part);
								if (part.type === "finish") {
									saved.usage = usageOf(part.usage);
									fresh.push(saved.usage);
									used.set(key, saved);
								}
								controller.enqueue(part);
							},
						}),
					),
				};
			},
		};
	}

	/** Writes the calls this run used (a recording run only). */
	function save() {
		if (!recording) return;
		realModel(); // the price of the recorded model, also when every call was already recorded
		const cost = (u: Usage) => (price ? callCostMicroUsd(price, u.input, u.output) : 0);
		// A run limited to some cases (EVRY_EVAL_CASES) keeps every other recording; a full run drops the unused ones.
		const kept = process.env.EVRY_EVAL_CASES ? Object.entries(loaded?.calls ?? {}) : [];
		const calls = Object.fromEntries([...kept, ...used.entries()].sort(([a], [b]) => a.localeCompare(b)));
		const all = Object.values(calls).map((c) => c.usage);
		const out: Recorded = {
			model: loaded?.model || (process.env.EVRY_MODEL ?? ""),
			recordedAt: fresh.length ? new Date().toISOString() : (loaded?.recordedAt ?? new Date().toISOString()),
			spend: {
				// A run that needed no new call keeps the last paid run's figures.
				newCalls: fresh.length || (loaded?.spend.newCalls ?? 0),
				newMicroUsd: fresh.length ? fresh.reduce((s, u) => s + cost(u), 0) : (loaded?.spend.newMicroUsd ?? 0),
				allCalls: all.length,
				allMicroUsd: all.reduce((s, u) => s + cost(u), 0),
			},
			calls,
		};
		// Consecutive deltas of one text or tool input are merged: replay streams the same text and input, so every later
		// call (and its key) is unchanged.
		for (const call of Object.values(out.calls)) if (call.kind === "stream") call.parts = merged(call.parts);
		writeFileSync(file, JSON.stringify(out, null, "\t") + "\n");
		loaded = out;
		return out.spend;
	}
	return { model, save, file: () => loaded };
}

const golden = recorder("golden");
export const saveRecording = golden.save;
export const recordedFile = golden.file;

export type Turn = { user: string } | { assistant: string };
export type ToolCall = { operation: string; input: any; result?: SourceResult; error?: string };
export type Proposal = { operation: string; input: any; prepared: boolean; review: ReturnType<typeof prepareReview> };
export type Conversation = {
	kind: "application" | "capabilities" | "pastoral_boundary";
	calls: ToolCall[];
	proposals: Proposal[];
	answer: string;
	keys: string[];
};

/** The turn's own stop: the 24-tool budget (a step past it runs nothing). The step bound only backs it up. */
const MAX_STEPS = LIMITS.toolCalls + 1;

export async function converse(as: ActorName, text: string, history: Turn[] = []): Promise<Conversation> {
	const { actor, church } = ACTORS[as];
	const keys: string[] = [];
	const model = golden.model(keys);
	const catalog = readCatalog(actor);
	const calls: ToolCall[] = [];
	const proposals: Proposal[] = [];
	const classified = await classifyRequest(model, text, AbortSignal.timeout(60_000));
	if (classified.kind !== "application")
		return {
			kind: classified.kind,
			calls,
			proposals,
			keys,
			answer: classified.kind === "pastoral_boundary" ? PASTORAL_BOUNDARY : describeCatalog(catalog),
		};

	const events = history.map(
		(t, i) =>
			({
				kind: "user" in t ? "user_message" : "status",
				sequence: i + 1,
				body: { text: "user" in t ? t.user : t.assistant },
			}) as unknown as ConversationEvent,
	);
	const context = compileContext({ actor, catalog, history: events, text, references: [], now: NOW });
	const results = new Map<number, SourceResult>();
	let sequence = 0;
	let toolCalls = 0;
	const admit = () => ++toolCalls <= LIMITS.toolCalls;
	const forModel = (result: SourceResult) => {
		const resultId = ++sequence;
		results.set(resultId, result);
		const json = scrub(JSON.stringify({ resultId, ...result }));
		// The church is sized so no result needs the runtime's section truncation.
		if (json.length > LIMITS.sectionChars) throw Error(`${result.operation} returned more than one content section`);
		return JSON.parse(json) as Record<string, unknown>;
	};

	const tools: ToolSet = readTools(actor, async (adapter, input) => {
		if (!admit()) return { error: "tool_budget" };
		const result = answerRead(actor, church, adapter.operation, input);
		calls.push({ operation: adapter.operation, input, result });
		return forModel(result);
	});
	if (catalog.selection.length)
		tools.select_returned_rows = tool({
			description:
				"Select people rows by id from a result this conversation already returned (its resultId). Selection never adds rows or ids.",
			inputSchema: z.strictObject({
				resultId: z.int().min(1),
				ids: z.array(z.uuid()).min(1).max(LIMITS.selectedRows),
			}),
			execute: async ({ resultId, ids }) => {
				if (!admit()) return { error: "tool_budget" };
				const source = results.get(resultId);
				const returned = new Set(source?.rows.filter((r) => r.kind === "person").map((r) => r.id) ?? []);
				const rejected = ids.filter((rowId) => !returned.has(rowId));
				calls.push({ operation: "evry.selectReturnedRows", input: { resultId, ids } });
				if (!source || rejected.length) return { error: "not_returned", rejected: rejected.length };
				const rows = source.rows.filter((r) => r.kind === "person" && ids.includes(r.id));
				return forModel({
					operation: "evry.selectReturnedRows",
					status: "available",
					rows,
					total: rows.length,
					page: 1,
					next: null,
					completeness: "complete",
					exclusions: source.total === null ? [] : [`selected from ${source.total} matched`],
				});
			},
		});
	const writes = allowedWrites(actor);
	if (writes.length) {
		const options = writes.map((w) => z.strictObject({ operation: z.literal(w.operation), input: w.input }));
		tools.propose_change = tool({
			description: `Prepare an exact review of one change for the user to approve: ${writes.map((w) => `${w.operation} (${w.description})`).join("; ")}. Use ids from earlier results. Nothing changes until the user approves.`,
			inputSchema: options.length === 1 ? options[0]! : z.discriminatedUnion("operation", options as never),
			execute: async (call: { operation: string; input: unknown }) => {
				if (!admit()) return { error: "tool_budget" };
				const review = prepareReview(church, call.operation, call.input);
				proposals.push({ operation: call.operation, input: call.input, prepared: !!review, review });
				if (!review) return { error: "source_unavailable" };
				const proposalId = `5b6d1f0e-0000-4000-8000-${(0x7000 + proposals.length).toString(16).padStart(12, "0")}`;
				return JSON.parse(
					scrub(
						JSON.stringify({
							proposalId,
							status: "awaiting_approval",
							expiresAt: new Date(NOW.getTime() + REVIEW_MINUTES * 60_000).toISOString(),
							rows: review.target ? [{ ...review.target, fields: { changes: review.changes } }] : [],
						}),
					),
				) as Record<string, unknown>;
			},
		});
	}

	const run = streamText({
		model,
		system: context.system,
		messages: context.messages,
		tools,
		stopWhen: [stepCountIs(MAX_STEPS), () => toolCalls >= LIMITS.toolCalls],
		maxRetries: 0,
		maxOutputTokens: LIMITS.outputTokensPerCall,
		onError: () => undefined,
	});
	let answer = "";
	let failure: unknown = null;
	for await (const part of run.fullStream) {
		if (part.type === "text-delta") answer += part.text;
		else if (part.type === "error") failure ??= part.error;
	}
	if (failure) throw failure;
	return { kind: "application", calls, proposals, answer, keys };
}

/** The tone and usefulness rubric, graded by the same model after the hard checks pass. No weights, no score. */
export const RUBRIC = {
	grades: ["strong", "adequate", "weak"] as const,
	tone: "Warm, plain and brief, the way a capable church staff member talks to a busy planter: no preaching, flattery, jargon or filler, and no false certainty.",
	usefulness:
		"Answers what was asked from what Evry actually read, states any limit or missing capability honestly, and offers a sensible next step the user can take (in Evry or in the app).",
};
const gradeSchema = z.object({
	tone: z.object({ grade: z.enum(RUBRIC.grades), reason: z.string() }),
	usefulness: z.object({ grade: z.enum(RUBRIC.grades), reason: z.string() }),
});
export type Grade = z.infer<typeof gradeSchema> & { key: string };

export async function judge(input: {
	question: string;
	expected: string;
	mustNot: string;
	answer: string;
}): Promise<Grade> {
	const keys: string[] = [];
	const { output } = await generateText({
		model: golden.model(keys),
		maxRetries: 0,
		maxOutputTokens: 1_000,
		output: Output.object({ schema: gradeSchema }),
		system: [
			"You grade one answer from Evry, the assistant inside Everyfield, a church planting application. Facts were already checked against the records; do not re-check them and do not reward length.",
			`Grade tone and usefulness separately as ${RUBRIC.grades.join(", ")}, each with a one-sentence reason.`,
			`Tone: ${RUBRIC.tone}`,
			`Usefulness: ${RUBRIC.usefulness}`,
		].join("\n"),
		prompt: JSON.stringify({
			question: input.question,
			expectedBehavior: input.expected,
			mustNot: input.mustNot,
			answer: input.answer,
		}),
	});
	return { ...output, key: keys[0]! };
}
