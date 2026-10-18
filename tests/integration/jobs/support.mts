import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));

const schema = "wp031_" + randomUUID().replaceAll("-", "");
const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
if (source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech" || process.env.NODE_ENV === "production")
	throw Error("Only approved shared development direct endpoint allowed");
source.searchParams.set("sslmode", "verify-full");
export const db = createDatabase({
	connectionString: source.href,
	max: 6,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
const role = "wp031_" + randomBytes(8).toString("hex");
const password = randomBytes(32).toString("hex");
const runtimeUrl = new URL(source);
runtimeUrl.username = role;
runtimeUrl.password = password;
export const runtimeSettings = {
	connectionString: runtimeUrl.href,
	max: 6,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
};
export const runtime = createDatabase(runtimeSettings);
export const tenant = randomUUID();
export async function setup() {
	await db.execute(querySql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(db, schema);
	await db.execute(
		querySql.raw(
			`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
		),
	);
	await db.execute(querySql.raw(`GRANT everyfield_runtime TO ${role}`));
	await db.execute(querySql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision)
    VALUES(${querySql.param(tenant)},'Synthetic','America/Chicago',7,14,0,16,1,1)`);
}
export async function teardown() {
	await closeDatabase(runtime);
	await db.execute(querySql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
	await db.execute(querySql.raw(`DROP ROLE IF EXISTS ${role}`));
	await closeDatabase(db);
}
export async function subject() {
	const id = randomUUID();
	await db.execute(
		querySql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${querySql.param(id)},${querySql.param(tenant)},'native','Synthetic')`,
	);
	return id;
}
export async function due() {
	await db.execute(
		querySql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second',next_attempt_at=NULL WHERE state IN ('ready','retry_wait')`,
	);
}
