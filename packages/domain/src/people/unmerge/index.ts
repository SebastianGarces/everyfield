import * as c from "@everyfield/contracts/people";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { adminRead } from "../assessments/shared.ts";
import { deny, mutation, parse, readReply, reply, type Context, type Tx, type WriteContext } from "../core.ts";
import {
	factsOf,
	moveRefs,
	parseFacts,
	participating,
	referencesDigest,
	updatePerson,
	writeParticipations,
	type Facts,
} from "../merge/index.ts";
import { columnsChanged, freshPosition, sameColumn } from "../people.ts";
import { lockPair } from "../person-reference-registry/index.ts";
import { commitmentOf, type CommitmentInputs } from "../commitments/lifecycle.ts";

type Kind = z.infer<typeof c.referenceKind>;
type Field = z.infer<typeof c.unmergeField>;
const mergeRow = z.object({
	id: z.uuid(),
	source_id: z.uuid(),
	survivor_id: z.uuid(),
	merged_at: z.coerce.date(),
	prior: z.object({
		source: z.record(z.string(), z.unknown()),
		survivor: z.record(z.string(), z.unknown()),
		participation: z.array(z.record(z.string(), z.unknown())).default([]),
		attendance: z.array(c.attendanceChange).default([]),
		training: z.array(z.uuid()).default([]),
		references: z.array(z.tuple([c.referenceKind, z.uuid(), z.string().nullable()])).optional(),
	}),
	moved: z.record(z.string(), z.array(z.uuid())),
	source_revision: z.coerce.string(),
	survivor_revision: z.coerce.string(),
	references_digest: z.string(),
	unmerged_at: z.coerce.date().nullable(),
	households_exist: z.boolean(),
	tags_exist: z.boolean(),
	later_merge: z.boolean(),
	undone: z.array(z.string()),
	added_to_moved: z.array(c.referenceKind),
	edited: z.array(z.string()),
});
type Merge = z.infer<typeof mergeRow>;
const priorHousehold = (side: "source" | "survivor") => sql.raw(`(m.prior->'${side}'->>'household_id')::uuid`);
const householdKept = (side: "source" | "survivor") =>
	sql`(${priorHousehold(side)} IS NULL OR EXISTS(SELECT FROM household h WHERE h.id=${priorHousehold(side)} AND h.plant_id=m.tenant_id))`;
const movedIds = (kind: Kind) =>
	sql`ARRAY(SELECT jsonb_array_elements_text(coalesce(m.moved->${kind}::text,'[]'))::uuid)`;
const addedTo = (kind: Kind, from: SQL, onMoved: SQL) =>
	sql`SELECT ${kind}::text AS kind WHERE EXISTS(SELECT FROM ${from} WHERE x.plant_id=m.tenant_id
 AND x.person_id=m.survivor_id AND x.id<>ALL(${movedIds(kind)}) AND (${onMoved}))`;
const addedToMoved = sql`(SELECT coalesce(jsonb_agg(a.kind ORDER BY a.kind),'[]') FROM (
 ${addedTo(
		"contact_outcome",
		sql`contact_outcome x`,
		sql`x.task_id=ANY(${movedIds("task")}) OR x.also_task_ids&&${movedIds("task")}
 OR x.obligation_id=ANY(${movedIds("obligation")}) OR x.supersedes_id=ANY(${movedIds("contact_outcome")})`,
 )}
 UNION ALL ${addedTo("task", sql`task x`, sql`x.obligation_id=ANY(${movedIds("obligation")})`)}
 UNION ALL ${addedTo("note", sql`person_note x`, sql`x.participation_id=ANY(${movedIds("participation")})`)}
 UNION ALL ${addedTo("team_tenure", sql`team_tenure x`, sql`x.previous_tenure_id=ANY(${movedIds("team_tenure")})`)}) a)`;

async function readMerge(tx: Tx, owner: string, mergeId: string, gate: SQL) {
	const result = await tx.execute(sql`SELECT ${gate} AS allowed,(SELECT to_jsonb(m)||jsonb_build_object(
 'source_revision',m.source_revision::text,'survivor_revision',m.survivor_revision::text,
 'households_exist',${householdKept("source")} AND ${householdKept("survivor")},
 'tags_exist',NOT EXISTS(SELECT FROM jsonb_array_elements_text(coalesce(m.moved->'tag_dropped','[]')) d
  WHERE NOT EXISTS(SELECT FROM tag t WHERE t.id=d::uuid AND t.plant_id=m.tenant_id)),
 'later_merge',EXISTS(SELECT FROM person_merge l WHERE l.tenant_id=m.tenant_id AND l.survivor_id=m.survivor_id
  AND l.unmerged_at IS NULL AND l.id<>m.id AND l.merged_at>=m.merged_at),
 'undone',(SELECT coalesce(jsonb_agg(k.key||'|'||k.id),'[]') FROM person_merge l CROSS JOIN LATERAL (
  SELECT e.key,i.id FROM jsonb_each(l.moved) e CROSS JOIN LATERAL jsonb_array_elements_text(e.value) i(id)
   WHERE e.key NOT IN ('participation','participation_inviter')
  UNION ALL SELECT 'participation',p->>'id' FROM jsonb_array_elements(coalesce(l.prior->'participation','[]')) p) k
  WHERE l.tenant_id=m.tenant_id AND l.unmerged_at IS NOT NULL AND l.id<>m.id AND l.merged_at>=m.merged_at
  AND m.survivor_id IN (l.source_id,l.survivor_id)),
 'added_to_moved',${addedToMoved},
 'edited',(SELECT coalesce(jsonb_agg(DISTINCT k),'[]') FROM audit_event e
  CROSS JOIN LATERAL jsonb_object_keys(coalesce(e.before_value,'{}')||coalesce(e.after_value,'{}')) k
  WHERE e.tenant_id=m.tenant_id AND e.subject_id=m.survivor_id AND e.recorded_at>m.merged_at
  AND e.action IN ('people.updated','people.stage_changed','people.recorded','people.corrected')))
 FROM person_merge m WHERE m.id=${mergeId}::uuid AND m.tenant_id=${owner}::uuid) AS merge,
 ${factsOf(sql`(SELECT source_id FROM person_merge WHERE id=${mergeId}::uuid AND tenant_id=${owner}::uuid)`, owner)} AS source,
 ${factsOf(sql`(SELECT survivor_id FROM person_merge WHERE id=${mergeId}::uuid AND tenant_id=${owner}::uuid)`, owner)} AS survivor`);
	const row = z
		.object({ allowed: z.boolean(), merge: z.unknown(), source: z.unknown(), survivor: z.unknown() })
		.parse(result.rows[0]);
	const source = parseFacts(row.source),
		survivor = parseFacts(row.survivor);
	if (!row.allowed || row.merge === null || !source || !survivor) deny("unavailable");
	return { merge: mergeRow.parse(row.merge), source, survivor };
}

type Cause = z.infer<typeof c.inverseConflict>;
type Inverse = { conflicts: Cause[]; changed: Kind[]; changedFields: Field[]; stays: Kind[]; staysFields: Field[] };
function organizationInverse(merge: Merge, source: Facts, survivor: Facts): Inverse {
	const conflicts: Cause[] = [];
	if (
		source.state !== "merged" ||
		source.merged_into_person_id !== survivor.id ||
		source.revision !== merge.source_revision
	)
		conflicts.push("source_changed");
	if (survivor.state !== "live" || survivor.revision !== merge.survivor_revision) conflicts.push("survivor_changed");
	const referencesChanged = referencesDigest(survivor.refs) !== merge.references_digest;
	if (referencesChanged) conflicts.push("references_changed");
	if (merge.moved.mail?.length) conflicts.push("mail_sent");
	return {
		conflicts,
		changed: referencesChanged ? changedKinds(merge, survivor) : [],
		changedFields: [],
		stays: [],
		staysFields: [],
	};
}
function changedKinds(merge: Merge, survivor: Facts): Kind[] {
	const then = merge.prior.references;
	if (!then) return [];
	const key = (k: string, id: string, r: string | null) => `${k}|${id}|${r}`;
	const before = new Set(then.map(([k, id, r]) => key(k, id, r)));
	const now = new Set(survivor.refs.map((x) => key(x.kind, x.id, x.revision)));
	const kinds = new Set<Kind>();
	for (const [k, id, r] of then) if (k !== "commitment_change" && !now.has(key(k, id, r))) kinds.add(k);
	for (const x of survivor.refs)
		if (x.kind !== "commitment_change" && !before.has(key(x.kind, x.id, x.revision))) kinds.add(x.kind);
	return [...kinds].sort();
}
function plantInverse(merge: Merge, source: Facts, survivor: Facts): Inverse {
	if (survivor.state === "merged" || merge.later_merge)
		return { conflicts: ["chained_merge"], changed: [], changedFields: [], stays: [], staysFields: [] };
	const conflicts: Cause[] = [];
	if (survivor.state !== "live") conflicts.push("survivor_retired");
	if (
		source.state !== "merged" ||
		source.merged_into_person_id !== survivor.id ||
		source.revision !== afterUndone(merge, "merged_person", source.id, merge.source_revision)
	)
		conflicts.push("source_changed");
	const changedFields = mergedFieldsChanged(merge, source, survivor);
	if (changedFields.length) conflicts.push("survivor_changed");
	const changed = new Set<Kind>([...movedRecordsChanged(merge, source, survivor), ...merge.added_to_moved]);
	if (!merge.tags_exist) changed.add("tag");
	const unrecorded = !merge.prior.references && referencesDigest(survivor.refs) !== merge.references_digest;
	if (changed.size || unrecorded) conflicts.push("references_changed");
	if (!merge.households_exist) conflicts.push("household_deleted");
	const then = new Set((merge.prior.references ?? []).map(([k, id]) => `${k}|${id}`));
	const set = Object.keys(merge.prior.survivor).map((col) => fieldOf(col));
	return {
		conflicts,
		changed: [...changed].sort(),
		changedFields,
		stays: merge.prior.references ? survivor.refs.filter((x) => !then.has(`${x.kind}|${x.id}`)).map((x) => x.kind) : [],
		staysFields: c.unmergeField.options.filter(
			(f) => !set.includes(f) && merge.edited.some((key) => (auditFields[key] ?? fieldOf(key)) === f),
		),
	};
}
function mergedFieldsChanged(merge: Merge, source: Facts, survivor: Facts): Field[] {
	const { survivor: prior } = merge.prior;
	const changed = new Set<Field>();
	for (const col of Object.keys(prior)) {
		const field = fieldOf(col);
		if (!field) continue;
		const given =
			col === "stage" ? furthest(source.stage, prior.stage) : (merge.prior.source[col] ?? source.values[col]);
		if (JSON.stringify(survivor.values[col] ?? null) !== JSON.stringify(given ?? null)) changed.add(field);
	}
	return c.unmergeField.options.filter((f) => changed.has(f));
}
function furthest(a: unknown, b: unknown) {
	const stages = c.stage.options;
	return stages[Math.max(stages.indexOf(c.stage.parse(a)), stages.indexOf(c.stage.parse(b)))];
}
function movedRecordsChanged(merge: Merge, source: Facts, survivor: Facts): Kind[] {
	const then = merge.prior.references;
	if (!then) return [];
	const key = (k: string, id: string) => `${k}|${id}`;
	const recorded = new Map(then.map(([k, id, r]) => [key(k, id), r]));
	const now = new Map(survivor.refs.map((x) => [key(x.kind, x.id), x.revision]));
	const kept = (k: Kind, id: string) =>
		now.has(key(k, id)) && now.get(key(k, id)) === afterUndone(merge, k, id, recorded.get(key(k, id)) ?? null);
	const kinds = new Set<Kind>();
	for (const [raw, ids] of Object.entries(merge.moved)) {
		if (raw === "tag_dropped" || raw === "mail" || participating(raw)) continue;
		const kind = c.referenceKind.parse(raw);
		if (ids.some((id) => !kept(kind, id))) kinds.add(kind);
	}
	const rows = new Map([...survivor.participations, ...source.participations].map((r) => [r.id, r]));
	for (const prior of merge.prior.participation) {
		const id = z.uuid().parse(prior.id);
		const row = rows.get(id);
		if (!ownAttendance(merge, prior)) {
			if (row?.inviter_person_id !== survivor.id) kinds.add("participation_inviter");
		} else if (!row) kinds.add("participation");
		else if (row.person_id === source.id ? row.removed_at === null : !kept("participation", id))
			kinds.add("participation");
	}
	return [...kinds];
}
function afterUndone(merge: Merge, kind: Kind, id: string, revision: string | null) {
	const round = merge.undone.filter((moved) => moved === `${kind}|${id}`).length;
	return revision === null ? null : String(BigInt(revision) + 2n * BigInt(round));
}
const ownAttendance = (merge: Merge, prior: Record<string, unknown>) =>
	prior.person_id === merge.source_id || prior.person_id === merge.survivor_id;

function counts(kinds: readonly Kind[]) {
	const n = new Map<Kind, number>();
	for (const k of kinds) n.set(k, (n.get(k) ?? 0) + 1);
	return [...n].map(([kind, count]) => ({ kind, count }));
}
function inverse(merge: Merge, source: Facts, survivor: Facts, kind: "plant" | "organization") {
	const { stays, ...found } = (kind === "plant" ? plantInverse : organizationInverse)(merge, source, survivor);
	const restores = counts(
		Object.entries(merge.moved).flatMap(([k, ids]) =>
			ids.map(() => (k === "tag_dropped" ? "tag" : c.referenceKind.parse(k))),
		),
	);
	const fields = c.mergeField.options.filter((f) =>
		Object.keys(merge.prior.survivor).some((col) => fieldOf(col) === f),
	);
	return { ...found, restores, fields, stays: counts(stays) };
}
function commitments(merge: Merge, source: Facts, survivor: Facts) {
	const back = new Set([...(merge.moved.commitment ?? []), ...(merge.moved.commitment_change ?? [])]);
	const cache = (c: CommitmentInputs) => {
		const next = commitmentOf(c);
		return { commitment_state: next.state, commitment_effective_on: next.effectiveOn };
	};
	const { cards, changes } = survivor.commitment;
	return {
		survivor: cache({ cards: cards.filter((x) => !back.has(x.id)), changes: changes.filter((x) => !back.has(x.id)) }),
		source: cache({
			cards: [...source.commitment.cards, ...cards.filter((x) => back.has(x.id))],
			changes: [...source.commitment.changes, ...changes.filter((x) => back.has(x.id))],
		}),
	};
}
const auditFields: Record<string, Field> = { membership: "household", photo: "photo" };
const fieldColumns: Record<string, Field> = {
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
	stage: "stage",
};
const fieldOf = (col: string) => fieldColumns[col];

const reopenTraining = (owner: string, ids: string[], closed: string[], from: string, to: string) =>
	sql`UPDATE training_assignment SET person_id=${to}::uuid,revision=revision+1,
 state=CASE WHEN id=ANY(${sql.param(closed)}::uuid[]) THEN 'active' ELSE state END,
 ended_on=CASE WHEN id=ANY(${sql.param(closed)}::uuid[]) THEN NULL ELSE ended_on END
 WHERE id=ANY(${sql.param(ids)}::uuid[]) AND person_id=${from}::uuid AND plant_id=${owner}::uuid`;

export const peopleUnmerge = {
	async previewUnmerge(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			if (ctx.selected.kind !== "plant" && ctx.selected.kind !== "organization") deny("unavailable");
			const input = parse(c.unmergePreviewRequest, raw);
			const { merge, source, survivor } = await readMerge(tx, ctx.selected.id, input.mergeId, adminRead(ctx));
			const i = inverse(merge, source, survivor, ctx.selected.kind);
			return c.unmergePreview.parse({
				mergeId: merge.id,
				sourceId: merge.source_id,
				survivorId: merge.survivor_id,
				mergedAt: merge.merged_at.toISOString(),
				state: merge.unmerged_at ? "unmerged" : "merged",
				restores: i.restores,
				fields: i.fields,
				conflicts: merge.unmerged_at ? [] : i.conflicts,
				changed: merge.unmerged_at ? [] : i.changed,
				changedFields: merge.unmerged_at ? [] : i.changedFields,
				stays: merge.unmerged_at ? [] : i.stays,
				staysFields: merge.unmerged_at ? [] : i.staysFields,
				attendance: merge.prior.attendance,
				reviewRevision: survivor.revision,
			});
		});
	},
	async unmergePeople(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			if (ctx.selected.kind !== "plant" && ctx.selected.kind !== "organization") deny("unavailable");
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
					const i = inverse(merge, source, survivor, kind);
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
					if (i.conflicts.length)
						deny("inverse_conflict", {
							causes: i.conflicts,
							changed: i.changed,
							changedFields: i.changedFields,
						});
					for (const [k, ids] of Object.entries(merge.moved))
						if (k !== "tag_dropped" && !participating(k) && ids.length)
							audit.writes.push(
								k === "training_assignment"
									? reopenTraining(owner, ids, merge.prior.training, survivor.id, source.id)
									: moveRefs(owner, k as Kind, ids, survivor.id, source.id),
							);
					const own = merge.prior.participation.filter((r) => ownAttendance(merge, r));
					const invited = merge.prior.participation.filter((r) => !ownAttendance(merge, r)).map((r) => String(r.id));
					if (own.length) audit.writes.push(writeParticipations(owner, own));
					if (invited.length)
						audit.writes.push(sql`UPDATE participation SET inviter_person_id=${source.id}::uuid,revision=revision+1
 WHERE id=ANY(${sql.param(invited)}::uuid[]) AND inviter_person_id=${survivor.id}::uuid AND plant_id=${owner}::uuid`);
					const dropped = merge.moved.tag_dropped ?? [];
					if (dropped.length)
						audit.writes.push(
							sql`INSERT INTO person_tag(plant_id,person_id,tag_id) SELECT ${owner}::uuid,${source.id}::uuid,t
 FROM unnest(${sql.param(dropped)}::uuid[]) t`,
						);
					const stage = survivor.stage;
					const restoredStage = (merge.prior.survivor.stage as string | undefined) ?? stage;
					const split = kind === "plant" ? commitments(merge, source, survivor) : null;
					audit.writes.push(
						updatePerson(owner, source.id, {
							state: "live",
							merged_into_person_id: null,
							retired_at: null,
							...merge.prior.source,
							...(kind === "plant" ? { pipeline_position: freshPosition(source.id) } : {}),
							...split?.source,
						}),
						updatePerson(owner, survivor.id, { ...merge.prior.survivor, ...split?.survivor }),
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
