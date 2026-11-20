import { accountId as accountIdSchema } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/phases";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer, type PlantViewer } from "../documents/access.ts";
import { defineRefusals, type Deny } from "../operations/refusals.ts";

const refusals = defineRefusals(c.phasesError);
export const deny: Deny<typeof c.phasesError> = refusals.deny;
export const { settle } = refusals;
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	if (!found.success) deny("invalid_input");
	return found.data;
}

export type Scope = PlantViewer & { admin: SQL };
export function scopeOf(authority: RequestActor): Scope {
	const viewer = plantViewer(authority);
	if (!viewer) deny("access_denied");
	return { ...viewer, admin: viewer.access.role === "member" ? sql`false` : liveRead(viewer.access, true) };
}

const iso = (value: SQL) => sql`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const entryJson = (t: SQL, actor: SQL) =>
	sql`jsonb_build_object('id',${t}.id,'kind',${t}.kind,'fromPhase',${t}.from_phase,'toPhase',${t}.to_phase,
 'reason',${t}.reason,'actorId',${actor},'actorName',(SELECT display_name FROM seat_identity(${actor}) LIMIT 1),
 'occurredAt',${iso(sql`${t}.occurred_at`)})`;
const entryRow = z.object({
	id: z.uuid(),
	kind: z.enum(["creation", "initial_declaration", "movement"]),
	fromPhase: c.phaseNumber.nullable(),
	toPhase: c.phaseNumber,
	reason: z.string(),
	actorId: z.uuid().nullable(),
	actorName: z.string().nullable(),
	occurredAt: z.string(),
});
export function entryOf(raw: unknown): c.PhaseEntry {
	const r = entryRow.parse(raw);
	const actor = r.actorId ? { accountId: accountIdSchema.parse(r.actorId), displayName: r.actorName ?? "" } : null;
	const base = { id: r.id, fromPhase: r.fromPhase, toPhase: r.toPhase, actor, occurredAt: r.occurredAt };
	if (r.kind !== "movement") return c.phaseEntry.parse({ ...base, kind: r.kind });
	const direction = c.classifyChange(r.fromPhase!, r.toPhase);
	return c.phaseEntry.parse({ ...base, kind: r.kind, direction, reason: r.reason });
}
export const declarable = (plant: SQL) =>
	sql`NOT EXISTS(SELECT FROM phase_transition x WHERE x.plant_id=${plant} AND x.kind IN ('initial_declaration','movement'))`;
