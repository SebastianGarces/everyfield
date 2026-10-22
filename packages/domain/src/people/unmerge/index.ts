import * as c from "@everyfield/contracts/people";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { adminRead } from "../assessments/shared.ts";
import { deny, mutation, parse, readReply, reply, type Context, type Tx, type WriteContext } from "../core.ts";
import { factsOf, moveRefs, parseFacts, referencesDigest, updatePerson, type Facts } from "../merge/index.ts";
import { columnsChanged, freshPosition, sameColumn } from "../people.ts";
import { lockPair } from "../person-reference-registry/index.ts";

type Kind = z.infer<typeof c.referenceKind>;
const mergeRow = z.object({
	id: z.uuid(),
	source_id: z.uuid(),
	survivor_id: z.uuid(),
	merged_at: z.coerce.date(),
	prior: z.object({ source: z.record(z.string(), z.unknown()), survivor: z.record(z.string(), z.unknown()) }),
	moved: z.record(z.string(), z.array(z.uuid())),
	source_revision: z.coerce.string(),
	survivor_revision: z.coerce.string(),
	references_digest: z.string(),
	unmerged_at: z.coerce.date().nullable(),
	household_exists: z.boolean(),
});
type Merge = z.infer<typeof mergeRow>;

/** The merge, both Persons with their current references, and whether the source's old household still exists. */
async function readMerge(tx: Tx, owner: string, mergeId: string, gate: SQL) {
	const result = await tx.execute(sql`SELECT ${gate} AS allowed,(SELECT to_jsonb(m)||jsonb_build_object(
 'source_revision',m.source_revision::text,'survivor_revision',m.survivor_revision::text,
 'household_exists',EXISTS(SELECT FROM household h WHERE h.id=(m.prior->'source'->>'household_id')::uuid AND h.plant_id=m.tenant_id)
 OR NOT (m.prior->'source' ? 'household_id')) FROM person_merge m WHERE m.id=${mergeId}::uuid AND m.tenant_id=${owner}::uuid) AS merge,
 ${factsOf(sql`(SELECT source_id FROM person_merge WHERE id=${mergeId}::uuid AND tenant_id=${owner}::uuid)`, owner)} AS source,
 ${factsOf(sql`(SELECT survivor_id FROM person_merge WHERE id=${mergeId}::uuid AND tenant_id=${owner}::uuid)`, owner)} AS survivor`);
	const row = z
		.object({ allowed: z.boolean(), merge: z.unknown(), source: z.unknown(), survivor: z.unknown() })
		.parse(result.rows[0]);
	const source = parseFacts(row.source),
		survivor = parseFacts(row.survivor);
	if (!row.allowed || row.merge === null || !source || !survivor) deny();
	return { merge: mergeRow.parse(row.merge), source, survivor };
}

/**
 * REQ-PPL-025: Unmerge restores the exact reviewed prior state only while nothing it would undo has changed since. A
 * later edit or merge of the survivor, a new, moved or corrected reference on it, a changed source, or a household that
 * no longer exists each refuses it. Pure, so the preview and the Unmerge decide alike.
 */
function inverse(merge: Merge, source: Facts, survivor: Facts) {
	const conflicts: z.infer<typeof c.inverseConflict>[] = [];
	if (
		source.state !== "merged" ||
		source.merged_into_person_id !== survivor.id ||
		source.revision !== merge.source_revision
	)
		conflicts.push("source_changed");
	if (survivor.state !== "live" || survivor.revision !== merge.survivor_revision) conflicts.push("survivor_changed");
	if (referencesDigest(survivor.refs) !== merge.references_digest || !merge.household_exists)
		conflicts.push("references_changed");
	const restores = Object.entries(merge.moved)
		.filter(([k, ids]) => k !== "tag_dropped" && ids.length)
		.map(([kind, ids]) => ({ kind: kind as Kind, count: ids.length }));
	const dropped = merge.moved.tag_dropped ?? [];
	if (dropped.length) {
		const tags = restores.find((x) => x.kind === "tag");
		if (tags) tags.count += dropped.length;
		else restores.push({ kind: "tag", count: dropped.length });
	}
	const fields = c.mergeField.options.filter((f) =>
		Object.keys(merge.prior.survivor).some((col) => fieldOf(col) === f),
	);
	return { conflicts, restores, fields };
}
const fieldColumns: Record<string, z.infer<typeof c.mergeField>> = {
	display_name: "displayName",
	first_name: "firstName",
	last_name: "lastName",
	email: "email",
	phone: "phone",
	street: "address",
	city: "address",
	state_province: "address",
	postal_code: "address",
	country: "address",
	source: "source",
	source_details: "source",
	notes: "summaryNotes",
	birth_date: "birthDate",
	adult_classification: "adultClassification",
	household_id: "household",
	household_role: "household",
	photo_object_id: "photo",
};
const fieldOf = (col: string) => fieldColumns[col];

export const peopleUnmerge = {
	/** people.previewUnmerge: what Unmerge would restore, and anything that would refuse it now. */
	async previewUnmerge(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			if (ctx.selected.kind !== "plant" && ctx.selected.kind !== "organization") deny();
			const input = parse(c.unmergePreviewRequest, raw);
			const { merge, source, survivor } = await readMerge(tx, ctx.selected.id, input.mergeId, adminRead(ctx));
			const i = inverse(merge, source, survivor);
			return c.unmergePreview.parse({
				mergeId: merge.id,
				sourceId: merge.source_id,
				survivorId: merge.survivor_id,
				mergedAt: merge.merged_at.toISOString(),
				state: merge.unmerged_at ? "unmerged" : "merged",
				restores: i.restores,
				fields: i.fields,
				conflicts: merge.unmerged_at ? [] : i.conflicts,
				reviewRevision: survivor.revision,
			});
		});
	},
	/**
	 * people.unmergePeople and orgPeople.unmerge: with both Persons locked in the merge's UUID order, one statement moves
	 * back exactly the references the merge moved, restores the source and the survivor's prior values, marks the merge
	 * reversed and appends one audit row. A repeat changes nothing more; there is no redo and no universal undo.
	 */
	async unmergePeople(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant" && ctx.selected.kind !== "organization") deny();
			const kind = ctx.selected.kind;
			const owner = ctx.selected.id;
			const input = parse(c.unmergePeopleRequest, raw);
			const name = kind === "plant" ? "people.unmergePeople" : "orgPeople.unmerge";
			return c.unmergeResult.parse(
				await mutation<unknown>(tx, ctx, name, input, async (_actor, receiptId, audit) => {
					const id = input.input.mergeId;
					await lockPair(
						tx,
						owner,
						sql`SELECT source_id FROM person_merge WHERE id=${id}::uuid AND tenant_id=${owner}::uuid
 UNION ALL SELECT survivor_id FROM person_merge WHERE id=${id}::uuid AND tenant_id=${owner}::uuid`,
					);
					const { merge, source, survivor } = await readMerge(tx, owner, id, sql`true`);
					const i = inverse(merge, source, survivor);
					const value = (outcome: "changed" | "noop", sourceRevision: string, survivorRevision: string) => ({
						mergeId: merge.id,
						sourceId: source.id,
						survivorId: survivor.id,
						sourceRevision,
						survivorRevision,
						restored: outcome === "changed" ? i.restores : [],
						outcome,
						receiptId,
					});
					if (merge.unmerged_at)
						return {
							value: value("noop", source.revision, survivor.revision),
							subject: survivor.id,
							action: "people.unmerged",
							outcome: "noop",
						};
					if (survivor.revision !== input.expectedRevision) deny("conflict");
					if (i.conflicts.length) deny("inverse_conflict", { causes: i.conflicts });
					for (const [k, ids] of Object.entries(merge.moved))
						if (k !== "tag_dropped" && ids.length)
							audit.writes.push(moveRefs(owner, k as Kind, ids, survivor.id, source.id));
					const dropped = merge.moved.tag_dropped ?? [];
					if (dropped.length)
						audit.writes.push(
							sql`INSERT INTO person_tag(plant_id,person_id,tag_id) SELECT ${owner}::uuid,${source.id}::uuid,t
 FROM unnest(${sql.param(dropped)}::uuid[]) t`,
						);
					const stage = survivor.stage;
					const restoredStage = (merge.prior.survivor.stage as string | undefined) ?? stage;
					audit.writes.push(
						updatePerson(owner, source.id, {
							state: "live",
							merged_into_person_id: null,
							retired_at: null,
							...merge.prior.source,
							...(kind === "plant" ? { pipeline_position: freshPosition(source.id) } : {}),
						}),
						updatePerson(owner, survivor.id, merge.prior.survivor),
					);
					if (kind === "plant")
						audit.writes.push(
							columnsChanged(owner, [
								source.stage,
								...(stage && restoredStage && !sameColumn(stage, restoredStage) ? [stage, restoredStage] : []),
							]),
						);
					audit.writes.push(
						sql`UPDATE person_merge SET unmerged_at=clock_timestamp() WHERE id=${id}::uuid AND tenant_id=${owner}::uuid`,
					);
					const sourceRevision = String(BigInt(source.revision) + 1n),
						survivorRevision = String(BigInt(survivor.revision) + 1n);
					return {
						value: value("changed", sourceRevision, survivorRevision),
						subject: survivor.id,
						action: "people.unmerged",
						before: { revision: survivor.revision },
						after: { revision: survivorRevision },
						metadata: { event: "person_unmerged", recordId: merge.id, sourceId: source.id },
					};
				}),
			);
		});
	},
};
