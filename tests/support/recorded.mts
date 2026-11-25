import { sql } from "../../packages/db/src/query.ts";
import type { Database } from "./test-database.mts";

export type Recorded = { audits: string[]; jobs: string[]; notices: number; mail: number };

const read = async (admin: Database) => {
	const { rows } = await admin.execute<{
		audits: string[];
		jobs: string[];
		notices: string[];
		mail: string[];
	}>(sql`SELECT
		(SELECT coalesce(array_agg(id||' '||action||CASE WHEN subject_type='command' THEN ' (receipt)' ELSE '' END),'{}') FROM audit_event) AS audits,
		(SELECT coalesce(array_agg(id||' '||kind||CASE state WHEN 'ready' THEN '' ELSE ' '||state END),'{}') FROM job) AS jobs,
		(SELECT coalesce(array_agg(id::text),'{}') FROM notice) AS notices, (SELECT coalesce(array_agg(id::text),'{}') FROM mail) AS mail`);
	return rows[0]!;
};

export async function recorded<T>(admin: Database, body: () => Promise<T>): Promise<{ value: T; added: Recorded }> {
	const before = await read(admin);
	const value = await body();
	const after = await read(admin);
	const added = (kind: keyof typeof after) => {
		const seen = new Set(before[kind]);
		return after[kind]
			.filter((row) => !seen.has(row))
			.map((row) => row.slice(37))
			.sort();
	};
	return {
		value,
		added: {
			audits: added("audits"),
			jobs: added("jobs"),
			notices: added("notices").length,
			mail: added("mail").length,
		},
	};
}
