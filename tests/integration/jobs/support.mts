import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { randomUUID } from "node:crypto";
import { searchPath, testDatabase } from "../../support/test-database.mts";
import { seeds } from "../../support/fixture.mts";

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
	await seeds(db).plant({ id: tenant, digest_weekday: 0, digest_hour: 16 });
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
