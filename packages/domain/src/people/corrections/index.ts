import * as c from "@everyfield/contracts/people";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { adminRead, attribution, notFuture, recordEvent, subject } from "../assessments/shared.ts";
import { deny, hash, mutation, parse, readReply, reply, type Context, type Tx, type WriteContext } from "../core.ts";
import { expectRevision, plantId } from "../fields/shared.ts";

type RecordType = z.infer<typeof c.recordType>;
const lens = (col: string) => sql.raw(`jsonb_build_object('score',r.${col},'notes',r.${col}_notes)`);
const criterion = (col: string) => sql.raw(`jsonb_build_object('rating',r.${col},'notes',r.${col}_notes)`);
/**
 * Each correctable record: its table, the date column, and every ordinary correction field as the contract names it,
 * with the SQL that reads it and the columns it writes. Original recorder, recorded instant, witness and document are
 * not fields here, so no correction can change them (REQ-PPL-015).
 */
const records: Record<
	RecordType,
	{ table: string; fields: Record<string, { read: SQL; write: (v: never) => Record<string, unknown> }> }
> = {
	assessment: {
		table: "four_cs",
		fields: {
			occurredOn: { read: sql`r.assessed_on::text`, write: (v: string) => ({ assessed_on: v }) },
			...Object.fromEntries(
				c.fourCs.map((n) => [
					n,
					{
						read: lens(n),
						write: (v: { score: number; notes: string | null }) => ({ [n]: v.score, [`${n}_notes`]: v.notes }),
					},
				]),
			),
		},
	},
	interview: {
		table: "interview",
		fields: {
			occurredOn: { read: sql`r.interviewed_on::text`, write: (v: string) => ({ interviewed_on: v }) },
			...Object.fromEntries(
				c.interviewCriteria.map((n) => {
					const col = n === "rightReasons" ? "right_reasons" : n;
					return [
						n,
						{
							read: criterion(col),
							write: (v: { rating: string; notes: string | null }) => ({ [col]: v.rating, [`${col}_notes`]: v.notes }),
						},
					];
				}),
			),
			result: { read: sql`r.result`, write: (v: string) => ({ result: v }) },
			nextSteps: { read: sql`r.next_steps`, write: (v: string | null) => ({ next_steps: v }) },
		},
	},
	commitment: {
		table: "commitment",
		fields: { notes: { read: sql`r.notes`, write: (v: string | null) => ({ notes: v }) } },
	},
};
const recordJson = (type: RecordType) =>
	sql`jsonb_build_object('person_id',r.person_id,'revision',r.revision::text,'voided',${type === "commitment" ? sql`r.voided_at IS NOT NULL` : sql`false`},
 'values',jsonb_build_object(${sql.join(
		Object.entries(records[type].fields).map(([k, f]) => sql`${k}::text,${f.read}`),
		sql`,`,
 )}))`;
const found = z.object({
	person_id: z.uuid(),
	revision: z.string(),
	voided: z.boolean(),
	values: z.record(z.string(), z.unknown()),
});
/** The fields whose value differs, whatever the key order, with old and new values, by field name. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
	return Object.keys({ ...before, ...after })
		.sort()
		.filter((k) => k !== "id" && hash(before[k] ?? null) !== hash(after[k] ?? null))
		.map((field) => ({ field, old: before[field] ?? null, new: after[field] ?? null }));
}

export const recordCorrections = {
	/**
	 * people.correctPersonRecord (REQ-PPL-015): correct an assessment, interview or card of this church against the
	 * revision the corrector saw, with an optional reason. The record keeps its recorder and recorded instant; the assessment total
	 * follows the corrected scores on every read; the stage never changes. One statement updates the record, appends the
	 * correction with its old and new values and appends one audit row, which names the record but holds no value.
	 */
	async correctPersonRecord(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(c.correctPersonRecordRequest, raw);
			return c.correctionResult.parse(
				await mutation<unknown>(tx, ctx, "people.correctPersonRecord", input, async (_actor, receiptId, audit) => {
					const { recordType, personId, recordId, reason, changes } = input.input;
					const def = records[recordType];
					const table = sql.identifier(def.table);
					const target = sql`FROM ${table} r WHERE r.id=${recordId}::uuid AND r.plant_id=${plant}::uuid`;
					// Lock the reviewed Person; a record that now belongs to someone else is a stale view.
					const p = await subject(tx, ctx, personId, sql`(SELECT ${recordJson(recordType)} ${target})`);
					if (p.extra === null) deny();
					const record = found.parse(p.extra);
					if (record.person_id !== p.id) deny("conflict");
					expectRevision(record.revision, input.expectedRevision);
					if (record.voided) deny("invalid_subject");
					const after: Record<string, unknown> = { ...record.values, ...changes };
					const changed = diff(record.values, after);
					const value = (outcome: "changed" | "noop", revision: string) => ({
						recordType,
						recordId,
						personId: p.id,
						revision,
						correctionId: outcome === "changed" ? receiptId : null,
						outcome,
						receiptId,
					});
					// Correcting to the values the record already holds changes nothing more.
					if (!changed.length)
						return {
							value: value("noop", record.revision),
							subject: p.id,
							action: "people.corrected",
							outcome: "noop",
						};
					if ("occurredOn" in changes && changes.occurredOn) notFuture(p, changes.occurredOn);
					const set = Object.assign(
						{},
						...changed.map(({ field }) => (def.fields[field]!.write as (v: unknown) => object)(after[field])),
					) as Record<string, unknown>;
					audit.writes.push(
						sql`UPDATE ${table} SET ${sql.join(
							[
								...Object.entries(set).map(([col, v]) => sql`${sql.identifier(col)}=${sql.param(v)}`),
								sql`revision=revision+1`,
							],
							sql`,`,
						)} WHERE id=${recordId}::uuid AND plant_id=${plant}::uuid`,
						sql`INSERT INTO record_correction(id,plant_id,person_id,record_type,record_id,before_value,after_value,reason)
 VALUES (${receiptId}::uuid,${plant}::uuid,${p.id}::uuid,${recordType},${recordId}::uuid,
 ${JSON.stringify(Object.fromEntries(changed.map((x) => [x.field, x.old])))}::jsonb,
 ${JSON.stringify(Object.fromEntries(changed.map((x) => [x.field, x.new])))}::jsonb,${reason ?? null})`,
					);
					return {
						value: value("changed", String(BigInt(record.revision) + 1n)),
						subject: p.id,
						action: "people.corrected",
						before: { revision: p.revision },
						after: { revision: p.revision },
						// The corrected values and the reason stay in plant history; audit names only the record (audit.md).
						metadata: recordEvent(`${recordType}_corrected`, recordId),
					};
				}),
			);
		});
	},
	/**
	 * people.listRecordCorrections: one Person's corrections, latest first, each with old and new values, corrector and
	 * reason. Card date, kind and void corrections (people.correctCommitmentLifecycle) come from their audit row; field
	 * corrections from plant history. One statement with the live Owner or Admin check inside it.
	 */
	async listRecordCorrections(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const input = parse(c.recordCorrectionsRequest, raw);
			const only = input.recordId ? sql`AND x.record_id=${input.recordId}::uuid` : sql``;
			const result = await tx.execute(sql`WITH x AS (
 SELECT rc.id,rc.record_type,rc.record_id,rc.corrected_at,a.actor_id,rc.reason,rc.before_value AS b,rc.after_value AS n
  FROM record_correction rc LEFT JOIN audit_event a ON a.id=rc.id WHERE rc.person_id=${input.personId}::uuid AND rc.plant_id=${plant}::uuid
 UNION ALL
 SELECT a.id,'commitment',(a.metadata->>'recordId')::uuid,a.occurred_at,a.actor_id,a.reason,a.before_value->'commitment',a.after_value->'commitment'
  FROM audit_event a WHERE a.tenant_id=${plant}::uuid AND a.action='people.corrected' AND a.metadata->>'event'='commitment_corrected'
  AND a.subject_id IN (SELECT ${input.personId}::uuid UNION ALL SELECT m.id FROM person m WHERE m.merged_into_person_id=${input.personId}::uuid AND m.tenant_id=${plant}::uuid)
  AND NOT EXISTS(SELECT FROM record_correction rc WHERE rc.id=a.id))
 SELECT p.id,(SELECT count(*)::int FROM x WHERE true ${only}) AS total,
 (SELECT coalesce(jsonb_agg(to_jsonb(y) ORDER BY y.corrected_at DESC,y.id DESC),'[]') FROM (SELECT * FROM x WHERE true ${only}
   ORDER BY x.corrected_at DESC,x.id DESC LIMIT ${input.limit} OFFSET ${(input.page - 1) * input.limit}) y) AS items
 FROM person p WHERE ${adminRead(ctx)} AND p.id=${input.personId}::uuid AND p.tenant_id=${plant}::uuid AND p.plant_id=${plant}::uuid`);
			const row = z
				.object({
					total: z.number(),
					items: z.array(
						z.object({
							id: z.uuid(),
							record_type: c.recordType,
							record_id: z.uuid(),
							corrected_at: z.coerce.date(),
							actor_id: z.uuid().nullable(),
							reason: z.string().nullable(),
							b: z.record(z.string(), z.unknown()),
							n: z.record(z.string(), z.unknown()),
						}),
					),
				})
				.safeParse(result.rows[0]);
			if (!row.success) deny();
			const { total, items } = row.data;
			return c.recordCorrectionsResult.parse({
				personId: input.personId,
				items: items.map((i) => ({
					id: i.id,
					recordType: i.record_type,
					recordId: i.record_id,
					correctedAt: i.corrected_at.toISOString(),
					actor: attribution(plant, i.id, i.actor_id),
					reason: i.reason,
					changes: diff(i.b, i.n),
				})),
				next: input.page * input.limit < total ? input.page + 1 : null,
				total,
			});
		});
	},
};
