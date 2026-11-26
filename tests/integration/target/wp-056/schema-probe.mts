import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import type { Database } from "../../../support/test-database.mts";

export type SchemaCase = {
	id: string;
	clock?: { now: string; zone: string };
	given: Record<string, Record<string, unknown>>;
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { state: Record<string, unknown>; result: Record<string, unknown>; event: null };
	subcases?: {
		name: string;
		given: Record<string, Record<string, unknown>>;
		action: { operation: string; arguments: Record<string, unknown> };
		expected: { state: Record<string, unknown>; result: Record<string, unknown>; event: null };
	}[];
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: SchemaCase[] };
export const schemaCase = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
export const subcaseOf = (c: SchemaCase, name: string) =>
	c.subcases?.find((s) => s.name === name) ?? assert.fail(`no subcase ${c.id} ${name}`);

const ROLLBACK = Symbol("rollback");
export async function accepts(admin: Database, statement: SQL) {
	try {
		await admin.transaction(async (tx) => {
			await tx.execute(statement);
			await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
			throw ROLLBACK;
		});
	} catch (error) {
		if (error === ROLLBACK) return true;
		const code = String((error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code);
		assert.match(code, /^(23|P0)/, String(error));
		return false;
	}
	assert.fail("the probe transaction committed");
}

export async function foreignKeyOf(admin: Database, table: string, columns: readonly string[]) {
	const found = await admin.execute<{ target: string; key: string[] }>(
		sql`SELECT c.confrelid::regclass::text AS target,
			array(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,i)
				JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.i) AS key
		FROM pg_constraint c WHERE c.contype='f' AND c.conrelid=${table}::regclass`,
	);
	return found.rows.find((r) => r.key.join(",") === columns.join(","))?.target.replace(/^.*\./, "") ?? null;
}
