import type { Database } from "@everyfield/db/client";
import { streamText, type ModelMessage, type StopCondition, type ToolSet } from "ai";
import { readCatalog, SELECT_RETURNED_ROWS } from "../catalog/catalog.ts";
import { invokeRead } from "../catalog/invoke.ts";
import { verifyPeople } from "../adapters/people/reads/index.ts";
import { liveRowKeys } from "../conversations/liveness.ts";
import type { ReadAdapter, SourceResult } from "../catalog/types.ts";
import { sameContext, type EvryActor } from "../context/actor.ts";
import { resolveSelf } from "../context/self.ts";
import {
	classifyRequest,
	compileContext,
	describeCatalog,
	PASTORAL_BOUNDARY,
	resolveReferences,
} from "../context/compile.ts";
import { EvryRefusal, projectError, scrub } from "../context/errors.ts";
import { LIMITS, type StopReason } from "../context/limits.ts";
import { prepareProposal } from "../proposals/store.ts";
import type { MailPort, NativePorts } from "../proposals/types.ts";
import type { QualifiedModel } from "./model.ts";
import { appendEvent, loadHistory, loadTurn, savedResult, type RunLease, type Turn } from "./run-store.ts";
import { liveRoom } from "./live.ts";
import { modelTools, proposalForModel, refusalForModel, resultForModel } from "./tools.ts";
import { meteredModel } from "./spend.ts";
import { traced, traceTurn, type Claimed } from "./trace.ts";
import { isTransient } from "@everyfield/domain/log";

export type RunDeps = {
	db: Database;
	model: QualifiedModel;
	freshActor(session: string): Promise<EvryActor | null>;
	mail?: MailPort | null;
	native?: NativePorts | null;
	now?: () => Date;
};
const WITHHELD_TEXT = "[An earlier part of this answer used a source that is no longer available.]";

export type RunOutcome = "succeeded" | "failed" | "lost";

export async function runTurn(deps: RunDeps, lease: RunLease, claimed?: Claimed): Promise<RunOutcome> {
	const turn = await loadTurn(deps.db, lease);
	if (!turn) return "lost";
	const { conversation_id: conversationId, message } = turn;
	return traceTurn(
		{
			turnId: lease.turnId,
			conversationId,
			submittedAt: message.createdAt,
			request: scrub(message.body.text),
			claimed,
		},
		(report) => run(deps, lease, turn, report),
	);
}

async function run(
	deps: RunDeps,
	lease: RunLease,
	turn: Turn,
	report: (output: Record<string, unknown>) => void,
): Promise<RunOutcome> {
	const { db } = deps;
	const abort = new AbortController();
	const wall = setTimeout(() => abort.abort("wall_time"), LIMITS.wallMs);
	let lost = false;
	let stop: StopReason = "completed";
	let failure: EvryRefusal | null = null;
	let text = "";
	let pending = "";
	let toolCalls = 0;
	const usage = { inputTokens: 0, outputTokens: 0 };
	let meter: ReturnType<typeof meteredModel> | null = null;
	let firstText = true;
	const room = liveRoom(turn.conversation_id);
	room.begin(lease.turnId);
	const saves: { running: Promise<void> | null; failed: { error: unknown } | null } = { running: null, failed: null };
	const save = async (kind: "assistant_text" | "tool_result", body: Record<string, unknown>) => {
		if (kind === "tool_result") await drain();
		const append = () => appendEvent(db, lease, turn.conversation_id, kind, body);
		const first = kind === "assistant_text" && firstText;
		firstText &&= !first;
		const sequence = lost
			? null
			: first
				? await traced("first text saved", append, () => ({
						submitToFirstTextMs: Date.now() - turn.message.createdAt.getTime(),
					}))
				: await append();
		if (sequence === null && !lost) {
			lost = true;
			abort.abort("lost");
		}
		return sequence;
	};
	const kick = () => {
		if (saves.running || !pending || lost) return;
		saves.running = (async () => {
			try {
				while (pending && !lost) {
					const delta = pending;
					pending = "";
					await save("assistant_text", { text: delta });
				}
			} catch (error) {
				saves.failed = { error };
			} finally {
				saves.running = null;
			}
		})();
	};
	const drain = async () => {
		kick();
		while (saves.running) await saves.running;
		if (saves.failed) throw saves.failed.error;
	};
	const fail = (error: EvryRefusal) => {
		failure ??= error;
		stop = "failed";
		abort.abort("failed");
	};
	const finish = async (): Promise<RunOutcome> => {
		if (lost) return "lost";
		const failed = stop === "failed";
		const sequence = await appendEvent(
			db,
			lease,
			turn.conversation_id,
			"status",
			{
				state: failed ? "failed" : stop === "completed" || stop === "policy_boundary" ? "completed" : "stopped",
				reason: stop,
				text,
				usage: { ...usage, toolCalls, ...(meter && { costMicroUsd: meter.charged() }) },
				...(failed ? { error: projectError(failure) } : {}),
			},
			true,
		);
		if (sequence === null) return "lost";
		report({ text, stop });
		return failed ? "failed" : "succeeded";
	};

	try {
		if (deps.model.status === "paused") throw new EvryRefusal("model_paused");
		const session = turn.session_id;
		const checked = session ? await traced("access check", () => deps.freshActor(session)) : null;
		if (!session || !checked || checked.accountId !== turn.account_id || checked.owner.id !== turn.tenant_id)
			throw new EvryRefusal("access_denied");
		const selfPersonId = await traced("self row", () => resolveSelf(db, checked));
		const actor: EvryActor = { ...checked, selfPersonId };
		if (deps.model.status !== "qualified") throw new EvryRefusal("model_unavailable");
		if (deps.model.spend) meter = meteredModel(db, deps.model.model, deps.model.spend);
		const model = meter?.model ?? deps.model.model;
		const catalog = readCatalog(actor);
		const request = turn.message.body.text;

		const classified = await classifyRequest(model, request, abort.signal).catch((error) => {
			throw abort.signal.aborted ? error : new EvryRefusal("model_unavailable");
		});
		usage.inputTokens += classified.usage.inputTokens ?? 0;
		usage.outputTokens += classified.usage.outputTokens ?? 0;
		if (classified.kind !== "application") {
			stop = classified.kind === "pastoral_boundary" ? "policy_boundary" : "completed";
			text = classified.kind === "pastoral_boundary" ? PASTORAL_BOUNDARY : describeCatalog(catalog);
			await save("assistant_text", { text });
			return await finish();
		}

		const compile = async () => {
			const history = await loadHistory(db, lease, turn.conversation_id, actor);
			if (!history) throw new EvryRefusal("access_denied");
			const references = await resolveReferences(db, actor, turn.message.body.references);
			return compileContext({
				actor,
				catalog,
				history,
				text: request,
				references,
				now: deps.now?.() ?? new Date(),
			});
		};
		const context = await compile();
		let current = actor;
		const withLiveRows = async (messages: ModelMessage[]) => {
			type Row = { kind: string; id: string };
			const key = (row: Row) => `${row.kind}:${row.id}`;
			const rows = new Map<string, Row>();
			const rowsOf = (part: unknown) => {
				const value = (part as { output?: { type?: string; value?: { rows?: unknown } } }).output;
				return value?.type === "json" && Array.isArray(value.value?.rows) ? (value.value.rows as Row[]) : null;
			};
			for (const m of messages)
				if (m.role === "tool")
					for (const part of m.content) for (const row of rowsOf(part) ?? []) rows.set(key(row), row);
			if (!rows.size) return messages;
			const live = await liveRowKeys(db, current, [...rows.values()]);
			const withheld = [...rows.keys()].some((k) => !live.has(k));
			if (!withheld) return messages;
			return messages.map((m): ModelMessage => {
				if (m.role === "assistant")
					return {
						...m,
						content:
							typeof m.content === "string"
								? WITHHELD_TEXT
								: m.content.map((part) => (part.type === "text" ? { ...part, text: WITHHELD_TEXT } : part)),
					};
				if (m.role !== "tool") return m;
				return {
					...m,
					content: m.content.map((part) => {
						const own = rowsOf(part);
						if (!own) return part;
						const kept = own.filter((r) => live.has(key(r)));
						if (kept.length === own.length) return part;
						const output = (part as { output: { value: Record<string, unknown> } }).output;
						return {
							...part,
							output: {
								type: "json" as const,
								value: {
									...output.value,
									rows: kept,
									total: null,
									completeness: "partial",
									withheldRows: own.length - kept.length,
								},
							},
						} as typeof part;
					}),
				};
			});
		};

		const admit = async () => {
			if (++toolCalls > LIMITS.toolCalls) {
				toolCalls = LIMITS.toolCalls;
				stop = "tool_budget";
				return null;
			}
			const fresh = await traced("access check", () => deps.freshActor(session));
			if (!fresh || !sameContext(fresh, actor)) {
				fail(new EvryRefusal("access_denied"));
				return null;
			}
			return (current = { ...fresh, selfPersonId });
		};
		const read = async <I>(adapter: ReadAdapter<I>, input: I) => {
			const fresh = await admit();
			if (!fresh) return { error: stop === "tool_budget" ? "tool_budget" : "access_denied" };
			let result: SourceResult | undefined;
			for (let attempt = 0; result === undefined; attempt++) {
				try {
					result = await invokeRead(db, fresh, adapter, input, deps.native ?? null);
				} catch (error) {
					if (attempt < LIMITS.readRetries && isTransient(error)) continue;
					const still = await deps.freshActor(session).catch(() => null);
					const lost = error instanceof EvryRefusal && error.code === "access_denied";
					if (!lost && still && sameContext(still, fresh) && still.role === fresh.role)
						return { error: "source_unavailable", operation: adapter.operation };
					fail(error instanceof EvryRefusal ? error : new EvryRefusal("source_unavailable"));
					return { error: "source_unavailable" };
				}
			}
			const sequence = await save("tool_result", { operation: adapter.operation, input, result });
			return sequence === null ? { error: "cancelled" } : resultForModel(sequence, result);
		};

		const tools = modelTools(actor, {
			read,
			select: async ({ resultId, ids }) => {
				const fresh = await admit();
				if (!fresh) return { error: stop === "tool_budget" ? "tool_budget" : "access_denied" };
				const saved = await savedResult(db, turn.conversation_id, resultId);
				const source = saved?.result as SourceResult | undefined;
				const returned = new Set(source?.rows.filter((r) => r.kind === "person").map((r) => r.id) ?? []);
				const rejected = ids.filter((id) => !returned.has(id));
				if (!source || rejected.length) return { error: "not_returned", rejected: rejected.length };
				const rows = await verifyPeople(db, fresh, ids);
				const result: SourceResult = {
					operation: SELECT_RETURNED_ROWS,
					status: "available",
					rows,
					total: rows.length,
					page: 1,
					next: null,
					completeness: "complete",
					exclusions: source.total === null ? [] : [`selected from ${source.total} matched`],
				};
				const sequence = await save("tool_result", {
					operation: SELECT_RETURNED_ROWS,
					input: { resultId, ids },
					result,
					originalTotal: source.total,
				});
				return sequence === null ? { error: "cancelled" } : resultForModel(sequence, result);
			},
			propose: async (call) => {
				const fresh = await admit();
				if (!fresh) return { error: stop === "tool_budget" ? "tool_budget" : "access_denied" };
				const proposal = await prepareProposal(
					db,
					fresh,
					lease,
					turn.conversation_id,
					call,
					deps.mail,
					deps.native ?? null,
				).catch((error) => (error instanceof EvryRefusal ? error.code : "unknown"));
				if (typeof proposal === "string") return refusalForModel(proposal);
				if (!proposal) return { error: "source_unavailable" };
				const target = proposal.review.target;
				const sequence = await save("tool_result", {
					operation: "evry.prepareProposal",
					input: { operation: call.operation },
					result: {
						operation: "evry.prepareProposal",
						status: "available",
						rows: target ? [{ kind: target.kind, id: target.id, label: target.label, fields: {} }] : [],
						total: 1,
						page: 1,
						next: null,
						completeness: "complete",
						exclusions: [],
						proposalId: proposal.id,
					},
				});
				return sequence === null ? { error: "cancelled" } : proposalForModel(proposal);
			},
		});

		const before = { ...usage };
		const budget: StopCondition<ToolSet> = ({ steps }) => {
			const input = before.inputTokens + steps.reduce((n, s) => n + (s.usage.inputTokens ?? 0), 0);
			const output = before.outputTokens + steps.reduce((n, s) => n + (s.usage.outputTokens ?? 0), 0);
			if (stop !== "completed") return true;
			if (toolCalls >= LIMITS.toolCalls) stop = "tool_budget";
			else if (input >= LIMITS.inputTokens) stop = "input_budget";
			else if (output >= LIMITS.outputTokens) stop = "output_budget";
			return stop !== "completed";
		};
		const stream = streamText({
			model,
			system: context.system,
			messages: context.messages,
			tools,
			stopWhen: budget,
			prepareStep: async ({ stepNumber, messages }) => {
				if (stepNumber === 0) return {};
				const current = await compile();
				const thisTurn = messages.slice(context.messages.length);
				return {
					system: current.system,
					messages: [...current.messages, ...(await withLiveRows(thisTurn))],
				};
			},
			maxRetries: 0,
			maxOutputTokens: LIMITS.outputTokensPerCall,
			abortSignal: abort.signal,
			onError: () => undefined,
			telemetry: { functionId: "evry.answer" },
		});
		for await (const part of stream.fullStream) {
			if (saves.failed) throw saves.failed.error;
			if (part.type === "text-delta") {
				text += part.text;
				pending += part.text;
				room.push(part.text);
				kick();
			} else if (part.type === "finish-step") {
				usage.inputTokens += part.usage.inputTokens ?? 0;
				usage.outputTokens += part.usage.outputTokens ?? 0;
			} else if (part.type === "error") {
				if (!abort.signal.aborted) throw new EvryRefusal("model_unavailable");
			} else if (part.type === "abort") break;
		}
		await drain();
	} catch (error) {
		if (!abort.signal.aborted) fail(error instanceof EvryRefusal ? error : new EvryRefusal("unknown"));
	} finally {
		clearTimeout(wall);
		room.end(lease.turnId);
	}
	if (abort.signal.reason === "wall_time" && stop === "completed") stop = "wall_time";
	await drain().catch(() => undefined);
	return finish();
}
