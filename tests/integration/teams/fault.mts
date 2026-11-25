import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import type { Database } from "../../support/test-database.mts";

export async function faulted<T>(admin: Database, table: string, body: () => Promise<T>) {
	const name = `fault_${randomUUID().replaceAll("-", "")}`;
	await admin.execute(
		sql.raw(
			`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'required_write_failed'; END $$`,
		),
	);
	await admin.execute(
		sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`),
	);
	try {
		return await body();
	} finally {
		await admin.execute(sql.raw(`DROP FUNCTION ${name}() CASCADE`));
	}
}
