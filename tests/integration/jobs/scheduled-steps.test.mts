import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { authorizeDigestMail, createDigestWorker } from "../../../apps/web/src/server/jobs/digest.ts";
import { createMailService, runDueMail } from "../../../apps/web/src/server/jobs/mail.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { INVITATION_MAIL } from "../../../apps/web/src/server/invitations/index.ts";
import { fixture } from "../identity/invitations-support.mts";

// The scheduled runner keeps going when one step throws (T-152). The object cleanup step fails for real: another
// transaction holds the file's row lock, and the job pool waits at most 200 ms for it. In the same tick the church
// digest is still planned and delivered and the church invitation mail is still sent, and the body names the failed
// step. Runs on a suite schema of the shared development database (or CI's disposable one).

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Body = {
	status: string;
	failed: string[];
	steps: Record<string, { status: string; count?: unknown }>;
	planned: { started: number; queued: number } | null;
	digests: number;
	mailed: number;
	removed: number;
};
let f: Fixture;
const secret = "cron-" + randomUUID();
const clock = { at: new Date() };
const deletes: string[] = [];

before(async () => {
	f = await fixture({ lockTimeout: "200ms" });
});
after(() => f?.close());

test("INV-scheduled-steps: a throwing object cleanup step still lets digests and invitation mail run in the same tick, and the body names it", async () => {
	const mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "digests@example.test",
		authorize: authorizeDigestMail,
		unsubscribe: { origin: "https://everyfield.test", keys: { current: randomBytes(32) } },
		transport: {
			async send() {
				return { kind: "refused", retryable: true };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const tick = scheduledJobs({
		secret,
		db: f.db,
		storage: {
			bucket: "synthetic-only",
			client: {
				send: async (command: { input: { Key: string } }) => {
					deletes.push(command.input.Key);
					return {};
				},
			},
		} as never,
		cleanup: null,
		reminders: null,
		digests: createDigestWorker({ mail, origin: "https://everyfield.test" }),
		mail: (limit, until) => runDueMail(f.db, f.mail, INVITATION_MAIL, limit, until),
		now: () => clock.at,
	});
	const run = async (at: string) => {
		clock.at = new Date(at);
		const response = await tick(
			new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }),
		);
		return { code: response.status, body: (await response.json()) as Body };
	};

	// A church whose weekly digest is Monday 08:00 UTC, and its Owner, who reads it in the bell and by email.
	const s = await f.setup("plant");
	await f.admin.execute(sql`UPDATE plant SET digest_cadence='weekly' WHERE id=${s.w.id}`);
	await f.admin
		.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,cadence,unsubscribe_revision)
		VALUES (${s.sender.id},'planter_digest','email',true,'weekly',1),(${s.sender.id},'planter_digest','in_app',true,'weekly',1)`);
	const task = randomUUID();
	await f.admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date)
		VALUES(${task},${s.w.id},'Book the venue','general','medium','not_started',now(),'date_only','2026-11-14'::date)`);
	await f.admin.execute(
		sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${s.w.id},${task},${s.sender.id})`,
	);

	// 07:59 on Monday 16 November 2026: every step runs, and the planner starts the digest coverage.
	const quiet = await run("2026-11-16T07:59:00Z");
	assert.equal(quiet.code, 200, JSON.stringify(quiet.body));
	assert.deepEqual([quiet.body.status, quiet.body.failed, quiet.body.digests], ["ok", [], 0]);
	assert.deepEqual(quiet.body.steps["object-cleanup"], { status: "ok", count: 0 });
	assert.deepEqual(quiet.body.steps["lifecycle-purge"], { status: "skipped" });
	assert.deepEqual(quiet.body.steps["documents-orphans"], { status: "ok", count: { purged: 0, unknown: 0 } });

	// Owed work for 08:00: a seat invitation, and the cleanup of one unreferenced private file.
	const actor = await f.actor(s.sender.session);
	await f.invitations.invite(actor, {
		requestKey: randomUUID(),
		expectedRevision: "1",
		input: { workspace: s.w, role: "member", recipientEmail: s.recipient.email },
	});
	const file = randomUUID(),
		key = `private/${s.w.id}/${randomUUID()}`;
	await f.admin.insert(t.file_object).values({
		id: file,
		tenant_id: s.w.id,
		purpose: "avatar",
		opaque_key: key,
		media_type: "image/png",
		max_bytes: "9",
		byte_count: "9",
		sha256: createHash("sha256").update("synthetic").digest("hex"),
		state: "ready",
		upload_key: randomUUID(),
		claim_generation: "0",
		// Still inside its staging window, so only its queued cleanup job may remove it, not the orphan sweep.
		expires_at: new Date(Date.now() + 3_600_000),
	});
	await f.admin
		.execute(sql`INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
		VALUES(${s.w.id},'object_cleanup',${file},${"cleanup/" + file},'ready',now(),0,4,0)`);

	// 08:00 while another transaction holds the file row: object cleanup throws, every other step still runs.
	const logged: string[] = [];
	const error = console.error;
	console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
	let due: Awaited<ReturnType<typeof run>>;
	try {
		due = await f.admin.transaction(async (tx) => {
			await tx.execute(sql`SELECT id FROM file_object WHERE id=${file} FOR UPDATE`);
			return run("2026-11-16T08:00:00Z");
		});
	} finally {
		console.error = error;
	}
	assert.equal(due.code, 500);
	assert.equal(due.body.status, "failed");
	assert.deepEqual(due.body.failed, ["object-cleanup"]);
	assert.deepEqual(due.body.steps["object-cleanup"], { status: "failed" });
	assert.equal(due.body.removed, 0);
	assert.deepEqual(deletes, [], "the locked file was not deleted");
	assert.deepEqual(due.body.steps["documents-orphans"], { status: "ok", count: { purged: 0, unknown: 0 } });
	// One log line names the failed component and carries no error text or row values.
	assert.deepEqual(
		logged.map((line) => JSON.parse(line)),
		[{ component: "object-cleanup", runner: "scheduled-jobs", outcome: "error" }],
	);
	// Digests were planned and delivered in the same tick.
	assert.deepEqual(due.body.steps["digest-planning"]?.status, "ok");
	assert.equal(due.body.planned?.queued, 1);
	assert.deepEqual(due.body.steps["digest-delivery"], { status: "ok", count: 1 });
	assert.equal(due.body.digests, 1);
	const bell = await f.admin.execute(
		sql`SELECT title FROM notice WHERE recipient_id=${s.sender.id} AND purpose='planter_digest'`,
	);
	assert.equal(bell.rows.length, 1);
	assert.match(String(bell.rows[0]!.title), /^Church digest: 1 open item/);
	const email = await f.admin.execute(
		sql`SELECT state FROM mail WHERE recipient_account_id=${s.sender.id} AND purpose='planter_digest'`,
	);
	assert.deepEqual(email.rows, [{ state: "pending" }], "the digest email is queued for its own sender");
	// The invitation mail was sent in the same tick.
	assert.deepEqual(due.body.steps.mail, { status: "ok", count: 1 });
	assert.equal(due.body.mailed, 1);
	assert.deepEqual(
		f.effects
			.filter((effect) => effect.to === s.recipient.email)
			.map((effect) => /invited you to join/.test(effect.text)),
		[true],
	);
});

test("INV-scheduled-steps: a throwing notification step names itself and the later steps still run", async () => {
	let messages = 0;
	const failing = scheduledJobs({
		secret,
		db: f.db,
		storage: null,
		cleanup: null,
		reminders: null,
		digests: null,
		mail: null,
		notifications: {
			run: async () => {
				throw Error("synthetic");
			},
		},
		messages: async () => ++messages,
	});
	const logged: string[] = [];
	const error = console.error;
	console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
	let response: Response;
	try {
		response = await failing(
			new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }),
		);
	} finally {
		console.error = error;
	}
	const body = await response.json();
	assert.equal(response.status, 500);
	assert.deepEqual(
		[body.status, body.failed, body.steps.notification],
		["failed", ["notification"], { status: "failed" }],
	);
	assert.deepEqual([body.steps.messages, body.messages, messages], [{ status: "ok", count: 1 }, 1, 1]);
	assert.deepEqual(
		logged.map((line) => JSON.parse(line)),
		[{ component: "notification", runner: "scheduled-jobs", outcome: "error" }],
	);
});

test("INV-scheduled-steps: each tick sweeps an unreferenced documents file whose staging window has passed", async () => {
	// T-126 (D-879): nothing ran documentsWriter.reconcileOrphans, so a file whose write never finished stayed stored.
	const removed: string[] = [];
	const tick = scheduledJobs({
		secret,
		db: f.db,
		storage: {
			bucket: "synthetic-only",
			client: {
				send: async (command: { input: { Key: string } }) => {
					removed.push(command.input.Key);
					return {};
				},
			},
		} as never,
		cleanup: null,
		reminders: null,
		digests: null,
		mail: null,
	});
	const s = await f.setup("plant");
	const file = (expiresAt: Date) => ({
		id: randomUUID(),
		tenant_id: s.w.id,
		purpose: "generated" as const,
		opaque_key: `private/${s.w.id}/${randomUUID()}`,
		media_type: "application/pdf",
		max_bytes: "9",
		byte_count: "9",
		sha256: createHash("sha256").update("synthetic").digest("hex"),
		state: "pending" as const,
		upload_key: randomUUID(),
		claim_generation: "0",
		expires_at: expiresAt,
	});
	const expired = file(new Date(Date.now() - 60_000));
	const staging = { ...file(new Date(Date.now() + 3_600_000)), state: "ready" as const };
	await f.admin.insert(t.file_object).values([expired, staging]);

	const response = await tick(
		new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }),
	);
	const body = (await response.json()) as Body;
	assert.equal(response.status, 200, JSON.stringify(body));
	assert.deepEqual(body.steps["documents-orphans"], { status: "ok", count: { purged: 1, unknown: 0 } });
	assert.deepEqual(removed, [expired.opaque_key]);
	const state = async (id: string) =>
		(await f.admin.execute(sql`SELECT state FROM file_object WHERE id=${id}`)).rows[0]!.state;
	assert.equal(await state(expired.id), "purged");
	assert.equal(await state(staging.id), "ready", "a file inside its staging window stays");

	// Without private storage the sweep is skipped and the rest of the tick still runs.
	const bare = scheduledJobs({
		secret,
		db: f.db,
		storage: null,
		cleanup: null,
		reminders: null,
		digests: null,
		mail: null,
	});
	const skipped = await bare(
		new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }),
	);
	assert.deepEqual(((await skipped.json()) as Body).steps["documents-orphans"], { status: "skipped" });
});
