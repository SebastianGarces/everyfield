// One isolated schema on the shared development database (or the disposable CI database), migrated from scratch, with
// synthetic accounts, seats, plants and people. Each suite drops its schema and login role afterwards.
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../apps/web/src/server/jobs/queue.ts";
import { evryActor, runTurn, selectQualifiedModel } from "../../../packages/evry/src/index.ts";
import { randomBytes, randomUUID } from "node:crypto";

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");

const schema = "wp051_" + randomUUID().replaceAll("-", "");
const role = "wp051_" + randomBytes(8).toString("hex");
export const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
export let db: ReturnType<typeof createDatabase>;
/** Every statement the runtime role sent, for statement counts. */
export const queries: string[] = [];

export const plant = randomUUID();
export const otherPlant = randomUUID();
export const organization = randomUUID();
type Who = "owner" | "member" | "foreign" | "orgOwner" | "seatless";
const seats: Record<Who, [string | null, string | null, string | null]> = {
	owner: [plant, null, "owner"],
	member: [plant, null, "member"],
	foreign: [otherPlant, null, "admin"],
	orgOwner: [null, organization, "owner"],
	seatless: [null, null, null],
};
export const accounts = Object.fromEntries(
	(Object.keys(seats) as Who[]).map((who) => [who, { id: randomUUID(), user: randomUUID(), session: randomUUID() }]),
) as Record<Who, { id: string; user: string; session: string }>;
export const people: Record<string, string> = {};

export async function actor(who: Who) {
	const viewer = await readViewer(db, accounts[who].session as never);
	if (!viewer?.authority) throw Error("no actor for " + who);
	return evryActor(viewer.authority);
}
export async function freshActor(session: string) {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
}
export const scripted = () => selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });

/** Claims the next due turn through the WP-031 queue, runs it and finishes the claim, as the app worker does. */
export async function work(model = scripted(), extra: Partial<Parameters<typeof runTurn>[0]> = {}) {
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	if (!claim) return null;
	const outcome = await runTurn(
		{ db, model, freshActor, ...extra },
		{ turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
	);
	if (outcome !== "lost")
		await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}

async function person(tenant: string, name: string, city: string | null, position: number) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,city,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${id},${tenant},${tenant},${name},${city},'other',clock_timestamp(),'prospect','unknown','unknown',${position},'live')`);
	return id;
}

export async function setup() {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${role}`));
	const url = new URL(source);
	url.username = role;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 6, options: `-c search_path=${schema},pg_catalog,pg_temp` });
	db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...args: unknown[]) {
			queries.push(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text);
			return Reflect.apply(query, this, args);
		} as typeof client.query;
	});
	for (const id of [plant, otherPlant])
		await admin.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${id},'Synthetic','America/Chicago',7,14,1,8,1,1)`,
		);
	await admin.execute(
		sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${organization},'sending_church','Synthetic','America/Chicago',1)`,
	);
	for (const who of Object.keys(seats) as Who[]) {
		const a = accounts[who];
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${a.user},${a.id + "@example.test"},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${a.id},${a.user},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${a.session},${a.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
		);
		const [p, o, r] = seats[who];
		if (r)
			await admin.execute(
				sql`INSERT INTO seat(account_id,plant_id,organization_id,role,accepted_at) VALUES(${a.id},${p},${o},${r},clock_timestamp())`,
			);
	}
	people.alexRivera = await person(plant, "Alex Rivera", "Chicago", 1);
	people.alexChen = await person(plant, "Alex Chen", "Evanston", 2);
	people.casey = await person(plant, "Casey Reed", null, 3);
	people.foreign = await person(otherPlant, "Quinn Foreign", "Peoria", 1);
	// 200 matching people in the plant, and 2,500 in the other plant for the tool budget.
	await admin.execute(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		SELECT ${plant}::uuid,${plant}::uuid,'Member '||lpad(n::text,3,'0'),'other',clock_timestamp(),'attendee','unknown','unknown',10+n,'live' FROM generate_series(1,200) n`);
	await admin.execute(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		SELECT ${otherPlant}::uuid,${otherPlant}::uuid,'Neighbor '||n,'other',clock_timestamp(),'attendee','unknown','unknown',10+n,'live' FROM generate_series(1,2500) n`);
}

export async function teardown() {
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`));
	} finally {
		await closeDatabase(admin);
	}
}

/** Counts of rows a test must see unchanged, read by the admin connection. */
export async function counts() {
	const r = await admin.execute(sql`SELECT (SELECT count(*)::int FROM conversation) conversations,
		(SELECT count(*)::int FROM conversation_event) events, (SELECT count(*)::int FROM job WHERE kind='assistant_turn') runs,
		(SELECT count(*)::int FROM audit_event) audits, (SELECT count(*)::int FROM person) people`);
	return r.rows[0] as Record<string, number>;
}
export { sql };
