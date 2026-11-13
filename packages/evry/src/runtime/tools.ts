import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readCatalog, READ_DOMAINS } from "../catalog/catalog.ts";
import type { ReadAdapter, SourceResult } from "../catalog/types.ts";
import type { EvryActor } from "../context/actor.ts";
import { scrub } from "../context/errors.ts";
import { LIMITS } from "../context/limits.ts";
import { allowedWrites, type Proposal } from "../proposals/store.ts";

type ModelReply = Record<string, unknown>;

/**
 * The model's read tools for this actor: one per domain, whose closed operation discriminator holds only the operations
 * the actor may use now. `run` executes one chosen operation.
 */
export function readTools(actor: EvryActor, run: ToolHandlers["read"]): ToolSet {
	const tools: ToolSet = {};
	for (const [domain, adapters] of Object.entries(READ_DOMAINS)) {
		const allowed = (adapters as readonly ReadAdapter<unknown>[]).filter((a) => a.allowed(actor));
		if (!allowed.length) continue;
		const options = allowed.map((a) => z.strictObject({ operation: z.literal(a.operation), input: a.input }));
		tools[`${domain}_read`] = tool({
			description: `Bounded ${domain} reads: ${allowed.map((a) => `${a.operation} (${a.description})`).join("; ")}`,
			inputSchema: options.length === 1 ? options[0]! : z.discriminatedUnion("operation", options as never),
			execute: async (call: { operation: string; input: unknown }) =>
				run(
					allowed.find((a) => a.operation === call.operation)!,
					call.input,
				),
		});
	}
	return tools;
}

/** What a turn does when the model calls one of its tools. Each handler returns what the model reads back. */
export type ToolHandlers = {
	/** Runs one read the actor may use now. */
	read(adapter: ReadAdapter<unknown>, input: unknown): Promise<ModelReply>;
	/** Re-selects person rows by id from a result this conversation already returned. */
	select(call: { resultId: number; ids: string[] }): Promise<ModelReply>;
	/** Prepares the exact review of one reviewed write; nothing changes until a person approves it. */
	propose(call: { operation: string; input: unknown }): Promise<ModelReply>;
};

/**
 * The model's tools for this actor, the one definition the turn (turn.ts) and the recorded evals both use: one bounded
 * read tool per domain, whose closed operation discriminator holds only the operations the actor may use now;
 * select_returned_rows when the actor has a read; propose_change when the actor has a reviewed write. Approvals,
 * execution, code, network, files and SQL are never model tools.
 */
export function modelTools(actor: EvryActor, handlers: ToolHandlers): ToolSet {
	const tools = readTools(actor, handlers.read);
	if (readCatalog(actor).selection.length)
		tools.select_returned_rows = tool({
			description:
				"Select people rows by id from a result this conversation already returned (its resultId). Selection never adds rows or ids.",
			inputSchema: z.strictObject({
				resultId: z.int().min(1),
				ids: z.array(z.uuid()).min(1).max(LIMITS.selectedRows),
			}),
			execute: async (call) => handlers.select(call),
		});
	// A reviewed write is only proposed here: the review card is saved and a person approves it in the app.
	const writes = allowedWrites(actor);
	if (writes.length) {
		const options = writes.map((w) => z.strictObject({ operation: z.literal(w.operation), input: w.input }));
		tools.propose_change = tool({
			description: `Prepare an exact review of one change for the user to approve: ${writes.map((w) => `${w.operation} (${w.description})`).join("; ")}. Use ids from earlier results. Nothing changes until the user approves.`,
			inputSchema: options.length === 1 ? options[0]! : z.discriminatedUnion("operation", options as never),
			execute: async (call: { operation: string; input: unknown }) => handlers.propose(call),
		});
	}
	return tools;
}

/** The model sees the rows' safe fields, the exact total and the paging facts, bounded to one content section. */
export function resultForModel(resultId: number, result: SourceResult): ModelReply {
	const value = { resultId, ...result };
	const json = scrub(JSON.stringify(value));
	if (json.length <= LIMITS.sectionChars) return JSON.parse(json) as ModelReply;
	const rows: SourceResult["rows"] = [];
	for (const row of result.rows) {
		if (JSON.stringify([...rows, row]).length > LIMITS.sectionChars - 1_000) break;
		rows.push(row);
	}
	return JSON.parse(scrub(JSON.stringify({ ...value, rows, truncatedRows: result.rows.length - rows.length })));
}

/** What the model reads back for a prepared review: the card's id, its expiry and the reviewed fields on their row. */
export function proposalForModel(proposal: Pick<Proposal, "id" | "expiresAt" | "review">): ModelReply {
	const target = proposal.review.target;
	return JSON.parse(
		scrub(
			JSON.stringify({
				proposalId: proposal.id,
				status: "awaiting_approval",
				expiresAt: proposal.expiresAt,
				// The reviewed fields live in their source row, so a later model call withholds them with the row once the
				// target is no longer available (withLiveRows in turn.ts).
				rows: target
					? [{ kind: target.kind, id: target.id, label: target.label, fields: { changes: proposal.review.changes } }]
					: [],
			}),
		),
	) as ModelReply;
}
