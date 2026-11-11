import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { searchPath, testDatabase } from "../../support/test-database.mts";
const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));

// The schema exists from import on; `setup` adds the tenant and `teardown` drops everything.
const database = await testDatabase({ prefix: "wp031", max: 6 });
export const db = database.admin;
export const runtime = database.pools.runtime;
export const runtimeSettings = {
	connectionString: database.logins.runtime.url.href,
	max: 6,
	options: searchPath(database.schema),
};
export const tenant = randomUUID();
export async function setup() {
	await db.execute(querySql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision)
    VALUES(${querySql.param(tenant)},'Synthetic','America/Chicago',7,14,0,16,1,1)`);
}
export async function teardown() {
	await database.close();
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
