import type { EvryActor } from "../context/actor.ts";
import type { SourceRow } from "./types.ts";

/**
 * The one builder of a `person` row. The row that is the signed-in user's own carries `you: true`, so the model can
 * tell the user from everyone else; every other row carries no `you` marker. Lists, counts and lookups still include
 * the user's row.
 */
export function personRow(
	actor: Pick<EvryActor, "selfPersonId">,
	id: string,
	label: string,
	fields: Record<string, string | null>,
): SourceRow {
	return { kind: "person", id, label, fields: id === actor.selfPersonId ? { ...fields, you: true } : fields };
}
