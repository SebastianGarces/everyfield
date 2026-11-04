import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { READ_DOMAINS } from "../catalog/catalog.ts";
import { allowedWrites } from "../proposals/store.ts";
import type { ReadAdapter } from "../catalog/types.ts";
import type { EvryActor } from "../context/actor.ts";

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

/**
 * The model's one write tool for this actor: it only prepares a review of a change, never makes it. The closed
 * operation discriminator holds only the reviewed writes the actor may use now; null when there are none. The turn
 * prepares the real review; the recorded evals pass a stub, so the model sees the same definition in both.
 */
export function proposeChangeTool(
	actor: EvryActor,
	execute: (call: { operation: string; input: unknown }) => Promise<Record<string, unknown>>,
) {
	const writes = allowedWrites(actor);
	if (!writes.length) return null;
	const options = writes.map((w) => z.strictObject({ operation: z.literal(w.operation), input: w.input }));
	return tool({
		description: `Prepare an exact review of one change for the user to approve: ${writes.map((w) => `${w.operation} (${w.description})`).join("; ")}. Use ids from earlier results. Nothing changes until the user approves.`,
		inputSchema: options.length === 1 ? options[0]! : z.discriminatedUnion("operation", options as never),
		execute,
	});
}
