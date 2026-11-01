import type { Database } from "@everyfield/db/client";
import { streamText, tool, type ModelMessage, type StopCondition, type ToolSet } from "ai";
import { z } from "zod";
import { READ_DOMAINS, readCatalog, SELECT_RETURNED_ROWS } from "../catalog/catalog.ts";
import { invokeRead } from "../catalog/invoke.ts";
import { verifyPeople } from "../adapters/people/reads/index.ts";
import type { ReadAdapter, SourceResult } from "../catalog/types.ts";
import { sameContext, type EvryActor } from "../context/actor.ts";
import {
	classifyRequest,
	compileContext,
	describeCatalog,
	PASTORAL_BOUNDARY,
	resolveReferences,
} from "../context/compile.ts";
import { EvryRefusal, projectError, scrub } from "../context/errors.ts";
import { LIMITS, type StopReason } from "../context/limits.ts";
import { allowedWrites, prepareProposal } from "../proposals/store.ts";
import type { QualifiedModel } from "./model.ts";
import { appendEvent, loadHistory, loadTurn, savedResult, type RunLease, type Turn } from "./run-store.ts";
import { liveRoom } from "./live.ts";
import { meteredModel } from "./spend.ts";
import { traced, traceTurn, type Claimed } from "./trace.ts";

export type RunDeps = {
	db: Database;
	model: QualifiedModel;
	/** The session's current actor, read again from the database: the fresh authority check before every read. */
	freshActor(session: string): Promise<EvryActor | null>;
	now?: () => Date;
};
/** succeeded: the turn saved its final state. failed: it saved a failure. lost: it no longer owned the run. */
/** Stands in for this turn's earlier assistant text once one of its sources is no longer available. */
const WITHHELD_TEXT = "[An earlier part of this answer used a source that is no longer available.]";

export type RunOutcome = "succeeded" | "failed" | "lost";

const TRANSIENT_SQL = new Set(["40001", "40P01", "08000", "08003", "08006", "57P01", "53300"]);
const transientRead = (error: unknown) => {
	const code =
		(error as { code?: unknown; cause?: { code?: unknown } })?.code ??
		(error as { cause?: { code?: unknown } })?.cause?.code;
	return typeof code === "string" && (TRANSIENT_SQL.has(code) || code === "ECONNRESET" || code === "ETIMEDOUT");
};

/** The model sees the rows' safe fields, the exact total and the paging facts, bounded to one content section. */
function forModel(resultId: number, result: SourceResult) {
	const value = { resultId, ...result };
	const json = scrub(JSON.stringify(value));
	if (json.length <= LIMITS.sectionChars) return JSON.parse(json) as Record<string, unknown>;
	const rows: SourceResult["rows"] = [];
	for (const row of result.rows) {
		if (JSON.stringify([...rows, row]).length > LIMITS.sectionChars - 1_000) break;
		rows.push(row);
	}
	return JSON.parse(scrub(JSON.stringify({ ...value, rows, truncatedRows: result.rows.length - rows.length })));
}

/**
 * Runs one claimed turn to its saved end. Reads run under the actor's authority, re-read before each one; every saved
 * event is fenced by the run's job lease; the turn stops truthfully at the first limit, on cancel or on lost ownership.
 */
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
	// A paid model reserves and settles each call in the month's spend counter (D77).
	let meter: ReturnType<typeof meteredModel> | null = null;
	let firstText = true;
	// Streamed text goes to this process's observers at once (live.ts) and to the database off the read loop: one save
	// in flight, each taking all the text that arrived meanwhile, so a slow database never delays the model stream.
	const room = liveRoom(turn.conversation_id);
	room.begin(lease.turnId);
	const saves: { running: Promise<void> | null; failed: { error: unknown } | null } = { running: null, failed: null };
	const save = async (kind: "assistant_text" | "tool_result", body: Record<string, unknown>) => {
		// A result is saved after the text before it, so replay keeps the order.
		if (kind === "tool_result") await drain();
		const append = () => appendEvent(db, lease, turn.conversation_id, kind, body);
		// The first saved text is what an observer can first read from the database: the end of the time to first token on our side.
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
		saves.running ??= (async () => {
			// Yield first, so the promise is stored before this loop can finish and clear it.
			await null;
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
	/** Waits until every delta received so far is saved; rethrows a failed save. */
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
		const session = turn.session_id;
		const actor = session ? await traced("access check", () => deps.freshActor(session)) : null;
		if (!session || !actor || actor.accountId !== turn.account_id || actor.owner.id !== turn.tenant_id)
			throw new EvryRefusal("access_denied");
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

		// The model input as of now: retained history and page references are read again under current authority right
		// before every model call, so a source that became unavailable during the turn never reaches the model.
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
		/** The actor as the last access check before a tool call found it. */
		let current = actor;
		/** This turn's messages with sources that are no longer available withheld. One read per model call. */
		const withLiveRows = async (messages: ModelMessage[]) => {
			const ids = new Set<string>();
			const rowsOf = (part: unknown) => {
				const value = (part as { output?: { type?: string; value?: { rows?: unknown } } }).output;
				return value?.type === "json" && Array.isArray(value.value?.rows)
					? (value.value.rows as { id: string }[])
					: null;
			};
			for (const m of messages)
				if (m.role === "tool") for (const part of m.content) for (const row of rowsOf(part) ?? []) ids.add(row.id);
			if (!ids.size) return messages;
			// verifyPeople checks live access in its statement, so a source the actor lost since the last tool call drops out.
			const live = new Set((await verifyPeople(db, current, [...ids])).map((r) => r.id));
			// The replay rule (retained.ts): when a source of this turn is withheld, so is this turn's assistant text,
			// which may quote it. Tool calls and their results stay, so the call/result protocol holds.
			const withheld = [...ids].some((id) => !live.has(id));
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
						const rows = rowsOf(part);
						if (!rows) return part;
						const kept = rows.filter((r) => live.has(r.id));
						if (kept.length === rows.length) return part;
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
									withheldRows: rows.length - kept.length,
								},
							},
						} as typeof part;
					}),
				};
			});
		};

		// One budget gate for every tool: the 25th call runs nothing, and a changed context stops the turn.
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
			return (current = fresh);
		};
		const read = async <I>(adapter: ReadAdapter<I>, input: I) => {
			const fresh = await admit();
			if (!fresh) return { error: stop === "tool_budget" ? "tool_budget" : "access_denied" };
			let result: SourceResult | undefined;
			for (let attempt = 0; result === undefined; attempt++) {
				try {
					result = await invokeRead(db, fresh, adapter, input);
				} catch (error) {
					if (attempt < LIMITS.readRetries && transientRead(error)) continue;
					fail(error instanceof EvryRefusal ? error : new EvryRefusal("source_unavailable"));
					return { error: "source_unavailable" };
				}
			}
			const sequence = await save("tool_result", { operation: adapter.operation, input, result });
			return sequence === null ? { error: "cancelled" } : forModel(sequence, result);
		};

		const tools: ToolSet = {};
		for (const [domain, adapters] of Object.entries(READ_DOMAINS)) {
			const allowed = (adapters as readonly ReadAdapter<unknown>[]).filter((a) => a.allowed(actor));
			if (!allowed.length) continue;
			const options = allowed.map((a) => z.strictObject({ operation: z.literal(a.operation), input: a.input }));
			tools[`${domain}_read`] = tool({
				description: `Bounded ${domain} reads: ${allowed.map((a) => `${a.operation} (${a.description})`).join("; ")}`,
				inputSchema: options.length === 1 ? options[0]! : z.discriminatedUnion("operation", options as never),
				execute: async (call: { operation: string; input: unknown }) =>
					read(
						allowed.find((a) => a.operation === call.operation)!,
						call.input,
					),
			});
		}
		if (catalog.selection.length)
			tools.select_returned_rows = tool({
				description:
					"Select people rows by id from a result this conversation already returned (its resultId). Selection never adds rows or ids.",
				inputSchema: z.strictObject({
					resultId: z.int().min(1),
					ids: z.array(z.uuid()).min(1).max(LIMITS.selectedRows),
				}),
				execute: async ({ resultId, ids }) => {
					const fresh = await admit();
					if (!fresh) return { error: stop === "tool_budget" ? "tool_budget" : "access_denied" };
					const saved = await savedResult(db, turn.conversation_id, resultId);
					const source = saved?.result as SourceResult | undefined;
					const returned = new Set(source?.rows.filter((r) => r.kind === "person").map((r) => r.id) ?? []);
					const rejected = ids.filter((id) => !returned.has(id));
					if (!source || rejected.length) return { error: "not_returned", rejected: rejected.length };
					// Current access is checked again before a returned row is reused.
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
					return sequence === null ? { error: "cancelled" } : forModel(sequence, result);
				},
			});

		// A reviewed write is only proposed here: the review card is saved and a person approves it in the app.
		const writes = allowedWrites(actor);
		if (writes.length) {
			const options = writes.map((w) => z.strictObject({ operation: z.literal(w.operation), input: w.input }));
			tools.propose_change = tool({
				description: `Prepare an exact review of one change for the user to approve: ${writes.map((w) => `${w.operation} (${w.description})`).join("; ")}. Use ids from earlier results. Nothing changes until the user approves.`,
				inputSchema: options.length === 1 ? options[0]! : z.discriminatedUnion("operation", options as never),
				execute: async (call: { operation: string; input: unknown }) => {
					const fresh = await admit();
					if (!fresh) return { error: stop === "tool_budget" ? "tool_budget" : "access_denied" };
					const proposal = await prepareProposal(db, fresh, lease, turn.conversation_id, call).catch((error) =>
						error instanceof EvryRefusal ? error.code : "unknown",
					);
					if (typeof proposal === "string") return { error: proposal };
					if (!proposal) return { error: "source_unavailable" };
					const target = proposal.review.target;
					const sequence = await save("tool_result", {
						operation: "evry.prepareProposal",
						input: { operation: call.operation },
						result: {
							operation: "evry.prepareProposal",
							status: "available",
							// The target row lets replay withhold the card once the target is no longer available.
							rows: target ? [{ kind: "person", id: target.id, label: target.label, fields: {} }] : [],
							total: 1,
							page: 1,
							next: null,
							completeness: "complete",
							exclusions: [],
							proposalId: proposal.id,
						},
					});
					if (sequence === null) return { error: "cancelled" };
					return JSON.parse(
						scrub(
							JSON.stringify({
								proposalId: proposal.id,
								status: "awaiting_approval",
								expiresAt: proposal.expiresAt,
								// The reviewed fields live in their source row, so a later model call withholds them with
								// the row once the target is no longer available (withLiveRows).
								rows: target
									? [
											{
												kind: "person",
												id: target.id,
												label: target.label,
												fields: { changes: proposal.review.changes },
											},
										]
									: [],
							}),
						),
					) as Record<string, unknown>;
				},
			});
		}

		// The classification call counts against the same turn budget as every tool-loop step.
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
			// The stream's error part ends the turn with a projected error; the SDK's default logger would print the raw
			// provider message, URL and payload.
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
