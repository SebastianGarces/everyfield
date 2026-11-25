import assert from "node:assert/strict";
import { inspect } from "node:util";
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

async function fingerprints(admin: Database) {
	const { rows: names } = await admin.execute<{ name: string }>(
		sql`SELECT table_name::text AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'`,
	);
	const { rows } = await admin.execute<{ name: string; rows: string }>(
		sql.join(
			names.map(
				({ name }) =>
					sql`SELECT ${name}::text AS name,md5(coalesce(string_agg(x::text,'|' ORDER BY x::text),'')) AS rows FROM ${sql.identifier(name)} x`,
			),
			sql` UNION ALL `,
		),
	);
	return new Map(rows.map((row) => [row.name, row.rows]));
}

export async function touched<T>(admin: Database, body: () => Promise<T>): Promise<{ value: T; tables: string[] }> {
	const before = await fingerprints(admin);
	const value = await body();
	const after = await fingerprints(admin);
	return { value, tables: [...after.keys()].filter((name) => before.get(name) !== after.get(name)).sort() };
}

export async function untouched<T>(admin: Database, body: () => Promise<T>): Promise<T> {
	const { value, tables } = await touched(admin, body);
	assert.deepEqual(tables, []);
	return value;
}

export async function faulted(admin: Database, table: string, body: () => Promise<unknown>): Promise<void> {
	await admin.execute(
		sql`CREATE FUNCTION required_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'required_source_unavailable'; END $$`,
	);
	await admin.execute(
		sql`CREATE TRIGGER required_source AFTER INSERT OR UPDATE ON ${sql.identifier(table)} FOR EACH ROW EXECUTE FUNCTION required_source()`,
	);
	try {
		const error = await untouched(admin, () =>
			body().then(
				(value) => assert.fail(`expected the required write to fail, got ${JSON.stringify(value)}`),
				(thrown: unknown) => thrown,
			),
		);
		assert.match(inspect(error), /required_source_unavailable/);
	} finally {
		await admin.execute(sql`DROP FUNCTION required_source() CASCADE`);
	}
}
