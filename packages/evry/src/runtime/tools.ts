import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { READ_DOMAINS } from "../catalog/catalog.ts";
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
