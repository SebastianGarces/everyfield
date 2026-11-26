import { appModule } from "./security-web.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { assertDevelopmentDatabase } from "../../../../packages/db/src/development.ts";
import { deploymentKind, isTestDeployment } from "../../../../packages/db/src/deployment.ts";
import { mailRecipientAllowed } from "../../../../packages/domain/src/mail-recipients.ts";
import { seedRefusal } from "../../../../tools/qa/qa-guard.ts";
import { testDatabase } from "../../../support/test-database.mts";
import * as identity from "../../identity/support.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);

let web: Awaited<ReturnType<typeof identity.fixture>>;
before(async () => {
	web = await identity.fixture();
});
after(() => web?.close());
const one = async (query: SQL) => (await web.db.execute(query)).rows[0] as Record<string, unknown>;

type Webhook = (request: Request, db: () => unknown, secret: string) => Promise<Response>;
const SECRET = `whsec_${randomBytes(32).toString("base64")}`;
const sign = (id: string, stamp: number, body: string, secret = SECRET) =>
	`v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
		.update(`${id}.${stamp}.${body}`)
		.digest("base64")}`;
const callback = (
	body: string,
	{
		id = `msg_${randomUUID()}`,
		stamp = Math.floor(Date.now() / 1000),
		signature,
	}: { id?: string; stamp?: number; signature?: string } = {},
) =>
	new Request("https://app.everyfield.test/api/webhooks/resend", {
		method: "POST",
		body,
		headers: { "svix-id": id, "svix-timestamp": String(stamp), "svix-signature": signature ?? sign(id, stamp, body) },
	});
const event = (type: string, emailId: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: emailId, ...extra } });

test("AC:SEC-09 mail callbacks are admitted only by a fresh signature over their raw bytes, apply once and in order, and an unknown or foreign id changes no other mail", async (t) => {
	const c = caseOf("SEC-09");
	const args = c.action.arguments as {
		provider_id: string;
		event_id: string;
		repeat: number;
		signature_valid: boolean;
	};
	const { result } = c.expected;
	const { resendWebhook } = await appModule<{ resendWebhook: Webhook }>("server/jobs/webhook-route.ts");
	const post = (request: Request) => resendWebhook(request, () => web.runtime, SECRET);
	web.setIp("127.0.9.1");
	assert.equal((await identity.register(web, "callbacks@example.test")).status, 200);
	assert.equal((await web.req("request-password-reset", { email: "callbacks@example.test" })).status, 200);
	await web.dispatch();
	assert.ok(
		web.effects.some((m) => m.to === "callbacks@example.test"),
		"the fixture sent one real mail to reconcile",
	);
	const sends = () => web.effects.length;
	const sent = sends();
	const { provider_message_id: ours, address_hash: address } = await one(
		sql`SELECT provider_message_id, address_hash FROM mail WHERE provider_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
	);
	assert.ok(ours);
	const state = () =>
		one(sql`SELECT (SELECT count(*)::int FROM provider_event) AS events, (SELECT count(*)::int FROM suppression) AS suppressions,
			(SELECT md5(string_agg(to_jsonb(m)::text,'' ORDER BY m.id)) FROM mail m) AS mail,
			(SELECT count(*)::int FROM audit_event) AS audits, (SELECT count(*)::int FROM job) AS jobs`);

	await t.test("a bad signature, bad bytes or a stale or future timestamp saves nothing, every time", async () => {
		assert.equal(args.signature_valid, false);
		const start = await state();
		const now = Math.floor(Date.now() / 1000);
		const body = event("email.bounced", args.provider_id, { bounce: { type: "Permanent" } });
		const attempts: [string, Request][] = [
			["unsigned", callback(body, { id: args.event_id, signature: "" })],
			[
				"wrong key",
				callback(body, {
					id: args.event_id,
					signature: sign(args.event_id, now, body, `whsec_${randomBytes(32).toString("base64")}`),
				}),
			],
			["signed other bytes", callback(`${body} `, { id: args.event_id, signature: sign(args.event_id, now, body) })],
			["signed other id", callback(body, { id: args.event_id, signature: sign("evt-other", now, body) })],
			["stale timestamp", callback(body, { id: args.event_id, stamp: now - 301 })],
			["future timestamp", callback(body, { id: args.event_id, stamp: now + 301 })],
			[
				"no timestamp",
				new Request("https://app.everyfield.test/api/webhooks/resend", {
					method: "POST",
					body,
					headers: { "svix-id": args.event_id },
				}),
			],
		];
		for (let n = 0; n < args.repeat; n++)
			for (const [name, request] of attempts) {
				const response = await post(request.clone());
				const reply = await response.json();
				assert.deepEqual([response.status, reply.code], [401, result.error_code], name);
				assert.equal(JSON.stringify(reply).includes(args.provider_id), false, name);
			}
		const end = await state();
		assert.equal(Number(end.events) - Number(start.events), result.provider_events_saved);
		assert.equal(Number(end.suppressions) - Number(start.suppressions), result.suppression_mutations);
		assert.deepEqual(end, start);
		assert.equal(sends() - sent, result.resends);
	});

	await t.test("signed garbage bytes are refused without a stored event", async () => {
		const start = await state();
		for (const body of [
			"not json",
			"{}",
			JSON.stringify({ type: "email.delivered" }),
			JSON.stringify({ type: "email.delivered", created_at: "yesterday", data: { email_id: ours } }),
		]) {
			const response = await post(callback(body));
			assert.ok(response.status >= 400, `${body}: ${response.status}`);
		}
		assert.deepEqual(await state(), start);
	});

	await t.test("an unknown provider id is kept unmatched and touches no mail, suppression or send", async () => {
		const start = await state();
		const response = await post(
			callback(event("email.bounced", args.provider_id, { bounce: { type: "Permanent" } }), {
				id: `${args.event_id}-unknown`,
			}),
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { stored: true, result: "unmatched" });
		const end = await state();
		assert.deepEqual(
			[end.suppressions, end.mail, end.audits, end.jobs],
			[start.suppressions, start.mail, start.audits, start.jobs],
		);
		assert.equal(sends(), sent);
	});

	await t.test("a replayed, duplicated or late callback applies once and never moves the outcome back", async () => {
		const delivered = event("email.delivered", String(ours));
		const first = await post(callback(delivered, { id: "evt-delivered" }));
		assert.deepEqual(await first.json(), { stored: true, result: "applied" });
		const middle = await state();
		for (let n = 0; n < args.repeat; n++) {
			const replay = await post(callback(delivered, { id: "evt-delivered" }));
			assert.deepEqual(await replay.json(), { stored: true, result: "duplicate" });
		}
		const changed = await post(
			callback(event("email.bounced", String(ours), { bounce: { type: "Permanent" } }), { id: "evt-delivered" }),
		);
		assert.equal(changed.status, 503, "the same event id with other bytes is refused");
		assert.deepEqual(await state(), middle);
		const late = await post(callback(event("email.accepted", String(ours)), { id: "evt-accepted-late" }));
		assert.deepEqual(await late.json(), { stored: true, result: "applied" });
		const { state: mailState, delivered_at } = await one(
			sql`SELECT state, delivered_at FROM mail WHERE provider_message_id=${ours}`,
		);
		assert.equal(mailState, "sent");
		assert.ok(delivered_at);
		assert.equal(sends(), sent, "no callback resends anything");
	});

	await t.test("a body that names another scope cannot move or suppress a mail it does not identify", async () => {
		const start = await state();
		const injected = JSON.stringify({
			type: "email.complained",
			created_at: new Date().toISOString(),
			data: {
				email_id: args.provider_id,
				to: ["callbacks@example.test"],
				tenant_id: randomUUID(),
				mail_id: randomUUID(),
				address_hash: address,
			},
		});
		const response = await post(callback(injected, { id: "evt-injected" }));
		assert.deepEqual(await response.json(), { stored: true, result: "unmatched" });
		const end = await state();
		assert.deepEqual([end.suppressions, end.mail, end.audits], [start.suppressions, start.mail, start.audits]);
		const { n } = await one(sql`SELECT count(*)::int n FROM suppression WHERE address_hash=${address}`);
		assert.equal(n, 0);
	});
});

test("AC:SEC-10 a preview or fixture that names a production or shared database, or a real sender, is refused before any write", async (t) => {
	const c = caseOf("SEC-10");
	const inputs = c.given["behavior-inputs"] as { preview_DB: string; preview_sender: string; fixture_target: string };
	const { result } = c.expected;
	assert.deepEqual([inputs.preview_DB, inputs.preview_sender, inputs.fixture_target], ["production", "real", "shared"]);
	const production = "postgres://app:secret@ep-gentle-dust-123456-pooler.us-east-1.aws.neon.tech/neondb";
	const shared = "postgres://app:secret@ep-autumn-dew-b8ltidky-pooler.c-14.us-east-1.aws.neon.tech/neondb";
	const preview = {
		VERCEL_ENV: "preview",
		VERCEL: "1",
		DATABASE_URL: production,
		IDENTITY_MAIL_KEY: "a".repeat(64),
		IDENTITY_ADDRESS_KEY: "b".repeat(64),
	};
	const schemas = () =>
		one(sql`SELECT count(*)::int n FROM information_schema.schemata WHERE schema_name LIKE 'sec10\_%'`);

	await t.test("startup of a preview or QA seed against production or the shared branch is refused", () => {
		const startup = (env: Record<string, string>) => {
			const refusal = seedRefusal(env);
			let database: string | null = null;
			try {
				assertDevelopmentDatabase(env.DATABASE_URL);
			} catch (error) {
				database = (error as Error).message;
			}
			return { allowed: refusal === null && database === null, refusal, database };
		};
		const prod = startup(preview);
		assert.equal(prod.allowed, result.startup_allowed);
		assert.equal(prod.refusal, "DATABASE_URL names the production database.");
		assert.match(String(prod.database), /development database or disposable CI database required/);
		const branch = startup({ ...preview, DATABASE_URL: shared });
		assert.equal(branch.allowed, result.startup_allowed, "the shared branch is not a fixture target");
		assert.equal(branch.refusal, "DATABASE_URL names the shared development branch, not a QA branch.");
		assert.equal(startup({ ...preview, NODE_ENV: "production", DATABASE_URL: shared }).allowed, false);
		assert.equal(deploymentKind(preview), "preview");
		assert.equal(isTestDeployment(preview), true);
	});

	await t.test("a preview sends only to synthetic recipients, never to a real customer address", () => {
		for (const address of [
			"alex@example.test",
			"pastor@gracechurch.example",
			"delivered+x@resend.dev.evil.example",
			"*@resend.dev",
		])
			assert.equal(mailRecipientAllowed(preview, address), false, address);
		assert.equal(mailRecipientAllowed(preview, "delivered+qa-owner@resend.dev"), true);
		assert.equal(
			mailRecipientAllowed({ ...preview, EMAIL_TEST_RECIPIENTS: "tester@example.test" }, "Tester@Example.test"),
			true,
		);
		assert.equal(mailRecipientAllowed({ VERCEL_ENV: "production" }, "pastor@gracechurch.example"), true);
	});

	await t.test("a fixture reset aimed at a production or non-disposable database writes nothing", async () => {
		const before = await schemas();
		const saved = {
			url: process.env.DATABASE_URL,
			unpooled: process.env.DATABASE_URL_UNPOOLED,
			disposable: process.env.EVERYFIELD_DISPOSABLE_DATABASE,
		};
		const local = saved.unpooled ?? saved.url ?? assert.fail("no test database");
		const targets: [string, Record<string, string | undefined>][] = [
			["production", { DATABASE_URL_UNPOOLED: production, DATABASE_URL: production }],
			[
				"production under a disposable flag",
				{ DATABASE_URL_UNPOOLED: production, EVERYFIELD_DISPOSABLE_DATABASE: "1" },
			],
			[
				"a local database not marked disposable",
				{ DATABASE_URL_UNPOOLED: local, EVERYFIELD_DISPOSABLE_DATABASE: undefined },
			],
		];
		let writes = 0;
		try {
			for (const [name, env] of targets) {
				for (const [key, value] of Object.entries(env))
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				await assert.rejects(
					testDatabase({ prefix: "sec10", migrate: false }).then(async (made) => {
						writes++;
						await made.close();
					}),
					/development database or disposable CI database required/,
					name,
				);
			}
		} finally {
			for (const [key, value] of Object.entries({
				DATABASE_URL: saved.url,
				DATABASE_URL_UNPOOLED: saved.unpooled,
				EVERYFIELD_DISPOSABLE_DATABASE: saved.disposable,
			}))
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
		}
		assert.equal(writes, result.fixture_writes);
		assert.deepEqual(await schemas(), before);
	});
});
