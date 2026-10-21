import * as c from "@everyfield/contracts/people";
import { and, eq, sql, type SQL, type SQLWrapper } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import "server-only";
import { z } from "zod";
import { deny, hash, type Context, type Tx } from "../core.ts";
import { liveRead } from "../../access/session.ts";
import { plantId } from "../fields/shared.ts";
import { columnsChanged, freshPosition, sameColumn } from "../people.ts";

type Stage = z.infer<typeof c.stage>;
const subjectRow = z.object({
	id: z.uuid(),
	state: z.enum(["live", "retired", "merged"]),
	stage: c.stage,
	revision: z.string(),
	pipeline_position: z.string(),
	commitment_state: z.enum(["active", "withdrawn", "unknown"]),
	commitment_effective_on: z.string().nullable(),
	today: z.string(),
	now: z.coerce.date(),
	extra: z.unknown(),
});
export type Subject = z.infer<typeof subjectRow>;

/**
 * The live plant Person a record names (by ID, or a subquery such as a card's Person), locked for the write, with the church-local date and the database time the
 * record keeps as its recorded instant. `extra` is a scalar subquery read in the same round trip (a witness, an upload).
 * Retirement and merge lock the same row, so a new record never names a retired Person (REQ-PPL-024).
 */
export async function subject(
	tx: Tx,
	ctx: Pick<Context, "selected">,
	person: string | SQL,
	extra?: SQL,
): Promise<Subject> {
	const plant = plantId(ctx);
	const result = await tx.execute(sql`SELECT p.id,p.state,p.stage,p.revision::text AS revision,
 p.pipeline_position::text AS pipeline_position,p.commitment_state,p.commitment_effective_on::text AS commitment_effective_on,
 (clock_timestamp() AT TIME ZONE pl.timezone)::date::text AS today,clock_timestamp() AS now,${extra ?? sql`NULL`} AS extra
 FROM person p JOIN plant pl ON pl.id=p.plant_id WHERE p.id=${typeof person === "string" ? sql`${person}::uuid` : person} AND p.tenant_id=${plant}::uuid AND p.plant_id=${plant}::uuid
 FOR UPDATE OF p`);
	if (!result.rows[0]) deny();
	const p = subjectRow.parse(result.rows[0]);
	if (p.state !== "live") deny();
	return p;
}
/** A recorded event happened on or before today in the church's time zone. */
export function notFuture(p: Subject, date: string) {
	if (date > p.today) deny("invalid_input");
}

/**
 * C13, C32: the live Owner or Admin read check, inside each statement that returns these records. live_session takes no
 * lock, so a sign-out never waits for a running read.
 */
export const adminRead = (ctx: Pick<Context, "session" | "selected">) =>
	liveRead({ session: ctx.session, owner: ctx.selected }, true);

const order = c.stage.options;
/**
 * REQ-PPL-020: an interview moves an earlier stage to interviewed and a commitment to core_group. An advanced stage
 * stays; only the stage command moves people back. Returns the Person columns to set and the change to report.
 */
export function advance(p: Subject, target: Stage) {
	if (order.indexOf(p.stage) >= order.indexOf(target)) return { set: {}, change: null };
	// Into another pipeline column: the person goes to its end with a fresh key (D68).
	const position = sameColumn(p.stage, target) ? p.pipeline_position : freshPosition(p.id);
	return { set: { stage: target, pipeline_position: position }, change: { from: p.stage, to: target } };
}
/** One Person update with the advance and any commitment change; the revision moves on only when something changed. */
export function personUpdate(
	tx: Tx,
	plant: string,
	p: Subject,
	set: Partial<typeof tables.person.$inferInsert>,
): SQLWrapper[] {
	if (!Object.keys(set).length) return [];
	const writes: SQLWrapper[] = [
		tx
			.update(tables.person)
			.set({ ...set, revision: sql`${tables.person.revision}+1` })
			.where(and(eq(tables.person.id, p.id), eq(tables.person.tenant_id, plant))),
	];
	if (set.stage && !sameColumn(p.stage, set.stage)) writes.push(columnsChanged(plant, [p.stage, set.stage]));
	return writes;
}
export const nextRevision = (p: Subject, set: object) =>
	Object.keys(set).length ? String(BigInt(p.revision) + 1n) : p.revision;

/** The audit metadata of one record event: never scores, criteria, results, notes or document details (audit.md). */
export const recordEvent = (event: string, recordId?: string): Record<string, string> =>
	recordId ? { event, recordId } : { event };

/**
 * The original recorder of a record, from its Person's audit history: the `people.recorded` event that names it. A
 * deleted account shows as a token local to the church and the record.
 */
export const recorderSql = (alias: string) =>
	sql.raw(`(SELECT a.actor_id FROM audit_event a WHERE a.tenant_id=${alias}.plant_id AND a.subject_id=${alias}.person_id
 AND a.action='people.recorded' AND a.metadata->>'recordId'=${alias}.id::text ORDER BY a.occurred_at,a.id LIMIT 1)`);
export function attribution(plant: string, recordId: string, actorId: string | null) {
	return actorId
		? { kind: "current_account" as const, accountId: actorId }
		: { kind: "former_account" as const, scopeLocalToken: hash([plant, recordId]) };
}

/**
 * One Person's records in one statement: the live reader check (C13, Owner and Admin only), the Person, one page latest
 * first, the latest record and the total. `row` builds one record's JSON from alias `r`; `order` sorts alias `r`.
 */
export async function readHistory(
	tx: Tx,
	ctx: Context,
	input: { personId: string; page: number; limit: number },
	from: SQL,
	row: SQL,
	order: SQL,
	extra: SQL = sql`NULL`,
) {
	const plant = plantId(ctx);
	const where = sql`r.person_id=p.id AND r.plant_id=${plant}::uuid`;
	const result = await tx.execute(sql`SELECT p.id AS person_id,${extra} AS extra,
 (SELECT count(*)::int FROM ${from} r WHERE ${where}) AS total,
 (SELECT coalesce(jsonb_agg(x.j ORDER BY x.n),'[]') FROM (SELECT ${row} AS j,row_number() OVER (ORDER BY ${order}) AS n
   FROM ${from} r WHERE ${where} ORDER BY ${order} LIMIT ${input.limit} OFFSET ${(input.page - 1) * input.limit}) x) AS items,
 (SELECT ${row} FROM ${from} r WHERE ${where} ORDER BY ${order} LIMIT 1) AS latest
 FROM person p WHERE ${adminRead(ctx)} AND p.id=${input.personId}::uuid AND p.tenant_id=${plant}::uuid
 AND p.plant_id=${plant}::uuid`);
	const found = z
		.object({
			person_id: z.uuid(),
			extra: z.unknown(),
			total: z.number(),
			items: z.array(z.unknown()),
			latest: z.unknown(),
		})
		.safeParse(result.rows[0]);
	if (!found.success) deny();
	const { total, items, latest, extra: more } = found.data;
	return { plant, total, items, latest, extra: more, next: input.page * input.limit < total ? input.page + 1 : null };
}

/**
 * The reply central audit keeps for a retry: everything except the private record (scores, criteria, notes, witness,
 * document), which audit must never hold (audit.md). It names the record instead.
 */
export function receiptOf(value: Record<string, unknown>, field: string, recordId: string) {
	return { ...Object.fromEntries(Object.entries(value).filter(([k]) => k !== field)), recordId };
}
/** A retry rebuilds the private part of its reply from the record itself, under the write's own authority. */
export async function replayed(
	tx: Tx,
	plant: string,
	stored: unknown,
	field: string,
	from: SQL,
	row: SQL,
	view: (plant: string, raw: unknown) => unknown,
) {
	const { recordId, ...rest } = z.looseObject({ recordId: z.uuid() }).parse(stored);
	const result = await tx.execute(
		sql`SELECT ${row} AS j FROM ${from} r WHERE r.id=${recordId}::uuid AND r.plant_id=${plant}::uuid`,
	);
	if (!result.rows[0]) deny();
	return { ...rest, [field]: view(plant, result.rows[0].j) };
}
