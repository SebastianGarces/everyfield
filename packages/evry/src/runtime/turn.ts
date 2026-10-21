import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { streamText, tool, type StopCondition, type ToolSet } from "ai";
import { z } from "zod";
import { READ_DOMAINS, readCatalog, SELECT_RETURNED_ROWS } from "../catalog/catalog.ts";
import { getPerson } from "../catalog/people.ts";
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
import type { QualifiedModel } from "./model.ts";
import { appendEvent, loadTurn, savedResult, type RunLease } from "./run-store.ts";

export type RunDeps = {
	db: Database;
	model: QualifiedModel;
	/** The session's current actor, read again from the database: the fresh authority check before every read. */
	freshActor(session: string): Promise<EvryActor | null>;
	now?: () => Date;
	/** How often streamed text is saved for observers. */
	flushMs?: number;
};
/** succeeded: the turn saved its final state. failed: it saved a failure. lost: it no longer owned the run. */
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
export async function runTurn(deps: RunDeps, lease: RunLease): Promise<RunOutcome> {
	const { db } = deps;
	const turn = await loadTurn(db, lease);
	if (!turn) return "lost";
	const abort = new AbortController();
	const wall = setTimeout(() => abort.abort("wall_time"), LIMITS.wallMs);
	let lost = false;
	let stop: StopReason = "completed";
	let failure: EvryRefusal | null = null;
	let text = "";
	let pending = "";
	let toolCalls = 0;
	const usage = { inputTokens: 0, outputTokens: 0 };
	const save = async (kind: "assistant_text" | "tool_result", body: Record<string, unknown>) => {
		const sequence = lost ? null : await appendEvent(db, lease, turn.conversation_id, kind, body);
		if (sequence === null && !lost) {
			lost = true;
			abort.abort("lost");
		}
		return sequence;
	};
	const flush = async () => {
		if (!pending) return;
		const delta = pending;
		pending = "";
		await save("assistant_text", { text: delta });
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
				usage: { ...usage, toolCalls },
				...(failed ? { error: projectError(failure) } : {}),
			},
			true,
		);
		if (sequence === null) return "lost";
		return failed ? "failed" : "succeeded";
	};

	try {
		const session = turn.session_id;
		const actor = session ? await deps.freshActor(session) : null;
		if (!session || !actor || actor.accountId !== turn.account_id || actor.owner.id !== turn.tenant_id)
			throw new EvryRefusal("access_denied");
		if (deps.model.status !== "qualified") throw new EvryRefusal("model_unavailable");
		const model = deps.model.model;
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

		const references = await resolveReferences(db, actor, turn.message.body.references);
		const context = compileContext({
			actor,
			catalog,
			history: turn.history,
			text: request,
			references: references.verified,
			now: deps.now?.() ?? new Date(),
		});

		// One budget gate for every tool: the 25th call runs nothing, and a changed context stops the turn.
		const admit = async () => {
			if (++toolCalls > LIMITS.toolCalls) {
				toolCalls = LIMITS.toolCalls;
				stop = "tool_budget";
				return null;
			}
			const fresh = await deps.freshActor(session);
			if (!fresh || !sameContext(fresh, actor)) {
				fail(new EvryRefusal("access_denied"));
				return null;
			}
			return fresh;
		};
		const read = async <I>(adapter: ReadAdapter<I>, input: I) => {
			const fresh = await admit();
			if (!fresh) return { error: stop === "tool_budget" ? "tool_budget" : "access_denied" };
			if (!adapter.allowed(fresh)) return { error: "access_denied" };
			let result: SourceResult | undefined;
			for (let attempt = 0; result === undefined; attempt++) {
				try {
					result = await db.transaction(async (tx) => {
						await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${LIMITS.readTimeoutMs}`));
						return adapter.invoke(tx, fresh, input);
					});
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
					const rows: SourceResult["rows"] = [];
					await db.transaction(async (tx) => {
						for (const personId of ids) rows.push(...(await getPerson.invoke(tx, fresh, { personId })).rows);
					});
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
			maxRetries: 0,
			maxOutputTokens: LIMITS.outputTokensPerCall,
			abortSignal: abort.signal,
		});
		let flushed = Date.now();
		for await (const part of stream.fullStream) {
			if (part.type === "text-delta") {
				text += part.text;
				pending += part.text;
				if (Date.now() - flushed >= (deps.flushMs ?? 250)) {
					flushed = Date.now();
					await flush();
				}
			} else if (part.type === "finish-step") {
				usage.inputTokens += part.usage.inputTokens ?? 0;
				usage.outputTokens += part.usage.outputTokens ?? 0;
				await flush();
			} else if (part.type === "error") {
				if (!abort.signal.aborted) throw new EvryRefusal("model_unavailable");
			} else if (part.type === "abort") break;
		}
		await flush();
	} catch (error) {
		if (!abort.signal.aborted) fail(error instanceof EvryRefusal ? error : new EvryRefusal("unknown"));
	} finally {
		clearTimeout(wall);
	}
	if (abort.signal.reason === "wall_time" && stop === "completed") stop = "wall_time";
	await flush().catch(() => undefined);
	return finish();
}
