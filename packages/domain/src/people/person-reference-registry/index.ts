import type { referenceKind, referenceTreatment } from "@everyfield/contracts/people";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { Tx } from "../core.ts";

type Kind = z.infer<typeof referenceKind>;
type Treatment = z.infer<typeof referenceTreatment>;
/**
 * One column that names a Person, with what a merge does to it (REQ-PPL-024). `move` rewrites the current reference to
 * the survivor; `deduplicate` moves it unless the survivor already holds the same key; `keep` leaves historical lineage
 * and evidence on the source; `block` refuses the merge while the source holds such a reference, until its owning
 * package registers its own merge behavior. Every Person foreign key in the database is listed here exactly once; a
 * test compares this list with the catalog.
 */
export type Registration = {
	kind: Kind;
	table: string;
	column: string;
	/** The owner column the row's church or organization lives in. */
	owner: "plant_id" | "organization_id" | "tenant_id";
	/** The row identity a merge records and Unmerge moves back. */
	key: "id" | "tag_id";
	revision: boolean;
	treatment: Treatment;
};
const r = (
	kind: Kind,
	table: string,
	column: string,
	owner: Registration["owner"],
	treatment: Treatment,
	key: Registration["key"] = "id",
	revision = true,
): Registration => ({ kind, table, column, owner, key, revision, treatment });

export const registry: readonly Registration[] = [
	r("tag", "person_tag", "person_id", "plant_id", "deduplicate", "tag_id", false),
	r("skill", "person_skill", "person_id", "plant_id", "move"),
	// The note moves; its author never does (no authorship moves with a Person).
	r("note", "person_note", "person_id", "tenant_id", "move"),
	r("assessment", "four_cs", "person_id", "plant_id", "move"),
	r("interview", "interview", "person_id", "plant_id", "move"),
	r("commitment", "commitment", "person_id", "plant_id", "move"),
	r("correction", "record_correction", "person_id", "plant_id", "move", "id", false),
	// A withdrawal or reactivation moves with its Person; the survivor's commitment is recomputed from both (C100).
	r("commitment_change", "commitment_change", "person_id", "plant_id", "move", "id", false),
	// People merged into the source earlier now redirect to the survivor, so lineage stays one step and acyclic.
	r("merged_person", "person", "merged_into_person_id", "tenant_id", "move"),
	// A witness is evidence of who signed with the card; it stays the Person it was.
	r("commitment_witness", "commitment", "witness_person_id", "plant_id", "keep"),
	r("merge_record", "person_merge", "source_id", "tenant_id", "keep", "id", false),
	r("merge_record", "person_merge", "survivor_id", "tenant_id", "keep", "id", false),
	// Owned by later packages, which prove their own references after merge (WP-091 closes the set).
	r("attestation", "attestation", "person_id", "plant_id", "block"),
	r("contact_outcome", "contact_outcome", "person_id", "plant_id", "block"),
	r("development_enrollment", "development_enrollment", "person_id", "organization_id", "block"),
	r("invitation", "invitation", "resident_person_id", "tenant_id", "block"),
	r("mail", "mail", "recipient_person_id", "tenant_id", "block"),
	r("meeting_kit_item", "meeting_kit_item", "assignee_person_id", "plant_id", "block"),
	r("obligation", "obligation", "person_id", "plant_id", "block"),
	r("participation", "participation", "person_id", "plant_id", "block"),
	r("participation_inviter", "participation", "inviter_person_id", "plant_id", "block"),
	r("pipeline_person", "pipeline_person", "person_id", "organization_id", "block"),
	r("residency_link", "residency_link", "person_id", "organization_id", "block"),
	r("task", "task", "person_id", "plant_id", "block"),
	r("team_leader", "team", "leader_person_id", "plant_id", "block"),
	r("team_tenure", "team_tenure", "person_id", "plant_id", "block"),
];
/** The references that decide whether a reviewed state is still current: everything except kept lineage and evidence. */
export const tracked = registry.filter((e) => e.treatment !== "keep");

export const referenceRow = z.object({ k: z.string(), id: z.uuid(), r: z.string().nullable() });
export type Reference = { kind: Kind; id: string; revision: string | null };
const kindOf = new Map(tracked.map((e) => [`${e.table}.${e.column}`, e.kind]));

/**
 * Every tracked reference to `person` in one owner, as one JSON array: kind, row key and revision. One scalar subquery
 * per registration over its Person index, so the statement count never grows with data size.
 */
export function referencesOf(person: SQL, owner: string | SQL): SQL {
	const parts = tracked.map(
		(e) =>
			sql`SELECT ${`${e.table}.${e.column}`}::text AS k,x.${sql.identifier(e.key)} AS id,${e.revision ? sql`x.revision::text` : sql`NULL::text`} AS r
 FROM ${sql.identifier(e.table)} x WHERE x.${sql.identifier(e.column)}=${person} AND x.${sql.identifier(e.owner)}=${owner}::uuid`,
	);
	return sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('k',u.k,'id',u.id,'r',u.r) ORDER BY u.k,u.id),'[]') FROM (${sql.join(parts, sql` UNION ALL `)}) u)`;
}
export function parseReferences(raw: unknown): Reference[] {
	return z
		.array(referenceRow)
		.parse(raw)
		.map((x) => ({ kind: kindOf.get(x.k)!, id: x.id, revision: x.r }));
}
export const treatmentOf = (kind: Kind) => registry.find((e) => e.kind === kind)!.treatment;
export const registrationOf = (kind: Kind) => registry.find((e) => e.kind === kind)!;

/**
 * Lock both Persons of a merge in one stable order (UUID ascending), the same order every merge and Unmerge takes, so two
 * of them never wait on each other in a cycle. Single-Person writers lock their one Person the same way (REQ-PPL-024).
 */
export async function lockPair(tx: Tx, owner: string, ids: SQL) {
	await tx.execute(sql`SELECT p.id FROM person p WHERE p.tenant_id=${owner}::uuid AND p.id IN (${ids})
 ORDER BY p.id FOR UPDATE OF p`);
}
