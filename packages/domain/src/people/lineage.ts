import { sql, type SQL } from "@everyfield/db/query";

export const lineageOf = (person: SQL, owner: SQL) =>
	sql`(SELECT ${person} UNION ALL SELECT merged_in.id FROM person merged_in
 WHERE merged_in.merged_into_person_id=${person} AND merged_in.tenant_id=${owner})`;

export const currentPersonJoin = (person: SQL, owner: SQL) =>
	sql`JOIN person named ON named.id=${person} AND named.tenant_id=${owner}
 JOIN person p ON p.id=coalesce(named.merged_into_person_id,named.id) AND p.tenant_id=named.tenant_id`;
