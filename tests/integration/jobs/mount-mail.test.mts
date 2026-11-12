import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { owner, sessionId } from "../../../packages/contracts/src/common/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/index.ts";
import { executeWrites } from "../../../packages/domain/src/operations/writes.ts";
import { testDatabase } from "../../support/test-database.mts";
import { seeds } from "../../support/fixture.mts";
import { resendRecorder } from "../communication/resend-recorder.mts";
import { queuedMailTransport } from "../../../apps/web/src/features/communication/mail.ts";
import { settingsMail, settingsMailPass } from "../../../apps/web/src/features/settings/mail.ts";
import { identityMailEnqueue, identityMailPass } from "../../../apps/web/src/server/identity/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { onboardingMailPass, onboardingMount } from "../../../apps/web/src/server/onboarding/index.ts";
import {
	current as organizationMount,
	organizationMailPass,
} from "../../../apps/web/src/server/organizations/index.ts";

// T-127 (people/peo-1): the scheduled runner sends the mail the identity, organizations, settings and onboarding
// mounts queue. Each mail is queued through its mount's own code, on a suite schema of the shared development database
// (or CI's disposable one). One tick hands each to a recorded email service through that mount's pass, which claims only
// its own prefixes and rechecks every mail under the mount's own rule.

const database = await testDatabase({ prefix: "t127", roles: { runtime: ["runtime"], auth: ["auth"] }, max: 6 });
const { admin } = database;
const db = database.pools.runtime;
const seed = seeds(admin);
const hex = () => randomBytes(32).toString("hex");
// The mounts read their configuration from the environment, as a deployment does: this suite's schema and fresh keys.
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
	},
	apiKey: "re_test_key",
};
// A production recipient rule, so every address is allowed and each send is one recorded call.
const transport = () => queuedMailTransport(ready, resend.fetch, { VERCEL_ENV: "production" });
const secret = "cron-" + randomUUID();

type Body = { status: string; mailed: number; steps: Record<string, { status: string; count?: unknown }> };
async function tick(mountMail: Parameters<typeof scheduledJobs>[0]["mountMail"]) {
	const response = await scheduledJobs({
		secret,
		db,
		storage: null,
		cleanup: null,
		reminders: null,
		digests: null,
		mail: null,
		mountMail,
	})(new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${secret}` } }));
	return { status: response.status, body: (await response.json()) as Body };
}
const allPasses = () => ({
	identity: identityMailPass(transport()),
	organization: organizationMailPass(transport()),
	settings: settingsMailPass(transport()),
	onboarding: onboardingMailPass(transport()),
});
const mailState = async (key: string) =>
	(await admin.execute(sql`SELECT state FROM mail WHERE logical_key = ${key}`)).rows.map((r) => r.state);

/** An account with a session and no seat, as sign-up leaves a planter. */
async function planter() {
	const a = { id: randomUUID(), user: randomUUID(), session: randomUUID(), email: `${randomUUID()}@example.test` };
	await admin.execute(
		sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES(${a.user},'Synthetic',${a.email},true)`,
	);
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_kind,registration_state) VALUES(${a.id},${a.user},'planter','active')`,
	);
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${a.session},${a.user},${hex()},clock_timestamp()+interval '1 day')`,
	);
	return a;
}

/** A church owner and a sending church to invite, and the command runner the organizations mount uses. */
async function connection() {
	const plant = owner.parse(await seed.plant({ name: "Harvest Point" }));
	const actor = await seed.actor(plant as never, "owner");
	const church = owner.parse(await seed.organization("sending_church", { name: "First Church" }));
	const m = organizationMount()!;
	const session = sessionId.parse(actor.session);
	const run = <T,>(body: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
		m.db.transaction(async (tx) => {
			if (!(await RequestActor.claimWrite(tx, session, plant))) throw Error("unavailable");
			return body(tx);
		});
	const invite = (recipientEmail: string) =>
		run((tx) =>
			m.adapter["associations.invite"](tx, session, plant, {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { pair: { kind: "plant", subject: plant, organization: church }, recipientEmail },
			}),
		);
	const resendInvitation = (invitationId: string, expectedRevision: string) =>
		run((tx) =>
			m.adapter["associations.resendInvitation"](tx, session, plant, {
				requestKey: randomUUID(),
				expectedRevision,
				input: { invitationId },
			}),
		);
	return { invite, resendInvitation };
}

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

before(() => resend.take());
after(async () => {
	// The mounts' own pools (server/database.ts), then the suite schema.
	const pools = (globalThis as Record<symbol, Map<string, Parameters<typeof closeDatabase>[0]>>)[
		Symbol.for("everyfield.web.pools")
	];
	await Promise.all([...(pools?.values() ?? [])].map((pool) => closeDatabase(pool)));
	await database.close();
});

test("INV-mount-mail: one tick sends the identity, relationship, settings and onboarding mail each mount queued, through that mount's own rule", async () => {
	// identity: a reset and a verification link to an account's own contact, as the identity service asks for them.
	const reader = await seed.actor(null);
	const enqueueIdentity = identityMailEnqueue()!;
	const identity = (purpose: "password_reset" | "email_verification", account = reader) => {
		const logicalKey = `${purpose}/${createHash("sha256").update(randomUUID()).digest("hex")}`;
		return db
			.transaction((tx) =>
				enqueueIdentity(tx, {
					accountId: account.id,
					address: account.email,
					purpose,
					logicalKey,
					subject: purpose === "password_reset" ? "Reset your password" : "Verify your email",
					text: `${purpose} link https://app.example.test/${purpose}?token=x`,
				}),
			)
			.then(() => logicalKey);
	};
	const reset = await identity("password_reset");
	const verification = await identity("email_verification");
	// The identity rule rejects a reset whose address no longer matches the account's contact.
	const moved = await seed.actor(null);
	const stale = await identity("password_reset", moved);
	await admin.execute(sql`UPDATE auth_user SET email = ${"moved-" + moved.email} WHERE id = ${moved.user}`);

	// organizations: a connection request to a typed address, through the mount's real adapter and effects.
	const invitee = `${randomUUID()}@example.test`;
	const invitation = await (await connection()).invite(invitee);
	assert.equal(invitation.status, "pending");

	// settings: an email-change link to the address of the account's live proof, and a security notice.
	const changer = await seed.actor(null);
	const newAddress = `${randomUUID()}@example.test`;
	await admin.execute(sql`INSERT INTO identity_proof(account_id,purpose,token_hash,proposed_email,expires_at)
		VALUES(${changer.id},'email_change',${hex()},${newAddress},clock_timestamp()+interval '1 hour')`);
	const settings = settingsMail()!;
	const correlationId = randomUUID();
	await db.transaction(async (tx) => {
		const writes: Parameters<typeof executeWrites>[1][number][] = [];
		await settings.deliverVerification(tx, { accountId: changer.id, address: newAddress, token: "t-" + hex() }, writes);
		await settings.securityNotice(
			tx,
			{ accountId: changer.id, address: changer.email, action: "password_changed", correlationId },
			writes,
		);
		await executeWrites(tx, writes);
	});

	// onboarding: the set-up receipt a new church's owner gets, through the mount's real producer.
	const founder = await planter();
	const onboarding = onboardingMount()!;
	await onboarding.db.transaction((tx) =>
		onboarding.producer.createPlant(
			tx,
			{ session: founder.session, selected: { kind: "account", id: founder.id } } as never,
			{
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { name: "Harvest Point", locality: { city: "Boston" }, confirmed: true },
			} as never,
		),
	);

	// Mail no new pass owns: church invitations (the `mail` step, absent here) and an association receipt.
	const permissive = createMailService({
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "other@example.test",
		authorize: async (_tx, list) => new Set(list.map((m) => m.id)),
		transport: { send: async () => ({ kind: "refused", retryable: true }), lookup: async () => ({ kind: "unknown" }) },
	});
	const foreign = [`invitation/${randomUUID()}/1`, `association/${randomUUID()}/1/${reader.id}`];
	for (const logicalKey of foreign)
		await db.transaction((tx) =>
			permissive.enqueue(tx, {
				owner: { kind: "account", id: reader.id },
				purpose: "discovery_receipt",
				logicalKey,
				recipient: reader.id,
				address: reader.email,
				content: { subject: "Other", text: "Other" },
				operation: null,
				notice: null,
				eligibleAt: new Date().toISOString(),
			}),
		);

	resend.take();
	const { status, body } = await tick(allPasses());
	assert.equal(status, 200);
	assert.equal(body.status, "ok");
	assert.equal(body.mailed, 0, "the invitation step's count is unchanged and its pass is not configured here");
	assert.deepEqual(body.steps.mail, { status: "skipped" });
	assert.deepEqual(body.steps.messages, { status: "skipped" });
	// Each pass claimed only its own mail: identity 3 (one rejected), relationship 1, settings 2, onboarding 1.
	assert.deepEqual(body.steps["identity-mail"], { status: "ok", count: 3 });
	assert.deepEqual(body.steps["organization-mail"], { status: "ok", count: 1 });
	assert.deepEqual(body.steps["settings-mail"], { status: "ok", count: 2 });
	assert.deepEqual(body.steps["onboarding-mail"], { status: "ok", count: 1 });

	const calls = resend.take();
	const sent = (to: string, subject: string | RegExp) =>
		calls.filter((c) => {
			const b = c.body as { to: string; subject: string };
			return b.to === to && (typeof subject === "string" ? b.subject === subject : subject.test(b.subject));
		});
	assert.equal(calls.length, 6, "six mails reached the email service");
	assert.equal(sent(reader.email, "Reset your password").length, 1, "password_reset/");
	assert.equal(sent(reader.email, "Verify your email").length, 1, "email_verification/");
	assert.equal(sent(invitee, /asks to connect on Everyfield$/).length, 1, "relationship/");
	assert.equal(sent(newAddress, /./).length, 1, "email-change/");
	assert.equal(sent(changer.email, "Your Everyfield password changed").length, 1, "security/");
	assert.equal(sent(founder.email, "Your church is set up").length, 1, "onboarding/");
	assert.deepEqual(sent("moved-" + moved.email, /./), []);
	assert.deepEqual(sent(moved.email, /./), [], "a rejected identity mail is not handed to the email service");

	for (const key of [reset, verification]) assert.deepEqual(await mailState(key), ["accepted"]);
	assert.deepEqual(await mailState(stale), ["cancelled"]);
	for (const key of foreign) assert.deepEqual(await mailState(key), ["pending"], `${key} is claimed by no new pass`);

	// The relationship mail prints the invitation's real expiry, as a UTC long date labelled UTC.
	const [request] = sent(invitee, /./);
	assert.ok(
		(request!.body as { text: string }).text.includes(
			`It works until ${day.format(new Date(invitation.expiresAt))} (UTC).`,
		),
	);

	// A deployment without mail configuration skips every pass.
	const quiet = await tick(undefined);
	for (const name of ["identity-mail", "organization-mail", "settings-mail", "onboarding-mail"])
		assert.deepEqual(quiet.body.steps[name], { status: "skipped" });
	assert.equal(quiet.status, 200);
});

test("INV-mount-mail: a relationship invitation resent on day 29 keeps its original expiry in the result and the mail", async () => {
	const invitee = `${randomUUID()}@example.test`;
	const c = await connection();
	const made = await c.invite(invitee);
	await tick({ organization: organizationMailPass(transport()) });
	resend.take();
	// Day 29: the invitation was created 29 days ago and never resent.
	await admin.execute(
		sql`UPDATE invitation SET created_at = clock_timestamp() - interval '29 days' WHERE id = ${made.invitationId}`,
	);
	const [{ created_at }] = (await admin.execute(sql`SELECT created_at FROM invitation WHERE id = ${made.invitationId}`))
		.rows as { created_at: Date | string }[];
	const original = new Date(new Date(created_at).getTime() + 30 * 86_400_000);
	const resent = await c.resendInvitation(made.invitationId, made.revision);
	assert.equal(resent.status, "pending");
	assert.equal(resent.expiresAt, original.toISOString());

	const { body } = await tick({ organization: organizationMailPass(transport()) });
	assert.deepEqual(body.steps["organization-mail"], { status: "ok", count: 1 });
	const calls = resend.take();
	assert.equal(calls.length, 1);
	const mail = calls[0]!.body as { to: string; text: string };
	assert.equal(mail.to, invitee);
	assert.ok(mail.text.includes(`It works until ${day.format(original)} (UTC).`), mail.text);
	// Not day 29 + 30.
	assert.ok(!mail.text.includes(day.format(new Date(Date.now() + 30 * 86_400_000))));
});
