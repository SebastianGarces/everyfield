import { accountId as accountIdSchema } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/phases";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer, type PlantViewer } from "../documents/access.ts";

type Code = c.PhasesError["code"];
export class Refusal extends Error {
	readonly code: Code;
	readonly details: object;
	constructor(code: Code, details: object = {}) {
		super(code);
		this.code = code;
		this.details = details;
	}
}
export function deny(code: Code, details: object = {}): never {
	throw new Refusal(code, details);
}
export async function settle<T>(body: () => Promise<T>): Promise<c.PhasesReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return {
			status: "refused",
			error: c.phasesError.parse({
				code: error.code,
				details: error.details,
				correlationId: randomUUID(),
				retry: error.code === "already_declared" || error.code === "revision_conflict" ? "refresh" : "never",
			}),
		};
	}
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	if (!found.success) deny("invalid_input");
	return found.data;
}

/**
 * The church plant of the request, with `admin`: the SQL condition that the request's session is live and its exact
 * seat is still an Owner or Admin seat (C13). Every phase read and write puts it in its own statement; a Member's
 * condition is false, so the statement reads and writes nothing (phases.* authority: Owner or Admin only).
 */
export type Scope = PlantViewer & { admin: SQL };
export function scopeOf(authority: RequestActor): Scope {
	const viewer = plantViewer(authority);
	if (!viewer) deny("access_denied");
	return { ...viewer, admin: viewer.access.role === "member" ? sql`false` : liveRead(viewer.access, true) };
}

/** An instant as the contracts write it. */
const iso = (value: SQL) => sql`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** One journey row as JSON, with the account that recorded it: `t` is a phase_transition row, `a` its audit row. */
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
/** A journey entry from entryJson: the direction comes from the phases, never from stored text. */
export function entryOf(raw: unknown): c.JourneyEntry {
	const r = entryRow.parse(raw);
	const actor = r.actorId ? { accountId: accountIdSchema.parse(r.actorId), displayName: r.actorName ?? "" } : null;
	const base = { id: r.id, fromPhase: r.fromPhase, toPhase: r.toPhase, actor, occurredAt: r.occurredAt };
	if (r.kind !== "movement") return c.journeyEntry.parse({ ...base, kind: r.kind });
	const direction = c.classifyChange(r.fromPhase!, r.toPhase);
	return c.journeyEntry.parse({ ...base, kind: r.kind, direction, reason: r.reason });
}
/** True while the plant has used neither its declaration slot nor an ordinary move: `plant` is an SQL id. */
export const declarable = (plant: SQL) =>
	sql`NOT EXISTS(SELECT FROM phase_transition x WHERE x.plant_id=${plant} AND x.kind IN ('initial_declaration','movement'))`;
