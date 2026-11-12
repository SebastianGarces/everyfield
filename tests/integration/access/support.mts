import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { testDatabase } from "../../support/test-database.mts";
import { seeds } from "../../support/fixture.mts";
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
	const a = await seeds(db).actor(null, "owner", {
		account: { registration_state: registration, registration_kind: "planter" },
	});
	return { id: a.id, user: a.user, session: a.session };
}
export async function plant(db) {
	return seeds(db).plant({ timezone: "UTC" });
}
export async function organization(db, kind = "sending_church") {
	return seeds(db).organization(kind);
}
export async function seat(db, actor, tenant, role = "admin") {
	return seeds(db).seat(actor, tenant, role);
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
