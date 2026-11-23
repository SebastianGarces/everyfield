import { sql, type SQL } from "@everyfield/db/query";
import { effectiveAdultSql, plantTodaySql } from "../adult.ts";

export const adultOfSql = (alias: string) => {
	const column = (name: string) => sql.raw(`${alias}.${name}`);
	return effectiveAdultSql(column("birth_date"), column("adult_classification"), plantTodaySql(column("plant_id")));
};

export const guardianLinksSql = (where: SQL, join: SQL = sql``) => sql`guardian_contact gcx
	JOIN person gch ON gch.id = gcx.child_person_id AND gch.tenant_id = gcx.plant_id AND gch.state = 'live'
		AND gch.household_id = gcx.household_id
	JOIN person gad ON gad.id = gcx.guardian_person_id AND gad.tenant_id = gcx.plant_id AND gad.plant_id = gcx.plant_id
		AND gad.state = 'live' AND gad.household_id = gcx.household_id
	${join}
	WHERE ${where} AND ${adultOfSql("gad")} = 'adult'`;
