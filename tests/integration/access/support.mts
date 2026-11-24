import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { randomUUID } from "node:crypto";
import { testDatabase, type Database } from "../../support/test-database.mts";
import { seeds, type Workspace } from "../../support/fixture.mts";
import { accountId, tenantId } from "../../../packages/contracts/src/common/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

export const id = randomUUID;
export async function database() {
	const t = await testDatabase({ prefix: "wp006", roles: { runtime: ["runtime"], cleanup: ["cleanup"] } });
	return { admin: t.admin, ...t.pools, schema: t.schema, createSchema: t.createSchema, close: t.close };
}
export const transaction = gatedTransaction;
export async function account(db: Database, registration = "active") {
	const a = await seeds(db).actor(null, "owner", {
		account: { registration_state: registration, registration_kind: "planter" },
	});
	return { id: accountId.parse(a.id), user: a.user, session: a.session };
}
export async function plant(db: Database) {
	const w = await seeds(db).plant({ timezone: "UTC" });
	return { ...w, id: tenantId.parse(w.id) };
}
export async function organization(db: Database) {
	const w = await seeds(db).organization("sending_church");
	return { ...w, id: tenantId.parse(w.id) };
}
export async function seat(
	db: Database,
	actor: { id: string },
	tenant: Workspace,
	role: "owner" | "admin" | "member" = "admin",
) {
	return seeds(db).seat(actor, tenant, role);
}
export async function person(db: Database, tenant: Workspace, linked: string | null = null) {
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
