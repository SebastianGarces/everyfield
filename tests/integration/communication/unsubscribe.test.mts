import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createNotificationProducer } from "../../../packages/domain/src/notifications/index.ts";
import { issueEmailOptOutToken } from "../../../packages/domain/src/notifications/opt-out.ts";
import { GET as outboxRoute } from "../../../apps/web/src/app/api/dev/outbox/route.ts";
import { readOutbox } from "../../../apps/web/src/features/communication/outbox.ts";
import { createMailService, mailPurpose, mailUnsubscribe } from "../../../packages/domain/src/jobs/mail.ts";
import { createNotificationService } from "../../../packages/domain/src/jobs/notifications.ts";
import { claimDue } from "../../../packages/domain/src/jobs/queue.ts";
import { createResendTransport } from "../../../apps/web/src/server/jobs/resend.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { requestDatabase } from "../../../apps/web/src/server/database.ts";
import { ok, refused } from "../../support/fixture.mts";
import { recorded, NOTHING, untouched } from "../../support/recorded.mts";
import { setServerEnv } from "../../support/server-env.mts";
import { db, runtime, runtimeSettings, setup, teardown, tenant } from "../jobs/support.mts";
import { caseOf } from "./communication-support.mts";

const web = new URL("../../../apps/web/src/", import.meta.url).href;
registerHooks({
	resolve: (specifier, context, next) =>
		next(specifier.startsWith("@/") ? `${web}${specifier.slice(2)}.ts` : specifier, context),
});
const { POST: oneClick } = await import("../../../apps/web/src/features/notifications/one-click.ts");

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
async function dispatchAll(mail: ReturnType<typeof createMailService>) {
	const before = requests.length;
	await db.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE kind='mail' AND state='ready'`,
	);
	for (let [claim] = await claimDue(runtime, ["mail"]); claim; [claim] = await claimDue(runtime, ["mail"]))
		await mail.dispatch(claim);
	return requests.slice(before).map((r) => r.body);
}
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

test("AC:CASE-NTF-012 a task-due email ends with Unsubscribe and settings links and carries the RFC 8058 headers with the same token", async () => {
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
	assert.deepEqual(email.headers, {
		"List-Unsubscribe": `<${ORIGIN}/email-preferences/${token}/one-click>`,
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	});
	assert.equal(headerToken(email), token);
	assert.deepEqual((({ purpose, accountId, category }) => ({ purpose, accountId, category }))(claimOf(token)), {
		purpose: "disable",
		accountId: account,
		category: "task_due",
	});
});

test("AC:CASE-NTF-012 a retried send of the same mail repeats the same body under its idempotency key", async () => {
	await notify(linked, "task_overdue");
	await db.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE kind='mail' AND state='ready'`,
	);
	const [claim] = await claimDue(runtime, ["mail"]);
	assert.ok(claim);
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

test("AC:CASE-NTF-012 AC:TARGET-IDN-028 one-click with the header's token turns off task-due email only; the page alone changes nothing", async () => {
	await notify(linked, "task_due");
	const [email] = await dispatchAll(linked);
	assert.ok(email);
	const token = headerToken(email);
	assert.ok(token);
	const described = await producer.describeEmailOptOut(runtime, { token: pageToken(email) });
	assert.equal(described.status, "ok", JSON.stringify(described));
	assert.deepEqual(
		(({ category, emailEnabled, changed }) => ({ category, emailEnabled, changed }))(
			(described as { value: { category: string; emailEnabled: boolean; changed: boolean } }).value,
		),
		{ category: "task_due", emailEnabled: true, changed: false },
	);
	assert.equal(await emailPref("task_due"), null);
	const code = (reply: { status: string }) =>
		"error" in reply ? (reply.error as { code: string }).code : reply.status;
	const forged = Buffer.from(token, "base64url");
	forged[20]! ^= 1;
	const stranger = issueEmailOptOutToken(randomBytes(32), { ...claimOf(token), purpose: "disable" } as never);
	for (const bad of [forged.toString("base64url"), stranger, "x".repeat(token.length)])
		for (const use of [producer.describeEmailOptOut, producer.applyEmailOptOut, producer.undoEmailOptOut])
			assert.equal(code(await use(runtime, { token: bad })), "access_denied");
	assert.equal(
		code(await producer.undoEmailOptOut(runtime, { token })),
		"access_denied",
		"a token with another purpose",
	);
	assert.equal(await emailPref("task_due"), null);
	const clicked = await producer.applyEmailOptOut(runtime, { token });
	assert.equal(clicked.status, "ok", JSON.stringify(clicked));
	assert.equal((clicked as { value: { changed: boolean; emailEnabled: boolean } }).value.changed, true);
	const { undoToken } = (clicked as { value: { undoToken: string | null } }).value;
	assert.ok(undoToken);
	assert.equal(code(await producer.applyEmailOptOut(runtime, { token: undoToken })), "access_denied");
	const repeat = await producer.applyEmailOptOut(runtime, { token });
	assert.equal(repeat.status, "ok", JSON.stringify(repeat));
	assert.equal((repeat as { value: { changed: boolean; emailEnabled: boolean } }).value.emailEnabled, false);
	assert.equal(await emailPref("task_due"), false);
	assert.equal(await emailPref("task_overdue"), null);

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

test("AC:CASE-NTF-012 AC:CASE-NTF-013 security, invitation and receipt mail carries no Unsubscribe link and no List-Unsubscribe headers", async () => {
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

test("AC:CASE-NTF-012 with no NOTIFICATION_OPT_OUT_KEYS the notification still goes, without link or headers", async () => {
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

test("AC:CASE-NTF-012 a captured notification records its List-Unsubscribe headers, and the dev outbox shows them", async () => {
	const outbox = mkdtempSync(join(tmpdir(), "t25-outbox-"));
	const saved = process.env.EVERYFIELD_DEV_OUTBOX;
	process.env.EVERYFIELD_DEV_OUTBOX = outbox;
	try {
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

test("AC:CASE-NTF-012 no token reaches a job error or an audit row", async () => {
	const rows = await db.execute(
		sql`SELECT coalesce(error_code,'') AS v FROM job UNION ALL SELECT coalesce(reason,'')||coalesce(metadata::text,'')||coalesce(event_key,'') FROM audit_event`,
	);
	for (const r of rows.rows as { v: string }[])
		assert.ok(!r.v.includes("email-preferences") && !/[\w-]{80,}/.test(r.v), r.v);
});

test("AC:CASE-NTF-012 a link at its 180-day end, a page open, a wrong or altered token and an undo at one hour change nothing; one explicit POST turns off that category's email and never the bell", async () => {
	const { expected, given, clock } = caseOf("CASE-NTF-012");
	const { result } = expected;
	const inputs = given["behavior-inputs"] as { disable_expires: string; now: string; method: string };
	const at = Date.parse(inputs.now);
	assert.deepEqual([inputs.now, inputs.disable_expires], [clock.now, clock.now]);
	const time = { at };
	const api = createNotificationProducer({ optOutKeys: ring, now: () => new Date(time.at) });
	const user = randomUUID(),
		reader = randomUUID();
	await db.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${`reader-${reader}@example.test`},true,'Alex')`,
	);
	await db.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${reader},${user},'active','planter')`,
	);
	await db.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
		VALUES(${reader},'task_due','in_app',true,0),(${reader},'task_overdue','in_app',false,0)`);
	const choices = async (channel: string) =>
		(
			await db.execute(
				sql`SELECT category,enabled FROM notification_preference WHERE account_id=${reader} AND channel=${channel} ORDER BY category`,
			)
		).rows;
	const bell = await choices("in_app");
	const claim = { accountId: reader, category: "task_due", unsubscribeRevision: "0" } as const;
	const token = (over: object = {}, key: typeof ring | Buffer = ring) =>
		issueEmailOptOutToken(key, { ...claim, purpose: "disable", iat: inputs.now, ...over } as never);
	const exact = token({ iat: new Date(at - 180 * 86_400_000).toISOString(), exp: inputs.disable_expires });
	const live = token();
	const tooLong = token({ exp: new Date(at + 180 * 86_400_000 + 1).toISOString() });
	const undoNow = token({ purpose: "undo", exp: inputs.now, iat: new Date(at - 3_600_000).toISOString() });
	const undoTooLong = token({ purpose: "undo", exp: new Date(at + 3_600_001).toISOString() });
	const oldKey = randomBytes(32);
	const flipped = Buffer.from(live, "base64url");
	flipped[20]! ^= 1;

	setServerEnv({ IDENTITY_DATABASE_URL: runtimeSettings.connectionString });
	process.env.NOTIFICATION_OPT_OUT_KEYS = ring.current.toString("base64");
	mock.timers.enable({ apis: ["Date"], now: at });
	const post = async (path: string, body = "List-Unsubscribe=One-Click") =>
		(
			await oneClick(
				new Request(`${ORIGIN}/email-preferences/${path}/one-click`, {
					method: "POST",
					body,
					headers: { "content-type": "application/x-www-form-urlencoded" },
				}),
				{ params: Promise.resolve({ token: path }) },
			)
		).status;
	const opened = async (path: string) => {
		const view = ok(await api.describeEmailOptOut(runtime, { token: path }));
		return [view.purpose, view.expired, view.changed, view.emailEnabled, view.inAppEnabled];
	};
	try {
		await untouched(db, async () => {
			const described = ok(await api.describeEmailOptOut(runtime, { token: exact }));
			assert.deepEqual(
				[described.expired, described.changed, described.emailEnabled, described.inAppEnabled],
				[true, result.expired_change, true, true],
			);
			const applied = ok(await api.applyEmailOptOut(runtime, { token: exact }));
			assert.deepEqual(
				[applied.expired, applied.changed, applied.emailEnabled, applied.undoToken],
				[true, result.expired_change, true, null],
			);
			const undone = ok(await api.undoEmailOptOut(runtime, { token: undoNow }));
			assert.deepEqual([undone.expired, undone.changed], [true, result.expired_change], "an undo at its hour");
			time.at = at - 1;
			assert.equal(ok(await api.describeEmailOptOut(runtime, { token: exact })).expired, false);
			time.at = at;

			assert.equal(inputs.method, "GET");
			for (let scan = 0; scan < 3; scan++)
				assert.deepEqual(await opened(live), ["disable", false, result.GET_change, true, true]);
			assert.deepEqual(await opened(exact), ["disable", true, result.GET_change, true, true]);
			assert.deepEqual(await opened(undoNow), ["undo", true, result.GET_change, true, true]);

			assert.deepEqual(
				[await post(exact), await post(live, ""), await post(live, "List-Unsubscribe=No")],
				[410, 400, 400],
			);
			for (const bad of [
				flipped.toString("base64url"),
				token({}, randomBytes(32)),
				token({}, { current: oldKey, previous: [] }),
				tooLong,
				undoTooLong,
				undoNow,
				"x".repeat(live.length),
			]) {
				refused(await api.applyEmailOptOut(runtime, { token: bad }), "access_denied");
				assert.equal(await post(bad), 403);
			}
			for (const bad of [live, exact, flipped.toString("base64url"), undoTooLong])
				refused(await api.undoEmailOptOut(runtime, { token: bad }), "access_denied");
			refused(await api.applyEmailOptOut(runtime, { token: "" }), "invalid_input");
		});
		assert.deepEqual([await choices("email"), await choices("in_app")], [[], bell]);

		const rotated = createNotificationProducer({
			optOutKeys: { current: randomBytes(32), previous: [oldKey] },
			now: () => new Date(time.at),
		});
		const underOld = token({ category: "task_overdue" }, { current: oldKey, previous: [] });
		time.at = at + 180 * 86_400_000 - 1;
		const kept = ok(await rotated.applyEmailOptOut(runtime, { token: underOld }));
		assert.deepEqual(
			[kept.changed, kept.inAppEnabled],
			[true, false],
			"an old key still opens its own link to its end",
		);
		time.at = at;

		const { value, added } = await recorded(db, () => post(live));
		assert.deepEqual([value, added], [200, { ...NOTHING, audits: ["settings.changed"] }], "one POST, one saved choice");
		const off = [
			{ category: "task_due", enabled: false },
			{ category: "task_overdue", enabled: false },
		];
		assert.deepEqual(await choices("email"), off);
		const again = ok(await api.applyEmailOptOut(runtime, { token: live }));
		assert.deepEqual([again.changed, again.emailEnabled], [false, false]);
		assert.ok(again.undoToken);
		time.at = at + 3_600_000;
		const late = ok(await api.undoEmailOptOut(runtime, { token: again.undoToken }));
		assert.deepEqual([late.expired, late.changed], [true, result.expired_change]);
		assert.deepEqual(await choices("email"), off);
		time.at = at + 3_600_000 - 1;
		const inTime = ok(await api.undoEmailOptOut(runtime, { token: again.undoToken }));
		assert.deepEqual([inTime.expired, inTime.changed, inTime.emailEnabled], [false, true, true]);
		assert.equal(JSON.stringify(await choices("in_app")) !== JSON.stringify(bell), result.in_app_changed);
	} finally {
		mock.timers.reset();
		delete process.env.NOTIFICATION_OPT_OUT_KEYS;
		await closeDatabase(requestDatabase() as never);
	}
});
