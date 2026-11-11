import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { testDatabase } from "../../support/test-database.mts";
const require = createRequire(new URL("../../../packages/domain/package.json", import.meta.url));

export const id = randomUUID;
export async function database() {
	const t = await testDatabase({ prefix: "wp006", roles: { runtime: ["runtime"], cleanup: ["cleanup"] } });
	return { admin: t.admin, ...t.pools, schema: t.schema, createSchema: t.createSchema, close: t.close };
}
export async function transaction(pool, run) {
	return pool.transaction(run);
}
export async function account(db, registration = "active") {
	const a = id(),
		user = id(),
		session = id();
	await db.execute(
		querySql`INSERT INTO auth_user(id,name,email,email_verified) VALUES(${user},'Synthetic',${user + "@example.test"},true)`,
	);
	await db.execute(
		querySql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${a},${user},${registration},'planter')`,
	);
	await db.execute(
		querySql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${session},${user},${randomBytes(32).toString("hex")},clock_timestamp()+interval '1 day')`,
	);
	return { id: a, user, session };
}
export async function plant(db) {
	const p = id();
	await db.execute(
		querySql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${p},'Synthetic','UTC',7,14,1,8,1,1)`,
	);
	return { kind: "plant", id: p };
}
export async function organization(db, kind = "sending_church") {
	const o = id();
	await db.execute(
		querySql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${o},${kind},'Synthetic','UTC',1)`,
	);
	return { kind: "organization", id: o, organizationKind: kind };
}
export async function seat(db, actor, tenant, role = "admin") {
	const s = id();
	await db.execute(
		statement(
			`INSERT INTO seat(id,account_id,${tenant.kind === "plant" ? "plant_id" : "organization_id"},role,accepted_at) VALUES($1,$2,$3,$4,clock_timestamp())`,
			[s, actor.id, tenant.id, role],
		),
	);
	return s;
}
export async function person(db, tenant, linked = null) {
	const p = id();
	await db.execute(
		statement(
			`INSERT INTO person(id,tenant_id,${tenant.kind === "plant" ? "plant_id" : "organization_id"},display_name,source,created_at,state,linked_account_id,stage,commitment_state,adult_classification,pipeline_position) VALUES($1,$2,$2,'Synthetic','other',clock_timestamp(),'live',$3,$4,$5,$6,$7)`,
			[
				p,
				tenant.id,
				linked,
				...(tenant.kind === "plant" ? ["prospect", "unknown", "adult", 1] : [null, null, null, null]),
			],
		),
	);
	return p;
}

function statement(text: string, values: readonly unknown[]) {
	return querySql.join(
		text
			.split(/(\$\d+)/)
			.filter(Boolean)
			.map((part) => (/^\$\d+$/.test(part) ? querySql`${values[Number(part.slice(1)) - 1]}` : querySql.raw(part))),
		querySql``,
	);
}
