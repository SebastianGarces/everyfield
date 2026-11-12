// Seeds a People preview on the shared development database (WP-011/ui). It opens the shared tests/ui seed environment
// (tests/ui/seed-env.mts: one isolated schema, login roles and apps/web/.env.local per worktree), signs up real accounts
// through the identity service, creates a church through the onboarding producer and adds people through the People
// producer, the same code the screens call.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/people/seed.mts up <preview-url>
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/people/seed.mts down
//
// `up` writes the Owner's session cookie and the people IDs the browser tests need (tests/ui/meetings/attendance.test.mjs,
// tests/ui/evry/review.test.mjs and tests/ui/meetings/seed.mts) to $PEOPLE_UI_FIXTURE (default
// /tmp/everyfield-people-ui.json). `down` deletes it and drops the shared schema when no other seed still uses it.
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { randomUUID } from "node:crypto";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

const PASSWORD = "People-preview-pass-1";

async function up(origin: string) {
	const env = await openSeedEnvironment(origin);
	const { admin, runtime, authDb, secret } = env;
	// Registration admission is limited per address; each seeded account signs up from its own loopback address.
	let ip = 1;
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin,
		secret,
		trustedIp: () => env.loopback("people", ip),
		// Verification mail is skipped: the seed marks the address verified directly below.
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
	const cookieOf = (r: Response) =>
		r.headers
			.getSetCookie()
			.map((v) => v.split(";")[0])
			.join("; ");

	async function account(name: string, email: string) {
		ip++;
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
		const cookie = cookieOf(signedIn);
		const session = (await (await call("get-session", undefined, cookie)).json()) as {
			status: string;
			accountId: string;
			sessionId: string;
		};
		if (session.status !== "active") throw Error(`session ${email}: ${session.status}`);
		return { cookie, accountId: session.accountId, sessionId: session.sessionId, email };
	}

	const owner = await account("Daniel Reyes", "owner@people-preview.example.test");

	const noop = async () => {};
	const onboarding = createOnboardingProducer({ invalidate: noop, notice: noop, enqueue: noop });
	const created = await runtime.transaction((tx) =>
		onboarding.createPlant(
			tx,
			{
				session: owner.sessionId,
				selected: { kind: "account", id: owner.accountId },
			} as never,
			{
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { name: "Harvest Point", locality: { city: "Austin" }, confirmed: true },
			} as never,
		),
	);
	if (created.status !== "ok") throw Error("createPlant: " + JSON.stringify(created));
	const plant = (created.value as { plant: { kind: "plant"; id: string } }).plant;

	const ctx = { session: owner.sessionId, selected: plant } as never;
	const write = <T,>(run: (tx: unknown) => Promise<T>) => runtime.transaction((tx) => run(tx));
	const people: Record<string, { id: string; revision: string }> = {};
	const names: [string, string, string | null][] = [
		["Maria Santos", "interviewed", "maria@example.test"],
		["James Okafor", "following_up", "james@example.test"],
		["Ana Lee", "core_group", "ana@example.test"],
		["Tom Baker", "leader", null],
		["Kim Wu", "attendee", null],
		["Rosa Bennett", "launch_team", "rosa@example.test"],
		["Eli Park", "prospect", null],
		["Sara Nunez", "prospect", "sara@example.test"],
		["Leo Pratt", "attendee", null],
		["Mia Hall", "following_up", null],
		["David Kim", "interviewed", null],
	];
	for (let i = 0; names.length < 30; i++) names.push([`Guest ${String(i + 1).padStart(2, "0")}`, "prospect", null]);
	for (const [displayName, stage, email] of names) {
		const r = await write((tx) =>
			peopleWriter.createPerson(tx as never, ctx, {
				requestKey: randomUUID(),
				input: { displayName, stage, email, source: displayName === "Maria Santos" ? "vision_meeting" : "other" },
			} as never),
		);
		if (r.status !== "ok") throw Error(`create ${displayName}: ` + JSON.stringify(r));
		people[displayName] = { id: r.value.person.id, revision: r.value.person.revision };
	}
	const fixture = writeFixture("people", env.schema, {
		origin,
		plant: plant.id,
		owner: { cookie: owner.cookie, accountId: owner.accountId },
		people: Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.id])),
	});
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fresh: env.fresh, fixture }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") console.log(JSON.stringify(await dropSeed("people")));
else throw Error("Usage: seed.mts up <preview-url> | down");
