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
import { testDatabase } from "../../support/test-database.mts";
import { sql } from "../../../packages/db/src/query.ts";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { BODY_JSON_MAX } from "../../../packages/contracts/src/documents/body.ts";
import { nativeFromText } from "../../../packages/contracts/src/documents/native.ts";
import { IMPORT_BYTES_MAX, IMPORT_TOO_LARGE } from "../../../packages/contracts/src/documents/values.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { teamsWriter } from "../../../packages/domain/src/teams/index.ts";
import { CATALOG } from "../../../packages/domain/src/tasks/catalog.ts";
import { p as wordParagraph, storedZip } from "../documents/fixtures/word.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = root + "apps/web/";
const output = process.env.EVF_WRITE_COUNTS;
assert.ok(output, "Set EVF_WRITE_COUNTS");
assert.ok(
	existsSync(web + ".next/BUILD_ID"),
	"No production build in apps/web/.next. Run `corepack pnpm build` first.",
);

const port = await new Promise((resolve) => {
	const probe = createServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address();
		probe.close(() => resolve(port));
	});
});
const origin = `http://127.0.0.1:${port}`;
const database = await testDatabase({ prefix: "wp011rq", roles: { runtime: ["runtime"], auth: ["auth"] }, max: 2 });
const { admin } = database,
	{ runtime, auth: authDb } = database.pools;
const login = (role) => database.logins[role].url.href;
let server, bucket;
try {
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
	// T-141: a seatless resident with a residency at a sending church (REQ-MUL-003); the plant connects with each church.
	const resident = await account("Resident");
	const sendingChurch = async (name) => {
		const id = randomUUID(),
			person = randomUUID(),
			invitation = randomUUID();
		await admin.execute(
			sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${id},'sending_church',${name},'America/Chicago',1)`,
		);
		await admin.execute(
			sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings) VALUES(${plant.id},${id},clock_timestamp(),true,true,false,false,true,false,false)`,
		);
		const [{ id: link }] = (
			await admin.execute(
				sql`INSERT INTO affiliation(account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings) VALUES(${resident.accountId},${id},clock_timestamp(),false,false,false,false,false,false,false) RETURNING id`,
			)
		).rows;
		await admin.execute(
			sql`INSERT INTO person(id,tenant_id,organization_id,display_name,source,state,linked_account_id,created_at,revision) VALUES(${person},${id},${id},'Resident','other','live',${resident.accountId},clock_timestamp(),1)`,
		);
		await admin.execute(
			sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,accepted_account_id,resident_person_id) VALUES(${invitation},${id},'residency_link','resident@requests.example.test',${randomUUID()},'accepted',clock_timestamp(),${resident.accountId},${person})`,
		);
		await admin.execute(
			sql`INSERT INTO residency_link(id,organization_id,person_id,account_id,affiliation_id,invitation_id,accepted_at,consent_revision,revision,share_foundations,share_milestones) VALUES(${randomUUID()},${id},${person},${resident.accountId},${link},${invitation},clock_timestamp(),1,1,true,false)`,
		);
	};
	await sendingChurch("Harbor Sending Church");
	// WP-036: Church Documents made from a built-in template, through the producer the New from template action calls.
	const churchDocument = async (templateId) => {
		const actor = await RequestActor.resolve(runtime, owner.sessionId);
		const r = await documentsWriter.createFromTemplate(runtime, actor, { templateId, requestKey: randomUUID() });
		assert.equal(r.status, "ok", JSON.stringify(r));
		return r.value.id;
	};
	const policyDocument = await churchDocument("conflict-of-interest-policy");
	// OPS-87: a plain native document of the church plant, saved through the producer the native page's Save calls.
	const saveWritten = async (body, documentId, expectedRevision = "0") => {
		const actor = await RequestActor.resolve(runtime, owner.sessionId);
		const r = await documentsWriter.saveNative(runtime, actor, {
			title: "Welcome",
			body,
			documentId,
			expectedRevision,
		});
		assert.equal(r.status, "ok", JSON.stringify(r));
		return r.value;
	};
	const writtenDocument = await saveWritten(nativeFromText("Welcome to the church plant."));
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
				IDENTITY_DATABASE_URL: login("runtime"),
				IDENTITY_AUTH_DATABASE_URL: login("auth"),
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
	const get = async (name, path, cookie, status = 200) => {
		const r = await fetch(origin + path, { headers: { "x-evf-request": name, cookie }, redirect: "manual" });
		await r.text();
		assert.equal(r.status, status, `${name}: HTTP ${r.status}`);
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
		["GET /tasks?task=<follow-up>", `/tasks?task=${followUpId}`, owner.cookie],
		["GET /documents", "/documents", owner.cookie],
		["GET /documents/church", "/documents/church", owner.cookie],
		["GET /documents/church (member)", "/documents/church", member.cookie],
		["GET /documents/church/[documentId]", `/documents/church/${policyDocument}`, owner.cookie],
		["GET /documents/church/[documentId]/file", `/documents/church/${policyDocument}/file?format=pdf`, member.cookie],
		["GET /documents/written/[documentId]", `/documents/written/${writtenDocument.id}`, owner.cookie],
		["GET /documents/written/[documentId] (member)", `/documents/written/${writtenDocument.id}`, member.cookie],
		// The landing route answers with a redirect.
		["GET /home", "/home", owner.cookie, 307],
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
		// T-141: 2 statements, the session and one residency read with each link's consent; 61845391 sent 4 (the session,
		// residencyLinks twice and subjectFacts). The plant's page sends 9 on both.
		["GET /settings/sharing", "/settings/sharing", resident.cookie],
		["GET /settings/sharing (plant)", "/settings/sharing", owner.cookie],
		["GET /notifications", "/notifications", owner.cookie],
		["GET /notifications/read?what=count", "/notifications/read?what=count", owner.cookie],
		["GET /ministries", "/ministries", owner.cookie],
		["GET /ministries?view=chart", "/ministries?view=chart", owner.cookie],
		["GET /ministries/[teamId]", `/ministries/${ministry.id}`, owner.cookie],
		["GET /intelligence", "/intelligence", owner.cookie],
		["GET /intelligence/attestations", "/intelligence/attestations", owner.cookie],
		["GET /intelligence/attestations (member)", "/intelligence/attestations", member.cookie],
		["GET /me/check-in", "/me/check-in", owner.cookie],
		["GET /me/check-in (member)", "/me/check-in", member.cookie],
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
	for (const [name, path, cookie, status] of pages) await get(name, path, cookie, status);
	// The resident's budget is the page with its residency card, not the refusal a seatless account without one gets.
	const sharingPage = await fetch(origin + "/settings/sharing", { headers: { cookie: resident.cookie } }).then((r) =>
		r.text(),
	);
	assert.match(sharingPage, /Residency with <!-- -->Harbor Sending Church|Residency with Harbor Sending Church/);

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
	const asset = (name, method, id, cookie, body, extra = {}) =>
		fetch(`${origin}/api/brand/assets/${id}`, {
			method,
			headers: {
				...(name ? { "x-evf-request": name } : {}),
				cookie,
				origin,
				...(body ? { "content-type": "image/png" } : {}),
				...extra,
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
	// INV-brand-asset-route: a 304 revalidation rechecks the seat and the kit's current reference (setup requests).
	const etag = served.headers.get("etag");
	assert.equal(served.headers.get("content-type"), "image/png");
	assert.match(etag, /^"[0-9a-f]{32}"$/);
	const revalidate = async (cookie) => {
		const r = await asset(null, "GET", fileId, cookie, undefined, { "if-none-match": etag });
		return [r.status, (await r.arrayBuffer()).byteLength];
	};
	assert.deepEqual(await revalidate(owner.cookie), [304, 0]);
	for (const cookie of [member.cookie, ""]) assert.deepEqual(await revalidate(cookie), [404, 0]);
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
	assert.deepEqual(await revalidate(owner.cookie), [404, 0], "a removed file does not revalidate");

	// The phase journey (WP-038): a declaration, then a backward move with its reason. Each is one write request.
	const phases = "apps/web/src/features/phases/actions.ts";
	const plantRevision = async () =>
		(await admin.execute(sql`SELECT revision::text AS r FROM plant WHERE id=${plant.id}`)).rows[0].r;
	const declared = await act("POST phases.declarePhase", "/intelligence", phases, "declarePhase", [
		randomUUID(),
		await plantRevision(),
		3,
	]);
	assert.equal(declared.status, "ok", JSON.stringify(declared));
	const movedBack = await act("POST phases.movePhase", "/intelligence", phases, "movePhase", [
		randomUUID(),
		declared.value.state.revision,
		2,
		"Back to forming the launch team",
	]);
	assert.equal(movedBack.status, "ok", JSON.stringify(movedBack));

	// The private check-in (WP-039): this week's save, a correction and an older history page. Each is one request.
	await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${owner.accountId}`);
	const care = "apps/web/src/features/intelligence/actions.ts";
	const steady = { spiritual: "steady", family: "steady", financial: "steady", pace: "steady" };
	const checkedIn = await act("POST intelligence.saveCheckIn", "/me/check-in", care, "saveCheckIn", [
		randomUUID(),
		"0",
		steady,
		"Rested this week",
	]);
	assert.equal(checkedIn.status, "ok", JSON.stringify(checkedIn));
	let careRevision = checkedIn.value.revision;
	const corrected = await act("POST intelligence.correctCheckIn", "/me/check-in", care, "correctCheckIn", [
		randomUUID(),
		careRevision,
		checkedIn.value.week.id,
		{ ...steady, pace: "strained" },
		"",
	]);
	assert.equal(corrected.status, "ok", JSON.stringify(corrected));
	careRevision = corrected.value.revision;
	const olderWeeks = await act("POST intelligence.readCheckInHistory", "/me/check-in", care, "readCheckInHistory", [2]);
	assert.equal(olderWeeks.status, "ok", JSON.stringify(olderWeeks));

	// Manual signals and leadership candidates (WP-039 slice 2): each write is one request.
	const sigs = "apps/web/src/features/intelligence/signals-actions.ts";
	const answered = await act("POST intelligence.attestSignal", "/intelligence/attestations", sigs, "attestSignal", [
		randomUUID(),
		"0",
		{ key: "prayer_rhythm_established", value: "yes", detail: "Weekly" },
	]);
	assert.equal(answered.status, "ok", JSON.stringify(answered));
	const renewed = await act("POST intelligence.reaffirmSignal", "/intelligence/attestations", sigs, "reaffirmSignal", [
		randomUUID(),
		answered.value.signal.revision,
		{ key: "prayer_rhythm_established", expectedValue: "yes" },
	]);
	assert.equal(renewed.status, "ok", JSON.stringify(renewed));
	const fixed = await act("POST intelligence.correctSignal", "/intelligence/attestations", sigs, "correctSignal", [
		randomUUID(),
		renewed.value.signal.revision,
		{ action: "correct", key: "prayer_rhythm_established", value: "not_yet" },
	]);
	assert.equal(fixed.status, "ok", JSON.stringify(fixed));
	const candidate = await person("Candidate Person");
	const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
	const recorded = await act(
		"POST intelligence.attestCandidate",
		"/intelligence/attestations",
		sigs,
		"attestCandidate",
		[
			randomUUID(),
			"0",
			{ personId: candidate.id, periodStart: day(70), periodEnd: day(2), attended: true, volunteered: true },
		],
	);
	assert.equal(recorded.status, "ok", JSON.stringify(recorded));
	const retracted = await act(
		"POST intelligence.correctCandidate",
		"/intelligence/attestations",
		sigs,
		"correctCandidate",
		[randomUUID(), recorded.value.candidate.revision, { action: "retract", personId: candidate.id }],
	);
	assert.equal(retracted.status, "ok", JSON.stringify(retracted));

	// T-120, kept by T-237 and moved here from the browser suite by T-259: the host's two document limits
	// (apps/web/next.config.ts), which only a running server shows. Setup requests: they carry no budget.
	//  - A Word import of exactly IMPORT_BYTES_MAX passes the proxy (proxyClientMaxBodySize) and the import route whole and
	//    lands as the document's first revision; a file one byte over gets the stated limit, not a dropped connection,
	//    with a length header and without one (the route counts the bytes as they arrive, before it reads anything else).
	//  - A written-document save and a Church Document save whose body JSON is near BODY_JSON_MAX (over 3 MB of UTF-8)
	//    pass the server-action limit (serverActions.bodySizeLimit) and are stored whole.
	async function documentHostLimits() {
		/** A Word file of exactly `size` bytes: one paragraph of text and a picture part that pads it to that size. */
		const wordFile = (size, line) => {
			const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${wordParagraph(line)}</w:body></w:document>`;
			const build = (padding) =>
				storedZip([
					{ name: "word/document.xml", data: xml },
					{ name: "word/media/image1.png", data: randomBytes(padding) },
				]);
			const bytes = build(size - build(0).length);
			assert.equal(bytes.length, size);
			return bytes;
		};
		/** Posts the file to the import route as the editor does, signed in as the Owner. */
		const importFile = async (body, title, extra = {}) => {
			const query = new URLSearchParams({ title, format: "docx", expectedRevision: "0", requestKey: randomUUID() });
			const r = await fetch(`${origin}/documents/written/import?${query}`, {
				method: "POST",
				headers: {
					"content-type": "application/octet-stream",
					cookie: owner.cookie,
					origin,
					"sec-fetch-site": "same-origin",
				},
				body,
				...extra,
			});
			assert.equal(r.status, 200, `import ${title}: HTTP ${r.status}`);
			return r.json();
		};
		const tooLarge = { status: "refused", code: "invalid_input", problem: "The file must be 10 MB or smaller." };
		assert.equal(IMPORT_TOO_LARGE, tooLarge.problem);
		// The route counts the bytes before anything reads the request: with an empty title too, the answer is the size
		// limit. The domain refuses an oversized file as well, but it states the title's problem first.
		const over = wordFile(IMPORT_BYTES_MAX + 1, "Just over");
		assert.deepEqual(await importFile(over, ""), tooLarge, "a length header just over the limit");
		const streamed = new ReadableStream({
			start(controller) {
				for (let at = 0; at < over.length; at += 1024 * 1024) controller.enqueue(over.subarray(at, at + 1024 * 1024));
				controller.close();
			},
		});
		assert.deepEqual(await importFile(streamed, "", { duplex: "half" }), tooLarge, "no length header");
		const marker = `Exactly ten ${randomUUID()}`;
		const exact = await importFile(wordFile(IMPORT_BYTES_MAX, marker), "Exactly the limit");
		assert.equal(exact.status, "ok", JSON.stringify(exact));
		assert.equal(exact.value.revision, "1");
		assert.equal(exact.value.title, "Exactly the limit");
		assert.match(JSON.stringify(exact.value.body), new RegExp(marker));

		/** The stored body of a document's latest revision, read again from the database. */
		const storedBody = async (documentId) =>
			JSON.parse(
				(
					await admin.execute(
						sql`SELECT r.body FROM document d JOIN document_revision r ON r.id=d.current_revision_id WHERE d.id=${documentId}::uuid`,
					)
				).rows[0].body,
			);
		/** Paragraphs of "€" (3 UTF-8 bytes each, under the block text limit) to add `room` characters of JSON. */
		const euros = (room) => {
			const paragraph = { type: "paragraph", content: [{ type: "text", text: "€".repeat(19_000) }] };
			return Array.from({ length: Math.floor(room / JSON.stringify(paragraph).length) }, () => paragraph);
		};
		const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));

		const start = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Start." }] }] };
		const writtenBody = { ...start, content: [...start.content, ...euros(BODY_JSON_MAX - 40_000)] };
		const writtenLength = JSON.stringify(writtenBody).length;
		assert.ok(writtenLength > 1_900_000 && writtenLength < BODY_JSON_MAX, `written body is ${writtenLength}`);
		assert.ok(bytesOf(writtenBody) > 3_000_000, "the written save is over 3 MB on the wire");
		const written = await act(
			null,
			"/documents/written/new",
			"apps/web/src/features/documents/actions.ts",
			"saveOwnedDocument",
			[{ title: "Near the body limit", body: writtenBody, expectedRevision: "0" }],
		);
		assert.equal(written.status, "ok", JSON.stringify(written).slice(0, 500));
		assert.equal(JSON.stringify(await storedBody(written.value.id)).length, writtenLength);

		const church = await churchDocument("commitment-card");
		const base = await storedBody(church);
		// The saved document holds its page setup and exports beside the body, so the fill leaves room for them.
		const churchBody = {
			...base,
			body: {
				...base.body,
				content: [...base.body.content, ...euros(BODY_JSON_MAX - 60_000 - JSON.stringify(base).length)],
			},
		};
		const churchLength = JSON.stringify(churchBody).length;
		assert.ok(churchLength > 1_900_000, `Church body is ${churchLength}`);
		assert.ok(bytesOf(churchBody) > 3_000_000, "the Church save is over 3 MB on the wire");
		const [{ revision: churchRevision }] = (
			await admin.execute(sql`SELECT revision::text AS revision FROM document WHERE id=${church}::uuid`)
		).rows;
		const savedChurch = await act(
			null,
			`/documents/church/${church}`,
			"apps/web/src/features/documents/church/actions.ts",
			"saveChurchDocument",
			[church, churchRevision, churchBody],
		);
		assert.equal(savedChurch.status, "saved", JSON.stringify(savedChurch).slice(0, 500));
		assert.equal(JSON.stringify(await storedBody(church)).length, churchLength);
	}
	await documentHostLimits();

	// More data than one screen shows: the same pages must send the same statements.
	for (let i = 0; i < 12; i++)
		assert.equal(
			(
				await act(null, "/intelligence", phases, "movePhase", [
					randomUUID(),
					await plantRevision(),
					i % 2 ? 2 : 1,
					`Grown move ${i}`,
				])
			).status,
			"ok",
		);
	for (let i = 0; i < 12; i++) {
		const grown = await act(null, "/me/check-in", care, "saveCheckIn", [
			randomUUID(),
			careRevision,
			{ ...steady, pace: i % 2 ? "steady" : "struggling" },
			`Grown note ${i}`,
		]);
		assert.equal(grown.status, "ok", JSON.stringify(grown));
		careRevision = grown.value.revision;
	}
	for (let i = 0; i < 30; i++) await person(`Grown ${String(i).padStart(2, "0")}`);
	for (let i = 0; i < 5; i++) maria = await note(maria, `Grown note ${i}`);
	for (let i = 0; i < 30; i++) await task(`Grown task ${i}`);
	await notices(80);
	for (let i = 0; i < 30; i++) await teams(teamsWriter.create, { input: { name: `Grown ministry ${i}` } });
	for (let i = 0; i < 8; i++) await staff(`Grown role ${i}`);
	// The ministry page lists its team meetings in one read: a dozen of them send the same statement count (WP-017).
	for (let i = 0; i < 12; i++) await meeting("team_meeting", { team: ministry.id });
	for (const id of ["budget-worksheet", "commitment-card", "guest-sign-in-sheet"])
		for (let i = 0; i < 4; i++) await churchDocument(id);
	// The same agenda reads at the largest size: 40 sections and 100 people on the list (the page count must not move).
	for (const m of [visionMeeting, boardMeeting])
		await admin.execute(sql`UPDATE meeting SET agenda=${sections(40)}::jsonb WHERE id=${m}`);
	for (let i = 0; i < 100; i++) {
		const who = (await person(`Listed ${String(i).padStart(3, "0")}`)).id;
		await guest(visionMeeting, who);
		await guest(boardMeeting, who);
	}
	// Phase checklists (WP-026). The last move offers Phase 2's checklists: the Tasks page with an open offer is its own
	// variant, read before and after an import grows the list. Accepting answers it; a move back to Phase 1 is declined,
	// and the move to Phase 2 again offers nothing, so the second "GET /tasks" read shows no offer, as the first did.
	const tasks = "apps/web/src/features/tasks/actions.ts";
	const latestMove = async () =>
		(
			await admin.execute(sql`SELECT id FROM phase_transition WHERE plant_id=${plant.id} AND kind='movement'
				ORDER BY occurred_at DESC, id DESC LIMIT 1`)
		).rows[0].id;
	const checklist = CATALOG.checklists.find((k) => k.key === "vision-meeting-preparation");
	await get("GET /tasks (phase offer)", "/tasks", owner.cookie);
	const imported = await act("POST tasks.importTemplate", "/tasks", tasks, "importTemplate", [
		randomUUID(),
		{ catalogVersion: CATALOG.version, checklistKey: checklist.key, itemKeys: checklist.items.map((i) => i.key) },
	]);
	assert.equal(imported.status, "ok", JSON.stringify(imported));
	await get("GET /tasks (phase offer)", "/tasks", owner.cookie);
	const accepted = await act("POST tasks.acceptPhaseOffer", "/tasks", tasks, "answerOffer", [
		randomUUID(),
		{ transitionId: await latestMove(), catalogVersion: CATALOG.version, checklistKeys: ["launch-date-planning"] },
	]);
	assert.equal(accepted.status, "ok", JSON.stringify(accepted));
	for (const [toPhase, answer] of [
		[1, "POST tasks.declinePhaseOffer"],
		[2, null],
	]) {
		const moved = await act(null, "/intelligence", phases, "movePhase", [
			randomUUID(),
			await plantRevision(),
			toPhase,
			`Checklist move ${toPhase}`,
		]);
		assert.equal(moved.status, "ok", JSON.stringify(moved));
		if (!answer) continue;
		const declined = await act(answer, "/tasks", tasks, "answerOffer", [
			randomUUID(),
			{ transitionId: await latestMove(), catalogVersion: CATALOG.version, checklistKeys: [] },
		]);
		assert.equal(declined.status, "ok", JSON.stringify(declined));
	}
	// A second residency and connection before the second read: the sharing page's count stays the same.
	await sendingChurch("Cedar Sending Church");
	// The native page's body grows to many blocks before the second read: its count stays the same.
	await saveWritten(
		nativeFromText(Array.from({ length: 400 }, (_, i) => `Line ${i + 1}`).join("\n")),
		writtenDocument.id,
		writtenDocument.revision,
	);
	for (const [name, path, cookie, status] of pages) await get(name, path, cookie, status);

	server.kill("SIGTERM");
	await exited;
} finally {
	if (server?.exitCode === null) server.kill("SIGKILL");
	bucket?.close();
	await database.close();
}
