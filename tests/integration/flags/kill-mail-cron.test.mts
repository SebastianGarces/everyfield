import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { testDatabase } from "../../support/test-database.mts";
import { seeds } from "../../support/fixture.mts";
import { resendRecorder } from "../communication/resend-recorder.mts";
import { queuedMailTransport } from "../../../apps/web/src/server/mail/transport.ts";
import { identityMailEnqueue, identityMailPass } from "../../../apps/web/src/server/identity/index.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { capturedLines, withSwitchOff } from "../../support/flags.mts";

const database = await testDatabase({ prefix: "t472", roles: { runtime: ["runtime"], auth: ["auth"] }, max: 6 });
const { admin } = database;
const db = database.pools.runtime;
const seed = seeds(admin);
const hex = () => randomBytes(32).toString("hex");
Object.assign(process.env, {
	IDENTITY_DATABASE_URL: database.logins.runtime.url.href,
	IDENTITY_AUTH_DATABASE_URL: database.logins.auth.url.href,
	IDENTITY_ORIGIN: "https://app.example.test",
	IDENTITY_SECRET: hex(),
	IDENTITY_MAIL_KEY: hex(),
	IDENTITY_ADDRESS_KEY: hex(),
	IDENTITY_MAIL_FROM: "everyfield@example.test",
});
const resend = resendRecorder();
const ready = {
	keys: {
		encryptionKey: Buffer.from(process.env.IDENTITY_MAIL_KEY!, "hex"),
		addressKey: Buffer.from(process.env.IDENTITY_ADDRESS_KEY!, "hex"),
		from: process.env.IDENTITY_MAIL_FROM!,
		origin: process.env.IDENTITY_ORIGIN!,
		optOutKeys: null,
	},
	apiKey: "re_test_key",
};
const PASSES = ["identity", "organization", "settings", "onboarding", "notice", "digest", "feedback"] as const;
const ran: string[] = [];
const spy = (name: string) => async () => (ran.push(name), 0);

type Body = { status: string; steps: Record<string, { status: string; count?: unknown }> };
async function tick() {
	const response = await scheduledJobs({
		db,
		storage: null,
		cleanup: null,
		reminders: null,
		digests: null,
		mail: spy("mail"),
		messages: spy("messages"),
		mountMail: {
			...Object.fromEntries(PASSES.map((name) => [name, spy(name)])),
			identity: identityMailPass(queuedMailTransport(ready, resend.fetch, { VERCEL_ENV: "production" })),
		},
	})();
	return (await response.json()) as Body;
}
const queued = async (keys: string[]) =>
	(
		await admin.execute(sql`SELECT m.state, j.state AS job, j.attempt_count AS attempts FROM mail m
			JOIN job j ON j.kind='mail' AND j.subject_record_id=m.id WHERE m.logical_key = ANY(${sql.param(keys)}::text[])
			ORDER BY m.logical_key`)
	).rows;

before(() => resend.take());
after(async () => {
	const pools = (globalThis as Record<symbol, Map<string, Parameters<typeof closeDatabase>[0]>>)[
		Symbol.for("everyfield.web.pools")
	];
	await Promise.all([...(pools?.values() ?? [])].map((pool) => closeDatabase(pool)));
	await database.close();
});

test("with outbound-mail off, no cron mail pass runs or calls the email service and queued mail stays queued with no attempt; the first run back on sends it once", async () => {
	const reader = await seed.actor(null);
	const enqueue = identityMailEnqueue()!;
	const keys: string[] = [];
	for (const purpose of ["password_reset", "email_verification"] as const) {
		const logicalKey = `${purpose}/${createHash("sha256").update(randomUUID()).digest("hex")}`;
		keys.push(logicalKey);
		await db.transaction((tx) =>
			enqueue(tx, {
				accountId: reader.id,
				address: reader.email,
				purpose,
				logicalKey,
				subject: purpose === "password_reset" ? "Reset your password" : "Verify your email",
				text: `${purpose} link https://app.example.test/${purpose}?token=x`,
			}),
		);
	}
	keys.sort();
	const waiting = await queued(keys);
	assert.deepEqual(
		waiting.map((r) => [r.state, r.attempts]),
		[
			["pending", 0],
			["pending", 0],
		],
	);

	const { value: paused, lines } = await capturedLines(() =>
		withSwitchOff(db, { flag: "outbound-mail", operator: reader.id }, () => tick()),
	);
	const mailSteps = ["mail", ...PASSES.map((name) => `${name}-mail`), "messages"];
	for (const step of mailSteps) assert.deepEqual(paused!.steps[step], { status: "paused" }, step);
	assert.equal(paused!.status, "ok");
	assert.deepEqual(ran, [], "no pass ran");
	assert.deepEqual(resend.take(), [], "no provider call and no capture");
	assert.deepEqual(await queued(keys), waiting, "queued mail stays queued with no attempt counted");
	assert.deepEqual(
		lines.filter((l) => l.component === "kill-switch").map((l) => [l.switch, l.action]),
		mailSteps.map((step) => ["outbound-mail", step]),
	);

	const on = await tick();
	assert.deepEqual(on.steps["identity-mail"], { status: "ok", count: 2 });
	assert.deepEqual(ran.sort(), [
		"digest",
		"feedback",
		"mail",
		"messages",
		"notice",
		"onboarding",
		"organization",
		"settings",
	]);
	const sent = resend.take();
	assert.equal(sent.length, 2, "each held mail goes out once");
	assert.deepEqual(
		(await queued(keys)).map((r) => r.state),
		["accepted", "accepted"],
	);
	await tick();
	assert.deepEqual(resend.take(), [], "a later run sends nothing again");
});
