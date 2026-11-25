import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { COMPOSE_READS, readCatalog, READ_DOMAINS, READ_DRAFT, READ_REVIEW, UPDATE_DRAFT } from "../catalog/catalog.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../catalog/types.ts";
import { outcomeOf } from "../context/compile.ts";
import type { ReviewOutcome } from "../conversations/store.ts";
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

const composed = z.strictObject({
	reads: z
		.array(z.strictObject({ operation: z.string(), input: z.record(z.string(), z.unknown()) }))
		.min(1)
		.describe(`At most ${LIMITS.composedReads}; each input is exactly what its own read tool takes`),
});
async function composeReads(
	adapters: readonly ReadAdapter<unknown>[],
	{ reads }: z.infer<typeof composed>,
	run: ToolHandlers["read"],
): Promise<ModelReply> {
	if (reads.length > LIMITS.composedReads) return { error: "too_many_reads", limit: LIMITS.composedReads };
	const byName = new Map(adapters.map((a) => [a.operation, a]));
	const undeclared = reads.filter((r) => !byName.has(r.operation)).map((r) => r.operation);
	if (undeclared.length) return { error: "not_a_read", operations: undeclared };
	const results = await Promise.all(
		reads.map(async ({ operation, input }): Promise<ModelReply> => {
			const adapter = byName.get(operation);
			const parsed = adapter?.input.safeParse(input);
			if (!adapter || !parsed?.success) return { operation, error: "invalid_input" };
			return { operation, ...(await run(adapter, parsed.data)) };
		}),
	);
	return { results };
}

export type ToolHandlers = {
	read(adapter: ReadAdapter<unknown>, input: unknown): Promise<ModelReply>;
	select(call: { resultId: number; ids: string[] }): Promise<ModelReply>;
	propose(call: { operation: string; input: unknown }): Promise<ModelReply>;
	readNotes(): Promise<ModelReply>;
	updateNotes(call: { notes: string; expectedRevision: number }): Promise<ModelReply>;
	readReview(call: { proposalId?: string }): Promise<ModelReply>;
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
	const reads = (Object.values(READ_DOMAINS).flat() as readonly ReadAdapter<unknown>[]).filter(
		(a) => offered(a.operation) && a.allowed(actor),
	);
	if (reads.length && offered(COMPOSE_READS))
		tools.compose_reads = tool({
			description: `Run two to ${LIMITS.composedReads} of your declared reads together when a question needs several and none needs another's result. Each read counts as one tool call, keeps its own resultId and access check, and fails on its own. Reads only: changes and approvals can't be composed.`,
			inputSchema: composed,
			execute: async (call) => composeReads(reads, call, handlers.read),
		});
	if (offered(READ_DRAFT))
		tools.read_planning_notes = tool({
			description:
				"Read back the planning notes you keep in this conversation, with their revision. Read them first when continuing a long request.",
			inputSchema: z.strictObject({}),
			execute: async () => handlers.readNotes(),
		});
	if (offered(UPDATE_DRAFT))
		tools.update_planning_notes = tool({
			description: `Keep your own planning notes between the steps of a long request (what is done, what is left, what to ask), at most ${LIMITS.notesChars.toLocaleString("en-US")} characters. notes replaces them all ("" clears them) and expectedRevision is the revision you last read, 0 when none. Notes are yours for this conversation: they change no record, approve nothing and are never something the user said.`,
			inputSchema: z.strictObject({ notes: z.string(), expectedRevision: z.int().min(0) }),
			execute: async (call) => handlers.updateNotes(call),
		});
	if (offered(READ_REVIEW))
		tools.read_review = tool({
			description:
				"Say what became of the changes you proposed in this conversation: waiting, approved, declined or expired, and an approved change's recorded outcome. Give proposalId for one, or leave it out for the latest. Answer only from it; it never repeats what a change said.",
			inputSchema: z.strictObject({ proposalId: z.uuid().optional() }),
			execute: async (call) => handlers.readReview(call),
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

const REVIEW_STATUS: Record<Proposal["status"], string> = {
	pending: "waiting",
	approved: "approved",
	cancelled: "declined",
	expired: "expired",
};
export function reviewsRead(total: number, reviews: readonly ReviewOutcome[]): SourceResult {
	return {
		operation: READ_REVIEW,
		status: reviews.length ? "available" : "not_found",
		rows: reviews.map((r) => {
			const target = r.review.target;
			return {
				kind: target ? (target.kind as SourceRow["kind"]) : "item",
				id: target ? target.id : r.id,
				label: target?.label ?? "",
				fields: {
					proposalId: r.id,
					operation: r.operation,
					status: REVIEW_STATUS[r.status],
					outcome: outcomeOf(r),
					approvedAt: r.approvedAt?.toISOString() ?? null,
				},
			};
		}),
		total,
		page: 1,
		next: null,
		completeness: reviews.length < total ? "partial" : "complete",
		exclusions: ["what each change said"],
	};
}

const REFUSAL_DETAIL: Partial<Record<string, string>> = {
	mail_paused:
		"Sending email is paused for everyone right now, so nothing was prepared, scheduled or sent. Tell the user that email is paused, that nothing was sent, and that they can ask again later.",
};

export function refusalForModel(code: string): { error: string; detail?: string } {
	const detail = REFUSAL_DETAIL[code];
	return detail ? { error: code, detail } : { error: code };
}

const RECORDED_CRITERIA = z.array(
	z.strictObject({ label: z.string(), status: z.string(), reading: z.string().nullable() }),
);
function forModel(c: Proposal["review"]["changes"][number]) {
	if (c.field === "note") return { ...c, before: c.before === null ? null : "(the current note)" };
	const open = c.field === "openCriteria" ? RECORDED_CRITERIA.safeParse(c.after) : null;
	return open?.success ? { ...c, after: open.data.map(({ label, status }) => ({ label, status })) } : c;
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
									changes: proposal.review.changes.map(forModel),
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
