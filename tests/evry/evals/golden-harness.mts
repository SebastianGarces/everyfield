import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { generateText, Output, stepCountIs, streamText } from "../../../packages/evry/node_modules/ai/dist/index.js";
import { z } from "../../../packages/evry/node_modules/zod/index.js";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { readCatalog, SELECT_RETURNED_ROWS } from "../../../packages/evry/src/catalog/catalog.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import { previewImport } from "../../../packages/evry/src/adapters/people-organization/reads/index.ts";
import type { ReadAdapter, SourceResult } from "../../../packages/evry/src/catalog/types.ts";
import { verifyPeople } from "../../../packages/evry/src/adapters/people/reads/index.ts";
import type { EvryActor } from "../../../packages/evry/src/context/actor.ts";
import {
	capabilitiesAnswer,
	classifyRequest,
	compileContext,
	PASTORAL_BOUNDARY,
	resolveReferences,
} from "../../../packages/evry/src/context/compile.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { ATTACHMENTS } from "../../../packages/evry/src/attachments/store.ts";
import { EvryRefusal } from "../../../packages/evry/src/context/errors.ts";
import { LIMITS } from "../../../packages/evry/src/context/limits.ts";
import { selectQualifiedModel, type Price } from "../../../packages/evry/src/runtime/model.ts";
import { callCostMicroUsd } from "../../../packages/evry/src/runtime/spend.ts";
import { modelTools, proposalForModel, resultForModel } from "../../../packages/evry/src/runtime/tools.ts";
import {
	prepareProposal,
	REVIEW_MINUTES,
	type Proposal as Prepared,
} from "../../../packages/evry/src/proposals/store.ts";
import {
	createConversation,
	submitTurn,
	type ConversationEvent,
} from "../../../packages/evry/src/conversations/store.ts";
import type { RunLease } from "../../../packages/evry/src/runtime/run-store.ts";
import type { MailPort } from "../../../packages/evry/src/proposals/types.ts";
import { claimDue } from "../../../apps/web/src/server/jobs/queue.ts";
import { byName, NOW, type ActorName, type GoldenChurch } from "./golden-church.mts";
import { SEAT_READS, SETTINGS_COMMANDS, SHARING_READS } from "../../../packages/evry/src/adapters/settings/index.ts";
import { ONBOARDING_READS } from "../../../packages/evry/src/adapters/onboarding/reads/index.ts";
import { ONBOARDING_COMMANDS } from "../../../packages/evry/src/adapters/onboarding/commands/index.ts";
import { DASHBOARD_READS } from "../../../packages/evry/src/adapters/dashboard/reads/index.ts";
import { FEEDBACK_READS } from "../../../packages/evry/src/adapters/feedback/reads/index.ts";
import { FEEDBACK_COMMANDS } from "../../../packages/evry/src/adapters/feedback/commands/index.ts";
import { PIPELINE_READS } from "../../../packages/evry/src/adapters/pipeline/reads/index.ts";
import { PIPELINE_COMMANDS } from "../../../packages/evry/src/adapters/pipeline/commands/index.ts";
import { LAUNCH_READS } from "../../../packages/evry/src/adapters/launch/reads/index.ts";
import { LAUNCH_COMMANDS } from "../../../packages/evry/src/adapters/launch/commands/index.ts";

const LATER = new Set<string>([
	...SEAT_READS.map((a) => a.operation),
	...SHARING_READS.map((a) => a.operation),
	...Object.keys(SETTINGS_COMMANDS),
	...ONBOARDING_READS.map((a) => a.operation),
	...Object.keys(ONBOARDING_COMMANDS),
	...DASHBOARD_READS.map((a) => a.operation),
	...FEEDBACK_READS.map((a) => a.operation),
	...Object.keys(FEEDBACK_COMMANDS),
	...PIPELINE_READS.map((a) => a.operation),
	...Object.keys(PIPELINE_COMMANDS),
	...LAUNCH_READS.map((a) => a.operation),
	...Object.keys(LAUNCH_COMMANDS),
]);
export const RECORDED = (operation: string) => !LATER.has(operation);

type Usage = { input: number; output: number };
type Call =
	| { kind: "stream"; parts: LanguageModelV4StreamPart[]; usage: Usage }
	| { kind: "generate"; content: LanguageModelV4Content[]; usage: Usage };
export type Recorded = {
	model: string;
	recordedAt: string;
	spend: { newCalls: number; newMicroUsd: number; allCalls: number; allMicroUsd: number };
	calls: Record<string, Call>;
};

const RealDate = Date;

export const recording = process.env.EVRY_EVAL_RECORD === "1";

async function capped<T>(call: () => PromiseLike<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await call();
		} catch (error) {
			const status = (error as { statusCode?: number }).statusCode;
			if (status !== 429 || attempt >= 8) throw error;
			await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)));
		}
	}
}

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

export function recorder(name: string) {
	const file = new URL(`${name}.recorded.json`, import.meta.url);
	let loaded: Recorded | null = (() => {
		try {
			return JSON.parse(readFileSync(file, "utf8"));
		} catch {
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

	function model(keys: string[] = [], inputs: string[] = []): LanguageModelV4 {
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
				inputs.push(JSON.stringify({ prompt: options.prompt, tools: options.tools }));
				let call = known(key);
				if (!call && recording) {
					const out = await capped(() => realModel().doGenerate(options));
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
				inputs.push(JSON.stringify({ prompt: options.prompt, tools: options.tools }));
				const call = known(key);
				if (call?.kind === "stream") {
					used.set(key, call);
					return { stream: new ReadableStream({ start: (c) => (call.parts.forEach((p) => c.enqueue(p)), c.close()) }) };
				}
				if (!recording) return missing(key);
				const out = await capped(() => realModel().doStream(options));
				const parts: LanguageModelV4StreamPart[] = [];
				const saved: Call = { kind: "stream", parts, usage: { input: 0, output: 0 } };
				return {
					...out,
					stream: out.stream.pipeThrough(
						new TransformStream({
							transform(part, controller) {
								parts.push(part);
								if (part.type === "finish" && !parts.some((p) => p.type === "error")) {
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

	function save() {
		if (!recording) return;
		realModel();
		const cost = (u: Usage) => (price ? callCostMicroUsd(price, u.input, u.output) : 0);
		const kept = process.env.EVRY_EVAL_CASES ? Object.entries(loaded?.calls ?? {}) : [];
		const calls = Object.fromEntries([...kept, ...used.entries()].sort(([a], [b]) => a.localeCompare(b)));
		const all = Object.values(calls).map((c) => c.usage);
		const out: Recorded = {
			model: loaded?.model || (process.env.EVRY_MODEL ?? ""),
			recordedAt: fresh.length ? new RealDate().toISOString() : (loaded?.recordedAt ?? new RealDate().toISOString()),
			spend: {
				newCalls: fresh.length || (loaded?.spend.newCalls ?? 0),
				newMicroUsd: fresh.length ? fresh.reduce((s, u) => s + cost(u), 0) : (loaded?.spend.newMicroUsd ?? 0),
				allCalls: all.length,
				allMicroUsd: all.reduce((s, u) => s + cost(u), 0),
			},
			calls,
		};
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
export type Proposal = {
	operation: string;
	input: any;
	prepared: boolean;
	review: Prepared["review"] | null;
	error?: string;
};
export type Conversation = {
	kind: "application" | "capabilities" | "pastoral_boundary";
	calls: ToolCall[];
	proposals: Proposal[];
	answer: string;
	keys: string[];
	inputs: string[];
	failed?: string;
};

const refuse = async (): Promise<never> => {
	throw Error("a review never calls the email service");
};
const MAIL: MailPort = {
	keys: {
		encryptionKey: Buffer.alloc(32, 7),
		addressKey: Buffer.alloc(32, 9),
		from: "church@example.test",
		origin: "https://app.example.test",
	},
	transport: { send: refuse, cancel: refuse, reschedule: refuse },
};

const MAX_STEPS = LIMITS.toolCalls + 1;

let opening: Promise<unknown> = Promise.resolve();
function openConversation(db: GoldenChurch["db"], actor: EvryActor, files: Attached[] = []) {
	const opened = opening.then(async () => {
		const c = await createConversation(db, actor, { requestKey: randomUUID() });
		for (const f of files)
			await db.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,state,upload_key,claim_generation,expires_at)
				VALUES(${f.id}::uuid,${actor.owner.id}::uuid,'assistant_staging',${`private/${actor.owner.id}/${f.id}`},'text/csv',${f.bytes.length},
					'pending',${`evry-attachment/${c.id}/${f.id}`},0,clock_timestamp()+make_interval(hours=>${ATTACHMENTS.stagingHours}))`);
		const submitted = await submitTurn(db, actor, c.id, {
			requestKey: randomUUID(),
			text: "Golden eval",
			attachments: files.map((f) => ({ id: f.id, name: f.name })),
		});
		for (const f of files.filter((x) => x.checked)) {
			const result = await invokeRead(db, actor, previewImport as ReadAdapter<unknown>, { attachmentId: f.id }, null, {
				read: async () => f.bytes,
			});
			await db.execute(sql`WITH c AS (UPDATE conversation SET last_sequence=last_sequence+1 WHERE id=${c.id}::uuid RETURNING id,last_sequence)
				INSERT INTO conversation_event(conversation_id,sequence,turn_id,kind,body)
				SELECT id,last_sequence,${submitted.turnId}::uuid,'tool_result',${JSON.stringify({ operation: "people.previewImport", input: { attachmentId: f.id }, result })}::jsonb FROM c`);
		}
		const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
		if (claim?.id !== submitted.turnId) throw Error("another assistant turn was due: the eval schema is not its own");
		const lease: RunLease = {
			turnId: claim.id,
			tenantId: claim.tenant_id,
			leaseOwner: claim.lease_owner,
			generation: claim.claim_generation,
		};
		return { id: c.id, lease };
	});
	opening = opened.catch(() => undefined);
	return opened;
}

export type CaseFile = { id: string; name: string; csv: string; checked?: boolean };
type Attached = CaseFile & { bytes: Uint8Array };
const fill = (csv: string) =>
	csv.replace(/\{([^}.]+)\.(email|phone)\}/g, (_, name: string, field: "email" | "phone") => byName(name)[field] ?? "");

export async function converse(
	church: GoldenChurch,
	as: ActorName,
	text: string,
	history: Turn[] = [],
	attachments: CaseFile[] = [],
	override?: LanguageModelV4,
	page?: string,
): Promise<Conversation> {
	const { db } = church;
	const actor = church.actors[as];
	const keys: string[] = [];
	const inputs: string[] = [];
	const model = override ?? golden.model(keys, inputs);
	const catalog = readCatalog(actor, RECORDED);
	const calls: ToolCall[] = [];
	const proposals: Proposal[] = [];
	const classified = await classifyRequest(model, text, AbortSignal.timeout(60_000));
	if (classified.kind !== "application")
		return {
			kind: classified.kind,
			calls,
			proposals,
			keys,
			inputs,
			answer: classified.kind === "pastoral_boundary" ? PASTORAL_BOUNDARY : capabilitiesAnswer(catalog, actor),
		};

	const events = history.map(
		(t, i) =>
			({
				kind: "user" in t ? "user_message" : "status",
				sequence: i + 1,
				body: { text: "user" in t ? t.user : t.assistant },
			}) as unknown as ConversationEvent,
	);
	const files: Attached[] = attachments.map((f) => ({ ...f, bytes: new TextEncoder().encode(fill(f.csv)) }));
	const attachedAt = new Date(NOW.getTime() - 5 * 60_000);
	const state = {
		attachments: files.map((f) => ({
			id: f.id,
			name: f.name,
			attachedAt,
			availableUntil: new Date(attachedAt.getTime() + ATTACHMENTS.stagingHours * 3_600_000),
			status: "available" as const,
			checkedDigest: f.checked ? createHash("sha256").update(f.bytes).digest("hex") : null,
		})),
		reviews: [],
	};
	const context = compileContext({
		actor,
		catalog,
		history: events,
		text,
		references: await resolveReferences(db, actor, page ? [{ kind: "article", slug: page }] : []),
		now: NOW,
		state,
		settingsGuidance: false,
	});
	const conversationFiles = {
		read: async (id: string) => {
			const f = files.find((x) => x.id === id);
			if (!f) throw new EvryRefusal("attachment_elsewhere");
			return f.bytes;
		},
	};
	let cards = 0;
	const saved = new Set<ToolCall>();
	const results = new Map<number, SourceResult>();
	let sequence = 0;
	let toolCalls = 0;
	let failed: string | undefined;
	const abort = new AbortController();
	const admit = () => ++toolCalls <= LIMITS.toolCalls;
	let queue: Promise<unknown> = Promise.resolve();
	const inOrder =
		<A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
		(...args: A) => {
			const next = queue.then(() => run(...args));
			queue = next.catch(() => undefined);
			return next;
		};
	const keep = (resultId: number, result: SourceResult) => {
		results.set(resultId, result);
		return resultForModel(resultId, result);
	};
	let conversation: ReturnType<typeof openConversation> | null = null;

	const tools = modelTools(
		actor,
		{
			read: inOrder(async (adapter: ReadAdapter<unknown>, input: unknown) => {
				if (!admit()) return { error: "tool_budget" };
				const call: ToolCall = { operation: adapter.operation, input };
				calls.push(call);
				const resultId = ++sequence;
				try {
					call.result = await invokeRead(db, actor, adapter, input, null, conversationFiles);
					return keep(resultId, call.result);
				} catch (error) {
					if (
						error instanceof EvryRefusal &&
						(error.code === "attachment_elsewhere" || error.code === "attachment_gone")
					)
						return ((call.error = error.code), { error: error.code });
					const code = error instanceof EvryRefusal ? error.code : "source_unavailable";
					call.error = code;
					failed ??= code;
					abort.abort();
					return { error: "source_unavailable" };
				}
			}),
			select: inOrder(async ({ resultId, ids }: { resultId: number; ids: string[] }) => {
				if (!admit()) return { error: "tool_budget" };
				const source = results.get(resultId);
				const returned = new Set(source?.rows.filter((r) => r.kind === "person").map((r) => r.id) ?? []);
				const rejected = ids.filter((rowId) => !returned.has(rowId));
				calls.push({ operation: SELECT_RETURNED_ROWS, input: { resultId, ids } });
				if (!source || rejected.length) return { error: "not_returned", rejected: rejected.length };
				const selected = ++sequence;
				const rows = await verifyPeople(db, actor, ids);
				return keep(selected, {
					operation: SELECT_RETURNED_ROWS,
					status: "available",
					rows,
					total: rows.length,
					page: 1,
					next: null,
					completeness: "complete",
					exclusions: source.total === null ? [] : [`selected from ${source.total} matched`],
				});
			}),
			propose: inOrder(async (call: { operation: string; input: unknown }) => {
				if (++cards > LIMITS.reviewCards) return { error: "review_limit" };
				if (!admit()) return { error: "tool_budget" };
				const card: Proposal = { operation: call.operation, input: call.input, prepared: false, review: null };
				proposals.push(card);
				const number = proposals.length;
				const open = await (conversation ??= openConversation(db, actor, files));
				for (const check of calls.filter((x) => x.operation === "people.previewImport" && x.result && !saved.has(x))) {
					saved.add(check);
					await db.execute(sql`WITH c AS (UPDATE conversation SET last_sequence=last_sequence+1 WHERE id=${open.id}::uuid RETURNING id,last_sequence)
					INSERT INTO conversation_event(conversation_id,sequence,turn_id,kind,body)
					SELECT id,last_sequence,${open.lease.turnId}::uuid,'tool_result',${JSON.stringify({ operation: check.operation, input: check.input, result: check.result })}::jsonb FROM c`);
				}
				const proposal = await prepareProposal(
					db,
					actor,
					open.lease,
					open.id,
					call,
					MAIL,
					null,
					conversationFiles,
				).catch((error) => (error instanceof EvryRefusal ? error.code : "unknown"));
				if (typeof proposal === "string" || !proposal) {
					card.error = proposal || "source_unavailable";
					return { error: card.error };
				}
				card.prepared = true;
				card.review = proposal.review;
				return proposalForModel({
					...proposal,
					review: pinnedContactTime(proposal.review, call.input),
					id: `5b6d1f0e-0000-4000-8000-${(0x7000 + number).toString(16).padStart(12, "0")}`,
					expiresAt: new Date(NOW.getTime() + REVIEW_MINUTES * 60_000),
				});
			}),
		},
		RECORDED,
	);

	const run = streamText({
		model,
		system: context.system,
		messages: context.messages,
		tools,
		stopWhen: [stepCountIs(MAX_STEPS), () => toolCalls >= LIMITS.toolCalls],
		maxRetries: 0,
		maxOutputTokens: LIMITS.outputTokensPerCall,
		abortSignal: abort.signal,
		onError: () => undefined,
	});
	let answer = "";
	let failure: unknown = null;
	for await (const part of run.fullStream) {
		if (part.type === "text-delta") answer += part.text;
		else if (part.type === "error" && !abort.signal.aborted) failure ??= part.error;
	}
	if (failure) throw failure;
	return { kind: "application", calls, proposals, answer, keys, inputs, ...(failed ? { failed } : {}) };
}

function pinnedContactTime<R extends { changes: { field: string; after: unknown }[] }>(review: R, input: unknown): R {
	if ((input as { occurred?: unknown } | null)?.occurred === undefined) return review;
	const changes = review.changes.map((c) => {
		const zone = c.field === "occurredAt" && typeof c.after === "string" ? c.after.split(" ").at(-1) : undefined;
		if (!zone?.includes("/")) return c;
		const part = (type: string) =>
			new Intl.DateTimeFormat("en-US", {
				timeZone: zone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
			})
				.formatToParts(NOW)
				.find((p) => p.type === type)!.value;
		const now = `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${zone}`;
		return String(c.after) >= now ? { ...c, after: now } : c;
	});
	return { ...review, changes };
}

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
