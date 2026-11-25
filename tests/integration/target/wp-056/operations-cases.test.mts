import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import { gunzipSync } from "node:zlib";
import { GET as health } from "../../../../apps/web/src/app/api/health/route.ts";
import { taskReminders } from "../../../../apps/web/src/features/tasks/reminders.ts";
import { requestDatabase } from "../../../../apps/web/src/server/database.ts";
import { INVITATION_MAIL } from "../../../../apps/web/src/server/invitations/index.ts";
import { scheduledJobs } from "../../../../apps/web/src/server/jobs/scheduled.ts";
import { loggedRoute, safeBoundary, safeResponse } from "../../../../apps/web/src/server/platform/boundary.ts";
import { cronRoute } from "../../../../apps/web/src/server/platform/cron.ts";
import { nativeFromText } from "../../../../packages/contracts/src/documents/native.ts";
import { closeDatabase, createDatabase } from "../../../../packages/db/src/client.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { migrate } from "../../../../packages/db/src/schema/migrate.ts";
import { RequestActor, type WriteTx } from "../../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { authorizeDigestMail, createDigestWorker } from "../../../../packages/domain/src/jobs/digest.ts";
import { createMailService, runDueMail } from "../../../../packages/domain/src/jobs/mail.ts";
import { runDueObjectCleanup } from "../../../../packages/domain/src/jobs/object-cleanup.ts";
import { checkpoint, claimDue, finishClaim, finishJob } from "../../../../packages/domain/src/jobs/queue.ts";
import { seatedNotificationService } from "../../../../packages/domain/src/jobs/seated-notifications.ts";
import { transaction } from "../../../../packages/domain/src/jobs/transaction.ts";
import { createAttendanceWriter, withMeetingsWrite } from "../../../../packages/domain/src/meetings/index.ts";
import {
	personFields,
	readPersonPhoto,
	uploadPersonPhoto,
	withPeopleWrite,
} from "../../../../packages/domain/src/people/index.ts";
import { authorizeTaskReminders } from "../../../../packages/domain/src/tasks/index.ts";
import { flushTraces, registerTracing, traceTurn } from "../../../../packages/evry/src/runtime/trace.ts";
import { readiness } from "../../../../ops/maintenance/readiness.mts";
import { fixture, ok, refused, type Actor } from "../../../support/fixture.mts";
import { failingWrite, NOTHING, recorded, touched, untouched } from "../../../support/recorded.mts";
import { setServerEnv } from "../../../support/server-env.mts";
import { MemoryClient } from "../../documents/storage.mts";
import { fixture as invitationFixture } from "../../identity/invitations-support.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { arguments: Record<string, string> };
	expected: { result: Record<string, unknown>; event: null | [] };
	subcases?: (Pick<Case, "given" | "expected"> & { name: string })[];
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/operations.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const given = (c: Pick<Case, "given">, name: string) => c.given[name] ?? assert.fail(`no fixture ${name}`);
const str = (value: unknown) => (typeof value === "string" ? value : assert.fail(JSON.stringify(value)));

const database = await fixture({ prefix: "opscases", plant: { name: "Harvest Point" } });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant;
const A = database.actors.admin;
const Q = await database.plant({ name: "Grace Hill", timezone: "America/New_York" });
const B = await database.actor(Q, "admin");
const client = new MemoryClient();
const storage = { bucket: "private-production", client };
after(() => database.close());
const rowsOf = async (query: SQL, pool = admin) => (await pool.execute(query)).rows;
const one = async (query: SQL, pool = admin) => (await rowsOf(query, pool))[0] ?? assert.fail("no row");
const actorOf = async (who: Actor, pool = db) => {
	const actor = await RequestActor.resolve(pool, who.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const code = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code;

async function person(name: string, plant = P.id, stage = "prospect") {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) VALUES(${id},${plant},${plant},${name},'other',${stage},'unknown',
		'unknown',0,'live',clock_timestamp())`);
	return id;
}
async function stored(purpose: string, bytes: Buffer, tenant = P.id) {
	const id = randomUUID(),
		key = `private/${tenant}/${randomUUID()}`;
	await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,
		upload_key,claim_generation) VALUES(${id},${tenant},${purpose},${key},'image/png',8388608,${bytes.length},
		${createHash("sha256").update(bytes).digest("hex")},'ready',${"stored-" + id},0)`);
	client.objects.set(key, bytes);
	return { id, key };
}
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);
const people = { session: A.session, selected: P };
const foreign = { session: B.session, selected: Q };
const writePeople = async <T,>(
	body: (tx: WriteTx, ctx: Parameters<Parameters<typeof withPeopleWrite>[2]>[1]) => Promise<T>,
) => withPeopleWrite(db, await actorOf(A), body as never) as Promise<T>;
async function photo(personId: string) {
	const { uploadId } = ok(
		await writePeople((tx, ctx) =>
			personFields.requestPersonPhotoUpload(tx, ctx, {
				requestKey: randomUUID(),
				personId,
				mime: "image/png",
				byteLength: PNG.length,
			}),
		),
	);
	ok(await uploadPersonPhoto(db, storage, people as never, { uploadId, bytes: PNG }));
	return uploadId;
}
const setPhoto = async (personId: string, uploadId: string, requestKey: string, expectedRevision?: string) => {
	const revision =
		expectedRevision ?? str((await one(sql`SELECT revision::text AS r FROM person WHERE id=${personId}`)).r);
	return writePeople((tx, ctx) =>
		personFields.setPersonPhoto(tx, ctx, {
			requestKey,
			expectedRevision: revision,
			input: { personId, uploadId },
		}),
	);
};

async function capturedErrors<T>(body: () => Promise<T>) {
	const lines: string[] = [];
	const { error, log } = console;
	console.error = console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
	try {
		return { value: await body(), lines };
	} finally {
		Object.assign(console, { error, log });
	}
}

const mailConfig = (f: { db: typeof db }, authorize: typeof authorizeDigestMail, keys: string[]) =>
	createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "digests@example.test",
		authorize,
		unsubscribe: { origin: "https://everyfield.test", keys: { current: randomBytes(32) } },
		transport: {
			async send(_payload, key) {
				keys.push(key);
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});

test("AC:CASE-OPS-001 under a mail backlog, overlapping ticks stay bounded, keep another church's owed digest, send nothing twice and fence a stopped worker", async (t) => {
	const c = caseOf("CASE-OPS-001");
	const { result } = c.expected;
	const ticks = Number(given(c, "case-input").concurrent_ticks);
	const BACKLOG = 45;
	const f = await invitationFixture();
	t.after(() => f.close());
	const backlog = await f.setup("plant");
	await f.admin.execute(sql`UPDATE plant SET digest_cadence='off' WHERE id=${backlog.w.id}`);
	const inviter = await f.actor(backlog.sender.session);
	for (let n = 0; n < BACKLOG; n++)
		await f.invitations.invite(inviter, {
			requestKey: randomUUID(),
			expectedRevision: "1",
			input: { workspace: backlog.w, role: "member", recipientEmail: `guest-${n}@example.test` },
		});
	const owed = await f.setup("plant");
	await f.admin.execute(sql`UPDATE plant SET digest_cadence='weekly',digest_weekday=1,digest_hour=8,
		timezone='America/New_York' WHERE id=${owed.w.id}`);
	await f.admin.execute(sql`UPDATE seat SET role='admin' WHERE account_id=${owed.sender.id}`);
	await f.admin
		.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,cadence,unsubscribe_revision)
		VALUES (${owed.sender.id},'planter_digest','email',true,'weekly',1),(${owed.sender.id},'planter_digest','in_app',true,'weekly',1)`);
	const task = randomUUID();
	await f.admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date)
		VALUES(${task},${owed.w.id},'Book the venue','general','medium','not_started',now(),'date_only','2026-10-14'::date)`);
	await f.admin.execute(
		sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${owed.w.id},${task},${owed.sender.id})`,
	);
	await f.admin.execute(sql`INSERT INTO digest_coverage(tenant_id,recipient_id,purpose,cadence,timezone,covered_through)
		VALUES(${owed.w.id},${owed.sender.id},'planter','weekly','America/New_York','2026-10-05')`);

	const digestKeys: string[] = [];
	const digestMail = mailConfig(f, authorizeDigestMail, digestKeys);
	const secret = "cron-" + randomUUID();
	const tick = cronRoute(
		secret,
		scheduledJobs({
			db: f.db,
			storage,
			cleanup: null,
			effects: null,
			digests: createDigestWorker({ mail: digestMail, origin: "https://everyfield.test" }),
			mail: (limit, until) => runDueMail(f.db, f.mail, INVITATION_MAIL, limit, until),
			mountMail: {
				digest: (limit, until) => runDueMail(f.db, digestMail, ["digest/"], limit, until),
			},
			now: () => new Date(c.clock.now),
		}),
	);
	const call = (authorization: string) =>
		tick(new Request("https://everyfield.test/api/cron/jobs", { headers: { authorization } }));
	const run = async () => {
		const response = await call(`Bearer ${secret}`);
		const body = (await response.json()) as { failed: string[]; mailed: number; digests: number };
		assert.deepEqual([response.status, body.failed], [200, []]);
		return body;
	};
	const overlapping = () => Promise.all(Array.from({ length: ticks }, run));
	const cursor = async () =>
		(await one(sql`SELECT covered_through::text AS c FROM digest_coverage WHERE tenant_id=${owed.w.id}`, f.admin)).c;
	const digestJob = async () =>
		one(
			sql`SELECT id,state,claim_generation::text AS generation FROM job WHERE kind='digest' AND tenant_id=${owed.w.id}`,
			f.admin,
		);
	const invited = async () => ({
		sent: f.effects.filter((e) => e.key && /guest-/.test(e.to)).length,
		keys: new Set(f.effects.map((e) => e.key)).size,
		ready: (
			await one(
				sql`SELECT count(*)::int AS n FROM job WHERE kind='mail' AND tenant_id=${backlog.w.id} AND state='ready'`,
				f.admin,
			)
		).n,
	});
	const notices = async () =>
		(
			await one(
				sql`SELECT count(*)::int AS n FROM notice WHERE recipient_id=${owed.sender.id} AND purpose='planter_digest'`,
				f.admin,
			)
		).n;

	await untouched(f.admin, async () => {
		assert.equal((await call(`Bearer ${secret}x`)).status, 401);
		assert.equal((await call(secret)).status, 401);
	});
	const events = async () =>
		rowsOf(
			sql`SELECT action,count(*)::int AS n FROM audit_event WHERE action NOT IN ('invitation.changed','mail.accepted') GROUP BY action`,
			f.admin,
		);
	const accepted = async () =>
		(await one(sql`SELECT count(*)::int AS n FROM audit_event WHERE action='mail.accepted'`, f.admin)).n;
	assert.deepEqual([await events(), await accepted()], [[], 0]);

	await f.admin
		.execute(sql`INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
		VALUES(${owed.w.id},'digest',${owed.sender.id},${`digest/planter/${owed.w.id}/2026-10-12`},'ready',clock_timestamp(),0,4,0)`);
	const [previous] = await claimDue(f.db, ["digest"]);
	assert.ok(previous, "the previous worker holds the owed digest");
	await f.admin.execute(sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${previous.id}`);

	const first = await overlapping();
	assert.deepEqual(
		first.map((b) => b.mailed),
		Array(ticks).fill(20),
	);
	assert.deepEqual(await invited(), { sent: 40, keys: 40, ready: BACKLOG - 40 });
	const held = await digestJob();
	assert.deepEqual([held.id, held.state], [previous.id, "retry_wait"]);
	assert.equal(BigInt(str(held.generation)) > BigInt(previous.claim_generation), true);
	assert.equal((await cursor()) === "2026-10-05", result.Q_due_cursor_retained);
	assert.equal(await notices(), 0);

	const stale = async () => [
		await finishJob(f.db, previous, { state: "succeeded" }),
		await transaction(f.db, (tx) => finishClaim(tx, previous, { state: "succeeded" })),
		await transaction(f.db, (tx) => checkpoint(tx, previous, "late-output")),
	];
	assert.equal((await stale()).some(Boolean), result.stale_generation_finalized);
	await f.admin.execute(sql`UPDATE job SET next_attempt_at=NULL,eligible_at=clock_timestamp()-interval '1 second'
		WHERE id=${previous.id}`);
	const [current] = await claimDue(f.db, ["digest"]);
	assert.equal(current?.id, previous.id);
	assert.equal((await stale()).some(Boolean), result.stale_generation_finalized);
	assert.equal((await digestJob()).state, "claimed");
	assert.equal(await finishJob(f.db, current!, { state: "retry_wait", code: "digest_failed" }), true);
	await f.admin.execute(sql`UPDATE job SET next_attempt_at=NULL WHERE id=${previous.id}`);

	const second = await overlapping();
	assert.equal(
		second.reduce((n, b) => n + b.mailed, 0),
		BACKLOG - 40,
	);
	assert.equal(
		second.reduce((n, b) => n + b.digests, 0),
		1,
	);
	const ended = await invited();
	assert.deepEqual(ended, { sent: BACKLOG, keys: BACKLOG, ready: 0 });
	assert.deepEqual([await cursor(), await notices()], ["2026-10-12", 1]);
	await run();
	assert.equal(digestKeys.length, 1);
	assert.equal(
		ended.sent < BACKLOG || (await notices()) !== 1 || (await cursor()) !== "2026-10-12",
		result.owed_work_dropped,
	);
	assert.deepEqual(await invited(), ended);
	assert.equal((await digestJob()).state, "succeeded");
	assert.equal((await stale()).some(Boolean), result.stale_generation_finalized);
	assert.equal((await events()).length === 0 ? null : "event", c.expected.event);
	assert.equal(await accepted(), BACKLOG + 1);
});

test("AC:CASE-OPS-002 with the database down, public liveness answers only status and time, the privileged run is not ready, and no reply or log holds the secret", async (t) => {
	const c = caseOf("CASE-OPS-002");
	const { result } = c.expected;
	const secret = str(given(c, "behavior-inputs").secret);
	const down = `postgres://runtime:${secret}@127.0.0.1:1/everyfield`;
	setServerEnv({ IDENTITY_DATABASE_URL: down, IDENTITY_AUTH_DATABASE_URL: down });
	const dead = createDatabase({ connectionString: down, max: 1 });
	t.after(() => closeDatabase(dead));
	const cron = "cron-" + randomUUID();
	const jobs = (pool: typeof db, mail: () => Promise<number>) =>
		loggedRoute(
			cronRoute(
				cron,
				scheduledJobs({
					db: pool,
					storage: null,
					cleanup: null,
					effects: null,
					digests: null,
					mail,
				}),
			),
		);
	const request = (authorization?: string) =>
		new Request("https://everyfield.test/api/cron/jobs", authorization ? { headers: { authorization } } : {});
	const invitations = (pool: typeof db) => () =>
		runDueMail(pool, mailConfig({ db: pool }, authorizeDigestMail, []), INVITATION_MAIL, 20, Infinity);
	const told: string[] = [];
	const { lines } = await capturedErrors(async () => {
		const shown = health();
		const body = (await shown.json()) as Record<string, unknown>;
		assert.deepEqual([shown.status, Object.keys(body).sort()], [200, ["status", "time"]]);
		assert.equal(body.status, result.public_liveness);
		assert.equal(new Date(str(body.time)).toISOString(), body.time);
		told.push(JSON.stringify(body));

		await assert.rejects(requestDatabase().execute(sql`SELECT 1`));
		const ready = async (pool: typeof db, mail: () => Promise<number>) => {
			const answer = await Promise.resolve(jobs(pool, mail)(request(`Bearer ${cron}`))).then(
				async (response) => ({ status: response.status, body: await response.text() }),
				(error: Error) => ({
					status: 500,
					body: `${error.name} ${error.message} ${String(error.cause)}`,
				}),
			);
			told.push(answer.body);
			return { state: answer.status === 200 ? "ready" : "not_ready", body: answer.body };
		};
		assert.equal((await ready(db, async () => 0)).state, "ready");
		const unready = await ready(dead, invitations(dead));
		assert.equal(unready.state, result.readiness);
		assert.match(unready.body, /^ServerFailure server_failure undefined$/);
		const lagging = await ready(db, invitations(dead));
		assert.equal(lagging.state, result.readiness);
		assert.deepEqual(JSON.parse(lagging.body).failed, ["mail"]);
		assert.deepEqual(JSON.parse(lagging.body).steps.mail, { status: "failed" });

		for (const authorization of [undefined, "Bearer wrong", `Bearer ${A.session}`]) {
			const denied = await jobs(dead, invitations(dead))(request(authorization));
			told.push(await denied.clone().text());
			assert.deepEqual([denied.status, await denied.json()], [401, { status: "unauthorized" }]);
		}
		const operator = readiness({
			capability: { account: A.id, session: A.session, context: P.id, role: "Admin" },
			evidence: {},
			now: new Date(c.clock.now),
		});
		assert.deepEqual(operator, { refusal: "operator_unavailable" });

		const failed = await safeBoundary(async () => safeResponse((await dead.execute(sql`SELECT ${secret}`)).rows));
		const error = (await failed.json()) as Record<string, unknown>;
		assert.deepEqual(
			[failed.status, error.code, Object.keys(error).sort()],
			[503, "unavailable", ["code", "requestId"]],
		);
		assert.equal(error.requestId, failed.headers.get("x-request-id"));
		told.push(JSON.stringify(error));
	});
	assert.ok(
		lines.some((line) => JSON.parse(line).error?.code === "ECONNREFUSED"),
		lines.join("\n"),
	);
	const all = [...told, ...lines].join("\n");
	assert.equal(all.includes(secret) ? secret : null, result.secret);
	assert.doesNotMatch(all, /postgres:|127\.0\.0\.1/);
});

test("AC:CASE-OPS-003 a telemetry sink that never answers leaves the saved document and its receipt alone, gets no private text and has no fallback", async (t) => {
	const c = caseOf("CASE-OPS-003");
	const { result } = c.expected;
	const note = str(given(c, "behavior-inputs").private_note);
	const privateCare = str(given(c, "private-A").note);
	const fault = given(c, "error-1");
	const { secret } = fault.metadata as { secret: string };
	const actor = await actorOf(A);
	const bodies: Promise<Buffer>[] = [];
	const sink = createServer((request) => {
		const { promise, resolve } = Promise.withResolvers<Buffer>();
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk)).on("end", () => resolve(Buffer.concat(chunks)));
		bodies.push(promise);
		arrived.resolve();
	});
	const arrived = Promise.withResolvers<void>();
	await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		sink.closeAllConnections();
		sink.close();
	});
	const named: string[] = [];
	const lookup = dns.lookup;
	t.mock.method(dns, "lookup", (...args: Parameters<typeof lookup>) => {
		named.push(args[0]);
		return Reflect.apply(lookup, dns, args);
	});
	const fetches = t.mock.method(globalThis, "fetch", async () =>
		assert.fail("no telemetry provider is called by fetch"),
	);
	const keys = { LANGFUSE_PUBLIC_KEY: "pk-lf-case", LANGFUSE_SECRET_KEY: "sk-lf-SECRET-CANARY" };
	const base = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
	const correlation = c.action.arguments.correlation_id!;
	const generate = () =>
		documentsWriter.generate(
			db,
			actor,
			{ templateId: "commitment-card", format: "pdf", requestKey: correlation },
			storage,
		);
	const invalid = given(c, "execution").invalid_control;

	const { value, lines } = await capturedErrors(async () => {
		for (const broken of [
			undefined,
			"",
			"not a url",
			"ftp://sink.example.test",
			"http://sink.example.test",
			"https://user@sink.example.test",
			"https://user:secret@sink.example.test",
			"https://sink.example.test/?token=secret",
			"https://sink.example.test/#secret",
		])
			assert.equal(registerTracing({ ...keys, LANGFUSE_BASE_URL: broken }), false, broken);
		assert.equal(registerTracing({ LANGFUSE_BASE_URL: base, LANGFUSE_PUBLIC_KEY: "pk-lf-case" }), false);
		assert.equal(registerTracing({ ...keys, LANGFUSE_BASE_URL: base }), true);
		const saved = await traceTurn(
			{
				turnId: randomUUID(),
				conversationId: randomUUID(),
				submittedAt: new Date(c.clock.now),
				request: "Make the card",
			},
			async () => ok(await generate()),
		);
		const reported = await safeBoundary(async () => {
			const metadata = { ...(fault.metadata as object), note: privateCare };
			throw Object.assign(new Error(str(fault.message)), { name: note, code: note, metadata });
		});
		const inRoute = loggedRoute(async () => {
			await db.execute(sql`SELECT ${privateCare}::uuid, ${secret}`);
			return safeResponse({});
		});
		await assert.rejects(Promise.resolve(inRoute(new Request("https://everyfield.test/"))), {
			name: "ServerFailure",
			message: "server_failure",
		});
		const flushing = flushTraces();
		await arrived.promise;
		const read = {
			again: ok(await generate()),
			reported: await reported.text(),
			status: reported.status,
		};
		const invalidReply = await documentsWriter.generate(db, actor, { ...(invalid as object) }, storage);
		const sent = (await Promise.all(bodies)).map((body) => gunzipSync(body).toString("latin1"));
		sink.closeAllConnections();
		sink.close();
		await flushing;
		return { saved, ...read, invalidReply, sent };
	});
	assert.deepEqual(value.again, value.saved);
	refused(value.invalidReply, "invalid_input");
	const [row] =
		await rowsOf(sql`SELECT f.upload_key,f.state FROM generated_document g JOIN file_object f ON f.id=g.object_id
		WHERE g.id=${value.saved.id}`);
	assert.equal(row?.state, "ready");
	assert.equal(str(row?.upload_key).split(":").at(-1), result.business_receipt);
	assert.equal(
		(await one(sql`SELECT count(*)::int AS n FROM file_object WHERE upload_key=${`generated:${P.id}:${correlation}`}`))
			.n,
		1,
	);
	assert.equal(value.status, 503);
	assert.ok(
		value.sent.length > 0 && value.sent.join("").includes("evry turn"),
		"the sink got the span and never answered",
	);
	const telemetry = [...lines, ...value.sent, value.reported].join("\n");
	assert.ok(lines.some((line) => /"component":"route"/.test(line)));
	assert.equal([note, privateCare].find((text) => telemetry.includes(text)) ?? null, result.private_note_in_telemetry);
	for (const hidden of [secret, keys.LANGFUSE_SECRET_KEY, A.email, "op-1"])
		assert.equal(telemetry.includes(hidden), false, hidden);
	assert.ok(lines.some((line) => /trace_export_failed/.test(line)));
	const elsewhere = named.filter(
		(host) => !["localhost", "127.0.0.1", new URL(database.logins.runtime.url).hostname].includes(host),
	);
	assert.equal(elsewhere.length + fetches.mock.callCount() > 0, result.cloud_fallback, elsewhere.join());
});

test("AC:CASE-OPS-004 a failed audit insert leaves no part of a finalized attendance, and a commit whose process dies before any wakeup keeps one set of work", async (t) => {
	const c = caseOf("CASE-OPS-004");
	const { result } = c.expected;
	t.mock.timers.enable({ apis: ["Date"], now: new Date(c.clock.now) });
	const actor = await actorOf(A);
	const keys: string[] = [];
	const reminders = taskReminders(seatedNotificationService(mailConfig({ db }, authorizeTaskReminders, keys)));
	const writer = createAttendanceWriter({ reminders });
	await admin.execute(
		sql`UPDATE person SET linked_account_id=${A.id} WHERE id=${await person("Avery Admin", P.id, "leader")}`,
	);
	const alex = await person("Alex");
	const M = randomUUID();
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,
		status,attendance_revision) VALUES(${M},${P.id},'vision_meeting',NULL,'2026-10-12','18:00','America/Chicago',
		'2026-10-12T23:00:00Z','1','in_progress',1)`);
	const request = (requestKey: string) => ({
		requestKey,
		expectedRevision: "1",
		input: {
			meetingId: M,
			attendeeIds: [alex],
			followUpAssigneeIds: [A.id],
			evaluationAssigneeIds: [A.id],
		},
	});
	const finalize = (pool: typeof db, requestKey: string) =>
		withMeetingsWrite(pool, actor, (tx, ctx) => writer.finalizeAttendance(tx, ctx, request(requestKey)));
	const counted = async () =>
		one(sql`SELECT (SELECT count(*)::int FROM participation WHERE meeting_id=${M}) AS attendance,
			(SELECT count(*)::int FROM obligation WHERE meeting_id=${M}) AS obligations,
			(SELECT count(*)::int FROM task t JOIN obligation b ON b.id=t.obligation_id WHERE b.meeting_id=${M}) AS tasks,
			(SELECT count(*)::int FROM notice n JOIN task t ON t.id=n.source_record_id JOIN obligation b ON b.id=t.obligation_id
				WHERE b.meeting_id=${M}) AS reminders,
			(SELECT count(*)::int FROM job j JOIN mail m ON m.id=j.subject_record_id WHERE j.kind='mail' AND j.state='ready'
				AND m.notice_id IS NOT NULL AND m.recipient_account_id=${A.id}) AS jobs,
			(SELECT count(*)::int FROM audit_event WHERE action='meetings.finalized' AND subject_id=${M}) AS finalized`);

	await t.test("the audit fault rolls every write back", async () => {
		assert.equal(given(c, "case-input").fault, "attendance_audit_insert");
		const { value, added } = await recorded(admin, () =>
			untouched(admin, () =>
				failingWrite(
					admin,
					{
						on: "audit_event",
						event: "INSERT",
						when: `NEW.action='meetings.finalized' AND NEW.subject_id='${M}'`,
					},
					() => finalize(db, randomUUID()),
				),
			),
		);
		refused(value, "required_write_failed");
		const left = await counted();
		assert.equal(left.attendance, result.faulted_transaction_attendance_writes);
		assert.equal(left.tasks, result.faulted_transaction_task_writes);
		assert.deepEqual(added.audits, c.expected.event);
		assert.deepEqual(added, NOTHING);
		assert.equal((await one(sql`SELECT stage FROM person WHERE id=${alex}`)).stage, "prospect");
	});

	const sub = c.subcases?.find((s) => s.name === "committed-intent-survives-wakeup-crash") ?? assert.fail("no subcase");
	await t.test(sub.name, async () => {
		const repeat = Number(given(sub, "execution").repeat);
		const dying = database.connect("runtime", { max: 1 });
		let committed = false;
		dying.$client.on("connect", (connection) => {
			const query = connection.query;
			let begun = false;
			connection.query = async function (this: unknown, ...args: unknown[]) {
				if (committed) throw Error("the process is gone");
				const text = String((args[0] as { text?: string } | undefined)?.text ?? args[0]);
				if (/^\s*begin/i.test(text)) begun = true;
				const answer = await Reflect.apply(query, this, args);
				if (/^\s*commit/i.test(text) || (!begun && text.startsWith("/* evf:final */"))) {
					committed = true;
					throw Error("the process died after its commit");
				}
				return answer;
			} as never;
		});
		const requestKey = randomUUID();
		const crashed = await finalize(dying, requestKey).then(
			(reply) => reply.status,
			() => "rejected",
		);
		assert.equal(committed, true);
		assert.notEqual(crashed, "ok");
		const survived = await counted();
		assert.deepEqual([survived.attendance, survived.obligations, survived.tasks, survived.finalized], [1, 2, 2, 1]);
		assert.ok(Number(survived.reminders) > 0);
		assert.equal(
			Number(survived.jobs) > 0 && Number(survived.jobs) === Number(survived.reminders),
			sub.expected.result.committed_intent_survives_crash,
			JSON.stringify(survived),
		);
		const receipts = new Set<string>();
		const { value: extra, added } = await recorded(admin, async () => {
			const { tables } = await touched(admin, async () => {
				for (let n = 0; n < repeat; n++) receipts.add(ok(await finalize(db, requestKey)).receiptId);
			});
			return tables;
		});
		assert.equal(receipts.size, 1);
		assert.equal(extra.length, sub.expected.result.duplicate_business_effects, extra.join());
		assert.deepEqual(await counted(), survived);
		assert.deepEqual(added, NOTHING);
		assert.equal(sub.expected.event, null);
		await admin.execute(sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second'
			WHERE kind='mail' AND tenant_id=${P.id}`);
		const claims = await claimDue(db, ["mail"], 100);
		assert.equal(claims.length, Number(survived.jobs));
		assert.deepEqual(await claimDue(db, ["mail"], 100), []);
		assert.deepEqual(keys, []);
	});
});

test("AC:OPS-ATOMIC-001 a replaced file, its history, its receipt and its cleanup job commit in one transaction or not at all, and one request leaves one durable job with no wakeup", async () => {
	const c = caseOf("OPS-ATOMIC-001");
	const { result } = c.expected;
	assert.equal(given(c, "execution").fault, "required_history");
	const owner = await person("Synthetic owner");
	const old = await stored("person_photo", PNG);
	await admin.execute(sql`UPDATE person SET photo_object_id=${old.id} WHERE id=${owner}`);
	const uploadId = await photo(owner);
	const revision = str((await one(sql`SELECT revision::text AS r FROM person WHERE id=${owner}`)).r);
	const requestKey = randomUUID();
	const run = () => setPhoto(owner, uploadId, requestKey, revision);
	const intents = async () =>
		Number(
			(await one(sql`SELECT count(*)::int AS n FROM job WHERE kind='object_cleanup' AND subject_record_id=${old.id}`))
				.n,
		);

	for (const on of ["audit_event", "job", "person"]) {
		const { value, tables } = await touched(admin, () =>
			failingWrite(admin, { on, event: "INSERT OR UPDATE" }, () =>
				run().then(
					(reply) => reply.status,
					() => "rejected",
				),
			),
		);
		assert.notEqual(value, "ok", on);
		assert.equal(tables.length, result.faulted_transaction_writes, `${on}: ${tables.join()}`);
	}
	const { value: first, added } = await recorded(admin, run);
	const saved = ok(first);
	assert.deepEqual(added.jobs, ["object_cleanup"]);
	assert.equal(added.audits.length, 1);
	assert.deepEqual([added.notices, added.mail], [0, 0]);
	assert.equal(await intents(), result.committed_intents);
	const repeated = await touched(admin, async () => {
		for (let n = 1; n < Number(given(c, "execution").repeat); n++) assert.deepEqual(ok(await run()), saved);
	});
	assert.equal(repeated.tables.length, result.duplicate_effects, repeated.tables.join());
	assert.equal(await intents(), result.committed_intents);
	assert.equal(client.objects.has(old.key), true, "nothing ran the job in memory");
	assert.equal(
		(await one(sql`SELECT state FROM job WHERE kind='object_cleanup' AND subject_record_id=${old.id}`)).state,
		"ready",
	);
	assert.equal(await runDueObjectCleanup(db, storage, 10), 1);
	assert.equal(await runDueObjectCleanup(db, storage, 10), 0);
	assert.equal(client.objects.has(old.key), false);
	refused(
		await withPeopleWrite(db, await actorOf(B), ((tx: WriteTx, ctx: never) =>
			personFields.setPersonPhoto(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { personId: owner, uploadId },
			})) as never),
	);
	assert.equal(c.expected.event, null);
});

test("AC:OPS-PLATFORM-001 the app login owns nothing, bypasses no row rule and cannot migrate, a failed consequence rolls back, and no worker runs outside the app's tick", async () => {
	const c = caseOf("OPS-PLATFORM-001");
	const { result } = c.expected;
	const role = await one(
		sql`SELECT current_user AS name,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
		pg_has_role(current_user,(SELECT rolname FROM pg_roles o JOIN pg_namespace n ON n.nspowner=o.oid WHERE n.nspname=current_schema()),'MEMBER') AS schema_owner,
		(SELECT count(*)::int FROM pg_class k JOIN pg_namespace n ON n.oid=k.relnamespace
			WHERE n.nspname=current_schema() AND pg_has_role(current_user,k.relowner,'MEMBER')) AS owned,
		has_schema_privilege(current_user,current_schema(),'CREATE') AS creates
		FROM pg_roles r WHERE r.rolname=current_user`,
		db,
	);
	assert.equal(role.name, database.logins.runtime.name);
	assert.equal(role.schema_owner || Number(role.owned) > 0, result.runtime_is_owner);
	assert.equal(role.rolbypassrls || role.rolsuper, result.runtime_bypasses_rls);
	assert.deepEqual([role.rolcreaterole, role.rolcreatedb], [false, false]);
	const group =
		await rowsOf(sql`SELECT rolname,rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolcanlogin AS strong
		FROM pg_roles WHERE rolname IN ('everyfield_runtime','everyfield_auth','everyfield_cleanup') ORDER BY rolname`);
	assert.deepEqual(group, [
		{ rolname: "everyfield_auth", strong: false },
		{ rolname: "everyfield_cleanup", strong: false },
		{ rolname: "everyfield_runtime", strong: false },
	]);
	const migrated = await migrate(db, database.schema).then(
		() => true,
		(error: unknown) => (code(error) === "42501" ? false : assert.fail(String(error))),
	);
	assert.equal(migrated || role.creates, result.runtime_can_migrate);
	for (const statement of [
		"CREATE TABLE planted(id int)",
		"ALTER TABLE plant ADD COLUMN planted int",
		"DROP TABLE audit_event",
		"SELECT * FROM schema_migration",
		"SELECT * FROM auth_account",
		"UPDATE audit_event SET kind='edit'",
	])
		await assert.rejects(db.execute(sql.raw(statement)), (error) => code(error) === "42501", statement);
	const operator = await one(sql`SELECT current_user AS name,
		pg_has_role(current_user,(SELECT nspowner FROM pg_namespace WHERE nspname=current_schema()),'MEMBER') AS owner`);
	assert.notEqual(operator.name, role.name);
	assert.equal(operator.owner, true);
	assert.deepEqual(await migrate(admin, database.schema), []);

	assert.equal(given(c, "execution").fault, "required_consequence_insert");
	const actor = await actorOf(A);
	const save = () =>
		documentsWriter.saveNative(db, actor, {
			title: "Platform",
			body: nativeFromText("Ours."),
			expectedRevision: "0",
		});
	const { value, tables } = await touched(admin, () =>
		failingWrite(admin, { on: "audit_event", event: "INSERT" }, () =>
			save().then(
				(reply) => reply.status,
				() => "rejected",
			),
		),
	);
	assert.notEqual(value, "ok");
	assert.equal(tables.length, result.faulted_transaction_writes, tables.join());
	ok(await save());

	const released = await stored("person_photo", PNG);
	await admin.execute(sql`INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
		VALUES(${P.id},'object_cleanup',${released.id},${`cleanup/${released.id}`},'ready',clock_timestamp()-interval '1 day',0,4,0)`);
	const state = async () => (await one(sql`SELECT state FROM job WHERE subject_record_id=${released.id}`)).state;
	for (let n = 0; n < 3; n++) await save();
	const sessions = await one(sql`SELECT count(*)::int AS n FROM pg_stat_activity
		WHERE usename=${database.logins.runtime.name} AND pid<>pg_backend_pid() AND state<>'idle'`);
	assert.equal((await state()) !== "ready" || sessions.n !== 0, result.standalone_worker);
	const response = await scheduledJobs({
		db,
		storage,
		cleanup: null,
		effects: null,
		digests: null,
		mail: null,
	})();
	assert.equal(((await response.json()) as { removed: number }).removed, 1);
	assert.equal(await state(), "succeeded");
	assert.equal(c.expected.event, null);
});

test("AC:PROVIDER48-001 a fault at the credential, the claim, the seat or the audit row leaves no domain row, through the one auth service and a login that cannot migrate", async (t) => {
	const c = caseOf("PROVIDER48-001");
	const { result } = c.expected;
	const { email, password, name } = c.action.arguments as {
		email: string;
		password: string;
		name: string;
	};
	const f = await invitationFixture();
	t.after(() => f.close());
	const s = await f.setup("plant");
	s.recipient.email = email;
	const invited = await f.invitation(s);
	const native = f.native("invitation_only");
	const open = f.native("open");
	let attempts = 0;
	const register = (call: typeof native, kind: object) =>
		call("register", { ...kind, name, email, password, requestKey: randomUUID() }, undefined, {
			"x-test-ip": `127.0.0.${++attempts}`,
		});
	const domain = async () =>
		one(
			sql`SELECT (SELECT count(*)::int FROM seat s JOIN account a ON a.id=s.account_id JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email=${email}) AS seats,
			(SELECT count(*)::int FROM person p JOIN account a ON a.id=p.linked_account_id JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email=${email}) AS people,
			(SELECT count(*)::int FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email=${email} AND a.registration_state='active') AS active,
			(SELECT count(*)::int FROM invitation WHERE tenant_id=${s.w.id} AND state<>'pending') AS claimed,
			(SELECT count(*)::int FROM audit_event a JOIN account k ON k.id=a.actor_id JOIN auth_user u ON u.id=k.auth_user_id WHERE u.email=${email}) AS audits`,
			f.admin,
		);
	const rowsAfter = async () => {
		const { audits, ...rows } = await domain();
		return { domain: Object.values(rows).reduce<number>((n, v) => n + Number(v), 0), audits };
	};
	const nothing = { domain: result.domain_rows_after_fault, audits: result.audit_rows };

	for (const on of ["auth_user", "auth_account", "account"]) {
		const { value: response, lines } = await capturedErrors(() =>
			failingWrite(f.admin, { on, event: "INSERT" }, () => register(open, { kind: "discovery" })),
		);
		for (const secret of [password, email, "insert into"])
			assert.ok(!lines.some((line) => line.includes(secret)), `${on}: ${secret}`);
		assert.deepEqual(response.headers.getSetCookie(), [], on);
		assert.deepEqual(await rowsAfter(), nothing, on);
	}
	assert.deepEqual(await (await register(native, { kind: "invitation", invitationProof: invited.proof })).json(), {
		status: "continue_identity_proof",
	});
	await f.admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE email=${email}`);
	const login = await native("sign-in/email", { email, password });
	assert.equal(login.status, 200);
	const cookie = login.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	const resume = { requestKey: randomUUID(), invitationProof: invited.proof };
	assert.equal(given(c, "execution").fault, "domain_audit_insert");
	for (const on of ["audit_event", "seat", "account", "invitation"]) {
		const { value, tables } = await touched(f.admin, () =>
			failingWrite(f.admin, { on, event: "INSERT OR UPDATE" }, async () =>
				(await native("resume-registration", resume, cookie)).json(),
			),
		);
		assert.notEqual(value.status, "active", on);
		assert.deepEqual(await rowsAfter(), nothing, on);
		assert.deepEqual(tables, [], on);
	}
	const { value: accepted } = await recorded(f.admin, async () =>
		(await native("resume-registration", resume, cookie)).json(),
	);
	assert.equal(accepted.status, "active");
	const joined = await domain();
	assert.deepEqual([joined.seats, joined.active, joined.claimed], [1, 1, 1]);
	assert.ok(Number(joined.audits) > 0);
	assert.deepEqual(await (await native("resume-registration", resume, cookie)).json(), accepted);
	assert.deepEqual(await domain(), joined);

	const stores = await rowsOf(
		sql`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema=current_schema()
		AND (column_name IN ('password_hash','password') OR (column_name='token' AND table_name LIKE '%session%'))`,
		f.admin,
	);
	const second = stores.map((r) => str(r.table_name)).filter((n) => !["auth_account", "auth_session"].includes(n));
	assert.equal(second.length > 0, result.second_auth_service, second.join());
	assert.equal(stores.length, 2);
	await assert.rejects(migrate(f.db, f.schema), (error) => code(error) === "42501");
	await assert.rejects(f.db.execute(sql`SELECT * FROM auth_account`), (error) => code(error) === "42501");
	assert.equal(c.expected.event, null);
});

test("AC:PROVIDER48-002 another church's account reads no stored file of any kind, a private object stays private, and a replaced file loses its bytes once while the current one stays", async (t) => {
	const c = caseOf("PROVIDER48-002");
	const { result } = c.expected;
	const { bytes_utf8 } = given(c, "D");
	const bytes = Buffer.concat([PNG, Buffer.from(str(bytes_utf8))]);
	const alex = await person("Alex Rivera");
	const D = await stored("person_photo", bytes);
	await admin.execute(sql`UPDATE person SET photo_object_id=${D.id} WHERE id=${alex}`);
	const version = { personId: alex, versionId: D.id };
	let gets: string[] = [];
	const send = client.send.bind(client);
	t.mock.method(client, "send", (command: Parameters<typeof send>[0]) => {
		if (command.constructor.name === "GetObjectCommand") gets.push(String(command.input?.Key));
		return send(command);
	});

	await t.test(
		"the current file opens for its church; a foreign account, key or ID gets no body and no bytes are fetched",
		async () => {
			const shown = ok(await readPersonPhoto(db, storage, people as never, version));
			assert.deepEqual(Buffer.from(shown.bytes), bytes);
			assert.equal(Buffer.from(shown.bytes).toString("utf8").endsWith(str(bytes_utf8)), true);
			assert.deepEqual(gets, [D.key]);
			gets = [];
			const outside = await person("Outside", Q.id);
			for (const attempt of [
				version,
				{ personId: outside, versionId: D.id },
				{ personId: alex, versionId: randomUUID() },
				{ personId: alex, versionId: D.key },
			]) {
				const reply = await untouched(admin, () => readPersonPhoto(db, storage, foreign as never, attempt));
				assert.equal(reply.status === "ok" ? reply.value.bytes : null, result.foreign_body);
				const own = { session: A.session, selected: Q };
				assert.equal((await readPersonPhoto(db, storage, own as never, attempt)).status, "refused");
			}
			assert.deepEqual(gets, []);
		},
	);

	await t.test(
		"each registered kind of file belongs to one owner, and a foreign account's link is refused",
		async () => {
			const kinds =
				await rowsOf(sql`SELECT unnest(regexp_matches(pg_get_constraintdef(oid),'''([a-z_]+)''::text','g')) AS kind
			FROM pg_constraint WHERE conrelid='file_object'::regclass AND conname='file_object_ck_1'`);
			assert.deepEqual(kinds.map((k) => k.kind).sort(), [
				"assistant_staging",
				"avatar",
				"brand_asset",
				"commitment",
				"communication_attachment",
				"generated",
				"native_import",
				"person_photo",
			]);
			await assert.rejects(stored("generic", PNG), (error) => code(error) === "23514");
			const generic = await rowsOf(sql`SELECT DISTINCT table_name FROM information_schema.columns
			WHERE table_schema=current_schema() AND column_name IN ('opaque_key','storage_key','bucket_key','object_key')`);
			assert.equal(
				generic.some((r) => r.table_name !== "file_object"),
				result.new_generic_file_framework,
				JSON.stringify(generic),
			);
			const made = ok(
				await documentsWriter.generate(
					db,
					await actorOf(A),
					{ templateId: "commitment-card", format: "pdf", requestKey: "private-D" },
					storage,
				),
			);
			for (const documentId of [made.id, D.id, D.key])
				assert.equal((await documentsWriter.download(db, await actorOf(B), { documentId }, storage)).status, "refused");
			const { opaque_key } = await one(
				sql`SELECT f.opaque_key FROM generated_document g JOIN file_object f ON f.id=g.object_id WHERE g.id=${made.id}`,
			);
			assert.match(str(opaque_key), new RegExp(`^private/${P.id}/[0-9a-f-]{36}$`));
			class OpenClient extends MemoryClient {
				override async send(command: Parameters<MemoryClient["send"]>[0]): ReturnType<MemoryClient["send"]> {
					if (command.constructor.name === "GetBucketAclCommand")
						return {
							Grants: [
								{
									Grantee: { URI: "http://acs.amazonaws.com/groups/global/AllUsers" },
									Permission: "READ",
								},
							],
						} as never;
					return super.send(command);
				}
			}
			const open = new OpenClient();
			const intoOpen = await documentsWriter.generate(
				db,
				await actorOf(A),
				{ templateId: "commitment-card", format: "pdf", requestKey: "open-bucket" },
				{ bucket: "open", client: open },
			);
			assert.equal(intoOpen.status === "refused" && open.objects.size === 0, result.private_object);
		},
	);

	await t.test("a replacement racing its cleanup removes the old bytes once and never the current ones", async () => {
		const next = await photo(alex);
		ok(await setPhoto(alex, next, randomUUID()));
		const { opaque_key } = await one(sql`SELECT opaque_key FROM file_object WHERE id=${next}`);
		assert.equal((await readPersonPhoto(db, storage, people as never, version)).status, "refused");
		await admin.execute(sql`INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
			VALUES(${P.id},'object_cleanup',${next},${`cleanup/${next}`},'ready',clock_timestamp(),0,4,0)`);
		const [cleaned, other, read] = await Promise.all([
			runDueObjectCleanup(db, storage, 10),
			runDueObjectCleanup(db, storage, 10),
			readPersonPhoto(db, storage, people as never, { personId: alex, versionId: next }),
		]);
		assert.equal(cleaned + other, 1);
		assert.deepEqual(Buffer.from(ok(read).bytes), PNG);
		assert.deepEqual([client.objects.has(D.key), client.objects.has(str(opaque_key))], [false, true]);
		ok(await readPersonPhoto(db, storage, people as never, { personId: alex, versionId: next }));
		assert.equal(
			(await readPersonPhoto(db, storage, foreign as never, { personId: alex, versionId: next })).status,
			"refused",
		);
	});
	assert.equal(c.expected.event, null);
});

test("AC:PROVIDER48-003 a link names one object for five minutes; after the seat ends no new link is issued, the old one may live to its own expiry, and a guessed key opens nothing", async (t) => {
	const c = caseOf("PROVIDER48-003");
	const { result } = c.expected;
	const { issued_at, expires_at, revoke_at } = given(c, "input");
	assert.equal(revoke_at, c.clock.now);
	const viewer = await database.actor(P, "admin");
	const D = await stored("generated", Buffer.from(str(given(c, "D").bytes_utf8)));
	const row =
		await one(sql`INSERT INTO generated_document(tenant_id,template_id,template_version,saved_template_name,renderer_version,
		format,object_id,inputs,download_name,generated_at) VALUES(${P.id},'commitment-card',${"ef".repeat(32)},'Commitment Card','saved',
		'pdf',${D.id},'[]'::jsonb,'commitment-card.pdf',clock_timestamp()) RETURNING id`);
	const documentId = str(row.id);
	const actor = await actorOf(viewer);
	t.mock.timers.enable({ apis: ["Date"], now: new Date(str(issued_at)) });
	const download = (request: object = { documentId }, who = actor) =>
		documentsWriter.download(db, who, request, storage);
	const link = ok(await download());
	const url = new URL(link.url);
	assert.ok(url.pathname.endsWith("/" + D.key));
	assert.equal(url.searchParams.get("response-cache-control"), "private, no-store");
	const signed = str(url.searchParams.get("X-Amz-Date")).replace(
		/^(....)(..)(..)T(..)(..)(..)Z$/,
		"$1-$2-$3T$4:$5:$6Z",
	);
	assert.equal(signed, issued_at);
	const until = Date.parse(signed) + Number(url.searchParams.get("X-Amz-Expires")) * 1000;
	assert.equal(new Date(until).toISOString().replace(".000Z", "Z"), result.old_URL_may_work_until);
	assert.equal(result.old_URL_may_work_until, expires_at);
	assert.equal(link.expiresInSeconds * 1000, until - Date.parse(signed));
	assert.doesNotMatch(JSON.stringify(link), /secretAccessKey|X-Amz-Security-Token/);
	for (const guess of [
		{ documentId: D.key },
		{ documentId: D.id },
		{ documentId, key: D.key },
		{ documentId: randomUUID() },
	])
		assert.equal((await download(guess)).status, "refused", JSON.stringify(guess));
	refused(await download({ documentId }, await actorOf(B)));

	t.mock.timers.setTime(Date.parse(str(revoke_at)));
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${viewer.id}`);
	const after = await untouched(admin, () => download());
	refused(after);
	assert.equal("value" in after ? after.value : null, result.new_URL_after_revoke);
	assert.equal((await RequestActor.resolve(db, viewer.session)) instanceof RequestActor, true);
	t.mock.timers.setTime(Date.parse(str(expires_at)));
	refused(await download());
	assert.equal(client.objects.has(D.key), true);
	assert.equal(c.expected.event, null);
});
