// Seeds an Attestations preview on the shared development database (WP-039/ui). It opens the shared tests/ui seed
// environment (tests/ui/seed-env.mts), signs up real accounts through the identity service, creates a church through
// the onboarding producer, adds people through the People producer and records mixed-state signals and candidates
// through the signals producer with a moving clock, so ages are exact.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/intelligence/seed.mts up <preview-url>
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/intelligence/seed.mts down
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createSignals } from "../../../packages/domain/src/intelligence/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { accountPersonProducer, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { randomUUID } from "node:crypto";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

const PASSWORD = "Intelligence-preview-pass-1";
const DAY = 86_400_000;

async function up(origin: string) {
	const env = await openSeedEnvironment(origin);
	const { admin, runtime, authDb, secret } = env;
	let ip = 1;
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin,
		secret,
		trustedIp: () => env.loopback("intelligence", ip),
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
		const r = await call("register", { kind: "plant_precreation", name, email, password: PASSWORD, requestKey: randomUUID() });
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

	const owner = await account("Daniel Reyes", "owner@intelligence-preview.example.test");
	const admin2 = await account("Priya Nair", "admin@intelligence-preview.example.test");
	const member = await account("Ruth Allen", "member@intelligence-preview.example.test");
	// An Admin with no personal time zone, kept for the check-in zone step (T-66): its test saves a zone once per seed.
	const newcomer = await account("Noah Kim", "newcomer@intelligence-preview.example.test");
	const organizer = await account("Grace Moreno", "church@intelligence-preview.example.test");
	const organization = randomUUID();
	await admin.execute(
		sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${organization},'sending_church','Grace Church','UTC',1)`,
	);
	await admin.execute(
		sql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${organizer.accountId},${organization},'owner',clock_timestamp())`,
	);
	const noop = async () => {};
	const onboarding = createOnboardingProducer({ invalidate: noop, notice: noop, enqueue: noop });
	const created = await runtime.transaction((tx) =>
		onboarding.createPlant(
			tx,
			{ session: owner.sessionId, selected: { kind: "account", id: owner.accountId } } as never,
			{
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { name: "Harvest Point", locality: { city: "Austin" }, confirmed: true },
			} as never,
		),
	);
	if (created.status !== "ok") throw Error("createPlant: " + JSON.stringify(created));
	const plant = (created.value as { plant: { kind: "plant"; id: string } }).plant;
	await admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${plant.id}`);
	for (const [who, role] of [
		[admin2, "admin"],
		[member, "member"],
		[newcomer, "admin"],
	] as const) {
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${who.accountId},${plant.id},${role},clock_timestamp())`,
		);
	}
	for (const [who, name] of [
		[admin2, "Priya Nair"],
		[member, "Ruth Allen"],
	] as const)
		await runtime.transaction((tx) =>
			accountPersonProducer.ensureAccountPerson(tx, {
				accountId: who.accountId,
				owner: plant,
				selection: { kind: "create", displayName: name },
			} as never),
		);

	const ctx = { session: owner.sessionId, selected: plant } as never;
	const people: Record<string, string> = {};
	for (const name of ["Alex Rivera", "Sam Ortiz", "Maria Santos", "Tom Baker", "Kim Wu", "Ana Lee", "Jo Park"]) {
		const r = await runtime.transaction((tx) =>
			peopleWriter.createPerson(tx as never, ctx, {
				requestKey: randomUUID(),
				input: { displayName: name, stage: "core_group", email: null, source: "other" },
			} as never),
		);
		if (r.status !== "ok") throw Error(`create ${name}: ` + JSON.stringify(r));
		people[name] = r.value.person.id;
	}

	// Mixed-state signals, written with a moving clock so every age is exact.
	const base = Date.now();
	let now = base;
	const signals = createSignals({ clock: { now: () => now } });
	const actor = await runtime.transaction((tx) => RequestActor.resolve(tx, owner.sessionId as never));
	if (!(actor instanceof RequestActor)) throw Error("owner actor");
	const ok = <T,>(r: { status: string; value?: T }): T => {
		if (r.status !== "ok") throw Error("seed signal: " + JSON.stringify(r));
		return r.value as T;
	};
	const ago = (days: number) => (now = base - days * DAY);
	const attest = async (key: string, value: string, days: number, extra: Record<string, unknown> = {}, rev = "0") => {
		ago(days);
		return ok(await signals.attest(runtime, actor, { requestKey: randomUUID(), expectedRevision: rev, input: { key, value, ...extra } })).signal;
	};
	const fix = async (key: string, days: number, input: Record<string, unknown>, rev: string) => {
		ago(days);
		return ok(await signals.correct(runtime, actor, { requestKey: randomUUID(), expectedRevision: rev, input: { key, ...input } })).signal;
	};
	await attest("values_documented", "yes", 41, { detail: "Vision and values document v2" });
	await attest("financial_base_established", "not_yet", 100, { detail: "Pledges cover about half of the launch budget" });
	let s = await attest("prayer_leader_assigned", "yes", 39, { detail: "Grace Kim" });
	s = await attest("prayer_rhythm_established", "yes", 70, { detail: "Every other week" });
	s = await fix("prayer_rhythm_established", 50, { action: "correct", value: "not_yet", detail: "Paused for summer" }, s.revision);
	s = await fix("prayer_rhythm_established", 34, { action: "correct", value: "yes", detail: "Weekly, Thursday evenings" }, s.revision);
	await attest("prayer_in_gatherings", "yes", 12);
	s = await attest("systems_tested", "not_yet", 10, { detail: "Giving was not tested yet" });
	await fix("systems_tested", 3, { action: "retract" }, s.revision);
	// Candidates: one established, one with a short period.
	const day = (days: number) => new Date(base - days * DAY).toISOString().slice(0, 10);
	ago(2);
	ok(
		await signals.attestCandidate(runtime, actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { personId: people["Alex Rivera"], periodStart: day(75), periodEnd: day(8), attended: true, volunteered: true, statement: "Seen at every setup and teardown." },
		}),
	);
	ago(1);
	ok(
		await signals.attestCandidate(runtime, actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { personId: people["Sam Ortiz"], periodStart: day(40), periodEnd: day(5), attended: true, volunteered: false },
		}),
	);

	const fixture = writeFixture("intelligence", env.schema, {
		origin,
		plant: plant.id,
		owner: { cookie: owner.cookie, accountId: owner.accountId },
		admin: { cookie: admin2.cookie, accountId: admin2.accountId },
		member: { cookie: member.cookie, accountId: member.accountId },
		newcomer: { cookie: newcomer.cookie, accountId: newcomer.accountId },
		organization: { cookie: organizer.cookie },
		password: PASSWORD,
		people,
	});
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fresh: env.fresh, fixture }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") console.log(JSON.stringify(await dropSeed("intelligence")));
else throw Error("Usage: seed.mts up <preview-url> | down");
