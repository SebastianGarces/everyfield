import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { READ_DOMAINS } from "../catalog/catalog.ts";
import type { ReadAdapter } from "../catalog/types.ts";
import type { EvryActor } from "../context/actor.ts";
import { LIMITS } from "../context/limits.ts";
import type { ReviewedWrite } from "../proposals/types.ts";

type Run<I> = (call: I) => Promise<Record<string, unknown>>;

/**
 * The model's read tools for this actor: one per domain, whose closed operation discriminator holds only the operations
 * the actor may use now. `run` executes one chosen operation. The turn runs the real read; the recorded evals pass a
 * fixture, so the model sees the same tool definitions in both.
 */
export function readTools(
	actor: EvryActor,
	run: (adapter: ReadAdapter<unknown>, input: unknown) => Promise<Record<string, unknown>>,
): ToolSet {
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

/** The tool that narrows a result this conversation already returned. The turn and the recorded evals share it. */
export function selectReturnedRowsTool(run: Run<{ resultId: number; ids: string[] }>) {
	return tool({
		description:
			"Select people rows by id from a result this conversation already returned (its resultId). Selection never adds rows or ids.",
		inputSchema: z.strictObject({
			resultId: z.int().min(1),
			ids: z.array(z.uuid()).min(1).max(LIMITS.selectedRows),
		}),
		execute: run,
	});
}

/** The tool that prepares a review of one of `writes` for a person to approve. It never applies the change. */
export function proposeChangeTool(
	writes: readonly ReviewedWrite<unknown>[],
	run: Run<{ operation: string; input: unknown }>,
) {
	const options = writes.map((w) => z.strictObject({ operation: z.literal(w.operation), input: w.input }));
	return tool({
		description: `Prepare an exact review of one change for the user to approve: ${writes.map((w) => `${w.operation} (${w.description})`).join("; ")}. Use ids from earlier results. Nothing changes until the user approves.`,
		inputSchema: options.length === 1 ? options[0]! : z.discriminatedUnion("operation", options as never),
		execute: run,
	});
}
