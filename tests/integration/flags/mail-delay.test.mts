import "../platform/setup.mts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { owner, sessionId } from "../../../packages/contracts/src/common/index.ts";
import { closeDatabase, type Database } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/index.ts";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { identityAuth } from "../../../packages/domain/src/identity/auth.ts";
import { mailDelay } from "../../../packages/domain/src/flags/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { createAccountCredentials } from "../../../packages/domain/src/settings/index.ts";
import { identityMailEnqueue } from "../../../apps/web/src/server/identity/index.ts";
import { invitationService } from "../../../apps/web/src/server/invitations/index.ts";
import { requestMailDelay, withMailDelay } from "../../../apps/web/src/server/switches.ts";
import { settingsMail } from "../../../apps/web/src/features/settings/mail.ts";
import { answerSend } from "../../../apps/web/src/features/identity/server.ts";
import {
	current as organizationMount,
	sendCommand,
	type Reply as OrganizationReply,
} from "../../../apps/web/src/features/organizations/mount.ts";
import { seeds, type Actor } from "../../support/fixture.mts";
import { capturedLines, withSwitchOff } from "../../support/flags.mts";
import { testDatabase } from "../../support/test-database.mts";

const database = await testDatabase({ prefix: "t533", roles: { runtime: ["runtime"], auth: ["auth"] }, max: 6 });
const { admin } = database;
const { runtime: db, auth: authDb } = database.pools;
const seed = seeds(admin);
const origin = "https://app.example.test";
const secret = randomBytes(32).toString("hex");
Object.assign(process.env, {
	IDENTITY_DATABASE_URL: database.logins.runtime.url.href,
	IDENTITY_AUTH_DATABASE_URL: database.logins.auth.url.href,
	IDENTITY_ORIGIN: origin,
	IDENTITY_SECRET: secret,
	IDENTITY_MAIL_KEY: randomBytes(32).toString("hex"),
	IDENTITY_ADDRESS_KEY: randomBytes(32).toString("hex"),
	IDENTITY_MAIL_FROM: "everyfield@example.test",
});
const operator = await seed.actor(null);

after(async () => {
	const pools = (globalThis as Record<symbol, Map<string, Parameters<typeof closeDatabase>[0]>>)[
		Symbol.for("everyfield.web.pools")
	];
	await Promise.all([...(pools?.values() ?? [])].map((pool) => closeDatabase(pool)));
	await database.close();
});

async function mailOff<T>(body: () => Promise<T>): Promise<T> {
	const { value, lines } = await capturedLines(() =>
		withSwitchOff(db, { flag: "outbound-mail", operator: operator.id }, body),
	);
	assert.deepEqual(
		lines.filter((l) => l.component === "kill-switch" || l.component === "mail-delay"),
		[],
	);
	return value;
}
const requestActor = async (a: Actor) => {
	const found = await gatedTransaction(db, (tx) => RequestActor.resolve(tx, sessionId.parse(a.session)));
	assert.ok(found instanceof RequestActor);
	return found;
};
const command = <T,>(input: T, expectedRevision = "1") => ({ requestKey: randomUUID(), expectedRevision, input });
const queuedFor = async (purpose: string, tenant: string) =>
	(
		await admin.execute(sql`SELECT m.state, j.state AS job, j.attempt_count AS attempts FROM mail m
			JOIN job j ON j.kind='mail' AND j.subject_record_id=m.id WHERE m.purpose=${purpose} AND m.tenant_id=${tenant}::uuid
			ORDER BY m.logical_key`)
	).rows;
const QUEUED = { state: "pending", job: "ready", attempts: 0 };
const attempts = async (kind: string) =>
	(
		await admin.execute(
			sql`SELECT state, count(*)::int AS n FROM admission_attempt WHERE kind=${kind} GROUP BY 1 ORDER BY 1`,
		)
	).rows;

function identityService(serviceDb: Database = db) {
	const deliveries: (() => Promise<void>)[] = [];
	const service = createIdentityService({
		db: serviceDb,
		authDb,
		admissionDb: db,
		origin,
		secret,
		scheduleDelivery: (work) => deliveries.push(work),
		trustedIp: () => null,
		enqueueMail: identityMailEnqueue(),
		diagnostic: (v) => assert.fail(JSON.stringify(v)),
	});
	return async (path: string, email: string) => {
		const response = await service.handle(
			new Request(`${origin}/api/auth/${path}`, {
				method: "POST",
				headers: { host: new URL(origin).host, origin, "content-type": "application/json" },
				body: JSON.stringify({ email }),
			}),
		);
		for (const work of deliveries.splice(0)) await work();
		const headers = [...response.headers].sort();
		return { status: response.status, headers, body: await response.text() };
	};
}
const person = (verified = true) => seed.actor(null, "owner", { user: { email_verified: verified } });

async function linkDelay(
	path: "request-password-reset" | "send-verification-email",
	purpose: "password_reset" | "email_verification",
	verified: boolean,
) {
	const ask = identityService();
	const a = await person(verified);
	const off = await mailOff(async () => ({
		known: await ask(path, a.email),
		unknown: await ask(path, `${randomUUID()}@example.test`),
	}));
	assert.equal(off.known.status, 200);
	assert.deepEqual(JSON.parse(off.known.body), { status: "accepted", mailDelayed: true });
	assert.deepEqual(off.unknown, off.known);
	assert.deepEqual(await queuedFor(purpose, a.id), [QUEUED]);

	const on = { known: await ask(path, a.email), unknown: await ask(path, `${randomUUID()}@example.test`) };
	assert.deepEqual(JSON.parse(on.known.body), { status: "accepted" });
	assert.deepEqual(on.unknown, on.known);
	assert.equal((await queuedFor(purpose, a.id)).length, 2);

	const b = await person(verified);
	const limited = async () => {
		for (let i = 0; i < 2; i++) assert.equal((await ask(path, b.email)).status, 200);
		return ask(path, b.email);
	};
	assert.equal((await mailOff(limited)).status, 200);
	const refused = await mailOff(() => ask(path, b.email));
	assert.equal(refused.status, 429, "the attempt budget is the same with mail off");
	assert.equal("mailDelayed" in JSON.parse(refused.body), false);
}

test("a password reset with mail off says delayed for a known and an unknown address alike and queues the mail; back on it answers as before", () =>
	linkDelay("request-password-reset", "password_reset", true));

test("a confirmation email with mail off says delayed for a known and an unknown address alike and queues the mail; back on it answers as before", () =>
	linkDelay("send-verification-email", "email_verification", false));

test("a switch read that fails leaves an accepted request accepted, with the ordinary reply", async () => {
	const failing = new Proxy(db, {
		get(target, key) {
			if (key !== "execute") return Reflect.get(target, key);
			return async (query: Parameters<Database["execute"]>[0]) => {
				if (JSON.stringify(query).includes("feature_flag")) throw Error("flag_read_down");
				return target.execute(query);
			};
		},
	});
	const a = await person();
	const { value, lines } = await capturedLines(() =>
		withSwitchOff(db, { flag: "outbound-mail", operator: operator.id }, () =>
			identityService(failing)("request-password-reset", a.email),
		),
	);
	assert.equal(value!.status, 200);
	assert.deepEqual(JSON.parse(value!.body), { status: "accepted" });
	assert.deepEqual(await queuedFor("password_reset", a.id), [QUEUED]);
	assert.deepEqual(
		lines.map((l) => [l.component, l.outcome]),
		[["mail-delay", "read_failed"]],
	);
	const { value: delay } = await capturedLines(() => mailDelay(() => Promise.reject(Error("flag_read_down"))));
	assert.deepEqual(delay, {});
});

test("a refused reply is not read as delayed, and the waiting screens follow the switch on each request", async () => {
	const refused = { status: "refused", code: "conflict" };
	assert.deepEqual(await mailOff(() => withMailDelay(refused)), refused);
	assert.deepEqual(await mailOff(() => requestMailDelay()), { mailDelayed: true });
	assert.deepEqual(await requestMailDelay(), {});
});

test("an email change with mail off says delayed and queues the mail with the same proof; back on it answers as before", async () => {
	const password = "Initial secret 2468!";
	const auth = identityAuth({ db: authDb, origin, secret, deliver: () => assert.fail("not expected") });
	const email = `${randomUUID()}@example.test`;
	const signed = await auth.api.signUpEmail({ body: { name: "Credential User", email, password } });
	const accountId = randomUUID();
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${accountId},${signed.user.id},'active','planter')`,
	);
	await admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE id=${signed.user.id}`);
	const signedIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
	const cookie = signedIn.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
	const credentials = createAccountCredentials({
		db,
		authDb,
		admissionDb: db,
		origin,
		secret,
		request: async () => ({
			request: new Request(`${origin}/api/auth/settings`, { method: "POST", headers: { origin, cookie } }),
			trustedIp: null,
			viewer: { accountId, email, verified: true },
		}),
		diagnostic: (v) => assert.fail(JSON.stringify(v)),
		responseCookies: async () => {},
		...settingsMail(),
	});
	const context = {
		session: sessionId.parse(session!.session.id),
		selected: owner.parse({ kind: "account", id: accountId }),
	};
	const change = () => credentials.requestEmailChange(context, { newEmail: `${randomUUID()}@example.test` });
	assert.deepEqual(await mailOff(change), {
		status: "ok",
		value: { status: "verification_requested", mailDelayed: true },
	});
	assert.deepEqual(await queuedFor("email_change", accountId), [QUEUED]);
	const counted = await attempts("email_change");
	assert.deepEqual(await change(), { status: "ok", value: { status: "verification_requested" } });
	assert.deepEqual(
		(await queuedFor("email_change", accountId)).map((r) => r.state),
		["pending", "pending"],
	);
	assert.deepEqual(
		(await attempts("email_change")).map((r) => [r.state, Number(r.n)]),
		counted.map((r) => [r.state, Number(r.n) + 1]),
	);
	const proofs = await admin.execute(
		sql`SELECT (expires_at-clock_timestamp()) > interval '23 hours' AS day_long FROM identity_proof WHERE account_id=${accountId}`,
	);
	assert.deepEqual(
		proofs.rows.map((r) => r.day_long),
		[true, true],
	);
});

type Sent = { invitation: { invitationId: string; revision: string } };
const sentOf = (reply: { status: string; value?: unknown }) => {
	assert.equal(reply.status, "ok", JSON.stringify(reply));
	return (reply as { value: Sent }).value.invitation;
};
const delayedOf = (reply: object) => "mailDelayed" in reply;
const pastCooldown = (id: string) =>
	admin.execute(sql`UPDATE invitation SET created_at=created_at-interval '2 minutes',
		resent_at=resent_at-interval '2 minutes' WHERE id=${id}::uuid`);
const rowOf = async (id: string) =>
	(await admin.execute(sql`SELECT state, revision::text AS revision FROM invitation WHERE id=${id}::uuid`)).rows[0];

async function invitationDelay(kind: "seat" | "residency") {
	const workspace = await seed.organization("sending_church", { name: "Grace" });
	const inviter = await seed.actor(workspace, "owner");
	const actor = await requestActor(inviter);
	const service = invitationService();
	const invite = async () => {
		const recipientEmail = `${randomUUID()}@example.test`;
		if (kind === "seat") return command({ workspace, recipientEmail, role: "member" });
		const personId = randomUUID();
		await admin.execute(
			sql`INSERT INTO person(id,tenant_id,organization_id,display_name,source,state,created_at) VALUES(${personId},${workspace.id},${workspace.id},'Casey','other','live',clock_timestamp())`,
		);
		return command({ organization: workspace, personId, recipientEmail });
	};
	const send = (c: unknown) =>
		answerSend(() => (kind === "seat" ? service.invite(actor, c) : service.inviteResident(actor, c)));
	const resend = (c: unknown) => answerSend(() => service.resend(actor, c));
	const resendOf = (i: Sent["invitation"]) => command({ invitationId: i.invitationId }, i.revision);

	const first = await invite();
	const off = await mailOff(() => send(first));
	assert.equal(delayedOf(off), true);
	const held = sentOf(off);
	assert.equal(JSON.stringify(held).includes("mailDelayed"), false, "the stored result holds no delay");
	const again = resendOf(held);
	const early = await mailOff(() => resend(again));
	assert.deepEqual(
		{ status: early.status, code: "code" in early && early.code, delayed: delayedOf(early) },
		{ status: "refused", code: "invitation_cooldown", delayed: false },
	);
	await pastCooldown(held.invitationId);
	const resendCommand = resendOf(held);
	const offResend = await mailOff(() => resend(resendCommand));
	assert.equal(delayedOf(offResend), true);
	assert.equal(sentOf(offResend).revision, "2");
	const purpose = kind === "seat" ? "seat_invitation" : "relationship_invitation";
	assert.deepEqual(await queuedFor(purpose, workspace.id), [QUEUED, QUEUED]);

	for (const replay of [await send(first), await resend(resendCommand)]) assert.equal(delayedOf(replay), false);
	assert.equal((await queuedFor(purpose, workspace.id)).length, 2, "a replay queues nothing");

	const on = await send(await invite());
	assert.equal(delayedOf(on), false);
	await pastCooldown(sentOf(on).invitationId);
	const onResend = await resend(resendOf(sentOf(on)));
	assert.equal(delayedOf(onResend), false);
	assert.deepEqual(await rowOf(held.invitationId), await rowOf(sentOf(on).invitationId));
}

test("a seat invitation and its resend succeed with mail off and say delayed; back on they and a replay of the off command do not", () =>
	invitationDelay("seat"));

test("a resident's account link invitation and its resend succeed with mail off and say delayed; back on they and a replay of the off command do not", () =>
	invitationDelay("residency"));

test("a connection invitation and its resend succeed with mail off and say delayed; back on they and a replay of the off command do not", async () => {
	const mount = organizationMount();
	const plant = await seed.plant();
	const inviter = await seed.actor(plant, "owner");
	const selected = owner.parse(plant);
	const request = async () => {
		const organization = await seed.organization("sending_church", { name: "Grace" });
		const reader = await seed.actor(organization, "owner");
		return command({ pair: { kind: "plant", subject: plant, organization }, recipientEmail: reader.email });
	};
	const run = async (
		op: "associations.invite" | "associations.resendInvitation",
		c: unknown,
	): Promise<OrganizationReply> =>
		sendCommand(mount, await requestActor(inviter), selected, (tx, s, o) => mount.adapter[op](tx, s, o, c));
	const valueOf = (reply: OrganizationReply) => {
		assert.equal(reply.status, "ok", JSON.stringify(reply));
		return (reply as { value: Sent["invitation"] }).value;
	};
	const resendOf = (i: Sent["invitation"]) => command({ invitationId: i.invitationId }, i.revision);

	const first = await request();
	const off = await mailOff(() => run("associations.invite", first));
	assert.equal(delayedOf(off), true);
	const held = valueOf(off);
	assert.equal("mailDelayed" in held, false, "the stored result holds no delay");
	await pastCooldown(held.invitationId);
	const resendCommand = resendOf(held);
	const offResend = await mailOff(() => run("associations.resendInvitation", resendCommand));
	assert.equal(delayedOf(offResend), true);
	assert.deepEqual(await queuedFor("relationship_invitation", plant.id), [QUEUED, QUEUED]);

	for (const [op, c] of [
		["associations.invite", first],
		["associations.resendInvitation", resendCommand],
	] as const)
		assert.equal(delayedOf(await run(op, c)), false);
	assert.equal((await queuedFor("relationship_invitation", plant.id)).length, 2, "a replay queues nothing");

	const on = await run("associations.invite", await request());
	assert.equal(delayedOf(on), false);
	await pastCooldown(valueOf(on).invitationId);
	const onResend = await run("associations.resendInvitation", resendOf(valueOf(on)));
	assert.equal(delayedOf(onResend), false);
	assert.deepEqual(await rowOf(held.invitationId), await rowOf(valueOf(on).invitationId));
});
