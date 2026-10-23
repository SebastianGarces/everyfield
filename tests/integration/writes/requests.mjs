// Real HTTP requests against the production build (apps/web/.next), counted per request by observer.cjs: the session
// lookup, the page reads and the write, everything a request sends. One isolated schema with its own login roles on the
// CI or shared development database; the seed uses the same producers the screens call. Each request names itself
// (x-evf-request), and statements.test.mts compares the counts with limits.json. Every page is read twice, before and
// after its data grows, because a page read uses a fixed number of statements independent of data size.
//   node --conditions=react-server --import tsx tests/integration/writes/requests.mjs   (EVF_WRITE_COUNTS=<jsonl>)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = root + "apps/web/";
const output = process.env.EVF_WRITE_COUNTS;
assert.ok(output, "Set EVF_WRITE_COUNTS");
assert.ok(
	existsSync(web + ".next/BUILD_ID"),
	"No production build in apps/web/.next. Run `corepack pnpm build` first.",
);

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const ci =
	process.env.CI === "true" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!ci && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Approved development or disposable CI database required");
if (!ci) source.searchParams.set("sslmode", "verify-full");

const port = await new Promise((resolve) => {
	const probe = createServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address();
		probe.close(() => resolve(port));
	});
});
const origin = `http://127.0.0.1:${port}`;
const schema = "wp011rq_" + randomBytes(8).toString("hex"),
	role = "wp011rq_" + randomBytes(6).toString("hex"),
	authRole = role + "_auth",
	password = randomBytes(24).toString("hex"),
	options = `-c search_path=${schema},pg_catalog,pg_temp`;
const login = (name) => {
	const url = new URL(source);
	url.username = name;
	url.password = password;
	url.searchParams.set("options", options);
	return url.href;
};
const admin = createDatabase({ connectionString: source.href, options, max: 2 });
let runtime, authDb, server, bucket;
try {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	for (const [name, grant] of [
		[role, "everyfield_runtime"],
		[authRole, "everyfield_auth"],
	]) {
		await admin.execute(
			sql.raw(
				`CREATE ROLE ${name} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
			),
		);
		await admin.execute(sql.raw(`GRANT ${grant} TO ${name}`));
	}
	runtime = createDatabase({ connectionString: login(role), max: 2 });
	authDb = createDatabase({ connectionString: login(authRole), max: 2 });
	const secret = randomBytes(32).toString("hex");

	// Accounts sign up and sign in through the identity service, each from its own address (registration admission).
	let ip = 0;
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin,
		secret,
		trustedIp: () => `127.0.9.${ip}`,
		enqueueMail: async () => {},
		diagnostic: () => {},
	});
	const call = (path, body, cookie) =>
		identity.handle(
			new Request(`${origin}/api/auth/${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: {
					host: new URL(origin).host,
					origin,
					"content-type": "application/json",
					...(cookie ? { cookie } : {}),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	async function account(name) {
		ip++;
		const email = `${name.toLowerCase()}@requests.example.test`,
			secretWord = "Requests-pass-" + randomBytes(6).toString("hex");
		const registered = await call("register", {
			kind: "plant_precreation",
			name,
			email,
			password: secretWord,
			requestKey: randomUUID(),
		});
		assert.ok(registered.ok, `register ${name}: ${registered.status}`);
		await admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE email=${email}`);
		await admin.execute(
			sql`UPDATE account SET registration_state='active' WHERE auth_user_id=(SELECT id FROM auth_user WHERE email=${email})`,
		);
		const signedIn = await call("sign-in/email", { email, password: secretWord });
		assert.ok(signedIn.ok, `sign in ${name}: ${signedIn.status}`);
		const cookie = signedIn.headers
			.getSetCookie()
			.map((v) => v.split(";")[0])
			.join("; ");
		const session = await (await call("get-session", undefined, cookie)).json();
		assert.equal(session.status, "active");
		return { cookie, accountId: session.accountId, sessionId: session.sessionId };
	}
	const owner = await account("Owner"),
		member = await account("Member");
	const noop = async () => {};
	const created = await runtime.transaction((tx) =>
		createOnboardingProducer({ invalidate: noop, notice: noop, enqueue: noop }).createPlant(
			tx,
			{ session: owner.sessionId, selected: { kind: "account", id: owner.accountId } },
			{
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { name: "Request Church", locality: { city: "Austin" }, confirmed: true },
			},
		),
	);
	assert.equal(created.status, "ok");
	const plant = created.value.plant;
	await admin.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${member.accountId},${plant.id},'member',clock_timestamp())`,
	);
	const ctx = { session: owner.sessionId, selected: plant };
	const person = async (displayName) => {
		const r = await runtime.transaction((tx) =>
			peopleWriter.createPerson(tx, ctx, { requestKey: randomUUID(), input: { displayName, stage: "prospect" } }),
		);
		assert.equal(r.status, "ok");
		return r.value.person;
	};
	const note = async (p, body) => {
		const r = await runtime.transaction((tx) =>
			peopleWriter.addNote(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: { personId: p.id, body },
			}),
		);
		assert.equal(r.status, "ok");
		const [row] = (await admin.execute(sql`SELECT revision::text AS revision FROM person WHERE id=${p.id}`)).rows;
		return { ...p, revision: row.revision };
	};
	const task = (title) =>
		admin.execute(
			sql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind) VALUES(${plant.id},${title},'general','medium','not_started',clock_timestamp(),'undated')`,
		);
	let maria = await person("Maria Santos");
	maria = await note(maria, "First note");
	await task("First task");
	// The owner's own notifications (WP-030/ui), from a task, as the reminder producers write them.
	const notices = (count) =>
		admin.execute(sql`INSERT INTO notice(tenant_id,recipient_id,category,purpose,logical_key,source_record_id,source_revision,title,eligible_at,created_at,timezone)
			SELECT ${plant.id},${owner.accountId},'task','task_due',${plant.id}::text || '/task_due/' || t.id || '/' || g,t.id,g,'Task due ' || g,
				clock_timestamp() - g * interval '1 minute',clock_timestamp(),'America/Chicago'
			FROM (SELECT id FROM task WHERE plant_id=${plant.id} ORDER BY created_at LIMIT 1) t, generate_series(1, ${count}) g
			ON CONFLICT DO NOTHING`);
	await notices(3);

	// A private bucket on this machine: it answers the privacy check (GetBucketAcl) and records every call it gets.
	// Signing an upload URL needs no other bucket call.
	const bucketCalls = [];
	bucket = httpServer((request, response) => {
		bucketCalls.push(`${request.method} ${request.url}`);
		response.setHeader("content-type", "application/xml");
		response.end(
			'<?xml version="1.0" encoding="UTF-8"?><AccessControlPolicy><Owner><ID>census</ID></Owner><AccessControlList>' +
				'<Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>census</ID>' +
				"</Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>",
		);
	});
	await new Promise((resolve) => bucket.listen(0, "127.0.0.1", resolve));

	// The production server, with only the identity and bucket settings it needs. The observer counts per request.
	server = spawn(
		process.execPath,
		[web + "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)],
		{
			cwd: web,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				NODE_ENV: "production",
				NEXT_TELEMETRY_DISABLED: "1",
				NODE_OPTIONS: "--require=" + fileURLToPath(new URL("./observer.cjs", import.meta.url)),
				EVF_WRITE_COUNTS: output,
				IDENTITY_DATABASE_URL: login(role),
				IDENTITY_AUTH_DATABASE_URL: login(authRole),
				IDENTITY_ORIGIN: origin,
				IDENTITY_SECRET: secret,
				IDENTITY_MAIL_KEY: randomBytes(32).toString("hex"),
				IDENTITY_ADDRESS_KEY: randomBytes(32).toString("hex"),
				IDENTITY_MAIL_FROM: "requests@example.test",
				AWS_BUCKET_NAME: "census-private",
				AWS_ACCESS_KEY_ID: "census",
				AWS_SECRET_ACCESS_KEY: randomBytes(16).toString("hex"),
				AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${bucket.address().port}`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let log = "";
	for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => (log += chunk));
	const exited = new Promise((resolve) => server.once("exit", resolve));
	for (let ready = false, started = Date.now(); !ready;) {
		assert.ok(
			Date.now() - started < 60_000 && server.exitCode === null,
			"next start did not answer:\n" + log.slice(-2000),
		);
		ready = await fetch(origin + "/signin").then(
			(r) => r.ok,
			() => false,
		);
		if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
	}

	// Server actions by exported name and file, from the build's action manifest.
	const manifest = JSON.parse(readFileSync(web + ".next/server/server-reference-manifest.json", "utf8"));
	const actionId = (file, name) => {
		const found = Object.entries(manifest.node).filter(
			([, a]) => a.exportedName === name && a.filename?.replace(/\\/g, "/").endsWith(file),
		);
		assert.equal(found.length, 1, `one server action ${file}#${name} in the build`);
		return found[0][0];
	};
	const get = async (name, path, cookie) => {
		const r = await fetch(origin + path, { headers: { "x-evf-request": name, cookie }, redirect: "manual" });
		await r.text();
		assert.equal(r.status, 200, `${name}: HTTP ${r.status}`);
	};
	// One server action call, as the browser sends it. Answers the action's result from the RSC reply. A null name
	// sends no x-evf-request header, so the call is setup and has no budget.
	const act = async (name, page, file, action, args, cookie = owner.cookie) => {
		const r = await fetch(origin + page, {
			method: "POST",
			headers: {
				...(name ? { "x-evf-request": name } : {}),
				cookie,
				origin,
				accept: "text/x-component",
				"next-action": actionId(file, action),
				"content-type": "text/plain;charset=UTF-8",
			},
			body: JSON.stringify(args),
		});
		const text = await r.text();
		assert.equal(r.status, 200, `${name}: HTTP ${r.status}`);
		const line = text.split("\n").find((l) => l.startsWith("1:"));
		assert.ok(line, `${name}: no action result`);
		return JSON.parse(line.slice(2));
	};

	const pages = [
		["GET /people", "/people", owner.cookie],
		["GET /people?view=pipeline", "/people?view=pipeline", owner.cookie],
		["GET /people (member)", "/people", member.cookie],
		["GET /people/[personId]", `/people/${maria.id}`, owner.cookie],
		["GET /tasks", "/tasks", owner.cookie],
		["GET /meetings", "/meetings", owner.cookie],
		["GET /settings", "/settings", owner.cookie],
		["GET /notifications", "/notifications", owner.cookie],
		["GET /notifications/read?what=count", "/notifications/read?what=count", owner.cookie],
		["GET /signin (signed out)", "/signin", ""],
	];
	// RT-6c: no request pays a cold-start cost. Server start checks the bucket's privacy without any request, and opens
	// the connections one request uses (the first before it answers, the rest just after: warm_rest), so the first
	// person page (two reads at once) and the first upload sign open no connection and call no bucket.
	for (
		const started = Date.now();
		!bucketCalls.length || !log.includes('"event":"warm_rest"');
		await new Promise((resolve) => setTimeout(resolve, 50))
	)
		assert.ok(Date.now() - started < 10_000, "server start never checked the bucket or never opened every connection");
	assert.deepEqual(bucketCalls, ["GET /census-private/?acl="]);
	const opened = async (name) => {
		for (const started = Date.now(); ; await new Promise((resolve) => setTimeout(resolve, 20))) {
			const row = readFileSync(output, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.find((r) => r.name === name);
			if (row) return row.connects;
			assert.ok(Date.now() - started < 5_000, `${name}: no sample`);
		}
	};
	await get("GET /people/[personId]", `/people/${maria.id}`, owner.cookie);
	assert.equal(await opened("GET /people/[personId]"), 0, "the first person page opened a database connection");
	const sign = "POST people.assessments.signCommitmentUpload";
	const signed = await act(
		sign,
		`/people/${maria.id}`,
		"apps/web/src/features/people/assessments/actions.ts",
		"signCommitmentUpload",
		[{ personId: maria.id, mime: "image/png", byteLength: 68 }],
	);
	assert.equal(signed.status, "ok", JSON.stringify(signed));
	assert.equal(await opened(sign), 0, "the first upload sign opened a database connection");
	assert.deepEqual(bucketCalls, ["GET /census-private/?acl="], "the first upload sign called the bucket");

	// Warm every route once (module load, first connections), then read each page with little data.
	for (const [, path, cookie] of pages) await fetch(origin + path, { headers: { cookie } }).then((r) => r.text());
	for (const [name, path, cookie] of pages) await get(name, path, cookie);

	const people = "apps/web/src/features/people/actions.ts";
	const key = randomUUID();
	const made = await act("POST people.createPerson", "/people", people, "createPerson", [
		key,
		{ displayName: "New person" },
	]);
	assert.equal(made.status, "ok");
	const replay = await act("POST people.createPerson (replay)", "/people", people, "createPerson", [
		key,
		{ displayName: "New person" },
	]);
	assert.deepEqual(replay, made);
	const personId = made.value.personId;
	const renamed = await act("POST people.updatePerson", "/people", people, "updatePerson", [
		randomUUID(),
		"1",
		personId,
		{ displayName: "Renamed person" },
	]);
	assert.equal(renamed.status, "ok");
	const stale = await act("POST people.updatePerson (stale revision)", "/people", people, "updatePerson", [
		randomUUID(),
		"1",
		personId,
		{ displayName: "Stale rename" },
	]);
	assert.equal(stale.status, "refused");
	const noted = await act("POST people.addNote", "/people", people, "addNote", [
		randomUUID(),
		renamed.value.person.revision,
		{ personId, body: "A note" },
	]);
	assert.equal(noted.status, "ok");
	// Person fields (WP-012/ui): a skill save and its replay after a lost answer (the save lane sends the same key once
	// more), a Member's refused skill, a tag on the person and its replay, and the reads a conflict sends to show the latest skills and photo.
	const fields = "apps/web/src/features/people/fields/actions.ts";
	const page = `/people/${personId}`;
	const skillKey = randomUUID();
	const skill = { personId, name: "Piano", category: "worship", proficiency: null, notes: null };
	const skilled = await act("POST people.fields.addSkill", page, fields, "addSkill", [skillKey, skill]);
	assert.equal(skilled.status, "ok", JSON.stringify(skilled));
	const skillReplay = await act("POST people.fields.addSkill (replay)", page, fields, "addSkill", [skillKey, skill]);
	assert.deepEqual(skillReplay.value.skills, skilled.value.skills);
	// A Member may not change skills: the refusal on the gate's locks is the answer, with no second run (RT-6b).
	const memberSkill = await act(
		"POST people.fields.addSkill (member)",
		page,
		fields,
		"addSkill",
		[randomUUID(), { ...skill, name: "Organ" }],
		member.cookie,
	);
	assert.equal(memberSkill.status, "refused", JSON.stringify(memberSkill));
	const tagKey = randomUUID();
	const tagged = await act("POST people.fields.addPersonTag", page, fields, "addPersonTag", [
		tagKey,
		{ personId, name: "Hosts" },
	]);
	assert.equal(tagged.status, "ok", JSON.stringify(tagged));
	const tagReplay = await act("POST people.fields.addPersonTag (replay)", page, fields, "addPersonTag", [
		tagKey,
		{ personId, name: "Hosts" },
	]);
	assert.deepEqual(tagReplay.value.tags, tagged.value.tags);
	const skills = await act("POST people.fields.readSkills", page, fields, "readSkills", [personId]);
	assert.equal(skills.value.length, 1);
	const photo = await act("POST people.fields.readPhoto", page, fields, "readPhoto", [personId]);
	assert.deepEqual(photo.value, { status: "absent" });
	const tasked = await act("POST tasks.createTask", "/tasks", "apps/web/src/features/tasks/actions.ts", "createTask", [
		randomUUID(),
		{ title: "A task" },
	]);
	assert.equal(tasked.status, "ok");
	// Marks carry the account revision the feed read returned: one entry, the shown entries and "Mark all read".
	const notifications = "apps/web/src/features/notifications/actions.ts";
	const owned = (
		await admin.execute(sql`SELECT id FROM notice WHERE recipient_id=${owner.accountId} ORDER BY eligible_at DESC`)
	).rows.map((r) => r.id);
	const [{ revision }] = (
		await admin.execute(sql`SELECT revision::text AS revision FROM account WHERE id=${owner.accountId}`)
	).rows;
	const envelope = () => ({ requestKey: randomUUID(), expectedRevision: revision });
	const marking = (name, action, input) => act(name, "/notifications", notifications, action, [envelope(), input]);
	const marked = await marking("POST notifications.markRead", "markRead", owned[0]);
	assert.deepEqual(marked, { status: "ok", value: { markedIds: [owned[0]] } });
	const selected = await marking("POST notifications.markSelectedRead", "markSelectedRead", [owned[1]]);
	assert.deepEqual(selected, { status: "ok", value: { markedIds: [owned[1]] } });
	const all = await marking("POST notifications.markAllVisibleRead", "markAllVisibleRead", new Date().toISOString());
	assert.deepEqual(all, { status: "ok", value: { markedIds: [owned[2]] } });
	const settings = "apps/web/src/features/settings/actions.ts";
	const section = await act(null, "/settings", settings, "getSection", [{ section: "account" }]);
	assert.equal(section.status, "ok", JSON.stringify(section));
	const saved = await act("POST settings.saveSection (account)", "/settings", settings, "saveSection", [
		{
			requestKey: randomUUID(),
			expectedRevision: section.value.revision,
			input: { section: "account", name: "Renamed owner" },
		},
	]);
	assert.equal(saved.status, "ok", JSON.stringify(saved));

	// More data than one screen shows: the same pages must send the same statements.
	for (let i = 0; i < 30; i++) await person(`Grown ${String(i).padStart(2, "0")}`);
	for (let i = 0; i < 5; i++) maria = await note(maria, `Grown note ${i}`);
	for (let i = 0; i < 30; i++) await task(`Grown task ${i}`);
	await notices(80);
	for (const [name, path, cookie] of pages) await get(name, path, cookie);

	server.kill("SIGTERM");
	await exited;
} finally {
	if (server?.exitCode === null) server.kill("SIGKILL");
	bucket?.close();
	if (runtime) await closeDatabase(runtime);
	if (authDb) await closeDatabase(authDb);
	await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
	for (const name of [role, authRole]) await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${name}`));
	await closeDatabase(admin);
}
