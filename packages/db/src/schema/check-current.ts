import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { migrate } from "./migrate.ts";
import { assertCurrentCatalog } from "./catalog.ts";

// No public/production schema is touched. CI uses its existing local throwaway
// database; local agents may use only the approved shared development endpoint.
let source: URL;
try {
	source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
} catch {
	throw Error("Schema check requires a valid approved development database configuration");
}
const localCI =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname);
if (
	process.env.NODE_ENV === "production" ||
	(!localCI && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech")
)
	throw Error("Schema check requires approved development or throwaway CI database");
if (!localCI) source.searchParams.set("sslmode", "verify-full");
const schema = "catalog_check_" + randomUUID().replaceAll("-", "");
const db = new pg.Pool({ connectionString: source.href, max: 2 });
try {
	await db.query(`CREATE SCHEMA ${schema}`);
	await migrate(db, schema);
	await assertCurrentCatalog(
		db,
		schema,
		JSON.parse(await readFile(new URL("../../../../docs/schema/target.json", import.meta.url), "utf8")),
	);
	console.log(
		"PASS: full migration chain matches target.json columns, types, nullability, primary keys and foreign keys. Historical SQL unchanged.",
	);
} finally {
	await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
	await db.end();
}
