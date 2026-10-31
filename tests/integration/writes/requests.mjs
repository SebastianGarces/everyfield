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
import { crc32, deflateSync } from "node:zlib";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { teamsWriter } from "../../../packages/domain/src/teams/index.ts";

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
	// A follow-up task for a Person (S2 batch 3, F13): its panel read also carries the first page of contact history.
	const [{ id: followUpId }] = (
		await admin.execute(
			sql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind,person_id,creator_id) VALUES(${plant.id},'Follow up with Maria Santos','follow_up','medium','not_started',clock_timestamp(),'undated',${maria.id},${owner.accountId}) RETURNING id`,
		)
	).rows;
	// The owner's own notifications (WP-030/ui), from a task, as the reminder producers write them.
	const notices = (count) =>
		admin.execute(sql`INSERT INTO notice(tenant_id,recipient_id,category,purpose,logical_key,source_record_id,source_revision,title,eligible_at,created_at,timezone)
			SELECT ${plant.id},${owner.accountId},'task','task_due',${plant.id}::text || '/task_due/' || t.id || '/' || g,t.id,g,'Task due ' || g,
				clock_timestamp() - g * interval '1 minute',clock_timestamp(),'America/Chicago'
			FROM (SELECT id FROM task WHERE plant_id=${plant.id} ORDER BY created_at LIMIT 1) t, generate_series(1, ${count}) g
			ON CONFLICT DO NOTHING`);
	await notices(3);
	// Ministries (WP-017/ui): one team with one filled role, through the producer the screens call.
	const teams = async (op, input) => {
		const r = await runtime.transaction((tx) => op(tx, ctx, { requestKey: randomUUID(), ...input }));
		assert.equal(r.status, "ok", JSON.stringify(r));
		return r.value;
	};
	const ministry = (await teams(teamsWriter.create, { input: { name: "Worship" } })).team;
	const staff = async (name) => {
		const { role } = await teams(teamsWriter.createRole, { input: { teamId: ministry.id, name } });
		const holder = await person(`${name} holder`);
		await teams(teamsWriter.assignRole, {
			expectedRevision: role.revision,
			input: { roleId: role.id, teamId: ministry.id, personId: holder.id },
		});
	};
	await staff("Worship lead");
	// Meetings (WP-036/api): a Vision meeting with a venue, 6 sections and 3 guests, an empty one, and a leadership team
	// meeting with a role holder. The agenda print reads each; they grow with the other data below.
	const sections = (n) =>
		JSON.stringify(
			Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Section ${i + 1}`, minutes: 5 + (i % 4) })),
		);
	const meeting = async (type, { agenda = 0, venue = true, team = null } = {}) => {
		const id = randomUUID();
		await admin.execute(
			sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision,agenda,venue_name,venue_address,team_id)
				VALUES(${id},${plant.id},${type},NULL,'2026-11-10','18:30','America/Chicago','2026-11-11T00:30:00Z','test','planning',1,${sections(agenda)}::jsonb,
					${venue ? "Harbor Hall" : null},${venue ? "12 Dock Street" : null},${team})`,
		);
		return id;
	};
	const guest = (meetingId, personId) =>
		admin.execute(
			sql`INSERT INTO participation(plant_id,meeting_id,person_id,roster_member,rsvp,presence) VALUES(${plant.id},${meetingId},${personId},false,'confirmed','absent')`,
		);
	const leadership = randomUUID();
	await admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order,template_key) VALUES(${leadership},${plant.id},'Leadership','active',99,'leadership')`,
	);
	const eldersRole = randomUUID();
	await admin.execute(
		sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order) VALUES(${eldersRole},${plant.id},${leadership},'Elder',true,1)`,
	);
	await admin.execute(
		sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${plant.id},${eldersRole},${maria.id},'2026-01-01')`,
	);
	const visionMeeting = await meeting("vision_meeting", { agenda: 6 });
	const emptyMeeting = await meeting("vision_meeting", { venue: false });
	const boardMeeting = await meeting("team_meeting", { agenda: 3, team: leadership });
	for (const m of [visionMeeting, boardMeeting]) await guest(m, maria.id);
	for (const name of ["Ada", "Ben"]) await guest(visionMeeting, (await person(`${name} Guest`)).id);

	// A private bucket on this machine: it answers the privacy check (GetBucketAcl), keeps the objects a brand asset
	// upload puts and records every call it gets. Signing an upload URL needs no other bucket call.
	const bucketCalls = [];
	const objects = new Map();
	bucket = httpServer(async (request, response) => {
		bucketCalls.push(`${request.method} ${request.url}`);
		const key = new URL(request.url, "http://bucket").pathname;
		if (request.method === "PUT") {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			objects.set(key, Buffer.concat(chunks));
			response.setHeader("etag", '"census"');
			return response.end();
		}
		if (request.method === "GET" && objects.has(key)) {
			response.setHeader("content-length", objects.get(key).length);
			return response.end(objects.get(key));
		}
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

	// WP-037/ui: one Church Document, so its page and the list read a fixed number of statements as revisions grow.
	const docActions = "apps/web/src/features/documents/actions.ts";
	const churchDoc = await act(null, "/documents", docActions, "createChurchDocument", [
		"member-expectations",
		{},
		randomUUID(),
	]);
	assert.equal(churchDoc.status, "ok", JSON.stringify(churchDoc));
	const churchId = churchDoc.value.id;

	const pages = [
		["GET /people", "/people", owner.cookie],
		["GET /people?view=pipeline", "/people?view=pipeline", owner.cookie],
		["GET /people (member)", "/people", member.cookie],
		["GET /people/[personId]", `/people/${maria.id}`, owner.cookie],
		["GET /tasks", "/tasks", owner.cookie],
		["GET /tasks?task=<follow-up>", `/tasks?task=${followUpId}`, owner.cookie],
		["GET /documents", "/documents", owner.cookie],
		["GET /documents/[documentId]", `/documents/${churchId}`, owner.cookie],
		["GET /documents/[documentId] (member)", `/documents/${churchId}`, member.cookie],
		["GET /meetings", "/meetings", owner.cookie],
		["GET /meetings/[meetingId]", `/meetings/${visionMeeting}`, owner.cookie],
		["GET /meetings/[meetingId] (leadership team meeting)", `/meetings/${boardMeeting}`, owner.cookie],
		["GET /meetings/[meetingId]/agenda", `/meetings/${visionMeeting}/agenda`, owner.cookie],
		[
			"GET /meetings/[meetingId]/agenda:no sections and nobody listed",
			`/meetings/${emptyMeeting}/agenda`,
			owner.cookie,
		],
		["GET /meetings/[meetingId]/agenda:leadership team meeting", `/meetings/${boardMeeting}/agenda`, owner.cookie],
		["GET /settings", "/settings", owner.cookie],
		["GET /settings/brand", "/settings/brand", owner.cookie],
		["GET /notifications", "/notifications", owner.cookie],
		["GET /notifications/read?what=count", "/notifications/read?what=count", owner.cookie],
		["GET /ministries", "/ministries", owner.cookie],
		["GET /ministries?view=chart", "/ministries?view=chart", owner.cookie],
		["GET /ministries/[teamId]", `/ministries/${ministry.id}`, owner.cookie],
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
	const emailed = await act("POST people.createPerson (with email)", "/people", people, "createPerson", [
		randomUUID(),
		{ displayName: "Reachable guest", email: "guest@example.com" },
	]);
	assert.equal(emailed.status, "ok", JSON.stringify(emailed));
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
	// The brand kit: the first save creates the kit (revision 0), so the request writes one row and its audit row.
	const brand = await act(
		"POST settings.brand.saveSettings",
		"/settings/brand",
		"apps/web/src/features/settings/brand/actions.ts",
		"saveBrand",
		[{ expectedRevision: "0", patch: { primaryColor: "#1F4E79" } }],
	);
	assert.equal(brand.status, "ok", JSON.stringify(brand));
	assert.equal(brand.value.revision, "1");

	// Brand assets (WP-104/ui slice 2): the upload request, the byte upload, finalize, the asset GET, suggest colors and
	// the removal of a slot. A 60 x 40 PNG whose 30 x 20 green logo has transparent margin. Each is one request.
	const brandActions = "apps/web/src/features/settings/brand/actions.ts";
	const chunk = (type, data) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), body.length + 4);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(60, 0);
	header.writeUInt32BE(40, 4);
	header.set([8, 6, 0, 0, 0], 8);
	const pixels = Buffer.alloc(40 * (1 + 60 * 4));
	for (let y = 10; y < 30; y++)
		for (let x = 15; x < 45; x++) pixels.set([0x2e, 0x7d, 0x32, 0xff], y * (1 + 60 * 4) + 1 + x * 4);
	const logo = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels)),
		chunk("IEND", Buffer.alloc(0)),
	]);
	const asset = (name, method, id, cookie, body) =>
		fetch(`${origin}/api/brand/assets/${id}`, {
			method,
			headers: {
				...(name ? { "x-evf-request": name } : {}),
				cookie,
				origin,
				...(body ? { "content-type": "image/png" } : {}),
			},
			body,
		});
	const ticket = await act("POST settings.brand.requestUpload", "/settings/brand", brandActions, "requestAssetUpload", [
		{ slot: "full_logo", mediaType: "image/png", byteLength: logo.length, altText: "Harvest Point logo" },
	]);
	assert.equal(ticket.status, "ok", JSON.stringify(ticket));
	const stored = await asset("PUT /api/brand/assets/[id]", "PUT", ticket.value.uploadId, owner.cookie, logo);
	assert.equal(stored.status, 204, await stored.text());
	const finalized = await act(
		"POST settings.brand.finalizeUpload",
		"/settings/brand",
		brandActions,
		"finalizeAssetUpload",
		[{ uploadId: ticket.value.uploadId, slot: "full_logo", altText: "Harvest Point logo", expectedRevision: "1" }],
	);
	assert.equal(finalized.status, "ok", JSON.stringify(finalized));
	assert.equal(finalized.value.revision, "2");
	const fileId = finalized.value.assets.full_logo.fileId;
	const served = await asset("GET /api/brand/assets/[id]", "GET", fileId, owner.cookie);
	assert.equal(served.status, 200);
	assert.equal(served.headers.get("cache-control"), "private, no-cache");
	assert.equal(served.headers.get("x-content-type-options"), "nosniff");
	assert.equal((await served.arrayBuffer()).byteLength > 0, true);
	const suggested = await act("POST settings.brand.suggestColors", "/settings/brand", brandActions, "suggestColors", [
		{ assetKind: "full_logo" },
	]);
	assert.equal(suggested.status, "ok", JSON.stringify(suggested));
	assert.equal(suggested.value.suggestedPrimary, "#2E7D32");
	// A Member gets nothing from any of them (setup requests, no budget).
	for (const [action, args] of [
		["requestAssetUpload", [{ slot: "mark", mediaType: "image/png", byteLength: logo.length, altText: "x" }]],
		["finalizeAssetUpload", [{ uploadId: ticket.value.uploadId, slot: "mark", altText: "x", expectedRevision: "2" }]],
		["suggestColors", [{ assetKind: "full_logo" }]],
		["saveBrand", [{ expectedRevision: "2", patch: { assets: { full_logo: null } } }]],
	]) {
		const refused = await act(null, "/settings/brand", brandActions, action, args, member.cookie);
		assert.deepEqual([refused.status, refused.error?.code], ["refused", "access_denied"], action);
	}
	assert.equal((await asset(null, "PUT", ticket.value.uploadId, member.cookie, logo)).status, 403);
	for (const cookie of [member.cookie, ""]) assert.equal((await asset(null, "GET", fileId, cookie)).status, 404);
	const removed = await act(
		"POST settings.brand.removeAsset",
		"/settings/brand",
		"apps/web/src/features/settings/brand/actions.ts",
		"saveBrand",
		[{ expectedRevision: "2", patch: { assets: { full_logo: null } } }],
	);
	assert.equal(removed.status, "ok", JSON.stringify(removed));
	assert.equal(removed.value.assets.full_logo, null);
	assert.equal((await asset(null, "GET", fileId, owner.cookie)).status, 404, "a removed file is not served");

	// More data than one screen shows: the same pages must send the same statements.
	for (let i = 0; i < 30; i++) await person(`Grown ${String(i).padStart(2, "0")}`);
	for (let i = 0; i < 5; i++) maria = await note(maria, `Grown note ${i}`);
	for (let i = 0; i < 30; i++) await task(`Grown task ${i}`);
	await notices(80);
	for (let i = 0; i < 30; i++) await teams(teamsWriter.create, { input: { name: `Grown ministry ${i}` } });
	for (let i = 0; i < 8; i++) await staff(`Grown role ${i}`);
	// The same agenda reads at the largest size: 40 sections and 100 people on the list (the page count must not move).
	for (const m of [visionMeeting, boardMeeting])
		await admin.execute(sql`UPDATE meeting SET agenda=${sections(40)}::jsonb WHERE id=${m}`);
	for (let i = 0; i < 100; i++) {
		const who = (await person(`Listed ${String(i).padStart(3, "0")}`)).id;
		await guest(visionMeeting, who);
		await guest(boardMeeting, who);
	}
	// The Church Document grows: more revisions, each one saved through the screen's own action.
	let churchRevision = "1";
	for (let i = 0; i < 6; i++) {
		const saved = await act(
			i === 0 ? "POST documents.saveChurchDocument" : null,
			`/documents/${churchId}`,
			docActions,
			"saveChurchDocument",
			[churchId, churchRevision, [{ kind: "paragraph", text: `Grown text ${i}` }]],
		);
		assert.equal(saved.status, "ok", JSON.stringify(saved));
		churchRevision = saved.value.document.revision;
		// A save answers with what it changed: the document and its one new revision, never the page.
		assert.deepEqual(Object.keys(saved.value).sort(), ["document", "revision"]);
		assert.equal(saved.value.revision.number, Number(churchRevision));
		assert.equal(saved.value.revision.id, saved.value.document.revisionId);
	}
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
