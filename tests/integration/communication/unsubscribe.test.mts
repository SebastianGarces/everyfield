// Unsubscribe links and List-Unsubscribe headers (T-25, REQ-NTF-012). A task-due notification goes through the real
// notification service, mail dispatch and Resend transport; a fake of the Resend HTTP API records each provider
// request. The tokens the tests use are read back from those requests, never minted by the test.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createNotificationProducer } from "../../../packages/domain/src/notifications/index.ts";
import { GET as outboxRoute } from "../../../apps/web/src/app/api/dev/outbox/route.ts";
import { readOutbox } from "../../../apps/web/src/features/communication/outbox.ts";
import { createMailService, mailPurpose, mailUnsubscribe } from "../../../apps/web/src/server/jobs/mail.ts";
import { createNotificationService } from "../../../apps/web/src/server/jobs/notifications.ts";
import { claimDue } from "../../../apps/web/src/server/jobs/queue.ts";
import { createResendTransport } from "../../../apps/web/src/server/jobs/resend.ts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { db, runtime, setup, teardown, tenant } from "../jobs/support.mts";

const ORIGIN = "https://app.everyfield.test";
const ring = { current: randomBytes(32), previous: [] };
const producer = createNotificationProducer({ optOutKeys: ring });
const keys = { encryptionKey: randomBytes(32), addressKey: randomBytes(32) };
const PRODUCTION = { VERCEL_ENV: "production" };

type Sent = { from: string; to: string; subject: string; text: string; html: string; headers?: Record<string, string> };
const requests: { idempotencyKey: string | null; body: Sent }[] = [];
async function provider(_input: string | URL | Request, init: RequestInit = {}) {
	requests.push({
		idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
		body: JSON.parse(String(init.body)) as Sent,
	});
	return Response.json({ id: `re-${randomUUID()}` });
}

/** Every mail service in this file shares the allow-all authorizer: the tests are about rendering, not authority. */
function service(
	unsubscribe: Parameters<typeof createMailService>[0]["unsubscribe"],
	env: Record<string, string> = PRODUCTION,
) {
	return createMailService({
		db: runtime,
		...keys,
		from: "no-reply@example.test",
		authorize: async (_tx, list) => new Set(list.map((m) => m.id)),
		transport: createResendTransport("re_test_key", provider, env),
		unsubscribe,
	});
}
const linked = service({ origin: ORIGIN, keys: ring });

const account = randomUUID(),
	address = `planter-${account.slice(0, 8)}@example.test`,
	task = randomUUID();

/** Queue one notice for the planter through the notification service. */
async function notify(mail: ReturnType<typeof createMailService>, category: "task_due" | "task_overdue") {
	const notifications = createNotificationService({
		mail,
		eligible: async (_tx, list) => list.map(() => ({ address })),
	});
	await transaction(runtime, (tx) =>
		notifications.enqueueMany(tx, [
			{
				owner: { kind: "plant", id: tenant },
				source: { kind: "task", id: task, revision: "1" },
				recipient: account,
				category,
				occurrence: randomUUID(),
				eligibleAt: new Date(Date.now() - 1000).toISOString(),
				title: category === "task_due" ? "Task due: Book the venue" : "Task overdue: Book the venue",
				text: "Book the venue is due.",
				operation: null,
			},
		]),
	);
}
/** Dispatch every due mail job with `mail`; returns the provider requests they made. */
async function dispatchAll(mail: ReturnType<typeof createMailService>) {
	const before = requests.length;
	await db.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE kind='mail' AND state='ready'`,
	);
	for (let [claim] = await claimDue(runtime, ["mail"]); claim; [claim] = await claimDue(runtime, ["mail"]))
		await mail.dispatch(claim);
	return requests.slice(before).map((r) => r.body);
}
/** Opens a token with the ring: the account and category it names. */
function claimOf(token: string) {
	const bytes = Buffer.from(token, "base64url");
	const decipher = createDecipheriv("aes-256-gcm", ring.current, bytes.subarray(0, 12));
	decipher.setAuthTag(bytes.subarray(12, 28));
	return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as {
		purpose: string;
		accountId: string;
		category: string;
	};
}
const pageToken = (email: Sent) =>
	/\nUnsubscribe: https:\/\/app\.everyfield\.test\/email-preferences\/([\w-]+)\n/.exec(email.text)?.[1];
const headerToken = (email: Sent) =>
	/^<https:\/\/app\.everyfield\.test\/email-preferences\/([\w-]+)\/one-click>$/.exec(
		email.headers?.["List-Unsubscribe"] ?? "",
	)?.[1];
const emailPref = async (category: string) =>
	(
		await db.execute(
			sql`SELECT enabled FROM notification_preference WHERE account_id=${account} AND category=${category} AND channel='email'`,
		)
	).rows[0]?.enabled ?? null;

before(async () => {
	await setup();
	const user = randomUUID();
	await db.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${address},true,'Pia Planter')`,
	);
	await db.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${account},${user},'active','planter')`,
	);
	await db.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${account},${tenant},'owner',now())`,
	);
	await db.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date)
		VALUES(${task},${tenant},'Book the venue','general','medium','not_started',now(),'date_only','2026-11-20')`);
	await db.execute(sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${tenant},${task},${account})`);
});
after(teardown);

test("T-25 criteria 1, 3: a task-due email ends with Unsubscribe and settings links and carries the RFC 8058 headers with the same token", async () => {
	await notify(linked, "task_due");
	const [email, ...rest] = await dispatchAll(linked);
	assert.equal(rest.length, 0);
	assert.ok(email);
	const token = pageToken(email);
	assert.ok(token, email.text);
	assert.ok(
		email.text.endsWith(
			`\n\n--\nUnsubscribe: ${ORIGIN}/email-preferences/${token}\nNotification settings: ${ORIGIN}/settings/notifications`,
		),
		email.text,
	);
	assert.ok(
		email.html.endsWith(
			`<hr><p><a href="${ORIGIN}/email-preferences/${token}">Unsubscribe</a> · <a href="${ORIGIN}/settings/notifications">Notification settings</a></p>`,
		),
		email.html,
	);
	// Criterion 3: the exact headers in the provider request body, with the visible link's token.
	assert.deepEqual(email.headers, {
		"List-Unsubscribe": `<${ORIGIN}/email-preferences/${token}/one-click>`,
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	});
	assert.equal(headerToken(email), token);
	// The token names this account and the email's own category.
	assert.deepEqual((({ purpose, accountId, category }) => ({ purpose, accountId, category }))(claimOf(token)), {
		purpose: "disable",
		accountId: account,
		category: "task_due",
	});
});

test("T-25: a retried send of the same mail repeats the same body under its idempotency key", async () => {
	await notify(linked, "task_overdue");
	await db.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE kind='mail' AND state='ready'`,
	);
	const [claim] = await claimDue(runtime, ["mail"]);
	assert.ok(claim);
	// The first request times out: the send is unknown. The retry must send the same body.
	const retry = service({ origin: ORIGIN, keys: ring });
	const first = requests.length;
	const lost = createMailService({
		db: runtime,
		...keys,
		from: "no-reply@example.test",
		authorize: async (_tx, list) => new Set(list.map((m) => m.id)),
		transport: createResendTransport(
			"re_test_key",
			async (input, init) => {
				await provider(input, init);
				throw new Error("timeout");
			},
			PRODUCTION,
		),
		unsubscribe: { origin: ORIGIN, keys: ring },
	});
	assert.deepEqual(await lost.dispatch(claim), { kind: "unknown" });
	await db.execute(sql`UPDATE job SET state='ready',next_attempt_at=NULL WHERE id=${claim.id}`);
	await db.execute(sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE id=${claim.id}`);
	const [again] = await claimDue(runtime, ["mail"]);
	assert.ok(again);
	await retry.dispatch(again);
	const [a, b] = requests.slice(first);
	assert.ok(a && b);
	assert.equal(a.idempotencyKey, b.idempotencyKey);
	assert.deepEqual(a.body, b.body);
	assert.equal(claimOf(pageToken(a.body)!).category, "task_overdue");
});

test("T-25 criteria 2, 4: one-click with the header's token turns off task-due email only; the page alone changes nothing", async () => {
	await notify(linked, "task_due");
	const [email] = await dispatchAll(linked);
	assert.ok(email);
	const token = headerToken(email);
	assert.ok(token);
	// Opening the link shows the confirm page for task due and changes nothing (a GET reaches only this read).
	const described = await producer.describeEmailOptOut(runtime, undefined as never, { token: pageToken(email) });
	assert.equal(described.status, "ok", JSON.stringify(described));
	assert.deepEqual(
		(({ category, emailEnabled, changed }) => ({ category, emailEnabled, changed }))(
			(described as { value: { category: string; emailEnabled: boolean; changed: boolean } }).value,
		),
		{ category: "task_due", emailEnabled: true, changed: false },
	);
	assert.equal(await emailPref("task_due"), null);
	// The mail client's one-click POST: email off; a repeat is harmless.
	const clicked = await producer.applyEmailOptOut(runtime, { token, oneClick: true });
	assert.equal(clicked.status, "ok", JSON.stringify(clicked));
	assert.equal((clicked as { value: { changed: boolean; emailEnabled: boolean } }).value.changed, true);
	const repeat = await producer.applyEmailOptOut(runtime, { token, oneClick: true });
	assert.equal(repeat.status, "ok", JSON.stringify(repeat));
	assert.equal((repeat as { value: { changed: boolean; emailEnabled: boolean } }).value.emailEnabled, false);
	assert.equal(await emailPref("task_due"), false);
	assert.equal(await emailPref("task_overdue"), null);

	// The next task-due notice reaches the bell and not the inbox; task overdue still emails.
	await notify(linked, "task_due");
	await notify(linked, "task_overdue");
	const next = await dispatchAll(linked);
	assert.deepEqual(
		next.map((m) => m.subject),
		["Task overdue: Book the venue"],
	);
	const bell = await db.execute(
		sql`SELECT count(*)::int AS n FROM notice WHERE recipient_id=${account} AND purpose='task_due' AND logical_key LIKE ${"%/task_due/%"} AND archived_at IS NULL`,
	);
	assert.equal(bell.rows[0]!.n, 3, "every task-due notice reached the bell");
});

test("T-25 criterion 6: security, invitation and receipt mail carries no Unsubscribe link and no List-Unsubscribe headers", async () => {
	const purposes = [
		"password_reset",
		"email_verification",
		"email_change",
		"seat_invitation",
		"relationship_invitation",
		"discovery_receipt",
		"relationship_receipt",
	] as const;
	for (const purpose of purposes) mailPurpose.parse(purpose);
	await transaction(runtime, (tx) =>
		linked.enqueueMany(
			tx,
			purposes.map((purpose) => ({
				owner: { kind: "account", id: account },
				purpose,
				logicalKey: `t25/${purpose}/${randomUUID()}`,
				recipient: account,
				address,
				content: { subject: purpose, text: `The ${purpose} email.` },
				operation: null,
				notice: null,
				eligibleAt: new Date(Date.now() - 1000).toISOString(),
			})),
		),
	);
	const sent = await dispatchAll(linked);
	assert.deepEqual(sent.map((m) => m.subject).sort(), [...purposes].sort());
	for (const m of sent) {
		assert.equal(m.headers, undefined, m.subject);
		assert.equal(m.text, `The ${m.subject} email.`);
		assert.ok(!m.html.includes("Unsubscribe"), m.subject);
	}
});

test("T-25 criterion 7: with no NOTIFICATION_OPT_OUT_KEYS the notification still goes, without link or headers", async () => {
	assert.equal(mailUnsubscribe({ IDENTITY_ORIGIN: ORIGIN }), null);
	assert.equal(mailUnsubscribe({ IDENTITY_ORIGIN: ORIGIN, NOTIFICATION_OPT_OUT_KEYS: "not-a-key" }), null);
	const bare = service(mailUnsubscribe({ IDENTITY_ORIGIN: ORIGIN }));
	await notify(bare, "task_overdue");
	const [email, ...rest] = await dispatchAll(bare);
	assert.equal(rest.length, 0);
	assert.equal(email?.subject, "Task overdue: Book the venue");
	assert.equal(email.headers, undefined);
	assert.equal(email.text, "Book the venue is due.");
	assert.ok(!email.html.includes("email-preferences"));
});

test("T-25 criterion 8: a captured notification records its List-Unsubscribe headers, and the dev outbox shows them", async () => {
	const outbox = mkdtempSync(join(tmpdir(), "t25-outbox-"));
	const saved = process.env.EVERYFIELD_DEV_OUTBOX;
	process.env.EVERYFIELD_DEV_OUTBOX = outbox;
	try {
		// Not production, and the address is not approved: the transport captures instead of calling the provider.
		const captured = service({ origin: ORIGIN, keys: ring }, {});
		await notify(captured, "task_overdue");
		const before = requests.length;
		await dispatchAll(captured);
		assert.equal(requests.length, before, "a capture never reaches the provider");
		const [entry] = await readOutbox(outbox);
		const token = entry && headerToken(entry);
		assert.ok(token);
		assert.deepEqual(entry.headers, {
			"List-Unsubscribe": `<${ORIGIN}/email-preferences/${token}/one-click>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		});
		assert.equal(pageToken(entry), token);
		const page = await (await outboxRoute(new Request("http://localhost/api/dev/outbox"))).text();
		assert.ok(page.includes(`List-Unsubscribe: &#60;${ORIGIN}/email-preferences/${token}/one-click&#62;`), page);
		assert.ok(page.includes("List-Unsubscribe-Post: List-Unsubscribe=One-Click"), page);
	} finally {
		if (saved === undefined) delete process.env.EVERYFIELD_DEV_OUTBOX;
		else process.env.EVERYFIELD_DEV_OUTBOX = saved;
		rmSync(outbox, { recursive: true, force: true });
	}
});

test("T-25 criterion 9: no token reaches a job error or an audit row", async () => {
	const rows = await db.execute(
		sql`SELECT coalesce(error_code,'') AS v FROM job UNION ALL SELECT coalesce(reason,'')||coalesce(metadata::text,'')||coalesce(event_key,'') FROM audit_event`,
	);
	for (const r of rows.rows as { v: string }[])
		assert.ok(!r.v.includes("email-preferences") && !/[\w-]{80,}/.test(r.v), r.v);
});
