import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { createPersonRequest, updatePersonRequest } from "../../../packages/contracts/src/people/requests.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { feedbackWriter } from "../../../packages/domain/src/feedback/index.ts";
import { withMeetingsWrite, meetingsWriter } from "../../../packages/domain/src/meetings/index.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
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
const SETUP_CHURCH = "Cedar Creek Church";

const command = (input: unknown, expectedRevision = "1") => ({ requestKey: randomUUID(), expectedRevision, input });
function ok<T>(reply: { status: string; value?: T; error?: unknown }): T {
	if (reply.status !== "ok") throw Error(`setup fixture refused: ${JSON.stringify(reply.error)}`);
	return reply.value as T;
}

export async function seedSetup(admin: Database, runtime: Database, native: NativePorts, { team = true } = {}) {
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
	if (team)
		await admin.execute(sql`INSERT INTO seat(account_id,plant_id,role,accepted_at)
			VALUES(${SETUP_SPECS.setupAdmin.account},${created.plant.id},'admin',clock_timestamp()-interval '1 day'),
				(${SETUP_SPECS.teamLead.account},${created.plant.id},'member',clock_timestamp()-interval '1 day')`);
	await admin.execute(sql`INSERT INTO seat(account_id,plant_id,role,accepted_at,ended_at)
		VALUES(${SETUP_SPECS.former.account},${PLANT},'member',clock_timestamp()-interval '30 days',clock_timestamp()-interval '2 days')`);
	for (const who of ["discovery", "sender"] as const)
		await runtime.transaction(async (tx) =>
			ok(await native.onboarding.createDiscovery(tx, as(who) as never, command({}) as never)),
		);
	const link = (who: SetupName, organization: string) =>
		admin.execute(sql`INSERT INTO affiliation(account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${SETUP_SPECS[who].account},${organization},clock_timestamp()-interval '1 day',false,false,false,false,false,false,false)`);
	await link("discovery", NETWORK);
	await link("sender", GRACE_AUSTIN);
	await link("sender", NETWORK);
	return { plant: created.plant.id };
}

const OVERVIEW_PEOPLE = [
	["Grace Holt", 50, true],
	["Marcus Webb", 45, true],
	["Nina Patel", 40, false],
	["Ana Ruiz", 28, true],
	["Ben Carter", 21, false],
	["Chloe Diaz", 16, false],
	["David Kim", 9, false],
	["Elena Brooks", 4, false],
] as const;

const viewerOf = async (runtime: Database, who: SetupName) =>
	(await readViewer(runtime, SETUP_SPECS[who].session as never))!.authority!;
const peopleCtx = (who: SetupName, plant: string) => ({
	session: SETUP_SPECS[who].session,
	selected: { kind: "plant" as const, id: plant },
});
async function addPerson(admin: Database, runtime: Database, plant: string, name: string, daysAgo = 0) {
	const person = await runtime.transaction(async (tx) =>
		ok<{ person: { id: string } }>(
			(await peopleWriter.createPerson(
				tx as never,
				peopleCtx("setupOwner", plant) as never,
				createPersonRequest.parse({ requestKey: randomUUID(), input: { displayName: name } }),
			)) as never,
		),
	);
	const id = person.person.id;
	if (daysAgo) {
		const at = sql`clock_timestamp()-make_interval(days=>${daysAgo})`;
		await admin.execute(sql`UPDATE person SET created_at=${at} WHERE id=${id}`);
		await admin.execute(
			sql`UPDATE audit_event SET occurred_at=${at} WHERE subject_id=${id} AND action='people.created'`,
		);
	}
	return id;
}
async function localDay(admin: Database, plant: string, days: number) {
	const [row] = (
		await admin.execute(sql`SELECT to_char((clock_timestamp() AT TIME ZONE timezone)::date+${days}::int,'YYYY-MM-DD') AS day
			FROM plant WHERE id=${plant}`)
	).rows as { day: string }[];
	return row!.day;
}
async function schedule(admin: Database, runtime: Database, plant: string, input: Record<string, unknown>) {
	const authority = await viewerOf(runtime, "setupOwner");
	return ok(
		await withMeetingsWrite(runtime, authority, (tx, ctx) =>
			meetingsWriter.schedule(tx, ctx, { requestKey: randomUUID(), input: { time: "18:30", ...input } }),
		),
	);
}

export async function seedOverview(admin: Database, runtime: Database, native: NativePorts, plant: string) {
	const owner = peopleCtx("setupOwner", plant);
	const [plantRow] = (
		await admin.execute<{ revision: string }>(sql`SELECT revision::text FROM plant WHERE id=${plant}`)
	).rows;
	if (!plantRow) throw Error(`no plant ${plant}`);
	const { revision } = plantRow;
	await runtime.transaction(async (tx) =>
		ok(await native.onboarding.complete(tx, owner as never, command({}, revision) as never)),
	);
	const [me] = (
		await admin.execute(
			sql`SELECT id::text FROM person WHERE plant_id=${plant} AND linked_account_id=${SETUP_SPECS.setupOwner.account}`,
		)
	).rows as { id: string }[];
	const ids: Record<string, string> = { [SETUP_SPECS.setupOwner.name]: me!.id };
	for (const [name, days, active] of OVERVIEW_PEOPLE) {
		ids[name] = await addPerson(admin, runtime, plant, name, days);
		if (active)
			await runtime.transaction(async (tx) =>
				ok(
					(await peopleWriter.updatePerson(
						tx as never,
						owner as never,
						updatePersonRequest.parse({
							requestKey: randomUUID(),
							expectedRevision: "1",
							input: { personId: ids[name], patch: { city: "Austin" } },
						}),
					)) as never,
				),
			);
	}
	await schedule(admin, runtime, plant, {
		type: "orientation",
		title: "Newcomer orientation",
		date: await localDay(admin, plant, 2),
	});
	await schedule(admin, runtime, plant, {
		type: "prelaunch_practice",
		title: "Practice service",
		date: await localDay(admin, plant, 9),
	});
	const task = randomUUID();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,creator_id,created_at,due_kind,due_date)
		VALUES(${task},${plant},'Ask the school about Sunday space','general','medium','not_started',${SETUP_SPECS.setupOwner.account},
			clock_timestamp()-interval '10 days','date_only',${await localDay(admin, plant, -3)})`);
	await admin.execute(
		sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${plant},${task},${SETUP_SPECS.setupOwner.account})`,
	);
	const sam = await viewerOf(runtime, "seatless");
	const other = await runtime.transaction(async (tx) =>
		ok<{ id: string }>(
			(await feedbackWriter.submit(
				tx as never,
				sam,
				{ requestKey: randomUUID(), category: "bug", description: "The sign-in page froze." },
				{ appVersion: null },
			)) as never,
		),
	);
	return { people: ids, otherFeedback: other.id };
}

export async function planVisionMeeting(admin: Database, runtime: Database, plant: string) {
	await schedule(admin, runtime, plant, {
		type: "vision_meeting",
		title: "Vision night",
		date: await localDay(admin, plant, 8),
	});
}
export async function seatMember(admin: Database, plant: string) {
	await admin.execute(sql`INSERT INTO seat(account_id,plant_id,role,accepted_at)
		VALUES(${SETUP_SPECS.teamLead.account},${plant},'member',clock_timestamp()-interval '1 day')`);
}
export async function crowdActivity(admin: Database, runtime: Database, plant: string) {
	for (let n = 1; n <= 15; n++) await addPerson(admin, runtime, plant, `Guest ${String(n).padStart(2, "0")}`);
}
