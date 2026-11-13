import { createDatabase, closeDatabase } from "../client.ts";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { migrate } from "./migrate.ts";
import { verifySchemaDrift, verifySnapshotBaseline } from "./drift.ts";
import { assertCurrentCatalog } from "./catalog.ts";
import { assertDevelopmentDatabase, developmentHosts } from "../development.ts";

// No public/production schema is touched. CI uses its existing local throwaway
// database; local agents may use only the approved shared development endpoint.
const source = assertDevelopmentDatabase(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
const localCI = !developmentHosts.has(source.hostname);
if (!localCI) source.searchParams.set("sslmode", "verify-full");
const schema = "catalog_check_" + randomUUID().replaceAll("-", "");
const db = createDatabase({ connectionString: source.href, max: 2 });
try {
	await db.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(db, schema);
	await verifySnapshotBaseline();
	await verifySchemaDrift(db, schema);
	await assertCurrentCatalog(
		db,
		schema,
		JSON.parse(await readFile(new URL("../../../../docs/schema/target.json", import.meta.url), "utf8")),
	);
	console.log(
		"PASS: Drizzle, target.json and full migration chain agree, including CHECKs, indexes, deferred keys, functions, triggers and privileges. Frozen SQL unchanged.",
	);
} finally {
	await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
	await closeDatabase(db);
}
