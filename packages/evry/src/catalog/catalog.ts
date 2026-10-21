import type { EvryActor } from "../context/actor.ts";
import { getPerson, listPeople } from "./people.ts";
import { allowedWrites } from "../proposals/store.ts";
import type { ReadAdapter } from "./types.ts";

/**
 * Every installed read adapter, grouped by domain. Each operation is flagged model_tool in docs/catalog/operations.json
 * and listed in the generated docs/catalog/evry-tools.json; the catalog test holds both lists to this one. A domain
 * gets one bounded read tool whose closed operation discriminator holds only the operations its adapters install.
 */
export const READ_DOMAINS = {
	people: [listPeople, getPerson],
} as const satisfies Record<string, readonly Pick<ReadAdapter<unknown>, "operation" | "description" | "allowed">[]>;

/** The runtime's own model tool: pick rows from a result this conversation already returned. */
export const SELECT_RETURNED_ROWS = "evry.selectReturnedRows";

/**
 * evry.readCatalog: what this actor may use right now. Current authority filters every adapter, so a plant Owner and
 * an organization Member see different lists, and an account context sees none of the People reads.
 */
export function readCatalog(actor: EvryActor) {
	const domains = Object.entries(READ_DOMAINS)
		.map(([domain, adapters]) => ({
			domain,
			operations: adapters
				.filter((a) => a.allowed(actor))
				.map((a) => ({ operation: a.operation, description: a.description })),
		}))
		.filter((d) => d.operations.length > 0);
	return {
		context: actor.contextKind,
		domains,
		selection: domains.length > 0 ? [SELECT_RETURNED_ROWS] : [],
		// A reviewed write is only proposed: a person approves the exact review before it runs. Approvals, code, network,
		// files and SQL are never model tools.
		reviewedWrites: allowedWrites(actor).map((w) => ({ operation: w.operation, description: w.description })),
	};
}
export type Catalog = ReturnType<typeof readCatalog>;
