// Seeds a People preview on the shared development database (WP-011/ui). It creates an isolated schema with its own
// login roles, applies every migration, signs up real accounts through the identity service, creates a church through
// the onboarding producer and adds people through the People producer, the same code the screens call.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/people/seed.mts up <preview-url>
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/people/seed.mts down
//
// `up` writes apps/web/.env.local in this worktree (git-ignored, mode 0600) with the isolated schema's disposable role
// credentials, so the preview's identity mount and People screens use that schema, and writes the session cookies and
// IDs the browser tests need to $PEOPLE_UI_FIXTURE (default /tmp/everyfield-people-ui.json). `down` drops the schema and
// roles and deletes both files. Never point this at production: it refuses any other database host.
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { peopleWriter, accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_FILE = fileURLToPath(new URL("../../../apps/web/.env.local", import.meta.url));
const FIXTURE = process.env.PEOPLE_UI_FIXTURE ?? "/tmp/everyfield-people-ui.json";
const PASSWORD = "People-preview-pass-1";

function adminUrl() {
	const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
	if (source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech" || process.env.NODE_ENV === "production")
		throw Error("Approved shared development database required");
	source.searchParams.set("sslmode", "verify-full");
	return source;
}

async function up(origin: string) {
	if (!/^https?:\/\/[a-z0-9.-]+\.localhost(:\d+)?$/.test(origin)) throw Error("Give the local preview URL");
	const source = adminUrl();
	const schema = "wp011ui_" + randomUUID().replaceAll("-", "").slice(0, 16),
		role = "wp011ui_" + randomBytes(6).toString("hex"),
		authRole = role + "_auth",
		password = randomBytes(24).toString("hex");
	const options = `-c search_path=${schema},pg_catalog,pg_temp`;
	writeFileSync(FIXTURE, JSON.stringify({ schema, role, authRole }), { mode: 0o600 });
	const admin = createDatabase({ connectionString: source.href, max: 4, options });
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	for (const [name, grant] of [
		[role, "everyfield_runtime"],
		[authRole, "everyfield_auth"],
	] as const) {
		await admin.execute(
			sql.raw(`CREATE ROLE ${name} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`),
		);
		await admin.execute(sql.raw(`GRANT ${grant} TO ${name}`));
	}
	const url = (name: string) => {
		const u = new URL(source);
		u.username = name;
		u.password = password;
		return u;
	};
	const runtime = createDatabase({ connectionString: url(role).href, max: 4, options });
	const authDb = createDatabase({ connectionString: url(authRole).href, max: 4, options });
	const secret = randomBytes(32).toString("hex");
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin,
		secret,
		trustedIp: () => "127.0.0.1",
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

	const owner = await account("Daniel Reyes", "owner@people-preview.example.test");
	const member = await account("Ruth Allen", "member@people-preview.example.test");
	const seatless = await account("Sam Lee", "seatless@people-preview.example.test");

	const noop = async () => {};
	const onboarding = createOnboardingProducer({ invalidate: noop, notice: noop, enqueue: noop });
	const created = await runtime.transaction((tx) =>
		onboarding.createPlant(
			tx,
			{
				session: owner.sessionId,
				selected: { kind: "account", id: owner.accountId },
				purpose: "native",
				origin: { kind: "native" },
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

	// The Member seat. Seat acceptance belongs to WP-008; the seed writes the accepted seat and links its person.
	await admin.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${member.accountId},${plant.id},'member',clock_timestamp())`,
	);
	await runtime.transaction((tx) =>
		accountPersonProducer.ensureAccountPerson(tx, {
			accountId: member.accountId,
			owner: plant,
			selection: { kind: "create", displayName: "Ruth Allen" },
		} as never),
	);

	const ctx = { session: owner.sessionId, selected: plant, purpose: "native", origin: { kind: "native" } } as never;
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
	const maria = people["Maria Santos"]!;
	const note = await write((tx) =>
		peopleWriter.addNote(tx as never, ctx, {
			requestKey: randomUUID(),
			expectedRevision: maria.revision,
			input: { personId: maria.id, body: "Wants to lead worship one Sunday a month after the baby comes." },
		} as never),
	);
	if (note.status !== "ok") throw Error("note: " + JSON.stringify(note));

	// A retired person, through the producer.
	const kim = people["Kim Wu"]!;
	const review = await admin.execute(sql`SELECT material_revision::text AS r FROM plant WHERE id=${plant.id}`);
	const retired = await write((tx) =>
		peopleWriter.retirePerson(tx as never, ctx, {
			requestKey: randomUUID(),
			expectedRevision: kim.revision,
			input: { personId: kim.id, reason: "Moved away", reviewRevision: review.rows[0]!.r, handoffs: [] },
		} as never),
	);
	if (retired.status !== "ok") throw Error("retire: " + JSON.stringify(retired));

	// A merged source. Merge belongs to WP-015 and has no producer yet; the seed writes the state it will produce.
	const merged = people[names.at(-1)![0]]!;
	await admin.execute(
		sql`UPDATE person SET state='merged', retired_at=clock_timestamp(), merged_into_person_id=${people["Eli Park"]!.id}, revision=revision+1 WHERE id=${merged.id}`,
	);

	// Follow-up duties for the pipeline badges. Tasks belong to WP-024; the seed writes two open parent tasks.
	await admin.execute(sql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind,due_date,person_id)
		VALUES (${plant.id},'Call James','follow_up','medium','not_started',clock_timestamp(),'date_only',(current_date - 3)::date,${people["James Okafor"]!.id}),
		       (${plant.id},'Invite Mia','follow_up','medium','not_started',clock_timestamp(),'undated',NULL,${people["Mia Hall"]!.id})`);

	const settings = (name: string) => {
		const u = url(name);
		u.searchParams.set("options", options);
		return u.href;
	};
	writeFileSync(
		ENV_FILE,
		[
			`IDENTITY_DATABASE_URL=${settings(role)}`,
			`IDENTITY_AUTH_DATABASE_URL=${settings(authRole)}`,
			`IDENTITY_ORIGIN=${origin}`,
			`IDENTITY_SECRET=${secret}`,
			`IDENTITY_MAIL_KEY=${randomBytes(32).toString("hex")}`,
			`IDENTITY_ADDRESS_KEY=${randomBytes(32).toString("hex")}`,
			`IDENTITY_MAIL_FROM=security@example.test`,
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	writeFileSync(
		FIXTURE,
		JSON.stringify(
			{
				schema,
				role,
				authRole,
				origin,
				plant: plant.id,
				owner: { cookie: owner.cookie, accountId: owner.accountId },
				member: { cookie: member.cookie, accountId: member.accountId },
				seatless: { cookie: seatless.cookie },
				people: Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.id])),
			},
			null,
			"\t",
		),
		{ mode: 0o600 },
	);
	await closeDatabase(runtime);
	await closeDatabase(authDb);
	await closeDatabase(admin);
	console.log(JSON.stringify({ schema, fixture: FIXTURE, env: ENV_FILE }));
}

async function down() {
	const state = JSON.parse(readFileSync(FIXTURE, "utf8")) as { schema: string; role: string; authRole: string };
	if (!/^wp011ui_[a-f0-9]+$/.test(state.schema)) throw Error("Not a People seed schema");
	const admin = createDatabase({ connectionString: adminUrl().href, max: 1 });
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${state.schema} CASCADE`));
		for (const r of [state.role, state.authRole])
			if (/^wp011ui_[a-f0-9]+(_auth)?$/.test(r)) await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${r}`));
	} finally {
		await closeDatabase(admin);
	}
	rmSync(ENV_FILE, { force: true });
	rmSync(FIXTURE, { force: true });
	console.log(JSON.stringify({ dropped: state.schema }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") await down();
else throw Error("Usage: seed.mts up <preview-url> | down");
