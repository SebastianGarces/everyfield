// The setup fixture (T-345), the acceptance fixture for the onboarding evals and the local preview, seeded next to Hope
// Fellowship (golden-church.mts) but apart from it: Cedar Creek Church (America/Chicago), which its Owner (Casey Rivera)
// created and has not finished setting up, with an Admin (Jordan Lee) and a Member invited to lead on its launch team
// (Taylor Nguyen); three seatless accounts (Sam Ortiz, Erin Walsh and Riley Park); a former Member of Hope Fellowship
// whose seat ended (Alex Moreno); a Discovery account (Dana Brooks) linked to Hill Country Network; and a Discovery
// account (Morgan Hale) linked to Grace Austin and Hill Country Network. A Discovery link shares nothing
// (affiliation_ck_2); what a link shares is chosen when the space becomes a church. The church and the Discovery spaces
// are made by the same onboarding producer `/onboarding` calls.
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import type { NativePorts } from "../../../packages/evry/src/index.ts";
import { GRACE_AUSTIN, NETWORK, PLANT } from "./golden-church.mts";

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
	starter: spec(6, "Riley Park"),
	former: spec(7, "Alex Moreno"),
	sender: spec(8, "Morgan Hale"),
	teamLead: spec(9, "Taylor Nguyen"),
} as const;
export type SetupName = keyof typeof SETUP_SPECS;
export const SETUP_CHURCH = "Cedar Creek Church";

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
		VALUES(${SETUP_SPECS.setupAdmin.account},${created.plant.id},'admin',clock_timestamp()-interval '1 day'),
			(${SETUP_SPECS.teamLead.account},${created.plant.id},'member',clock_timestamp()-interval '1 day')`);
	// A Member of Hope Fellowship whose seat ended: an active account with no seat and no Discovery space.
	await admin.execute(sql`INSERT INTO seat(account_id,plant_id,role,accepted_at,ended_at)
		VALUES(${SETUP_SPECS.former.account},${PLANT},'member',clock_timestamp()-interval '30 days',clock_timestamp()-interval '2 days')`);
	for (const who of ["discovery", "sender"] as const)
		await runtime.transaction(async (tx) =>
			ok(await native.onboarding.createDiscovery(tx, as(who) as never, command({}) as never)),
		);
	// The organizations each Discovery account chose: links that share nothing until the space becomes a church.
	const link = (who: SetupName, organization: string) =>
		admin.execute(sql`INSERT INTO affiliation(account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${SETUP_SPECS[who].account},${organization},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
	await link("discovery", NETWORK);
	await link("sender", GRACE_AUSTIN);
	await link("sender", NETWORK);
	return { plant: created.plant.id };
}
