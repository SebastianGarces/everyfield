import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	createNotificationProducer,
	issueMailOptOutToken,
} from "../../../packages/domain/src/notifications/index.ts";
import { ok, seeds } from "../../support/fixture.mts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import {
	createMailService,
	claimUnknownMail,
	MAIL_PASSES,
	runDueMail,
} from "../../../apps/web/src/server/jobs/mail.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { createResendTransport } from "../../../apps/web/src/server/jobs/resend.ts";
import { protectedTemplate } from "../../../apps/web/src/server/jobs/templates.ts";
import { claimDue, recoverLease } from "../../../apps/web/src/server/jobs/queue.ts";
import {
	receiveMailCallback,
	mailCallbackHandler,
	callbackVisibility,
} from "../../../apps/web/src/server/jobs/webhook.ts";
import { db, runtime, runtimeSettings, tenant, setup, teardown, due } from "./support.mts";
const account = randomUUID(),
	key = randomBytes(32),
	secret = "whsec_" + randomBytes(32).toString("base64");
let handedOff = () => {};
const effects = new Map(),
	requests = [];
let mode = "accepted",
	sequence = 0,
	endpoint;
const server = createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const payload = Buffer.concat(chunks).toString();
	if (req.method === "GET") {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ id: req.url.split("/").at(-1) }));
		return;
	}
	const requestKey = req.headers["idempotency-key"];
	requests.push({ key: requestKey, payload });
	if (mode === "refused") {
		res.writeHead(429, { "retry-after": "901" });
		res.end("{}");
		return;
	}
	if (!effects.has(requestKey)) effects.set(requestKey, "provider-" + ++sequence);
	if (mode === "lost") {
		req.socket.destroy();
		return;
	}
	if (mode === "hold") {
		handedOff();
		return;
	}
	if (mode === "malformed") {
		res.end("{}");
		return;
	}
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify({ id: effects.get(requestKey) }));
});
const transport = createResendTransport(
	"synthetic",
	async (url, init) => fetch(endpoint + new URL(url).pathname, init),
	{ VERCEL_ENV: "production" },
);
const authorize = async (tx, mail) => {
	const input = mail.map((m) => ({ id: m.id, recipient: m.recipient, tenant: m.tenant }));
	const r = await tx.execute(
		querySql`SELECT i.id FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) i(id uuid,recipient uuid,tenant uuid) JOIN seat s ON s.account_id=i.recipient AND s.plant_id=i.tenant AND s.ended_at IS NULL FOR SHARE OF s`,
	);
	return new Set(r.rows.map((r) => r.id));
};
const service = createMailService({
	db: runtime,
	encryptionKey: key,
	addressKey: randomBytes(32),
	from: "no-reply@example.test",
	authorize,
	transport,
});
async function enqueue(
	purpose = "notification",
	content = { subject: "Synthetic", text: "safe" },
	logicalKey = `test/${randomUUID()}`,
) {
	return transaction(runtime, (tx) =>
		service.enqueue(tx, {
			owner: { kind: "plant", id: tenant },
			purpose,
			logicalKey,
			recipient: account,
			address: "synthetic@example.test",
			content,
			operation: null,
			notice: null,
			eligibleAt: "2026-01-01T00:00:00Z",
		}),
	);
}
async function callback(messageId, kind, eventKey = randomUUID(), bounce) {
	const raw = JSON.stringify({
		type: "email." + kind,
		created_at: new Date().toISOString(),
		data: { email_id: messageId, bounce },
	});
	const stamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
		.update(eventKey + "." + stamp + "." + raw)
		.digest("base64");
	return new Request("http://example.test/callback", {
		method: "POST",
		body: raw,
		headers: { "svix-id": eventKey, "svix-timestamp": stamp, "svix-signature": "v1," + signature },
	});
}
before(async () => {
	await setup();
	const user = randomUUID();
	await db.execute(
		querySql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${querySql.param(user)},${querySql.param(user + "@example.test")},true,'Synthetic')`,
	);
	await db.execute(
		querySql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${querySql.param(account)},${querySql.param(user)},'active','planter')`,
	);
	await db.execute(
		querySql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${querySql.param(account)},${querySql.param(tenant)},'owner',now())`,
	);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	endpoint = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await teardown();
});
test("AC:NOTIFY47-008 INV-mail: dropped acceptance replays only the identical request/key; expiry and unknown never mint another effect", async () => {
	mode = "lost";
	const id = await enqueue();
	const [claim] = await claimDue(runtime, ["mail"]);
	const n = effects.size;
	assert.deepEqual(await service.dispatch(claim), { kind: "unknown" });
	assert.equal(effects.size, n + 1);
	assert.equal(
		(await db.execute(querySql`SELECT state FROM job WHERE id=${querySql.param(claim.id)}`)).rows[0].state,
		"reconcile",
	);
	mode = "accepted";
	const before = (await db.execute(querySql`SELECT clock_timestamp()::text AS at`)).rows[0].at;
	const [again] = await claimUnknownMail(runtime, ["test/"]);
	assert.equal(again.id, claim.id);
	assert.equal(
		(
			await db.execute(
				querySql`SELECT lease_until BETWEEN ${querySql.param(before)}::timestamptz+interval '5 minutes' AND clock_timestamp()+interval '5 minutes' AS correct FROM job WHERE id=${querySql.param(again.id)}`,
			)
		).rows[0].correct,
		true,
	);
	const out = await service.dispatch(again);
	assert.equal(out.kind, "accepted");
	assert.equal(effects.size, n + 1);
	assert.deepEqual(requests.at(-1), requests.at(-2));
	assert.equal(
		(await db.execute(querySql`SELECT provider_message_id FROM mail WHERE id=${querySql.param(id)}`)).rows[0]
			.provider_message_id,
		out.id,
	);
	mode = "lost";
	const expired = await enqueue();
	const [c] = await claimDue(runtime, ["mail"]);
	await service.dispatch(c);
	await db.execute(
		querySql`UPDATE mail_request SET first_dispatched_at=clock_timestamp()-interval '24 hours' WHERE id=(SELECT request_id FROM mail_request_member WHERE mail_id=${querySql.param(expired)})`,
	);
	assert.deepEqual(await claimUnknownMail(runtime, ["test/"]), []);
	const count = requests.length;
	assert.deepEqual(await service.reconcileUnknownOutcome(expired), { kind: "unknown" });
	assert.equal(requests.length, count);
});
test("INV-mail: killing a worker after provider acceptance recovers its original request without another effect", async () => {
	mode = "hold";
	const id = await enqueue();
	const observed = new Promise((resolve) => (handedOff = resolve));
	const child = spawn(
		process.execPath,
		["--conditions=react-server", new URL("./dispatch-child.mts", import.meta.url).pathname],
		{
			stdio: "ignore",
			env: {
				...process.env,
				JOBS_TEST_CONNECTION: runtimeSettings.connectionString,
				JOBS_TEST_OPTIONS: runtimeSettings.options,
				JOBS_TEST_KEY: key.toString("base64"),
				JOBS_TEST_ENDPOINT: endpoint,
			},
		},
	);
	const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
	// The provider sees the handoff before the child ends; a child that exits first never handed off.
	try {
		const first = await Promise.race([observed.then(() => "handed_off"), exited.then(() => "handoff_not_observed")]);
		assert.equal(first, "handed_off");
	} finally {
		child.kill("SIGKILL");
	}
	assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
	const count = effects.size;
	assert.equal(
		(await db.execute(querySql`SELECT state FROM mail WHERE id=${querySql.param(id)}`)).rows[0].state,
		"dispatched",
	);
	await db.execute(
		querySql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE subject_record_id=${querySql.param(id)}`,
	);
	assert.equal(await recoverLease(runtime), 1);
	assert.equal(
		(await db.execute(querySql`SELECT state FROM mail WHERE id=${querySql.param(id)}`)).rows[0].state,
		"unknown",
	);
	mode = "accepted";
	await db.execute(querySql`UPDATE job SET next_attempt_at=NULL WHERE subject_record_id=${querySql.param(id)}`);
	const [claim] = await claimUnknownMail(runtime, ["test/"]);
	assert.equal(claim.subject_record_id, id);
	assert.equal((await service.dispatch(claim)).kind, "accepted");
	assert.equal(effects.size, count);
	assert.deepEqual(requests.at(-1), requests.at(-2));
});
test("INV-mail: protected token bytes stay encrypted and fixed content survives retries; identity and authority are checked", async () => {
	mode = "accepted";
	const token = "SYNTHETIC_SECRET_" + randomUUID();
	const content = protectedTemplate(
		{ purpose: "password_reset", url: "https://example.test/reset-password?token=" + token },
		"https://example.test",
	);
	const logical = randomUUID();
	const id = await enqueue("password_reset", content, logical);
	assert.equal(await enqueue("password_reset", content, logical), id);
	await assert.rejects(enqueue("password_reset", { ...content, text: "changed" }, logical), /mail_identity_conflict/);
	const sql = await db.execute(querySql`SELECT row_to_json(m)::text data FROM mail m WHERE id=${querySql.param(id)}`);
	assert.equal(sql.rows[0].data.includes(token), false);
	assert.equal(sql.rows[0].data.includes("synthetic@example.test"), false);
	const [claim] = await claimDue(runtime, ["mail"]);
	assert.equal((await service.dispatch(claim)).kind, "accepted");
	assert.equal(JSON.parse(requests.at(-1).payload).text, content.text);
	assert.equal(
		(await db.execute(querySql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${querySql.param(id)}`)).rows[0]
			.n,
		1,
	);
	assert.equal(
		JSON.stringify(
			(await db.execute(querySql`SELECT * FROM audit_event WHERE subject_id=${querySql.param(id)}`)).rows,
		).includes(token),
		false,
	);
	assert.throws(
		() =>
			protectedTemplate(
				{ purpose: "password_reset", url: "https://foreign.test/reset-password?token=x" },
				"https://example.test",
			),
		/invalid_purpose_link/,
	);
	const denied = await enqueue();
	await db.execute(querySql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${querySql.param(account)}`);
	const before = requests.length;
	const [c] = await claimDue(runtime, ["mail"]);
	assert.deepEqual(await service.dispatch(c), { kind: "not_dispatched" });
	assert.equal(requests.length, before);
	assert.equal(
		(await db.execute(querySql`SELECT state FROM mail WHERE id=${querySql.param(denied)}`)).rows[0].state,
		"cancelled",
	);
	await db.execute(querySql`UPDATE seat SET ended_at=NULL WHERE account_id=${querySql.param(account)}`);
});
test("INV-mail: known retryable refusals back off and exhaust exactly three retries", async () => {
	mode = "refused";
	const id = await enqueue();
	for (let attempt = 1; attempt <= 4; attempt++) {
		const [claim] = await claimDue(runtime, ["mail"]);
		assert.equal(claim.attempt_count, attempt);
		assert.deepEqual(await service.dispatch(claim), { kind: "refused", retryable: true, retryAfterSeconds: 901 });
		const state = (await db.execute(querySql`SELECT state FROM job WHERE id=${querySql.param(claim.id)}`)).rows[0]
			.state;
		assert.equal(state, attempt === 4 ? "failed" : "retry_wait");
		if (attempt < 4) {
			const delay = (
				await db.execute(
					querySql`SELECT extract(epoch FROM next_attempt_at-clock_timestamp())::int n FROM job WHERE id=${querySql.param(claim.id)}`,
				)
			).rows[0].n;
			assert.ok(delay >= (attempt === 3 ? 1199 : 900));
			await due();
		}
	}
	assert.equal(
		(
			await db.execute(
				querySql`SELECT count(*)::int n FROM mail_attempt a JOIN mail_request_member m ON m.request_id=a.request_id WHERE m.mail_id=${querySql.param(id)}`,
			)
		).rows[0].n,
		4,
	);
	mode = "accepted";
});
test("INV-mail: callbacks persist unknown IDs, reject wrong secrets, replay without send, and never regress delivery", async () => {
	const id = await enqueue();
	const [claim] = await claimDue(runtime, ["mail"]);
	const out = await service.dispatch(claim);
	assert.equal(out.kind, "accepted");
	const count = requests.length;
	const delivered = await callback(out.id, "delivered");
	const clone = delivered.clone();
	assert.deepEqual(await receiveMailCallback(runtime, delivered, secret), { stored: true, result: "applied" });
	assert.deepEqual(await receiveMailCallback(runtime, clone, secret), { stored: true, result: "duplicate" });
	await receiveMailCallback(runtime, await callback(out.id, "sent"), secret);
	await receiveMailCallback(runtime, await callback(out.id, "accepted"), secret);
	assert.equal(
		(
			await db.execute(
				querySql`SELECT state,delivered_at IS NOT NULL delivered FROM mail WHERE id=${querySql.param(id)}`,
			)
		).rows[0].state,
		"sent",
	);
	assert.equal(requests.length, count);
	const unknown = "unknown-" + randomUUID();
	assert.deepEqual(await receiveMailCallback(runtime, await callback(unknown, "delivered"), secret), {
		stored: true,
		result: "unmatched",
	});
	await db.execute(
		querySql`UPDATE mail SET provider_message_id=${querySql.param(unknown)} WHERE id=${querySql.param(id)}`,
	);
	const handler = mailCallbackHandler(runtime, "whsec_" + randomBytes(32).toString("base64"));
	const response = await handler(await callback(out.id, "sent"));
	assert.equal(response.status, 404);
	const body = await response.text();
	assert.equal(body.includes(secret), false);
	assert.equal(body.includes(out.id), false);
	const genuine = mailCallbackHandler(runtime, secret);
	const prior = (await db.execute(querySql`SELECT count(*)::int n FROM provider_event`)).rows[0].n;
	await db.execute(
		querySql`CREATE FUNCTION reject_callback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_storage_failure'; END $$; CREATE TRIGGER reject_callback BEFORE INSERT ON provider_event FOR EACH ROW EXECUTE FUNCTION reject_callback()`,
	);
	const unavailable = await genuine(await callback(unknown, "sent"));
	assert.equal(unavailable.status, 503);
	assert.equal((await db.execute(querySql`SELECT count(*)::int n FROM provider_event`)).rows[0].n, prior);
	await db.execute(querySql`DROP TRIGGER reject_callback ON provider_event; DROP FUNCTION reject_callback()`);
	await db.execute(
		querySql`CREATE FUNCTION reject_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_apply_failure'; END $$; CREATE TRIGGER reject_projection BEFORE UPDATE ON mail FOR EACH ROW EXECUTE FUNCTION reject_projection()`,
	);
	const pending = await genuine(await callback(unknown, "sent"));
	assert.equal(pending.status, 202);
	assert.deepEqual(await pending.json(), { stored: true, result: "pending" });
	// Both receipts for the late-matched message stay pending: the unmatched one and the one whose apply failed.
	assert.deepEqual(await callbackVisibility(runtime, "disabled"), { endpoint: "disabled", pending: 2, unmatched: 0 });
	await db.execute(querySql`DROP TRIGGER reject_projection ON mail; DROP FUNCTION reject_projection()`);
	assert.equal(requests.length, count);
});
test("INV-recovery: only a freshly authorized operator can attach provider evidence after the replay window", async () => {
	mode = "lost";
	const id = await enqueue();
	const [claim] = await claimDue(runtime, ["mail"]);
	assert.deepEqual(await service.dispatch(claim), { kind: "unknown" });
	const providerId = effects.get(requests.at(-1).key),
		operation = randomUUID();
	await db.execute(
		querySql`UPDATE mail_request SET first_dispatched_at=clock_timestamp()-interval '24 hours' WHERE id=(SELECT request_id FROM mail_request_member WHERE mail_id=${querySql.param(id)})`,
	);
	await db.execute(
		querySql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,occurred_at,recorded_at,request_key,metadata) VALUES(${querySql.param(operation)},${querySql.param(tenant)},${querySql.param(account)},'mail.reconciled','edit','command',${querySql.param(tenant)},now(),now(),${querySql.param(operation)},jsonb_build_object('outcome',NULL))`,
	);
	const recovery = createMailService({
		db: runtime,
		encryptionKey: key,
		addressKey: randomBytes(32),
		from: "no-reply@example.test",
		authorize,
		transport,
		authorizeRecovery: async (tx, m, p) => {
			if (m.id !== id || p !== providerId || !(await authorize(tx, [m])).has(m.id)) return null;
			const r =
				await tx.execute(querySql`SELECT g.id FROM platform_grant g JOIN audit_event o ON o.id=${querySql.param(operation)} AND o.tenant_id=${querySql.param(m.tenant)} AND o.actor_id=g.account_id
    WHERE g.account_id=${querySql.param(account)} AND g.capability='recovery_operator' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) FOR SHARE OF g`);
			return r.rowCount === 1 ? { actorId: account, operationId: operation, evidenceHash: "c".repeat(64) } : null;
		},
	});
	await assert.rejects(recovery.recordProviderReceipt(id, providerId), /recovery_unavailable/);
	await db.execute(
		querySql`INSERT INTO platform_grant(account_id,capability) VALUES(${querySql.param(account)},'recovery_operator')`,
	);
	const count = requests.length;
	assert.deepEqual(await recovery.recordProviderReceipt(id, providerId), { kind: "accepted", id: providerId });
	assert.equal(requests.length, count);
	assert.deepEqual(
		(
			await db.execute(
				querySql`SELECT actor_id,command_id,reason FROM audit_event WHERE subject_id=${querySql.param(id)} AND kind='reconcile'`,
			)
		).rows,
		[{ actor_id: account, command_id: operation, reason: "provider_receipt/" + "c".repeat(64) }],
	);
	assert.equal(
		(await db.execute(querySql`SELECT state FROM job WHERE id=${querySql.param(claim.id)}`)).rows[0].state,
		"succeeded",
	);
	mode = "accepted";
});
test("INV-mail: hard bounce suppresses even security mail; soft bounce does not", async () => {
	const id = await enqueue();
	const [c] = await claimDue(runtime, ["mail"]);
	const out = await service.dispatch(c);
	assert.equal(out.kind, "accepted");
	await receiveMailCallback(runtime, await callback(out.id, "bounced", randomUUID(), { type: "Transient" }), secret);
	assert.equal((await db.execute(querySql`SELECT count(*)::int n FROM suppression`)).rows[0].n, 0);
	await receiveMailCallback(runtime, await callback(out.id, "bounced", randomUUID(), { type: "Permanent" }), secret);
	assert.equal((await db.execute(querySql`SELECT reason FROM suppression`)).rows[0].reason, "hard_bounce");
	const next = await enqueue("password_reset");
	const [claim] = await claimDue(runtime, ["mail"]);
	const count = requests.length;
	assert.deepEqual(await service.dispatch(claim), { kind: "not_dispatched" });
	assert.equal(requests.length, count);
	assert.equal(
		(await db.execute(querySql`SELECT state FROM mail WHERE id=${querySql.param(next)}`)).rows[0].state,
		"refused",
	);
});

// T-151: every queued mail reaches the email service from the scheduled runner, and every unknown outcome settles.

/** A mail service over a recording email service: it keeps each send's idempotency key and answers with `answer`. */
function recorded(answer: () => { kind: "accepted"; id: string } | { kind: "unknown" }) {
	const keys: string[] = [];
	const svc = createMailService({
		db: runtime,
		encryptionKey: key,
		addressKey: randomBytes(32),
		from: "no-reply@example.test",
		authorize: async (_tx, list) => new Set(list.map((m) => m.id)),
		transport: {
			async send(_payload, k) {
				keys.push(k);
				return answer();
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	return { svc, keys };
}
/** One queued mail under `logicalKey`, due now, to an address no earlier test suppressed. */
function queue(svc: ReturnType<typeof recorded>["svc"], logicalKey: string, extra: Record<string, unknown> = {}) {
	return transaction(runtime, (tx) =>
		svc.enqueue(tx, {
			owner: { kind: "plant", id: tenant },
			purpose: "notification",
			logicalKey,
			recipient: account,
			address: `queued-${randomUUID()}@example.test`,
			content: { subject: "Queued", text: "safe" },
			operation: null,
			notice: null,
			eligibleAt: new Date(Date.now() - 60_000).toISOString(),
			...extra,
		} as never),
	);
}
const cron = "cron-" + randomUUID();
/** One scheduled-runner tick with only these mail passes configured. */
async function tick(mountMail: Parameters<typeof scheduledJobs>[0]["mountMail"]) {
	const response = await scheduledJobs({
		secret: cron,
		db: runtime,
		storage: null,
		cleanup: null,
		reminders: null,
		digests: null,
		mail: null,
		mountMail,
	})(new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${cron}` } }));
	return (await response.json()) as { steps: Record<string, { status: string; count?: unknown }> };
}
const passOver = (svc: ReturnType<typeof recorded>["svc"], prefixes: readonly string[]) => (limit: number, until: number) =>
	runDueMail(runtime, svc, prefixes, limit, until);
const row = async (query) => (await db.execute(query)).rows[0];

test("AC:T151-2 every logical-key prefix a mail producer writes is claimed by exactly one runner pass", () => {
	// Producers whose prefix is built at run time, by producer.
	const listed = [
		"password_reset/", // packages/domain/src/identity/service.ts: `${purpose}/${digest(token)}` and the outcome notice
		"email_verification/", // packages/domain/src/identity/service.ts: `${purpose}/${digest(token)}`
		"digest/", // apps/web/src/server/jobs/digest.ts: MAIL_KEY + the digest notice's key
		"notice/", // apps/web/src/server/jobs/notifications.ts: "notice/" + the notice id (tasks, phases, meetings, milestones)
	];
	// Every literal prefix in a producer's mail intent: `logicalKey: "x/..."` or `logicalKey: \`x/...\``.
	const root = new URL("../../../", import.meta.url).pathname;
	const files = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path);
			return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
		});
	const literal = new Set<string>();
	for (const file of [...files(join(root, "apps/web/src")), ...files(join(root, "packages/domain/src"))])
		for (const m of readFileSync(file, "utf8").matchAll(/logicalKey:\s*[`"']([a-z_-]+\/)/g)) literal.add(m[1]!);
	// Messages email (communication/) is handed off by its own runner step and Messages screens, not a mail pass.
	literal.delete("communication/");
	const prefixes = [...new Set([...listed, ...literal])].sort();
	assert.ok(prefixes.length >= 12, prefixes.join(" "));
	for (const prefix of prefixes) {
		const passes = Object.entries(MAIL_PASSES).filter(([, owned]) => (owned as readonly string[]).includes(prefix));
		assert.equal(passes.length, 1, `${prefix} is claimed by ${passes.map(([name]) => name).join(", ") || "no pass"}`);
	}
	// And no pass claims a prefix nothing writes.
	assert.deepEqual(Object.values(MAIL_PASSES).flat().sort(), prefixes);
});

test("AC:T151-3 a seeded backlog of dead links and past reminders sends none of it on the first tick; fresh mail still goes", async () => {
	const { svc, keys } = recorded(() => ({ kind: "accepted", id: randomUUID() }));
	const deadReset = await queue(svc, `password_reset/${randomUUID()}`, { purpose: "password_reset" });
	const deadVerify = await queue(svc, `email_verification/${randomUUID()}`, { purpose: "email_verification" });
	const resetOutcome = await queue(svc, `password_reset/outcome/${randomUUID()}`, { purpose: "password_reset" });
	const freshReset = await queue(svc, `password_reset/${randomUUID()}`, { purpose: "password_reset" });
	const notice = randomUUID(),
		task = randomUUID();
	await db.execute(querySql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date)
		VALUES(${querySql.param(task)},${querySql.param(tenant)},'Call','general','medium','not_started',clock_timestamp(),
		'date_only',(clock_timestamp()-interval '2 days')::date)`);
	await db.execute(querySql`INSERT INTO notice(id,tenant_id,recipient_id,category,purpose,logical_key,source_record_id,
		source_revision,title,eligible_at,created_at) VALUES(${querySql.param(notice)},${querySql.param(tenant)},${querySql.param(account)},
		'task','task_due',${"task/task_due/" + randomUUID()},${querySql.param(task)},1,'Task due',
		clock_timestamp()-interval '2 days',clock_timestamp())`);
	const pastReminder = await queue(svc, `notice/${notice}`, { notice });
	// The links were requested two hours ago (they work for one); the reminder's slot was two days ago.
	await db.execute(querySql`UPDATE mail SET created_at=clock_timestamp()-interval '2 hours'
		WHERE id=ANY(${querySql.param([deadReset, deadVerify, resetOutcome])}::uuid[])`);
	await db.execute(querySql`UPDATE job SET eligible_at=clock_timestamp()-interval '2 days'
		WHERE subject_record_id=${querySql.param(pastReminder)}`);

	const { steps } = await tick({ identity: passOver(svc, MAIL_PASSES.identity), notice: passOver(svc, MAIL_PASSES.notice) });
	assert.deepEqual(steps["mail-expiry"], { status: "ok", count: 3 });
	assert.deepEqual(steps["identity-mail"], { status: "ok", count: 2 });
	assert.deepEqual(steps["notice-mail"], { status: "ok", count: 0 });
	assert.equal(keys.length, 2, "only the fresh link and the reset's outcome notice reached the email service");
	const states = async (ids: string[]) =>
		(
			await db.execute(querySql`SELECT m.state, j.state AS job, j.error_code FROM mail m JOIN job j ON j.id=m.job_id
				WHERE m.id=ANY(${querySql.param(ids)}::uuid[])`)
		).rows;
	for (const r of await states([deadReset, deadVerify, pastReminder]))
		assert.deepEqual(r, { state: "cancelled", job: "cancelled", error_code: "stale" });
	for (const r of await states([freshReset, resetOutcome])) assert.equal(r.state, "accepted");
});

test("AC:T151-4 an unknown handoff is replayed on the next tick under the same key, only inside the provider window", async () => {
	let answer: { kind: "accepted"; id: string } | { kind: "unknown" } = { kind: "unknown" };
	const { svc, keys } = recorded(() => answer);
	const pass = { identity: passOver(svc, ["replay/"]) };
	const id = await queue(svc, `replay/${randomUUID()}`);
	assert.deepEqual((await tick(pass)).steps["identity-mail"], { status: "ok", count: 1 });
	assert.equal(keys.length, 1);
	assert.deepEqual(
		await row(querySql`SELECT m.state, j.state AS job FROM mail m JOIN job j ON j.id=m.job_id WHERE m.id=${querySql.param(id)}`),
		{ state: "unknown", job: "reconcile" },
	);
	answer = { kind: "accepted", id: "replayed-" + randomUUID() };
	assert.deepEqual((await tick(pass)).steps["identity-mail"], { status: "ok", count: 1 });
	assert.equal(keys.length, 2);
	assert.equal(keys[1], keys[0], "the replay carries the first handoff's idempotency key");
	assert.deepEqual(
		await row(querySql`SELECT m.state, m.provider_message_id AS provider, j.state AS job FROM mail m JOIN job j ON j.id=m.job_id
			WHERE m.id=${querySql.param(id)}`),
		{ state: "accepted", provider: answer.id, job: "succeeded" },
	);

	// Past the window (23 h 55 min from the first handoff) the mail is not replayed and its job is not left claimed.
	answer = { kind: "unknown" };
	const late = await queue(svc, `replay/${randomUUID()}`);
	await tick(pass);
	assert.equal(keys.length, 3);
	await db.execute(querySql`UPDATE mail_request SET first_dispatched_at=clock_timestamp()-interval '23 hours 56 minutes'
		WHERE id=(SELECT request_id FROM mail_request_member WHERE mail_id=${querySql.param(late)})`);
	answer = { kind: "accepted", id: "too-late-" + randomUUID() };
	assert.deepEqual((await tick(pass)).steps["identity-mail"], { status: "ok", count: 0 });
	assert.equal(keys.length, 3);
	assert.deepEqual(
		await row(querySql`SELECT m.state, j.state AS job, j.lease_owner FROM mail m JOIN job j ON j.id=m.job_id
			WHERE m.id=${querySql.param(late)}`),
		{ state: "unknown", job: "reconcile", lease_owner: null },
	);
});

test("AC:T151-5 a stored callback whose email had no provider id yet is applied on the first tick after it gets one", async () => {
	const providerId = "early-" + randomUUID();
	assert.deepEqual(await receiveMailCallback(runtime, await callback(providerId, "delivered"), secret), {
		stored: true,
		result: "unmatched",
	});
	const { svc } = recorded(() => ({ kind: "accepted", id: providerId }));
	const id = await queue(svc, `callback/${randomUUID()}`);
	const { steps } = await tick({ identity: passOver(svc, ["callback/"]) });
	assert.deepEqual(steps["identity-mail"], { status: "ok", count: 1 });
	assert.deepEqual(steps["mail-callbacks"], { status: "ok", count: 1 });
	assert.deepEqual(
		await row(querySql`SELECT state, provider_message_id AS provider, delivered_at IS NOT NULL AS delivered FROM mail
			WHERE id=${querySql.param(id)}`),
		{ state: "sent", provider: providerId, delivered: true },
	);
});

test("AC:T151-7 an Unsubscribe link minted before the account's first cadence save still unsubscribes after it", async () => {
	const ring = { current: randomBytes(32), previous: [] };
	const api = createNotificationProducer({ optOutKeys: ring });
	const reader = await seeds(db).actor({ kind: "plant", id: tenant } as never, "admin");
	// The digest email sent before any preference row exists carries revision 0 (mail.ts live()).
	const token = issueMailOptOutToken(ring, {
		accountId: reader.id,
		category: "planter_digest",
		unsubscribeRevision: "0",
		iat: new Date().toISOString(),
	});
	const actor = await RequestActor.resolve(runtime, sessionId.parse(reader.session));
	const before = ok(await api.getPreferences(runtime, actor, {}));
	ok(
		await api.setDigestCadence(runtime, actor, {
			requestKey: randomUUID(),
			expectedRevision: before.revision,
			input: { plantId: tenant, cadence: "weekly" },
		}),
	);
	const saved = await row(querySql`SELECT unsubscribe_revision::text AS rev, enabled FROM notification_preference
		WHERE account_id=${querySql.param(reader.id)} AND category='planter_digest' AND channel='email'`);
	assert.deepEqual(saved, { rev: "0", enabled: true });
	const out = ok(await api.applyEmailOptOut(runtime, { token }));
	assert.equal(out.changed, true);
	assert.equal(
		(
			await row(querySql`SELECT enabled FROM notification_preference
				WHERE account_id=${querySql.param(reader.id)} AND category='planter_digest' AND channel='email'`)
		).enabled,
		false,
	);
});
