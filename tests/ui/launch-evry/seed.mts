// Seeds the Evry Launch example (WP-075, WP-076) on the shared tests/ui seed environment (tests/ui/seed-env.mts), so
// each Launch panel state can be viewed on a preview. Four churches, all America/Chicago, dated from today:
//
// - Cedar Hill Church (Owner Noah Hayes, Admin Grace Lin, Member Eli Ward): Launch Sunday 28 days out, set a month ago
//   for 35 days out and moved three days ago ("The school asked us to start a week earlier."). Four milestones are
//   marked complete, so five stay open. "Send the press release to local media", a prep task linked to "Promotion plan
//   implemented", is two days overdue; "Send a press release to local media outlets", an ordinary task linked to no
//   milestone, is three days overdue. Launch team holds 14 people. Ask the countdown, the open and blocked milestones,
//   the launch-team goal and what changed since last week; move or postpone the date as each seat.
// - Westfield Church (Owner Ava Stone): no launch date.
// - Riverbend Church (Owner Leo Grant): Launch Sunday two days ago, not recorded yet. Record its attendance, then submit
//   the debrief and publish the summary.
// - Northgate Church (Owner Mia Cole): Launch Sunday three days ago, recorded with attendance 150 and three named
//   first-time guests (Maya Brooks, Owen Price, Ruth Kim); a Vision meeting a month ago had two other people attend.
//
// Accounts sign up through the identity service, churches are created through the onboarding producer, people through
// the People writer and every Launch change through the native Launch writer the Launch plan calls. Seats beyond the
// Owner, task due dates and the history dates are raw rows: no public write backdates them.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/launch-evry/seed.mts up <preview-url>
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/launch-evry/seed.mts down
//
// `up` writes every seat's session cookie and the church ids to the launch-evry fixture (fixturePath in setup.mjs; by
// default /tmp/everyfield-launch-evry-ui.json). Every account's password is in PASSWORD below.
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { reviewedOf } from "../../../packages/contracts/src/launch/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createLaunchReader } from "../../../packages/domain/src/launch/reads.ts";
import { createLaunchWriter } from "../../../packages/domain/src/launch/writes.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { randomUUID } from "node:crypto";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

const PASSWORD = "Launch-preview-pass-1";
type Account = { cookie: string; accountId: string; sessionId: string; email: string };
type Plant = { kind: "plant"; id: string };
type Database = Awaited<ReturnType<typeof openSeedEnvironment>>["admin"];

const ZONE = "America/Chicago";
const today = () =>
	new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(),
	);
/** The church-local date `n` days from today. */
const day = (n: number) => new Date(Date.parse(`${today()}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const COMPLETED = [
	"operations.equipment_on_site",
	"operations.worship_center",
	"launch_team.prayer_and_fasting",
	"promotion.plan",
];

function ok<T>(reply: { status: string; value?: T; error?: unknown }, what: string): T {
	if (reply.status !== "ok") throw Error(`${what}: ${JSON.stringify(reply)}`);
	return reply.value as T;
}

/** The example's accounts, churches and Launch plans in the schema `admin` and `runtime` are pinned to. */
export async function seedLaunchEvry(env: {
	admin: Database;
	runtime: Database;
	authDb: Database;
	secret: string;
	origin: string;
	address: (n: number) => string;
}) {
	const { admin, runtime, authDb, secret, origin } = env;
	let ip = 1;
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin,
		secret,
		trustedIp: () => env.address(ip),
		enqueueMail: async () => {},
		diagnostic: () => {},
	});
	const host = new URL(origin).host;
	const call = async (path: string, body?: unknown, cookie?: string) =>
		identity.handle(
			new Request(`${origin}/api/auth/${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { host, origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	const tag = randomUUID().slice(0, 8);

	/** A signed-in active account that may create a church. */
	async function account(name: string): Promise<Account> {
		ip++;
		const email = `${name.toLowerCase().replace(/\W+/g, ".")}.${tag}@launch-preview.example.test`;
		const r = await call("register", {
			kind: "plant_precreation",
			name,
			email,
			password: PASSWORD,
			requestKey: randomUUID(),
		});
		if (!r.ok) throw Error(`register ${email}: ${r.status} ${await r.text()}`);
		await admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE email=${email}`);
		await admin.execute(
			sql`UPDATE account SET registration_state='active' WHERE auth_user_id=(SELECT id FROM auth_user WHERE email=${email})`,
		);
		const signedIn = await call("sign-in/email", { email, password: PASSWORD });
		if (!signedIn.ok) throw Error(`sign in ${email}: ${signedIn.status}`);
		const cookie = signedIn.headers
			.getSetCookie()
			.map((v) => v.split(";")[0])
			.join("; ");
		const session = (await (await call("get-session", undefined, cookie)).json()) as {
			status: string;
			accountId: string;
			sessionId: string;
		};
		if (session.status !== "active") throw Error(`session ${email}: ${session.status}`);
		return { cookie, accountId: session.accountId, sessionId: session.sessionId, email };
	}

	const noop = async () => {};
	const onboarding = createOnboardingProducer({ invalidate: noop, notice: noop, enqueue: noop } as never);
	const ctx = (a: Account, selected: Plant | { kind: "account"; id: string }) =>
		({ session: a.sessionId, selected }) as never;
	/** A church its Owner creates through onboarding, in America/Chicago. */
	async function plant(owner: Account, name: string, city: string): Promise<Plant> {
		const created = ok<{ plant: Plant }>(
			(await runtime.transaction((tx) =>
				onboarding.createPlant(tx, ctx(owner, { kind: "account", id: owner.accountId }), {
					requestKey: randomUUID(),
					expectedRevision: "1",
					input: { name, locality: { city, stateProvince: "TX", country: "US" }, confirmed: true },
				} as never),
			)) as never,
			`createPlant ${name}`,
		);
		await admin.execute(sql`UPDATE plant SET timezone=${ZONE} WHERE id=${created.plant.id}`);
		return created.plant;
	}
	const seat = (a: Account, p: Plant, role: "admin" | "member") =>
		admin.execute(sql`INSERT INTO seat(account_id,plant_id,role,accepted_at)
			VALUES(${a.accountId},${p.id},${role},clock_timestamp()-interval '1 minute')`);
	async function person(owner: Account, p: Plant, displayName: string, stage: string) {
		const r = await runtime.transaction((tx) =>
			peopleWriter.createPerson(tx as never, ctx(owner, p), {
				requestKey: randomUUID(),
				input: { displayName, stage, source: "other" },
			} as never),
		);
		return ok<{ person: { id: string } }>(r as never, `person ${displayName}`).person.id;
	}

	const reader = createLaunchReader();
	const writer = createLaunchWriter({ notices: async () => undefined });
	const authority = (a: Account) => RequestActor.resolve(runtime, a.sessionId as never) as Promise<RequestActor>;
	const planOf = async (a: Account) => ok(await reader.readPlan(runtime, await authority(a)), "plan").plan;
	const schedule = async (a: Account, date: string, reason: string | null) => {
		const plan = await planOf(a);
		ok(
			await writer.schedule(runtime, await authority(a), {
				requestKey: randomUUID(),
				expectedRevision: plan.launch?.revision ?? plan.revision,
				input: { date, reason },
			}),
			`schedule ${date}`,
		);
	};
	/** Dates the church's newest Launch date row back `days` days, as if it was made then. */
	const backdate = (p: Plant, days: number) =>
		admin.execute(sql`UPDATE audit_event SET occurred_at=clock_timestamp()-make_interval(days=>${days}),
			recorded_at=clock_timestamp()-make_interval(days=>${days})
			WHERE id=(SELECT id FROM audit_event WHERE tenant_id=${p.id} AND action='launch.changed' AND subject_type='launch'
				ORDER BY recorded_at DESC LIMIT 1)`);

	// Cedar Hill: 28 days out, moved there three days ago, five milestones open, one linked prep task overdue.
	const noah = await account("Noah Hayes");
	const grace = await account("Grace Lin");
	const eli = await account("Eli Ward");
	const cedar = await plant(noah, "Cedar Hill Church", "Round Rock");
	await seat(grace, cedar, "admin");
	await seat(eli, cedar, "member");
	await schedule(noah, day(35), null);
	await backdate(cedar, 30);
	await schedule(noah, day(28), "The school asked us to start a week earlier.");
	await backdate(cedar, 3);
	for (const key of COMPLETED) {
		const m = (await planOf(noah)).milestones.find((x) => x.templateKey === key)!;
		ok(
			await writer.completeMilestone(runtime, await authority(noah), {
				requestKey: randomUUID(),
				expectedRevision: m.revision,
				input: { milestoneId: m.id, reviewed: reviewedOf(m.tasks) },
			}),
			`complete ${key}`,
		);
	}
	await admin.execute(sql`UPDATE task SET due_kind='date_only',due_date=${day(-2)}::date
		WHERE plant_id=${cedar.id} AND title='Send the press release to local media' AND launch_task_key IS NOT NULL`);
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,creator_id,created_at,due_kind,due_date)
		VALUES(${randomUUID()},${cedar.id},'Send a press release to local media outlets','general','medium','not_started',
			${noah.accountId},clock_timestamp()-interval '10 days','date_only',${day(-3)}::date)`);
	for (let n = 1; n <= 14; n++) await person(noah, cedar, `Launch Team ${String(n).padStart(2, "0")}`, "launch_team");
	for (let n = 1; n <= 4; n++) await person(noah, cedar, `Prospect ${n}`, "prospect");

	// Westfield: no launch date.
	const ava = await account("Ava Stone");
	const westfield = await plant(ava, "Westfield Church", "Pflugerville");

	// Riverbend: Launch Sunday two days ago, not recorded yet.
	const leo = await account("Leo Grant");
	const riverbend = await plant(leo, "Riverbend Church", "Austin");
	await schedule(leo, day(-2), null);

	// Northgate: Launch Sunday recorded with 150 people and three named guests; a Vision meeting had two others.
	const mia = await account("Mia Cole");
	const northgate = await plant(mia, "Northgate Church", "Georgetown");
	await schedule(mia, day(-3), null);
	const recorded = await planOf(mia);
	ok(
		await writer.recordOutcome(runtime, await authority(mia), {
			requestKey: randomUUID(),
			expectedRevision: recorded.launch!.revision,
			input: { actualDate: day(-3), attendance: 150, decisions: null, note: null },
		}),
		"outcome",
	);
	for (const displayName of ["Maya Brooks", "Owen Price", "Ruth Kim"])
		ok(
			await writer.addGuestAttendance(runtime, await authority(mia), {
				requestKey: randomUUID(),
				input: { displayName },
			}),
			`guest ${displayName}`,
		);
	const vision = randomUUID();
	const visionDay = day(-30);
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
		resolver_version,status,attendance_revision,finalized_at) VALUES(${vision},${northgate.id},'vision_meeting',
		'Vision night',${visionDay},'18:00',${ZONE},${`${visionDay}T23:00:00Z`},'1','completed',1,clock_timestamp())`);
	for (const name of ["Hannah Reed", "Caleb Fox"]) {
		const id = await person(mia, northgate, name, "attendee");
		await admin.execute(sql`INSERT INTO participation(plant_id,meeting_id,person_id,roster_member,presence)
			VALUES(${northgate.id},${vision},${id},true,'attended')`);
	}

	const signedIn = (a: Account) => ({ cookie: a.cookie, accountId: a.accountId, email: a.email });
	return {
		origin,
		password: PASSWORD,
		seats: {
			cedarOwner: signedIn(noah),
			cedarAdmin: signedIn(grace),
			cedarMember: signedIn(eli),
			westfieldOwner: signedIn(ava),
			riverbendOwner: signedIn(leo),
			northgateOwner: signedIn(mia),
		},
		plants: { cedar: cedar.id, westfield: westfield.id, riverbend: riverbend.id, northgate: northgate.id },
	};
}

async function up(origin: string) {
	const env = await openSeedEnvironment(origin);
	const data = await seedLaunchEvry({ ...env, origin, address: (n) => env.loopback("launch-evry", n) });
	const fixture = writeFixture("launch-evry", env.schema, data);
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fresh: env.fresh, fixture }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") console.log(JSON.stringify(await dropSeed("launch-evry")));
else if (action !== undefined) throw Error("Usage: seed.mts up <preview-url> | down");
