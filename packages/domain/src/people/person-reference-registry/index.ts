import type { referenceKind, referenceTreatment } from "@everyfield/contracts/people";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { Tx } from "../core.ts";

type Kind = z.infer<typeof referenceKind>;
type Treatment = z.infer<typeof referenceTreatment>;
export type Registration = {
	kind: Kind;
	table: string;
	column: string;
	owner: "plant_id" | "organization_id" | "tenant_id";
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
	r("note", "person_note", "person_id", "tenant_id", "move"),
	r("assessment", "four_cs", "person_id", "plant_id", "move"),
	r("interview", "interview", "person_id", "plant_id", "move"),
	r("commitment", "commitment", "person_id", "plant_id", "move"),
	r("correction", "record_correction", "person_id", "plant_id", "move", "id", false),
	r("commitment_change", "commitment_change", "person_id", "plant_id", "move", "id", false),
	r("merged_person", "person", "merged_into_person_id", "tenant_id", "move"),
	r("commitment_witness", "commitment", "witness_person_id", "plant_id", "keep"),
	r("merge_record", "person_merge", "source_id", "tenant_id", "keep", "id", false),
	r("merge_record", "person_merge", "survivor_id", "tenant_id", "keep", "id", false),
	r("attestation", "attestation", "person_id", "plant_id", "move"),
	r("attestation_history", "attestation_revision", "person_id", "plant_id", "keep", "id", false),
	r("email_opt_out", "person_email_opt_out", "person_id", "plant_id", "keep", "id", false),
	r("duplicate_dismissal", "person_duplicate_dismissal", "person_id", "plant_id", "keep", "id", false),
	r("duplicate_dismissal", "person_duplicate_dismissal", "with_person_id", "plant_id", "keep", "id", false),
	r("launch_guest", "launch_guest", "person_id", "plant_id", "move"),
	r("contact_outcome", "contact_outcome", "person_id", "plant_id", "block"),
	r("development_enrollment", "development_enrollment", "person_id", "organization_id", "move"),
	r("invitation", "invitation", "resident_person_id", "tenant_id", "block"),
	r("mail", "mail", "recipient_person_id", "tenant_id", "block"),
	r("meeting_kit_item", "meeting_kit_item", "assignee_person_id", "plant_id", "block"),
	r("obligation", "obligation", "person_id", "plant_id", "block"),
	r("participation", "participation", "person_id", "plant_id", "block"),
	r("participation_inviter", "participation", "inviter_person_id", "plant_id", "block"),
	r("pipeline_person", "pipeline_person", "person_id", "organization_id", "keep"),
	r("residency_link", "residency_link", "person_id", "organization_id", "keep"),
	r("answer_review", "answer_review", "person_id", "organization_id", "keep", "id", false),
	r("task", "task", "person_id", "plant_id", "block"),
	r("team_leader", "team", "leader_person_id", "plant_id", "block"),
	r("team_tenure", "team_tenure", "person_id", "plant_id", "block"),
	r("training_assignment", "training_assignment", "person_id", "plant_id", "move"),
	r("training_credit", "training_credit", "person_id", "plant_id", "keep", "id", false),
];
const tracked = registry.filter((e) => e.treatment !== "keep");

const referenceRow = z.object({ k: z.string(), id: z.uuid(), r: z.string().nullable() });
export type Reference = { kind: Kind; id: string; revision: string | null };
const kindOf = new Map(tracked.map((e) => [`${e.table}.${e.column}`, e.kind]));

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
		.map((x) => {
			const kind = kindOf.get(x.k);
			if (!kind) throw Error(`Reference column ${x.k} is not registered`);
			return { kind, id: x.id, revision: x.r };
		});
}
export function registrationOf(kind: Kind) {
	const registration = registry.find((e) => e.kind === kind);
	if (!registration) throw Error(`Reference kind ${kind} is not registered`);
	return registration;
}
export const treatmentOf = (kind: Kind) => registrationOf(kind).treatment;

export async function lockPair(tx: Tx, owner: string, ids: SQL) {
	await tx.execute(sql`SELECT p.id FROM person p WHERE p.tenant_id=${owner}::uuid AND p.id IN (${ids})
 ORDER BY p.id FOR UPDATE OF p`);
}
