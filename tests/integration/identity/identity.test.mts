import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createAccountCredentials } from "../../../packages/domain/src/settings/index.ts";
import { trustedIdentityIp } from "../../../packages/domain/src/identity/index.ts";
import { RequestActor, readRequestViewer } from "../../../packages/domain/src/access/index.ts";
import { signedSessionToken } from "../../../packages/domain/src/identity/session-cookie.ts";
import { verifyCallback } from "../../../apps/web/src/server/platform/webhook.ts";
import { QA_LOGINS, QA_PASSWORD, seedRefusal } from "../../../tools/qa/qa-guard.ts";
import { fixture, register, signIn, cookie, password } from "./support.mts";
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => {
	f = await fixture();
});
after(async () => {
	if (f) await f.close();
});

async function resetProof(email: string) {
	assert.equal((await f.req("request-password-reset", { email })).status, 200);
	await f.dispatch();
	const effect = f.effects.filter((v) => v.to === email && v.text.startsWith("Reset your password")).at(-1);
	assert.ok(effect);
	const token = new URL(effect.text.split("\n")[2]!).searchParams.get("token");
	assert.ok(token);
	return token;
}

test("AC:TARGET-IDN-030 AC:WP005-API-STAGED INV-nonenumeration: pending credentials reveal no account or tenant authority, duplicate registration converges, authenticated self resumes", async () => {
	f.setIp("127.0.0.11");
	const first = await register(f, "staged@example.test");
	assert.equal(first.status, 200);
	assert.deepEqual(await first.json(), { status: "continue_identity_proof" });
	assert.equal(cookie(first), "");
	const duplicate = await register(f, "staged@example.test");
	assert.equal(duplicate.status, 200);
	assert.deepEqual(await duplicate.json(), { status: "continue_identity_proof" });
	assert.equal(cookie(duplicate), "");
	assert.deepEqual(
		(
			await f.db.execute(
				querySql`SELECT registration_state,registration_kind FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email='staged@example.test'`,
			)
		).rows,
		[{ registration_state: "pending_domain", registration_kind: "discovery" }],
	);
	assert.deepEqual(
		(
			await f.db.execute(
				querySql`SELECT (SELECT count(*)::int FROM auth_user WHERE email='staged@example.test') users,
					(SELECT count(*)::int FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email='staged@example.test') accounts,
					(SELECT count(*)::int FROM seat) seats,(SELECT count(*)::int FROM affiliation) affiliations,
					(SELECT count(*)::int FROM plant) plants,(SELECT count(*)::int FROM discovery) discoveries,
					(SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM audit_event) events`,
			)
		).rows,
		[{ users: 1, accounts: 1, seats: 0, affiliations: 0, plants: 0, discoveries: 0, people: 0, events: 0 }],
	);
	assert.equal((await f.req("registration-status")).status, 401);
	assert.equal((await f.req("resume-registration", { requestKey: randomUUID() })).status, 401);
	const login = await signIn(f, " STAGED@EXAMPLE.TEST ");
	assert.equal(login.status, 200);
	const c = cookie(login);
	assert.ok(c);
	const status = await (await f.req("registration-status", undefined, c)).json();
	assert.equal(status.status, "pending_domain");
	const session = await (await f.req("get-session", undefined, c)).json();
	assert.deepEqual(await RequestActor.resolve(f.runtime, session.sessionId), {
		status: "pending_domain",
		accountId: status.accountId,
	});
	assert.deepEqual(await (await f.req("resume-registration", { requestKey: randomUUID() }, c)).json(), status);
	assert.equal(
		(await f.req("resume-registration", { requestKey: randomUUID(), invitationProof: "stolen" }, c)).status,
		503,
	);
});

test("INV-identity: atomic registration admission counts malformed submissions, requires trustworthy IP and does not trust client IP headers", async () => {
	f.setIp("127.0.0.12");
	assert.deepEqual(
		await Promise.all(Array.from({ length: 5 }, () => f.req("register", {}).then((r) => r.status))).then((a) =>
			a.sort(),
		),
		[422, 422, 422, 429, 429],
	);
	f.setIp(null);
	assert.equal((await register(f, "noip@example.test")).status, 503);
	assert.equal((await f.req("register", {}, undefined, { "x-forwarded-for": "127.0.0.99" })).status, 503);
	assert.equal(
		(await f.db.execute(querySql`SELECT count(*)::int n FROM auth_user WHERE email='noip@example.test'`)).rows[0]!.n,
		0,
	);
	await f.db.execute(querySql`ALTER TABLE admission_attempt RENAME TO admission_unavailable`);
	try {
		const staged = await signIn(f, "staged@example.test");
		assert.equal(staged.status, 503);
		assert.equal(cookie(staged), "");
	} finally {
		await f.db.execute(querySql`ALTER TABLE admission_unavailable RENAME TO admission_attempt`);
	}
});

test("AC:TARGET-IDN-001 INV-identity: normalized login and reset budgets reserve concurrently, success clears only own login failures", async () => {
	f.setIp("127.0.0.13");
	await register(f, "limits@example.test");
	const statuses = await Promise.all(
		Array.from({ length: 8 }, () => signIn(f, " LIMITS@EXAMPLE.TEST ", "Wrong-password-1").then((r) => r.status)),
	);
	assert.deepEqual(statuses.sort(), [401, 401, 401, 401, 401, 429, 429, 429]);
	f.setIp(null);
	assert.equal((await signIn(f, "limits@example.test")).status, 429);
	await f.db.execute(
		querySql`UPDATE admission_attempt SET reserved_at=clock_timestamp()-interval '16 minutes' WHERE kind='login'`,
	);
	await signIn(f, "foreign@example.test", "Wrong-password-1");
	const login = await signIn(f, "limits@example.test");
	assert.equal(login.status, 200);
	assert.equal(
		(
			await f.db.execute(
				querySql`SELECT count(*)::int n FROM admission_attempt WHERE kind='login' AND state='failed' AND reserved_at>clock_timestamp()-interval '15 minutes'`,
			)
		).rows[0]!.n,
		1,
	);
	assert.deepEqual(
		await Promise.all(
			Array.from({ length: 5 }, () =>
				f.req("request-password-reset", { email: "missing@example.test" }).then((r) => r.status),
			),
		).then((a) => a.sort()),
		[200, 200, 200, 429, 429],
	);
});

test("INV-identity: a rate-limited refusal names the end of the budget window it hit", async () => {
	const minutesOut = async (response: Response) => {
		assert.equal(response.status, 429);
		const body = (await response.json()) as { code: string; details: { retryAt: string } };
		assert.equal(body.code, "rate_limited");
		const { now } = (
			await f.db.execute<{ now: number }>(querySql`SELECT (extract(epoch FROM clock_timestamp())*1000)::float8 AS now`)
		).rows[0]!;
		return (new Date(body.details.retryAt).getTime() - now) / 60_000;
	};
	const near = (actual: number, expected: number) =>
		assert.ok(Math.abs(actual - expected) < 1, `retryAt ${actual.toFixed(2)} minutes out, expected ${expected}`);
	f.setIp("127.0.0.31");
	await register(f, "window@example.test");
	f.setIp(null);
	for (let n = 0; n < 5; n++) assert.equal((await signIn(f, "window@example.test", "Wrong-password-1")).status, 401);
	near(await minutesOut(await signIn(f, "window@example.test", "Wrong-password-1")), 15);
	f.setIp("127.0.0.32");
	for (let n = 0; n < 3; n++)
		assert.equal((await f.req("request-password-reset", { email: "window-reset@example.test" })).status, 200);
	near(await minutesOut(await f.req("request-password-reset", { email: "window-reset@example.test" })), 60);
	f.setIp("127.0.0.33");
	for (let n = 0; n < 3; n++) await f.req("register", {});
	near(await minutesOut(await f.req("register", {})), 60);
	f.setIp(null);
});

test("AC:TARGET-IDN-009 AC:WP005-API-RESET INV-proof-link: real single-use reset consumes one proof, rejects unchanged/expired/consumed proof, revokes every prior session and reports failure truthfully", async () => {
	f.setIp("127.0.0.14");
	await register(f, "reset@example.test");
	const c1 = cookie(await signIn(f, "reset@example.test")),
		c2 = cookie(await signIn(f, "reset@example.test"));
	const proof = await resetProof("reset@example.test");
	const lifetime = await f.db.execute(
		querySql`SELECT extract(epoch FROM(expires_at-created_at))::int seconds FROM auth_verification WHERE identifier=${"reset-password:" + proof}`,
	);
	assert.equal(lifetime.rows[0]!.seconds, 3600);
	assert.equal(
		(await f.req("reset-password", { proof, newPassword: password, confirmPassword: password })).status,
		422,
	);
	await f.db.execute(
		querySql`CREATE FUNCTION fail_security_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='identity.credential_changed' THEN RAISE EXCEPTION 'synthetic_event_failure'; END IF; RETURN NEW; END $$`,
	);
	await f.db.execute(
		querySql`CREATE TRIGGER fail_security_event BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_security_event()`,
	);
	const results = await Promise.all(
		Array.from({ length: 2 }, () =>
			f.req("reset-password", { proof, newPassword: "Fixture-new-pass-2", confirmPassword: "Fixture-new-pass-2" }),
		),
	);
	await f.db.execute(querySql`DROP TRIGGER fail_security_event ON audit_event`);
	assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
	assert.deepEqual(await results.find((r) => r.status === 200)!.json(), { status: "password_reset", next: "sign_in" });
	assert.equal(cookie(results.find((r) => r.status === 200)!), "");
	for (const c of [c1, c2])
		assert.deepEqual(await (await f.req("get-session", undefined, c)).json(), { status: "unauthenticated" });
	assert.equal((await signIn(f, "reset@example.test", password)).status, 401);
	assert.equal((await signIn(f, "reset@example.test", "Fixture-new-pass-2")).status, 200);
	assert.ok(
		f.diagnostics.some(
			(v: unknown) => typeof v === "object" && v !== null && "outcome" in v && v.outcome === "reporting_pending",
		),
	);
	const events = await f.db.execute(
		querySql`SELECT action FROM audit_event WHERE action LIKE 'identity.credential%' ORDER BY recorded_at`,
	);
	assert.equal(
		events.rows.some((v) => v.action === "identity.credential_observed"),
		true,
	);
	assert.equal(
		events.rows.some((v) => v.action === "identity.credential_changed"),
		false,
	);
	f.setMailFault(false);
	const expired = await resetProof("reset@example.test");
	await f.db.execute(
		querySql`UPDATE auth_verification SET expires_at=clock_timestamp()-interval '1 second' WHERE identifier=${"reset-password:" + expired}`,
	);
	assert.equal(
		(
			await f.req("reset-password", {
				proof: expired,
				newPassword: "Fixture-third-pass-3",
				confirmPassword: "Fixture-third-pass-3",
			})
		).status,
		400,
	);
	const stale = proof;
	assert.equal(
		(
			await f.req("reset-password", {
				proof: stale,
				newPassword: "Fixture-third-pass-3",
				confirmPassword: "Fixture-third-pass-3",
			})
		).status,
		400,
	);
});

test("AC:TARGET-IDN-009 INV-nonenumeration INV-identity: recovery is nonenumerating through outbox failure and unknown provider acceptance; tokens never reach security diagnostics", async () => {
	f.setIp("127.0.0.15");
	await register(f, "notice@example.test");
	const missing = await f.req("request-password-reset", { email: "missing-notice@example.test" });
	assert.equal(missing.status, 200);
	assert.deepEqual(await missing.json(), { status: "accepted" });
	f.setMailFault(true);
	const failed = await f.req("request-password-reset", { email: "notice@example.test" });
	assert.equal(failed.status, 200);
	assert.deepEqual(await failed.json(), { status: "accepted" });
	await f.runDeliveryRequests();
	f.setMailFault(false);
	const accepted = await f.req("request-password-reset", { email: "notice@example.test" });
	assert.deepEqual(await accepted.json(), { status: "accepted" });
	f.setProviderFault(true);
	await f.dispatch();
	f.setProviderFault(false);
	assert.equal((await f.db.execute(querySql`SELECT count(*)::int n FROM mail WHERE state='unknown'`)).rows[0]!.n, 1);
	const serialized = JSON.stringify(f.diagnostics);
	assert.equal(serialized.includes("@example.test"), false);
	assert.equal(serialized.includes(password), false);
	assert.equal((await f.db.execute(querySql`SELECT count(*)::int n FROM job WHERE state='reconcile'`)).rows[0]!.n, 1);
});

test("AC:TARGET-IDN-001 INV-identity: real database session renews, expired/revoked/deleted identities deny; logout converges and revocation preserves only its own session", async () => {
	f.setIp("127.0.0.16");
	await register(f, "session@example.test");
	const c1 = cookie(await signIn(f, "session@example.test")),
		c2 = cookie(await signIn(f, "session@example.test"));
	const s = await (await f.req("get-session", undefined, c1)).json();
	assert.equal(s.status, "pending_domain");
	await f.db.execute(
		querySql`UPDATE auth_session SET expires_at=clock_timestamp()+interval '14 days',updated_at=clock_timestamp()-interval '16 days' WHERE id=${s.sessionId}`,
	);
	const renewed = await f.req("get-session", undefined, c1);
	assert.equal(renewed.status, 200);
	assert.ok(cookie(renewed));
	const row = await f.db.execute<{ seconds: number }>(
		querySql`SELECT extract(epoch FROM(expires_at-clock_timestamp()))::int seconds FROM auth_session WHERE id=${s.sessionId}`,
	);
	assert.ok(row.rows[0]!.seconds >= 2591990 && row.rows[0]!.seconds <= 2592000);
	assert.equal((await f.req("revoke-other-sessions", {}, c1)).status, 200);
	assert.deepEqual(await (await f.req("get-session", undefined, c2)).json(), { status: "unauthenticated" });
	assert.equal((await (await f.req("get-session", undefined, c1)).json()).status, "pending_domain");
	for (let i = 0; i < 2; i++)
		assert.deepEqual(await (await f.req("sign-out", {}, c1)).json(), { status: "signed_out" });
	assert.deepEqual(await (await f.req("get-session", undefined, c1)).json(), { status: "unauthenticated" });
	const c3 = cookie(await signIn(f, "session@example.test"));
	await f.db.execute(querySql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second'`);
	assert.deepEqual(await (await f.req("get-session", undefined, c3)).json(), { status: "unauthenticated" });
	const c4 = cookie(await signIn(f, "session@example.test"));
	await f.db
		.execute(querySql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,request_revision,state,witness_checkpoint,cleanup_state,request_id,requested_at,cancel_until)
    VALUES('account',${s.accountId},1,'pending_deletion',1,'not_started',${randomUUID()},statement_timestamp(),statement_timestamp()+interval '720 hours')`);
	assert.deepEqual(await (await f.req("get-session", undefined, c4)).json(), { status: "unauthenticated" });
	assert.equal((await f.req("resume-registration", { requestKey: randomUUID() }, c4)).status, 401);
});

test("AC:TARGET-IDN-001 INV-nonenumeration: sign-in refuses a wrong password and an unknown address alike, and a deleting account gets no session", async () => {
	f.setIp("127.0.0.23");
	await register(f, "enum@example.test");
	const refusal = async (r: Response) => {
		const { correlationId, ...body } = await r.json();
		assert.ok(correlationId);
		return [r.status, cookie(r), body];
	};
	const expected = [401, "", { code: "invalid_credentials", details: {}, retry: "never" }];
	assert.deepEqual(await refusal(await signIn(f, "enum@example.test", "Wrong-password-1")), expected);
	assert.deepEqual(await refusal(await signIn(f, "nobody-enum@example.test", "Wrong-password-1")), expected);
	const s = await (await f.req("get-session", undefined, cookie(await signIn(f, "enum@example.test")))).json();
	await f.db
		.execute(querySql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,request_revision,state,witness_checkpoint,cleanup_state,request_id,requested_at,cancel_until)
    VALUES('account',${s.accountId},1,'pending_deletion',1,'not_started',${randomUUID()},statement_timestamp(),statement_timestamp()+interval '720 hours')`);
	const blocked = await signIn(f, "enum@example.test");
	assert.deepEqual(await refusal(blocked), [401, "", { code: "unauthenticated", details: {}, retry: "never" }]);
});

test("AC:TARGET-IDN-001 AC:TARGET-IDN-028 INV-proof-link INV-identity: real routes reject wrong/missing origins, method and raw handler bypasses, unknown keys and unsafe returns", async () => {
	f.setIp("127.0.0.17");
	await register(f, "boundary@example.test");
	for (const origin of [
		"",
		"https://evil.example",
		f.origin.replace("http:", "https:"),
		f.origin.replace(/\d+$/, "1"),
		f.origin + ".evil.example",
	])
		assert.equal(
			(await f.req("sign-in/email", { email: "boundary@example.test", password }, undefined, { origin })).status,
			403,
		);
	const hostStatus = await new Promise<number>((resolve, reject) => {
		const r = httpRequest(f.origin + "/api/auth/get-session", { headers: { host: "evil.example" } }, (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		r.on("error", reject);
		r.end();
	});
	assert.equal(hostStatus, 403);
	assert.equal(
		(
			await f.req("get-session", undefined, undefined, {
				"x-forwarded-host": "evil.example",
				"x-forwarded-proto": "https",
			})
		).status,
		200,
	);
	for (const path of ["sign-up/email", "change-password", "reset-password/anything", "verify-email?token=forged"])
		assert.equal((await f.req(path)).status, 404);
	assert.equal(
		(await f.req("sign-in/email", { email: "boundary@example.test", password, actor: "forged" })).status,
		422,
	);
	const safe = await f.req("sign-in/email", { email: "boundary@example.test", password, returnTo: "/people?q=Alex" });
	assert.equal((await safe.json()).returnTo, "/people?q=Alex");
	const unsafe = await f.req("sign-in/email", { email: "boundary@example.test", password, returnTo: "//evil.example" });
	assert.equal((await unsafe.json()).returnTo, null);
	assert.deepEqual(
		await (
			await f.req("get-session", undefined, "forged=canary", { "user-agent": "Googlebot", "x-wiki-preview": "1" })
		).json(),
		{ status: "unauthenticated" },
	);
});

test("AC:TARGET-IDN-030 INV-identity: interruption after credentials preserves authenticated resumption, email verification and successful reset append event and outbox together", async () => {
	f.setIp("127.0.0.18");
	await f.db.execute(
		querySql`CREATE FUNCTION fail_pending() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_pending_failure'; END $$`,
	);
	await f.db.execute(
		querySql`CREATE TRIGGER fail_pending BEFORE INSERT ON account FOR EACH ROW EXECUTE FUNCTION fail_pending()`,
	);
	try {
		assert.deepEqual(await (await register(f, "interrupted@example.test")).json(), {
			status: "continue_identity_proof",
		});
	} finally {
		await f.db.execute(querySql`DROP TRIGGER fail_pending ON account`);
	}
	assert.equal(
		(await f.db.execute(querySql`SELECT count(*)::int n FROM auth_user WHERE email='interrupted@example.test'`))
			.rows[0]!.n,
		1,
	);
	await f.db.execute(
		querySql`UPDATE admission_attempt SET reserved_at=clock_timestamp()-interval '25 hours',expires_at=clock_timestamp()-interval '1 second' WHERE kind='registration'`,
	);
	const login = await signIn(f, "interrupted@example.test");
	assert.equal(login.status, 200);
	const c = cookie(login);
	assert.equal((await f.req("registration-status", undefined, c)).status, 401);
	assert.deepEqual(
		await (
			await f.req(
				"register",
				{ kind: "discovery", name: "Synthetic", email: "interrupted@example.test", password, requestKey: randomUUID() },
				c,
			)
		).json(),
		{ status: "continue_identity_proof" },
	);
	const status = await (await f.req("registration-status", undefined, c)).json();
	assert.equal(status.status, "pending_domain");
	assert.equal(
		(await f.db.execute(querySql`SELECT registration_kind FROM account WHERE id=${status.accountId}`)).rows[0]!
			.registration_kind,
		"discovery",
	);
	assert.equal((await f.req("send-verification-email", { email: "interrupted@example.test" }, c)).status, 200);
	await f.dispatch();
	const verification = f.effects.find(
		(v) => v.to === "interrupted@example.test" && v.text.startsWith("Verify your email"),
	);
	assert.ok(verification);
	const proof = new URL(verification.text.split("\n")[2]!).searchParams.get("token");
	assert.ok(proof);
	assert.deepEqual(await (await f.req("verify-email", { proof })).json(), { status: "email_verified" });
	assert.equal(
		(await f.db.execute(querySql`SELECT email_verified FROM auth_user WHERE email='interrupted@example.test'`)).rows[0]!
			.email_verified,
		true,
	);
	const reset = await resetProof("interrupted@example.test");
	assert.equal(
		(
			await f.req("reset-password", {
				proof: reset,
				newPassword: "Fixture-final-pass-4",
				confirmPassword: "Fixture-final-pass-4",
			})
		).status,
		200,
	);
	assert.equal(
		(
			await f.db.execute(
				querySql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${status.accountId} AND action='identity.credential_changed'`,
			)
		).rows[0]!.n,
		1,
	);
	const outbox = await f.db.execute(
		querySql`SELECT state FROM mail WHERE tenant_id=${status.accountId} AND logical_key LIKE 'password_reset/outcome/%'`,
	);
	assert.deepEqual(outbox.rows, [{ state: "pending" }]);
	await f.dispatch();
	assert.ok(
		f.effects.find(
			(v) => v.to === "interrupted@example.test" && v.text.startsWith("Your Everyfield password was reset"),
		),
		JSON.stringify(
			(
				await f.db.execute(
					querySql`SELECT m.state,j.state AS job_state,j.error_code FROM mail m JOIN job j ON j.id=m.job_id WHERE m.tenant_id=${status.accountId}`,
				)
			).rows,
		),
	);
});

test("AC:TARGET-IDN-001 INV-identity: a successful login never clears other identifiers or the trusted-IP failure budget", async () => {
	f.setIp("127.0.0.19");
	await register(f, "ip-limit@example.test");
	for (let i = 0; i < 4; i++) assert.equal((await signIn(f, "ip-limit@example.test", "Wrong-password-1")).status, 401);
	assert.equal((await signIn(f, "ip-limit@example.test")).status, 200);
	const attempts = await Promise.all(
		Array.from({ length: 20 }, (_, i) =>
			signIn(f, `ip-other-${i}@example.test`, "Wrong-password-1").then((r) => r.status),
		),
	);
	assert.equal(attempts.filter((s) => s === 401).length, 16);
	assert.equal(attempts.filter((s) => s === 429).length, 4);
	const fake = new Request(f.origin, {
		headers: { "x-forwarded-for": "192.0.2.1", "x-vercel-forwarded-for": "192.0.2.2" },
	});
	assert.equal(trustedIdentityIp(fake, false), null);
	assert.equal(trustedIdentityIp(fake, true), "192.0.2.2");
	assert.equal(
		trustedIdentityIp(new Request(f.origin, { headers: { "x-vercel-forwarded-for": "192.0.2.1, 192.0.2.2" } }), true),
		null,
	);
});

test("INV-identity: outcome mail INSERT failure rolls back the success event without restoring credentials or sessions", async () => {
	f.setIp("127.0.0.20");
	await register(f, "mail-rollback@example.test");
	const c = cookie(await signIn(f, "mail-rollback@example.test"));
	const state = await (await f.req("get-session", undefined, c)).json();
	const proof = await resetProof("mail-rollback@example.test");
	await f.db.execute(
		querySql`CREATE FUNCTION fail_outcome_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.logical_key LIKE 'password_reset/outcome/%' THEN RAISE EXCEPTION 'synthetic_mail_insert_failure'; END IF;RETURN NEW;END $$`,
	);
	await f.db.execute(
		querySql`CREATE TRIGGER fail_outcome_mail BEFORE INSERT ON mail FOR EACH ROW EXECUTE FUNCTION fail_outcome_mail()`,
	);
	const diagnosticsBefore = f.diagnostics.length;
	try {
		assert.deepEqual(
			await (
				await f.req("reset-password", {
					proof,
					newPassword: "Fixture-mail-pass-5",
					confirmPassword: "Fixture-mail-pass-5",
				})
			).json(),
			{ status: "password_reset", next: "sign_in" },
		);
	} finally {
		await f.db.execute(querySql`DROP TRIGGER fail_outcome_mail ON mail`);
	}
	assert.deepEqual(
		(
			await f.db.execute(
				querySql`SELECT action FROM audit_event WHERE subject_id=${state.accountId} ORDER BY recorded_at`,
			)
		).rows,
		[{ action: "identity.credential_observed" }],
	);
	assert.equal(
		(
			await f.db.execute(
				querySql`SELECT count(*)::int n FROM mail WHERE tenant_id=${state.accountId} AND logical_key LIKE 'password_reset/outcome/%'`,
			)
		).rows[0]!.n,
		0,
	);
	assert.deepEqual(await (await f.req("get-session", undefined, c)).json(), { status: "unauthenticated" });
	assert.equal((await signIn(f, "mail-rollback@example.test", password)).status, 401);
	assert.equal((await signIn(f, "mail-rollback@example.test", "Fixture-mail-pass-5")).status, 200);
	assert.ok(
		f.diagnostics
			.slice(diagnosticsBefore)
			.some((v: unknown) => typeof v === "object" && v !== null && "outcome" in v && v.outcome === "reporting_pending"),
	);
});

test("INV-identity: existing and missing recovery/verification requests perform no identity lookup or outbox write before their response", async () => {
	f.setIp("127.0.0.21");
	await register(f, "deferred@example.test");
	await f.runDeliveryRequests();
	const proofs = (await f.db.execute(querySql`SELECT count(*)::int n FROM auth_verification`)).rows[0]!.n;
	const mails = (await f.db.execute(querySql`SELECT count(*)::int n FROM mail`)).rows[0]!.n;
	for (const path of ["request-password-reset", "send-verification-email"])
		for (const email of ["deferred@example.test", "absent-deferred@example.test"]) {
			assert.deepEqual(await (await f.req(path, { email })).json(), { status: "accepted" });
			assert.equal((await f.db.execute(querySql`SELECT count(*)::int n FROM auth_verification`)).rows[0]!.n, proofs);
			assert.equal((await f.db.execute(querySql`SELECT count(*)::int n FROM mail`)).rows[0]!.n, mails);
		}
	assert.equal(f.pendingDeliveryCount(), 4);
	await f.dispatch();
	assert.equal(f.effects.filter((e) => e.to === "deferred@example.test").length, 2);
});

test("BUG-PR94: killing post-response recovery work leaves no stuck state and permits the next budgeted request", async () => {
	f.setIp("127.0.0.22");
	const serviceUrl = new URL("../../../packages/domain/src/identity/index.ts", import.meta.url).href;
	const mailUrl = new URL("../../../packages/domain/src/jobs/mail.ts", import.meta.url).href;
	const worker = `
    import {createServer} from 'node:http';import {once} from 'node:events';
    import {createIdentityService} from ${JSON.stringify(serviceUrl)};import {createMailService} from ${JSON.stringify(mailUrl)};
    const chunks=[];for await(const c of process.stdin)chunks.push(c);const v=JSON.parse(Buffer.concat(chunks));
    const {createDatabase}=await import(${JSON.stringify(new URL("../../../packages/db/src/client.ts", import.meta.url).href)});
    const db=createDatabase({connectionString:v.IDENTITY_DATABASE_URL}),authDb=createDatabase({connectionString:v.IDENTITY_AUTH_DATABASE_URL}),admissionDb=createDatabase({connectionString:v.IDENTITY_DATABASE_URL});
    const mail=createMailService({db,encryptionKey:Buffer.from(v.IDENTITY_MAIL_KEY,'hex'),addressKey:Buffer.from(v.IDENTITY_ADDRESS_KEY,'hex'),from:v.IDENTITY_MAIL_FROM,
      authorize:async()=>new Set(),transport:{async send(){throw Error('producer_only')},async lookup(){throw Error('producer_only')}}});
    const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
    const service=createIdentityService({db,authDb,admissionDb,origin,secret:v.IDENTITY_SECRET,trustedIp:()=> '127.0.0.22',
      scheduleDelivery:()=>{},diagnostic:()=>{},
      enqueueMail:(tx,m)=>mail.enqueue(tx,{owner:{kind:'account',id:m.accountId},purpose:m.purpose,logicalKey:m.logicalKey,recipient:m.accountId,address:m.address,
        content:{subject:m.subject,text:m.text},operation:null,notice:null,eligibleAt:new Date().toISOString()})});
    server.on('request',async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);
      const response=await service.handle(new Request(origin+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(chunks)}));
      res.statusCode=response.status;res.end(Buffer.from(await response.arrayBuffer()));});
    console.log(origin);
  `;
	for (const [i, path] of ["request-password-reset", "send-verification-email"].entries()) {
		const email = `lost-worker-${i}@example.test`;
		await register(f, email);
		const c = cookie(await signIn(f, email));
		const proofs = (await f.db.execute(querySql`SELECT count(*)::int n FROM auth_verification`)).rows[0]!.n;
		const mails = (await f.db.execute(querySql`SELECT count(*)::int n FROM mail`)).rows[0]!.n;
		const child = spawn(
			process.execPath,
			["--import", "tsx", "--conditions=react-server", "--input-type=module", "--eval", worker],
			{ stdio: ["pipe", "pipe", "ignore"] },
		);
		child.stdin.end(JSON.stringify(f.previewSettings));
		const exited = once(child, "exit");
		try {
			const [line] = await Promise.race([
				once(child.stdout, "data"),
				exited.then(() => {
					throw Error("recovery_worker_exited_before_ready");
				}),
			]);
			const origin = String(line).trim();
			assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
			const response = await fetch(origin + "/api/auth/" + path, {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body: JSON.stringify({ email }),
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { status: "accepted" });
			child.kill("SIGKILL");
			const [code, signal] = await exited;
			assert.equal(code, null);
			assert.equal(signal, "SIGKILL");
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
		}
		assert.equal((await f.db.execute(querySql`SELECT count(*)::int n FROM auth_verification`)).rows[0]!.n, proofs);
		assert.equal((await f.db.execute(querySql`SELECT count(*)::int n FROM mail`)).rows[0]!.n, mails);
		assert.equal((await (await f.req("get-session", undefined, c)).json()).status, "pending_domain");
		assert.equal((await signIn(f, email)).status, 200);
		assert.deepEqual(await (await f.req(path, { email })).json(), { status: "accepted" });
		await f.dispatch();
		assert.equal(f.effects.filter((e) => e.to === email).length, 1);
		assert.equal(
			(
				await f.db.execute(
					querySql`SELECT count(*)::int n FROM admission_attempt WHERE kind='reset' AND state='reserved'`,
				)
			).rows[0]!.n,
			0,
		);
	}
});

const alone = async (query: ReturnType<typeof querySql>) =>
	(await f.db.execute<Record<string, unknown>>(query)).rows[0]!;
const effects = () =>
	alone(
		querySql`SELECT (SELECT count(*)::int FROM auth_user) users,(SELECT count(*)::int FROM account) accounts,
			(SELECT count(*)::int FROM auth_session) sessions,(SELECT count(*)::int FROM seat) seats,
			(SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM audit_event) events,
			(SELECT count(*)::int FROM mail) mail,(SELECT count(*)::int FROM job) jobs`,
	);
const failing = async (table: string, when: string, body: () => Promise<void>) => {
	await f.db.execute(
		querySql.raw(
			`CREATE FUNCTION fail_required() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_required_failure'; END $$;
			 CREATE TRIGGER fail_required BEFORE ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_required()`,
		),
	);
	try {
		await body();
	} finally {
		await f.db.execute(querySql.raw(`DROP TRIGGER fail_required ON ${table};DROP FUNCTION fail_required()`));
	}
};
const loginHash = (value: string) =>
	createHmac("sha256", f.previewSettings.IDENTITY_SECRET).update(value).digest("hex");
const loginFailures = async (email: string) =>
	(
		await alone(
			querySql`SELECT count(*)::int n FROM admission_attempt WHERE kind='login' AND state='failed' AND identifier_hash=${loginHash(email)}`,
		)
	).n;
const failedLogins = (n: number, email: string, ip: string, age: string) =>
	f.db.execute(
		querySql`INSERT INTO admission_attempt(id,kind,identifier_hash,trusted_ip_hash,reserved_at,state,expires_at)
			SELECT gen_random_uuid(),'login',${loginHash(email)},${loginHash(ip)},clock_timestamp()-${age}::interval,'failed',clock_timestamp()+interval '9 hours'
			FROM generate_series(1,${n}::int)`,
	);

test("AC:TARGET-IDN-001 five identifier failures or twenty trusted-IP failures inside fifteen minutes refuse the right password, and nothing else is cleared or written", async () => {
	f.setIp("127.0.1.1");
	const email = "alex@example.test",
		other = "other-alex@example.test";
	await register(f, email);
	const attempt = async (address = email) => {
		const response = await signIn(f, address);
		const body = await response.json();
		return [response.status, body.code ?? body.status, cookie(response) !== ""];
	};
	const LIMITED = [429, "rate_limited", false],
		SIGNED_IN = [200, "signed_in", true];
	const clear = () => f.db.execute(querySql`DELETE FROM admission_attempt WHERE kind='login'`);
	const inside = "14 minutes 30 seconds",
		cutoff = "15 minutes";
	const rows: [string, [identifier: number, age: string], [ip: number, age: string], string | null, unknown[]][] = [
		["4 identifier failures", [4, inside], [0, inside], "127.0.1.1", SIGNED_IN],
		["5 identifier failures", [5, inside], [0, inside], "127.0.1.1", LIMITED],
		["5 identifier failures at the cutoff", [5, cutoff], [0, inside], "127.0.1.1", SIGNED_IN],
		["19 IP failures", [0, inside], [19, inside], "127.0.1.1", SIGNED_IN],
		["20 IP failures", [0, inside], [20, inside], "127.0.1.1", LIMITED],
		["20 IP failures at the cutoff", [0, inside], [20, cutoff], "127.0.1.1", SIGNED_IN],
		["20 IP failures, unknown IP", [0, inside], [20, inside], null, SIGNED_IN],
		["5 identifier failures, unknown IP", [5, inside], [0, inside], null, LIMITED],
	];
	for (const [name, [identifiers, age], [ips, ipAge], ip, expected] of rows) {
		await clear();
		await failedLogins(identifiers, email, "127.0.1.99", age);
		await failedLogins(ips, other, "127.0.1.1", ipAge);
		f.setIp(ip);
		assert.deepEqual(await attempt(" ALEX@Example.Test "), expected, name);
	}
	f.setIp("127.0.1.1");
	await clear();
	await failedLogins(5, email, "127.0.1.99", inside);
	await failedLogins(19, other, "127.0.1.1", inside);
	const before = await effects();
	for (const address of [email, "ALEX@EXAMPLE.TEST"]) assert.deepEqual(await attempt(address), LIMITED);
	const forged = await f.req("sign-in/email", { email, password }, undefined, { "x-forwarded-for": "198.51.100.9" });
	assert.equal(forged.status, 429);
	assert.deepEqual(await effects(), before);
	assert.deepEqual([await loginFailures(email), await loginFailures(other)], [5, 19]);
	await f.db.execute(
		querySql`DELETE FROM admission_attempt WHERE id=(SELECT id FROM admission_attempt WHERE kind='login' AND identifier_hash=${loginHash(email)} LIMIT 1)`,
	);
	assert.deepEqual(await attempt(), SIGNED_IN);
	assert.deepEqual([await loginFailures(email), await loginFailures(other)], [0, 19]);
});

test("AC:TARGET-IDN-001 an expired cookie still reaches sign-in, which keeps a safe nested return path and refuses unsafe ones", async () => {
	f.setIp("127.0.1.2");
	await register(f, "nested@example.test");
	const c = cookie(await signIn(f, "nested@example.test"));
	const s = await (await f.req("get-session", undefined, c)).json();
	await f.db.execute(
		querySql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${s.sessionId}`,
	);
	const back = async (returnTo: string) => {
		const response = await f.req("sign-in/email", { email: "nested@example.test", password, returnTo }, c);
		assert.equal(response.status, 200);
		return (await response.json()).returnTo;
	};
	assert.equal(await back("/people/p1?returnTo=%2Ftasks%3Fmine%3D1"), "/people/p1?returnTo=%2Ftasks%3Fmine%3D1");
	for (const unsafe of ["https://evil.example/x", "//evil.example", "/\\evil.example", "\\evil", "/a\u0000b", "/a\nb"])
		assert.equal(await back(unsafe), null, JSON.stringify(unsafe));
	for (let i = 0; i < 2; i++) assert.deepEqual(await (await f.req("sign-out", {}, c)).json(), { status: "signed_out" });
});

test("AC:TARGET-IDN-001 a sign-in whose session, or whose admission row, cannot be written signs nobody in and writes nothing else", async () => {
	f.setIp("127.0.1.3");
	await register(f, "required@example.test");
	const before = await effects();
	for (const table of ["auth_session", "admission_attempt"])
		await failing(table, "INSERT", async () => {
			const response = await signIn(f, "required@example.test");
			assert.ok([401, 503].includes(response.status), table + response.status);
			assert.equal(cookie(response), "");
		});
	await failing("admission_attempt", "UPDATE", async () => {
		const response = await signIn(f, "required@example.test");
		assert.equal(response.status, 503);
		assert.equal((await response.json()).code, "unavailable");
		assert.equal(cookie(response), "");
	});
	assert.deepEqual(await effects(), before);
	assert.equal(
		(
			await alone(
				querySql`SELECT count(*)::int n FROM auth_session s JOIN auth_user u ON u.id=s.user_id WHERE u.email='required@example.test'`,
			)
		).n,
		0,
	);
	assert.equal((await signIn(f, "required@example.test")).status, 200);
});

test("AC:TARGET-IDN-030 AC:WP005-API-STAGED a registration whose credential or account row cannot be written leaves no domain write, seat or event", async () => {
	f.setIp("127.0.1.4");
	const before = await effects();
	for (const table of ["auth_user", "auth_account", "admission_attempt"])
		await failing(table, "INSERT", async () => {
			const response = await register(f, "unwritten@example.test");
			assert.equal(cookie(response), "");
			assert.ok([200, 503].includes(response.status), table + response.status);
		});
	assert.deepEqual(await effects(), before);
	assert.deepEqual(await (await register(f, "unwritten@example.test")).json(), { status: "continue_identity_proof" });
	const stolen = await f.req("register", {
		kind: "discovery",
		name: "Other",
		email: "unwritten@example.test",
		password: "Fixture-other-pass-9",
		requestKey: randomUUID(),
	});
	assert.equal(cookie(stolen), "");
	assert.equal((await signIn(f, "unwritten@example.test", "Fixture-other-pass-9")).status, 401);
	assert.deepEqual(await effects(), {
		...before,
		users: Number(before.users) + 1,
		accounts: Number(before.accounts) + 1,
	});
});

test("AC:TARGET-IDN-009 AC:WP005-API-RESET a reset whose outcome is unknown is tried once, records no success and leaves the old password; a foreign-purpose proof is refused", async () => {
	f.setIp("127.0.1.5");
	const zone = process.env.TZ;
	process.env.TZ = "Pacific/Kiritimati";
	try {
		await register(f, "unknown-reset@example.test");
		const c = cookie(await signIn(f, "unknown-reset@example.test"));
		const { accountId } = await (await f.req("get-session", undefined, c)).json();
		const reset = (proof: string) =>
			f.req("reset-password", { proof, newPassword: "Fixture-new-pass-2", confirmPassword: "Fixture-new-pass-2" });
		const events = async () =>
			(
				await f.db.execute(
					querySql`SELECT action FROM audit_event WHERE subject_id=${accountId} AND action='identity.credential_changed'`,
				)
			).rows;
		assert.equal((await f.req("send-verification-email", { email: "unknown-reset@example.test" })).status, 200);
		await f.dispatch();
		const verification = f.effects.findLast(
			(v) => v.to === "unknown-reset@example.test" && v.text.startsWith("Verify your email"),
		)!;
		const foreign = new URL(verification.text.split("\n")[2]!).searchParams.get("token")!;
		assert.equal((await reset(foreign)).status, 400);
		const proof = await resetProof("unknown-reset@example.test");
		await f.db.execute(
			querySql`CREATE SEQUENCE reset_writes;CREATE FUNCTION fail_credential() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN PERFORM nextval('reset_writes');RAISE EXCEPTION 'synthetic_unknown'; END $$;
				CREATE TRIGGER fail_credential BEFORE UPDATE ON auth_account FOR EACH ROW EXECUTE FUNCTION fail_credential()`,
		);
		const diagnostics = f.diagnostics.length;
		try {
			const unknown = await reset(proof);
			assert.equal(unknown.status, 503);
			assert.equal((await unknown.json()).code, "unavailable");
			await f.dispatch();
			assert.equal(Number((await alone(querySql`SELECT last_value::int n FROM reset_writes`)).n), 1);
		} finally {
			await f.db.execute(
				querySql`DROP TRIGGER fail_credential ON auth_account;DROP FUNCTION fail_credential();DROP SEQUENCE reset_writes`,
			);
		}
		assert.ok(
			f.diagnostics
				.slice(diagnostics)
				.some((v) => typeof v === "object" && v !== null && "outcome" in v && v.outcome === "unknown"),
		);
		assert.deepEqual(await events(), []);
		assert.equal((await signIn(f, "unknown-reset@example.test")).status, 200);
		assert.equal((await signIn(f, "unknown-reset@example.test", "Fixture-new-pass-2")).status, 401);
		const moved = await resetProof("unknown-reset@example.test");
		await f.db.execute(
			querySql`UPDATE auth_user SET email='moved-reset@example.test' WHERE email='unknown-reset@example.test'`,
		);
		await register(f, "unknown-reset@example.test");
		assert.equal((await reset(moved)).status, 200);
		assert.equal((await signIn(f, "moved-reset@example.test", "Fixture-new-pass-2")).status, 200);
		assert.equal((await signIn(f, "unknown-reset@example.test", "Fixture-new-pass-2")).status, 401);
		assert.deepEqual(await (await f.req("get-session", undefined, c)).json(), { status: "unauthenticated" });
		assert.equal((await events()).length, 1);
	} finally {
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	}
});

type Login = { id: string; email: string; password: string; cookie: string; session: string };
async function login(email: string, secret = password): Promise<Login> {
	const response = await signIn(f, email, secret);
	assert.equal(response.status, 200, email);
	const { accountId, sessionId } = await (await f.req("get-session", undefined, cookie(response))).json();
	return { id: accountId, email, password: secret, cookie: cookie(response), session: sessionId };
}
async function verifiedLogin(email: string) {
	await register(f, email);
	await f.db.execute(querySql`UPDATE auth_user SET email_verified=true WHERE email=${email}`);
	const who = await login(email);
	await f.db.execute(querySql`UPDATE account SET registration_state='active' WHERE id=${who.id}`);
	return who;
}
function settingsCredentials() {
	const proofs: string[] = [];
	const api = createAccountCredentials({
		db: f.runtime,
		authDb: f.authDb,
		admissionDb: f.runtime,
		origin: f.origin,
		secret: f.previewSettings.IDENTITY_SECRET,
		request: async (c) => {
			const { cookie: held, id, email } = c as unknown as Login & { session: never };
			return {
				request: new Request(f.origin + "/api/settings", {
					method: "POST",
					headers: { origin: f.origin, cookie: held },
				}),
				trustedIp: "127.0.2.1",
				viewer: { accountId: id, email, verified: true },
			};
		},
		responseCookies: async () => {},
		diagnostic: () => {},
		deliverVerification: async (_tx, i) => void proofs.push(i.token),
		securityNotice: async () => randomUUID(),
	});
	const context = (who: Login) => ({ ...who, selected: { kind: "account", id: who.id } }) as never;
	return {
		changePassword: (who: Login, newPassword: string) =>
			api.changePassword(context(who), {
				currentPassword: who.password,
				newPassword,
				confirmPassword: newPassword,
			}),
		emailProof: async (who: Login, newEmail: string) => {
			assert.equal((await api.requestEmailChange(context(who), { newEmail })).status, "ok");
			return proofs.at(-1)!;
		},
		confirmEmail: (who: Login, proof: string) => api.confirmEmailChange(context(who), { proof }),
	};
}

test("AC:TARGET-IDN-007 AC:TARGET-IDN-008 AC:TARGET-IDN-009 a password reset after, or racing, a password change or an email confirmation has one winner per proof and revokes every earlier session", async () => {
	f.setIp("127.0.2.1");
	const settings = settingsCredentials();
	const reset = (proof: string, newPassword: string) =>
		f.req("reset-password", { proof, newPassword, confirmPassword: newPassword });
	const changes = async (who: Login) =>
		(
			await f.db.execute(
				querySql`SELECT action,count(*)::int n FROM audit_event WHERE subject_id=${who.id}
					AND action IN ('identity.credential_changed','identity.email_changed') GROUP BY 1 ORDER BY 1`,
			)
		).rows.map((r) => `${String(r.action)} ${String(r.n)}`);
	const works = async (email: string, secret: string) => (await signIn(f, email, secret)).status === 200;
	const ended = async (who: Login) =>
		assert.deepEqual(await (await f.req("get-session", undefined, who.cookie)).json(), { status: "unauthenticated" });

	const first = await verifiedLogin("changed-first@example.test");
	const outstanding = await resetProof(first.email);
	assert.equal((await settings.changePassword(first, "Changed-first-pass-2")).status, "succeeded");
	const between = await login(first.email, "Changed-first-pass-2");
	assert.equal(
		(await reset(outstanding, "Reset-second-pass-3")).status,
		200,
		"a password change leaves the proof live",
	);
	assert.deepEqual(await changes(first), ["identity.credential_changed 2"]);
	for (const who of [first, between]) await ended(who);
	assert.equal(await works(first.email, "Changed-first-pass-2"), false);
	assert.equal(await works(first.email, "Reset-second-pass-3"), true);
	assert.equal((await reset(outstanding, "Reset-again-pass-4")).status, 400, "the proof is used once");

	const moved = await verifiedLogin("moved-first@example.test");
	const confirm = await settings.emailProof(moved, "moved-first-new@example.test");
	const held = await resetProof(moved.email);
	assert.equal((await settings.confirmEmail(moved, confirm)).status, "succeeded");
	assert.equal(
		(await reset(held, "Reset-second-pass-3")).status,
		200,
		"the proof belongs to the account, not its address",
	);
	assert.deepEqual(await changes(moved), ["identity.credential_changed 1", "identity.email_changed 1"]);
	await ended(moved);
	assert.equal(await works("moved-first-new@example.test", "Reset-second-pass-3"), true);
	assert.equal(await works(moved.email, "Reset-second-pass-3"), false);

	for (let round = 0; round < 3; round++) {
		f.setIp(`127.0.2.${10 + round}`);
		const raced = await verifiedLogin(`raced-${round}@example.test`);
		const proof = await resetProof(raced.email);
		const [change, redeemed] = await Promise.all([
			settings.changePassword(raced, "Changed-race-pass-2"),
			reset(proof, "Reset-race-pass-3"),
		]);
		assert.equal(redeemed.status, 200);
		const won = change.status === "succeeded" ? 2 : 1;
		assert.deepEqual(await changes(raced), [`identity.credential_changed ${won}`], change.status);
		const live = [];
		for (const secret of [raced.password, "Changed-race-pass-2", "Reset-race-pass-3"])
			if (await works(raced.email, secret)) live.push(secret);
		assert.equal(live.length, 1, "one password is left");
		assert.ok(live[0] === "Reset-race-pass-3" || (won === 2 && live[0] === "Changed-race-pass-2"));
		await ended(raced);
		f.setIp(`127.0.2.${20 + round}`);
		const both = await verifiedLogin(`raced-mail-${round}@example.test`);
		const target = `raced-mail-new-${round}@example.test`;
		const emailProof = await settings.emailProof(both, target);
		const resetting = await resetProof(both.email);
		const [confirmed, again] = await Promise.all([
			settings.confirmEmail(both, emailProof),
			reset(resetting, "Reset-race-pass-3"),
		]);
		assert.equal(again.status, 200);
		const renamed = confirmed.status === "succeeded";
		assert.deepEqual(await changes(both), [
			"identity.credential_changed 1",
			...(renamed ? ["identity.email_changed 1"] : []),
		]);
		for (const [email, current] of [
			[target, renamed],
			[both.email, !renamed],
		] as const)
			assert.equal(await works(email, "Reset-race-pass-3"), current, email);
		await ended(both);
	}
});

test("AC:TARGET-IDN-004 no fixture identity switch exists: forged switch requests answer not found and issue no session, and fixtures refuse production", async () => {
	f.setIp("127.0.1.6");
	await register(f, "switch@example.test");
	await register(f, "switched@example.test");
	const c = cookie(await signIn(f, "switch@example.test"));
	const target = (
		await alone(
			querySql`SELECT a.id FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email='switched@example.test'`,
		)
	).id;
	const before = await effects();
	for (const path of [
		"dev.switchFixtureIdentity",
		"dev/switch-fixture-identity",
		"switch-fixture-identity",
		"admin/impersonate-user",
		"multi-session/set-active",
	])
		for (const identity of ["owner", "switched@example.test", target, "not-an-account"])
			for (const headers of [{}, { "x-fixture-identity": String(identity), "x-role": "owner" }] as Record<
				string,
				string
			>[])
				for (const jar of [undefined, c]) {
					const response = await f.req(
						path,
						{ identity, userId: identity, role: "owner", enabled: true },
						jar,
						headers,
					);
					assert.equal(response.status, 404, path);
					assert.deepEqual(await response.json(), { code: "unavailable" });
					assert.equal(cookie(response), "");
				}
	assert.deepEqual(await effects(), before);
	assert.equal((await (await f.req("get-session", undefined, c)).json()).status, "pending_domain");
	assert.equal(
		(await f.req("sign-in/email", { email: "switch@example.test", password, identity: "owner", fixture: true })).status,
		422,
	);
	const keys = { IDENTITY_MAIL_KEY: "a".repeat(64), IDENTITY_ADDRESS_KEY: "b".repeat(64) };
	const qa = "postgres://u:p@ep-some-branch.example.test/db";
	assert.equal(seedRefusal({ ...keys, DATABASE_URL: qa }), null);
	for (const env of [
		{ ...keys, DATABASE_URL: qa, NODE_ENV: "production" },
		{ ...keys, DATABASE_URL: "postgres://u:p@ep-gentle-dust-x.example.test/db" },
		{ ...keys },
	])
		assert.notEqual(seedRefusal(env), null);
	assert.deepEqual(await effects(), before);
});

test("AC:TARGET-IDN-004 the isolated fixture sign-in gives a session to a named fixture login only, never to an arbitrary account", async () => {
	f.setIp("127.0.1.7");
	await register(f, "customer@example.test");
	const customer = (
		await alone(
			querySql`SELECT a.id FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email='customer@example.test'`,
		)
	).id;
	await f.db.execute(querySql`DELETE FROM admission_attempt`);
	for (const email of [QA_LOGINS.owner, QA_LOGINS.admin])
		assert.equal(
			(
				await f.req("register", {
					kind: "discovery",
					name: "Fixture",
					email,
					password: QA_PASSWORD,
					requestKey: randomUUID(),
				})
			).status,
			200,
		);
	const folder = await mkdtemp(join(tmpdir(), "fixture-signin-"));
	try {
		const out = join(folder, "cookies.json");
		const input = {
			origin: f.origin,
			secret: f.previewSettings.IDENTITY_SECRET,
			runtimeUrl: f.previewSettings.IDENTITY_DATABASE_URL,
			authUrl: f.previewSettings.IDENTITY_AUTH_DATABASE_URL,
			out,
			personas: ["owner", "admin", "customer@example.test", customer],
		};
		const script = fileURLToPath(new URL("../../../tools/app/signin.ts", import.meta.url));
		const child = spawn(
			process.execPath,
			["--import", "tsx", "--conditions=react-server", script, JSON.stringify(input)],
			{ stdio: "ignore" },
		);
		const [code] = await once(child, "exit");
		assert.equal(code, 0);
		const issued: Record<string, { name: string; value: string }> = JSON.parse(await readFile(out, "utf8"));
		assert.deepEqual(Object.keys(issued).sort(), ["admin", "owner"]);
		assert.deepEqual(
			(
				await f.db.execute(
					querySql`SELECT u.email,count(*)::int n FROM auth_session s JOIN auth_user u ON u.id=s.user_id WHERE u.email IN (${QA_LOGINS.owner},${QA_LOGINS.admin},'customer@example.test') GROUP BY 1 ORDER BY 1`,
				)
			).rows,
			[
				{ email: QA_LOGINS.admin, n: 1 },
				{ email: QA_LOGINS.owner, n: 1 },
			],
		);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
});

test("AC:TARGET-IDN-028 a missing, forged, expired or revoked cookie reads nothing private, whatever crawler or preview headers it carries", async () => {
	f.setIp("127.0.1.8");
	const { NextRequest } = createRequire(new URL("../../../apps/web/package.json", import.meta.url))("next/server");
	const { proxy, config } = await import("../../../apps/web/src/proxy.ts");
	const canary = "CARE-CANARY-" + randomUUID();
	await register(f, "cookie-life@example.test");
	const signed = () => signIn(f, "cookie-life@example.test").then(cookie);
	const [live, expired, revoked] = [await signed(), await signed(), await signed()];
	const sessionOf = async (c: string) => (await (await f.req("get-session", undefined, c)).json()).sessionId;
	const { accountId } = await (await f.req("get-session", undefined, live)).json();
	const plant = randomUUID();
	await f.db.execute(
		querySql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${plant},${canary},'America/Chicago',7,14,1,8,1,1)`,
	);
	await f.db.execute(querySql`UPDATE account SET registration_state='active' WHERE id=${accountId}`);
	await f.db.execute(
		querySql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${accountId},${plant},'admin',clock_timestamp())`,
	);
	await f.db.execute(
		querySql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${await sessionOf(expired)}`,
	);
	assert.equal((await f.req("sign-out", {}, revoked)).status, 200);
	const forged = live.replace(/(session_token=)[^;]+/, "$1forged.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D");
	const headers = {
		"user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
		"x-wiki-preview": "1",
		"x-routed-url": f.origin + "/wiki/public",
		"x-everyfield-path": "/wiki/public",
	};
	const tokenOf = (c: string) =>
		signedSessionToken(
			decodeURIComponent(c.match(/session_token=([^;]+)/)?.[1] ?? ""),
			f.previewSettings.IDENTITY_SECRET,
		);
	const before = { ...(await effects()), sessions: null };
	for (const [name, c] of [
		["none", ""],
		["forged", forged],
		["expired", expired],
		["revoked", revoked],
	] as const) {
		const session = await f.req("get-session", undefined, c || undefined, headers);
		assert.equal(session.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(await session.json(), { status: "unauthenticated" }, name);
		const status = await f.req("registration-status", undefined, c || undefined, headers);
		const body = await status.json();
		assert.deepEqual([status.status, body.code, body.details], [401, "unauthenticated", {}], name);
		assert.equal(JSON.stringify(body).includes(canary), false);
		const token = tokenOf(c);
		assert.equal(token ? await readRequestViewer(f.runtime, token) : null, null, name);
	}
	const liveToken = tokenOf(live);
	assert.ok(liveToken);
	const viewer = await readRequestViewer(f.runtime, liveToken);
	assert.ok(viewer?.viewer?.authority, "the live cookie reads its own seat");
	assert.deepEqual({ ...(await effects()), sessions: null }, before);
	const families = config.matcher
		.map((path) => path.split("/:")[0]!)
		.filter((path) => !["/confirm-email", "/reset-password", "/verify-email"].includes(path));
	assert.ok(families.includes("/people") && families.includes("/settings"));
	for (const path of families) {
		const answer = proxy(new NextRequest("https://everyfield.test" + path + "?q=Alex", { headers }));
		assert.equal(answer.status, 307, path);
		const to = new URL(answer.headers.get("location")!);
		assert.deepEqual(
			[to.origin, to.pathname, to.searchParams.get("returnTo")],
			["https://everyfield.test", "/signin", path + "?q=Alex"],
		);
		assert.equal(await answer.text(), "");
	}
});

test("AC:TARGET-IDN-028 the mail webhook is admitted only by a fresh valid signature over its raw body, whatever origin the request carries", () => {
	const key = randomBytes(32);
	const hook = "whsec_" + key.toString("base64");
	const raw = Buffer.from('{"type":"email.delivered"}');
	const now = 1_800_000_000_000;
	const signed = (body: Buffer, id = "msg_1", stamp = String(now / 1000), by = key) => ({
		"svix-id": id,
		"svix-timestamp": stamp,
		"svix-signature": "v1," + createHmac("sha256", by).update(`${id}.${stamp}.`).update(body).digest("base64"),
	});
	assert.equal(verifyCallback(raw, new Headers(signed(raw)), hook, now), "msg_1");
	for (const headers of [
		{ origin: f.origin },
		signed(Buffer.from("{}")),
		signed(raw, "msg_1", String(now / 1000 - 301)),
		signed(raw, "msg_1", String(now / 1000), randomBytes(32)),
		{ ...signed(raw), "svix-id": "msg_2" },
	] as Record<string, string>[])
		assert.throws(() => verifyCallback(raw, new Headers(headers), hook, now), /unavailable/);
});
