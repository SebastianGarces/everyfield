import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readCatalog, READ_DOMAINS } from "../catalog/catalog.ts";
import type { ReadAdapter, SourceResult } from "../catalog/types.ts";
import type { EvryActor } from "../context/actor.ts";
import { scrub } from "../context/errors.ts";
import { LIMITS } from "../context/limits.ts";
import { allowedWrites, everyOperation, type Offered, type Proposal } from "../proposals/store.ts";

type ModelReply = Record<string, unknown>;

export function readTools(actor: EvryActor, run: ToolHandlers["read"], offered: Offered = everyOperation): ToolSet {
	const tools: ToolSet = {};
	for (const [domain, adapters] of Object.entries(READ_DOMAINS)) {
		const allowed = (adapters as readonly ReadAdapter<unknown>[]).filter(
			(a) => offered(a.operation) && a.allowed(actor),
		);
		if (!allowed.length) continue;
		const options = allowed.map((a) => z.strictObject({ operation: z.literal(a.operation), input: a.input }));
		const [only] = options;
		tools[`${domain}_read`] = tool({
			description: `Bounded ${domain} reads: ${allowed.map((a) => `${a.operation} (${a.description})`).join("; ")}`,
			inputSchema: only && options.length === 1 ? only : z.discriminatedUnion("operation", options as never),
			execute: async (call: { operation: string; input: unknown }) => {
				const adapter = allowed.find((a) => a.operation === call.operation);
				if (!adapter) throw new Error(`${call.operation} is not an offered read`);
				return run(adapter, call.input);
			},
		});
	}
	return tools;
}

export type ToolHandlers = {
	read(adapter: ReadAdapter<unknown>, input: unknown): Promise<ModelReply>;
	select(call: { resultId: number; ids: string[] }): Promise<ModelReply>;
	propose(call: { operation: string; input: unknown }): Promise<ModelReply>;
};

export function modelTools(actor: EvryActor, handlers: ToolHandlers, offered: Offered = everyOperation): ToolSet {
	const tools = readTools(actor, handlers.read, offered);
	if (readCatalog(actor, offered).selection.length)
		tools.select_returned_rows = tool({
			description:
				"Select people rows by id from a result this conversation already returned (its resultId). Selection never adds rows or ids.",
			inputSchema: z.strictObject({
				resultId: z.int().min(1),
				ids: z.array(z.uuid()).min(1).max(LIMITS.selectedRows),
			}),
			execute: async (call) => handlers.select(call),
		});
	const writes = allowedWrites(actor, offered);
	if (writes.length) {
		const options = writes.map((w) => z.strictObject({ operation: z.literal(w.operation), input: w.input }));
		const [only] = options;
		tools.propose_change = tool({
			description: `Prepare an exact review of one change for the user to approve: ${writes.map((w) => `${w.operation} (${w.description})`).join("; ")}. Use ids from earlier results. Nothing changes until the user approves.`,
			inputSchema: only && options.length === 1 ? only : z.discriminatedUnion("operation", options as never),
			execute: async (call: { operation: string; input: unknown }) => handlers.propose(call),
		});
	}
	return tools;
}

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

export function proposalForModel(proposal: Pick<Proposal, "id" | "expiresAt" | "review">): ModelReply {
	const target = proposal.review.target;
	const people = (proposal.review.people ?? []).map((p) => ({
		kind: "person",
		id: p.id,
		label: p.label,
		fields: { changes: p.changes, ...(p.unchanged && { unchanged: p.unchanged }) },
	}));
	return JSON.parse(
		scrub(
			JSON.stringify({
				proposalId: proposal.id,
				...(proposal.review.refusal
					? { status: "refused", refusal: proposal.review.refusal }
					: { status: "awaiting_approval", expiresAt: proposal.expiresAt }),
				...(proposal.review.refusal ? { refusal: proposal.review.refusal } : {}),
				rows: target
					? [
							{
								kind: target.kind,
								id: target.id,
								label: target.label,
								fields: {
									changes: proposal.review.changes.map((c) =>
										c.field === "note" ? { ...c, before: c.before === null ? null : "(the current note)" } : c,
									),
								},
							},
							...people,
						]
					: people,
				...(target ? {} : { changes: proposal.review.changes }),
			}),
		),
	) as ModelReply;
}
