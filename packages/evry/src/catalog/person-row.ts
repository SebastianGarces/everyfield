import type { EvryActor } from "../context/actor.ts";
import type { SourceRow } from "./types.ts";

export function personRow(
	actor: Pick<EvryActor, "selfPersonId">,
	id: string,
	label: string,
	fields: Record<string, string | number | boolean | null>,
): SourceRow {
	return { kind: "person", id, label, fields: id === actor.selfPersonId ? { ...fields, you: true } : fields };
}
