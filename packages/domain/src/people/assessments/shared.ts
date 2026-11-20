import * as c from "@everyfield/contracts/people";
import { and, eq, sql, type SQL, type SQLWrapper, type SqlLiteral } from "@everyfield/db/query";
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
export const churchToday = sql`(clock_timestamp() AT TIME ZONE pl.timezone)::date::text`;

export async function subject(
	tx: Tx,
	ctx: Pick<Context, "selected">,
	person: string | SQL,
	extra?: SQL,
): Promise<Subject> {
	const plant = plantId(ctx);
	const result = await tx.execute(sql`SELECT p.id,p.state,p.stage,p.revision::text AS revision,
 p.pipeline_position::text AS pipeline_position,p.commitment_state,p.commitment_effective_on::text AS commitment_effective_on,
 ${churchToday} AS today,clock_timestamp() AS now,${extra ?? sql`NULL`} AS extra
 FROM person p JOIN plant pl ON pl.id=p.plant_id WHERE p.id=${typeof person === "string" ? sql`${person}::uuid` : person} AND p.tenant_id=${plant}::uuid AND p.plant_id=${plant}::uuid
 FOR UPDATE OF p`);
	if (!result.rows[0]) deny("unavailable");
	const p = subjectRow.parse(result.rows[0]);
	if (p.state !== "live") deny("unavailable");
	return p;
}
export function notFuture(p: Pick<Subject, "today">, date: string) {
	if (date > p.today) deny("invalid_input", { reason: "future_date" });
}

export const adminRead = (ctx: Pick<Context, "session" | "selected">) =>
	liveRead({ session: ctx.session, owner: ctx.selected }, true);

const order = c.stage.options;
export function advance(p: Subject, target: Stage) {
	if (order.indexOf(p.stage) >= order.indexOf(target)) return { set: {}, change: null };
	const position = sameColumn(p.stage, target) ? p.pipeline_position : freshPosition(p.id);
	return { set: { stage: target, pipeline_position: position }, change: { from: p.stage, to: target } };
}
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

export const recordEvent = (event: string, recordId?: string): Record<string, string> =>
	recordId ? { event, recordId } : { event };

export const recorderSql = <AliasName extends string>(alias: SqlLiteral<AliasName>) =>
	sql.raw(`(SELECT a.actor_id FROM audit_event a WHERE a.tenant_id=${alias}.plant_id AND a.subject_id IN (SELECT ${alias}.person_id
 UNION ALL SELECT m.id FROM person m WHERE m.merged_into_person_id=${alias}.person_id AND m.tenant_id=${alias}.plant_id)
 AND a.action='people.recorded' AND a.metadata->>'recordId'=${alias}.id::text ORDER BY a.occurred_at,a.id LIMIT 1)`);
export function attribution(plant: string, recordId: string, actorId: string | null) {
	return actorId
		? { kind: "current_account" as const, accountId: actorId }
		: { kind: "former_account" as const, scopeLocalToken: hash([plant, recordId]) };
}

export type HistoryPage = { page: number; limit: number };
export function historyJson(
	plant: string,
	input: HistoryPage,
	from: SQL,
	row: SQL,
	order: SQL,
	extra: SQL = sql`NULL`,
) {
	const where = sql`r.person_id=p.id AND r.plant_id=${plant}::uuid`;
	return sql`jsonb_build_object('extra',${extra},'total',(SELECT count(*)::int FROM ${from} r WHERE ${where}),
 'items',(SELECT coalesce(jsonb_agg(x.j ORDER BY x.n),'[]') FROM (SELECT ${row} AS j,row_number() OVER (ORDER BY ${order}) AS n
   FROM ${from} r WHERE ${where} ORDER BY ${order} LIMIT ${input.limit} OFFSET ${(input.page - 1) * input.limit}) x),
 'latest',(SELECT ${row} FROM ${from} r WHERE ${where} ORDER BY ${order} LIMIT 1))`;
}
const historyRow = z.object({
	extra: z.unknown(),
	total: z.number(),
	items: z.array(z.unknown()),
	latest: z.unknown(),
});
export function history(plant: string, input: HistoryPage, raw: unknown) {
	const { total, items, latest, extra } = historyRow.parse(raw);
	return { plant, total, items, latest, extra, next: input.page * input.limit < total ? input.page + 1 : null };
}
export type History = ReturnType<typeof history>;

export async function readHistory(
	tx: Tx,
	ctx: Context,
	input: { personId: string } & HistoryPage,
	json: (plant: string) => SQL,
) {
	const plant = plantId(ctx);
	const result = await tx.execute(sql`SELECT ${json(plant)} AS h
 FROM person p WHERE ${adminRead(ctx)} AND p.id=${input.personId}::uuid AND p.tenant_id=${plant}::uuid
 AND p.plant_id=${plant}::uuid`);
	if (!result.rows[0]) deny("unavailable");
	return history(plant, input, result.rows[0].h);
}

export function receiptOf(value: Record<string, unknown>, field: string, recordId: string) {
	return { ...Object.fromEntries(Object.entries(value).filter(([k]) => k !== field)), recordId };
}
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
	if (!result.rows[0]) deny("unavailable");
	return { ...rest, [field]: view(plant, result.rows[0].j) };
}
