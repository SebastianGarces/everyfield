// The setup fixture (T-345), seeded next to Hope Fellowship (golden-church.mts) for the onboarding evals and the local
// preview: Riverside Church, which its Owner (Casey Rivera) created and has not finished setting up, with an Admin
// (Jordan Lee); two seatless accounts (Sam Ortiz and Erin Walsh); and a Discovery account (Dana Brooks) linked to Hill
// Country Network. The church and the Discovery space are made by the same onboarding producer `/onboarding` calls.
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import type { NativePorts } from "../../../packages/evry/src/index.ts";
import { NETWORK } from "./golden-church.mts";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
type Spec = { account: string; user: string; session: string; name: string };
const spec = (k: number, name: string): Spec => ({
	account: id(0xe00 + k),
	user: id(0xe10 + k),
	session: id(0xe20 + k),
	name,
});
export const SETUP_SPECS = {
	setupOwner: spec(1, "Casey Rivera"),
	setupAdmin: spec(2, "Jordan Lee"),
	seatless: spec(3, "Sam Ortiz"),
	explorer: spec(4, "Erin Walsh"),
	discovery: spec(5, "Dana Brooks"),
} as const;
export type SetupName = keyof typeof SETUP_SPECS;
export const SETUP_CHURCH = "Riverside Church";

/** The command envelope the onboarding screens send. */
const command = (input: unknown, expectedRevision = "1") => ({ requestKey: randomUUID(), expectedRevision, input });
function ok<T>(reply: { status: string; value?: T; error?: unknown }): T {
	if (reply.status !== "ok") throw Error(`setup fixture refused: ${JSON.stringify(reply.error)}`);
	return reply.value as T;
}

/** Seeds the setup accounts into the schema `admin` writes, then creates the church and the Discovery space natively. */
export async function seedSetup(admin: Database, runtime: Database, native: NativePorts) {
	for (const [who, a] of Object.entries(SETUP_SPECS)) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${a.user},${`${who.toLowerCase()}@example.test`},true,${a.name})`,
		);
		await admin.execute(sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind)
			VALUES(${a.account},${a.user},'active','planter')`);
		await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
			VALUES(${a.session},${a.user},${`golden-${who}`},clock_timestamp()+interval '1 day')`);
	}
	const as = (who: SetupName) => ({
		session: SETUP_SPECS[who].session,
		selected: { kind: "account", id: SETUP_SPECS[who].account },
	});
	const created = await runtime.transaction(async (tx) =>
		ok<{ plant: { id: string } }>(
			await native.onboarding.createPlant(
				tx,
				as("setupOwner") as never,
				command({ name: SETUP_CHURCH, confirmed: true }) as never,
			),
		),
	);
	await admin.execute(sql`INSERT INTO seat(account_id,plant_id,role,accepted_at)
		VALUES(${SETUP_SPECS.setupAdmin.account},${created.plant.id},'admin',clock_timestamp()-interval '1 day')`);
	await runtime.transaction(async (tx) =>
		ok(await native.onboarding.createDiscovery(tx, as("discovery") as never, command({}) as never)),
	);
	// The organization the Discovery account chose: a link that shares nothing until it becomes a church.
	await admin.execute(sql`INSERT INTO affiliation(account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${SETUP_SPECS.discovery.account},${NETWORK},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
	return { plant: created.plant.id };
}
