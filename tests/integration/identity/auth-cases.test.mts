import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { accountId, sessionId, tenantId } from "../../../packages/contracts/src/common/index.ts";
import { and, eq, isNull, sql } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { RequestActor, currentActor, readViewer } from "../../../packages/domain/src/access/session.ts";
import { raced } from "../../support/fixture.mts";
import { failingWrite, untouched } from "../../support/recorded.mts";
import { fixture, key, type Fixture } from "./invitations-support.mts";
import { identityAuth } from "../../../packages/domain/src/identity/auth.ts";
import { createAccountCredentials, deletionOperations } from "../../../packages/domain/src/settings/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { openedDeletion } from "../../support/deletion-cookie.mts";
import type { SettingsContext } from "../../../packages/contracts/src/settings/server.ts";
import { IDENTITY_LINK_SECONDS } from "../../../packages/contracts/src/identity/index.ts";
import { request as httpRequest } from "node:http";
import {
	cookie as cookieOf,
	fixture as identityFixture,
	password,
	register as nativeRegister,
	signIn,
} from "./support.mts";

type Step = {
	actor: { account: string; session: string; context: string | null };
	name?: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: unknown };
};
type Case = Step & { id: string; subcases?: Step[] };
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as {
	cases: Case[];
};
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const str = (value: unknown) => (typeof value === "string" ? value : assert.fail(JSON.stringify(value)));

let f: Fixture;
let g: Awaited<ReturnType<typeof identityFixture>>;
before(async () => {
	f = await fixture({ lockTimeout: "0" });
	g = await identityFixture();
});
after(async () => {
	await f?.close();
	await g?.close();
});

async function frozenAt<T>(instant: string, body: () => Promise<T>): Promise<T> {
	const clock = `${f.schema}.clock_timestamp()`;
	await f.admin.execute(
		sql.raw(`CREATE FUNCTION ${clock} RETURNS timestamptz LANGUAGE sql VOLATILE PARALLEL SAFE
			AS $$ SELECT '${new Date(instant).toISOString()}'::timestamptz $$`),
	);
	try {
		return await body();
	} finally {
		await f.admin.execute(sql.raw(`DROP FUNCTION ${clock}`));
	}
}
const PASSWORD = "Fixture-new-pass-2";
const ORIGIN = "http://settings.example.test",
	SECRET = randomBytes(40).toString("hex");
const ingress = new Map<string, Request>(),
	trustedIps = new Map<string, string>(),
	issued: string[] = [],
	reported: { correlationId: string; outcome: string }[] = [];
let world: { auth: ReturnType<typeof identityAuth>; credentials: ReturnType<typeof createAccountCredentials> } | null =
	null;
function credentialWorld() {
	world ??= {
		auth: identityAuth({
			db: f.admin,
			origin: ORIGIN,
			secret: SECRET,
			deliver: async () => {
				throw Error("not expected");
			},
		}),
		credentials: createAccountCredentials({
			db: f.db,
			authDb: f.admin,
			admissionDb: f.db,
			origin: ORIGIN,
			secret: SECRET,
			request: async (c) => {
				const request = ingress.get(c.session) ?? assert.fail("missing native request");
				const [v] = await f.admin
					.select({ accountId: t.account.id, email: t.auth_user.email, verified: t.auth_user.email_verified })
					.from(t.auth_session)
					.innerJoin(t.auth_user, eq(t.auth_user.id, t.auth_session.user_id))
					.innerJoin(t.account, eq(t.account.auth_user_id, t.auth_user.id))
					.where(eq(t.auth_session.id, c.session));
				return { request, trustedIp: trustedIps.get(c.session) ?? "198.51.100.41", viewer: v ?? null };
			},
			responseCookies: async (_c, cookies) => void issued.push(...cookies),
			diagnostic: (value) => void reported.push(value),
			deliverVerification: async () => {},
			securityNotice: (tx, i, writes) =>
				f.mail.append(
					tx,
					{
						owner: { kind: "account", id: i.accountId },
						purpose: "notification",
						logicalKey: "security/" + i.correlationId,
						recipient: i.accountId,
						address: i.address,
						content: { subject: "Security update", text: "Your sign-in details changed." },
						operation: null,
						notice: null,
						eligibleAt: new Date().toISOString(),
					},
					writes,
				),
		}),
	};
	return world;
}
type Login = { id: string; user: string; email: string; password: string };
async function nativeLogin(a: Login) {
	const { auth } = credentialWorld();
	const r = await auth.api.signInEmail({ body: { email: a.email, password: a.password }, asResponse: true });
	assert.equal(r.status, 200);
	const request = new Request(ORIGIN + "/api/settings", {
		method: "POST",
		headers: { origin: ORIGIN, cookie: jar(r) },
	});
	const s = await auth.api.getSession({ headers: request.headers });
	assert.ok(s);
	ingress.set(s.session.id, request);
	return { ...a, session: s.session.id, cookie: jar(r) };
}
async function credentialAccount(email = `alex-${key()}@example.test`, password = "Fixture-old-pass-1") {
	const { auth } = credentialWorld();
	const signed = await auth.api.signUpEmail({ body: { name: "Alex Rivera", email, password } });
	const [a] = await f.admin
		.insert(t.account)
		.values({ auth_user_id: signed.user.id, registration_state: "active", registration_kind: "planter" })
		.returning({ id: t.account.id });
	await f.admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, signed.user.id));
	return nativeLogin({ id: a!.id, user: signed.user.id, email, password });
}
const own = (a: { id: string; session: string }): SettingsContext => ({
	session: sessionId.parse(a.session),
	selected: { kind: "account", id: accountId.parse(a.id) },
});
const liveUser = async (cookie: string) =>
	(await credentialWorld().auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id ?? null;
const count = (...[table, predicate]: Parameters<Fixture["admin"]["$count"]>) => f.admin.$count(table, predicate);
const liveSeats = (account: string) => count(t.seat, and(eq(t.seat.account_id, account), isNull(t.seat.ended_at)));
let ips = 0;
const nextIp = () => `127.0.9.${++ips}`;
const jar = (response: Response) =>
	response.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
const answer = async (response: Response) => [response.status, await response.json()] as const;

async function identityOf(email: string) {
	const rows = await f.admin
		.select({
			user: t.auth_user.id,
			id: t.account.id,
			state: t.account.registration_state,
			digest: t.account.registration_digest,
			kind: t.account.registration_kind,
		})
		.from(t.auth_user)
		.leftJoin(t.account, eq(t.account.auth_user_id, t.auth_user.id))
		.where(eq(t.auth_user.email, email));
	assert.equal(rows.length, 1, email + " has one identity");
	return rows[0]!;
}
async function credentialKept(user: string) {
	assert.equal(await count(t.auth_user, eq(t.auth_user.id, user)), 1);
	assert.equal(
		await count(t.auth_account, and(eq(t.auth_account.user_id, user), eq(t.auth_account.provider_id, "credential"))),
		1,
	);
}
async function businessAccess(session: string) {
	const viewer = await readViewer(f.db, sessionId.parse(session));
	const actor = await RequestActor.resolve(f.db, sessionId.parse(session));
	return viewer?.authority != null || actor instanceof RequestActor;
}
async function invited(email: string) {
	const s = await f.setup();
	s.recipient.email = email;
	return { s, i: await f.invitation(s) };
}
async function register(native: ReturnType<Fixture["native"]>, email: string, i: { proof: string }) {
	const registered = await native(
		"register",
		{ kind: "invitation", name: "Alex", email, password: PASSWORD, invitationProof: i.proof, requestKey: key() },
		undefined,
		{ "x-test-ip": nextIp() },
	);
	assert.deepEqual(await answer(registered), [200, { status: "continue_identity_proof" }]);
	assert.equal(registered.headers.get("set-cookie"), null);
}
async function signedIn(native: ReturnType<Fixture["native"]>, email: string, password = PASSWORD) {
	const response = await native("sign-in/email", { email, password }, undefined, { "x-test-ip": nextIp() });
	assert.equal(response.status, 200);
	const cookie = jar(response);
	const session = await (await native("get-session", undefined, cookie)).json();
	return { cookie, session: str(session.sessionId), status: session.status };
}
async function credentialed(email: string) {
	const native = f.native();
	const response = await native(
		"register",
		{ kind: "discovery", name: "Casey", email, password: PASSWORD, requestKey: key() },
		undefined,
		{ "x-test-ip": nextIp() },
	);
	assert.equal(response.status, 200);
	const a = await identityOf(email);
	await f.admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, a.user));
	await f.admin.update(t.account).set({ registration_state: "active" }).where(eq(t.account.id, a.id!));
	return { ...(await signedIn(native, email)), id: a.id!, user: a.user, email };
}
async function bystander() {
	const Q = await f.workspace("plant", { timezone: "America/New_York" });
	const B = await f.account("active", `casey-${key()}@example.test`);
	await f.seat(B, Q, "admin");
	const seats = async () => JSON.stringify(await f.admin.select().from(t.seat).where(eq(t.seat.plant_id, Q.id)));
	return { Q, B, seats, before: await seats() };
}

test("AC:AUTH-001 a credential that committed grants nothing while any later account, token, seat, Person, audit or intent write fails, and the registration stays pending and resumable", async () => {
	const c = caseOf("AUTH-001");
	assert.equal(c.given["behavior-inputs"]!.domain_acceptance_fault, "Person_link");
	const native = f.native("invitation_only");
	const q = await bystander();
	const email = "alex@example.test";
	const { s, i } = await invited(email);
	await failingWrite(f.admin, { on: "account", event: "INSERT" }, () => register(native, email, i));
	const created = await f.admin.select().from(t.auth_user).where(eq(t.auth_user.email, email));
	assert.equal(created.length, 1, "the credential committed before the account write failed");
	await credentialKept(created[0]!.id);
	assert.equal(await count(t.account, eq(t.account.auth_user_id, created[0]!.id)), 0);
	await f.admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, created[0]!.id));
	const login = await signedIn(native, email);
	assert.equal(login.status, "pending_domain", "the saved intent makes the pending account at sign-in");
	const a = await identityOf(email);
	assert.ok(a.id);
	const resume = { requestKey: key(), invitationProof: i.proof };
	const pending = { status: "pending_domain", accountId: a.id };
	const invitationRow = eq(t.invitation.id, i.result.invitation.invitationId);
	for (const [table, event] of [
		["invitation", "UPDATE"],
		["account", "UPDATE"],
		["seat", "INSERT"],
		["person", "INSERT"],
		["audit_event", "INSERT"],
		["mail", "INSERT"],
	] as const)
		for (const atCommit of [false, true]) {
			const at = `${table} ${atCommit ? "at commit" : "after the row"}`;
			const [status] = await failingWrite(f.admin, { on: table, event, atCommit }, () =>
				untouched(f.admin, async () => answer(await native("resume-registration", resume, login.cookie))),
			);
			assert.equal(status, 503, at);
			assert.deepEqual(await answer(await native("registration-status", undefined, login.cookie)), [200, pending], at);
			assert.equal(await businessAccess(login.session), false, at);
			await credentialKept(a.user);
			assert.equal(await liveSeats(a.id), 0, at);
			assert.equal(await count(t.person, eq(t.person.linked_account_id, a.id)), 0, at);
			assert.equal((await f.admin.select().from(t.invitation).where(invitationRow))[0]!.state, "pending", at);
		}
	assert.equal(await q.seats(), q.before, "the other church's seat is untouched");
	const accepted = await answer(await native("resume-registration", resume, login.cookie));
	assert.deepEqual(accepted, [200, { status: "active", accountId: a.id }]);
	assert.equal(await liveSeats(a.id), 1);
	assert.equal(await count(t.person, and(eq(t.person.linked_account_id, a.id), eq(t.person.plant_id, s.w.id))), 1);
	assert.equal(await businessAccess(login.session), true);
});

test("AC:AUTH-002 two accepts on separate connections after a concurrent revoke, and an accept at the exact expiry, grant no seat and no Person", async () => {
	const c = caseOf("AUTH-002");
	const setup = c.given["case-input"]!;
	assert.equal(setup.concurrent_accepts, 2);
	const s = await f.setup(),
		i = await f.invitation(s);
	const id = i.result.invitation.invitationId;
	const sender = await f.actor(s.sender.session);
	const revoke = { requestKey: key(), expectedRevision: "1", input: { invitationId: id } };
	const outcome = <V,>(p: Promise<V>) =>
		p.then(
			(value) => ({ value, code: null }),
			(e: unknown) => ({ value: null, code: e instanceof Error && "code" in e ? e.code : String(e) }),
		);
	const [revoked, first, second] = await raced(
		f.admin,
		f.db,
		sql`SELECT id FROM invitation WHERE id=${id} FOR UPDATE`,
		[
			() => outcome(f.invitations.revoke(sender, revoke)),
			() => outcome(f.invitations.accept(s.recipient.session, i.claim)),
			() => outcome(f.invitations.accept(s.recipient.session, i.claim)),
		] as const,
	);
	assert.equal(revoked.code, null, JSON.stringify(revoked));
	assert.deepEqual([first.code, second.code], ["invitation_unavailable", "invitation_unavailable"]);
	const grants = async () => ({
		accepted_seats: await liveSeats(s.recipient.id),
		person_links: await count(t.person, eq(t.person.linked_account_id, s.recipient.id)),
	});
	assert.deepEqual(await grants(), { accepted_seats: 0, person_links: 0 });
	const late = await untouched(f.admin, () => outcome(f.invitations.accept(s.recipient.session, i.claim)));
	assert.equal(late.code, "invitation_unavailable");
	assert.equal(late.value, null, "post_revoke_grants 0");
	assert.equal((await f.admin.select().from(t.invitation).where(eq(t.invitation.id, id)))[0]!.state, "revoked");

	const now = c.clock.now,
		expiresAt = str(setup.expires_at);
	assert.equal(now, expiresAt);
	const atExpiry = await f.setup(),
		j = await f.invitation(atExpiry);
	const jid = j.result.invitation.invitationId;
	await f.admin
		.update(t.invitation)
		.set({ created_at: new Date(Date.parse(expiresAt) - 30 * 86_400_000) })
		.where(eq(t.invitation.id, jid));
	const attempts = await frozenAt(now, () =>
		untouched(f.admin, async () => ({
			described: await f.invitations.describe({ proof: j.proof }),
			accepted: await outcome(f.invitations.accept(atExpiry.recipient.session, j.claim)),
			resumed: await outcome(f.invitations.resume(atExpiry.recipient.session, j.proof, key())),
		})),
	);
	assert.deepEqual(attempts.described, { status: "unavailable" });
	assert.deepEqual(
		[attempts.accepted.code, attempts.resumed.code],
		["invitation_unavailable", "invitation_unavailable"],
	);
	assert.equal(await liveSeats(atExpiry.recipient.id), 0, "at_expiry_grants 0");
	const before = new Date(Date.parse(expiresAt) - 1).toISOString();
	const justBefore = await frozenAt(before, () => f.invitations.accept(atExpiry.recipient.session, j.claim));
	assert.equal(justBefore.status, "accepted", "one millisecond earlier the same accept succeeds");
	assert.equal(await liveSeats(atExpiry.recipient.id), 1);
});

test("AC:AUTH-003 a stolen invitation preview, an existing or unknown address and a changed registration intent disclose no account and let no other identity resume", async () => {
	const c = caseOf("AUTH-003");
	assert.equal(c.actor.account, "B");
	const native = f.native("invitation_only");
	const q = await bystander();
	const grants = async () =>
		JSON.stringify([
			await f.admin.$count(t.seat),
			await f.admin.$count(t.person, sql`linked_account_id IS NOT NULL`),
			await f.admin.$count(t.affiliation),
			await f.admin.$count(t.residency_link),
		]);
	const alex = await credentialed(`alex-${key()}@example.test`);
	const known = await invited(alex.email);
	const unknown = await invited(`alex-${key()}@example.test`);
	assert.equal(await count(t.auth_user, eq(t.auth_user.email, unknown.s.recipient.email)), 0);
	const casey = await credentialed(`casey-${key()}@example.test`);
	await f.seat(casey, q.Q, "admin");
	q.before = await q.seats();
	const before = await grants();
	const B = casey.cookie;
	const preview = async (proof: string, cookie?: string) =>
		answer(await native("registration-options?invitationProof=" + encodeURIComponent(proof), undefined, cookie));
	const shown = await preview(known.i.proof, B);
	assert.equal(shown[0], 200);
	assert.deepEqual(shown[1].invitation, {
		status: "invitation",
		kind: "plant_precreation",
		organizationName: "Synthetic plant",
	});
	for (const leaked of [alex.email, alex.id, alex.user, "accountExists", "exists"])
		assert.equal(JSON.stringify(shown).includes(leaked), false, leaked);
	assert.deepEqual(
		await preview(unknown.i.proof, B),
		shown,
		"the preview is the same whether the address has an account",
	);
	assert.deepEqual(await preview(known.i.proof), shown, "and whoever is signed in");

	const attempt = async (email: string, proof: string, password = "Wrong-guess-pass-9") => {
		const response = await native(
			"register",
			{ kind: "invitation", name: "Casey", email, password, invitationProof: proof, requestKey: key() },
			B,
			{ "x-test-ip": nextIp() },
		);
		return [response.status, await response.json(), response.headers.get("set-cookie")];
	};
	const knownUser = async () =>
		JSON.stringify(await f.admin.select().from(t.auth_account).where(eq(t.auth_account.user_id, alex.user)));
	const credentialBefore = await knownUser();
	assert.notEqual(credentialBefore, "[]");
	const existing = await attempt(known.s.recipient.email, known.i.proof);
	const asCasey = await attempt(casey.email, known.i.proof);
	assert.deepEqual(existing, [200, { status: "continue_identity_proof" }, null], "an existing address");
	assert.deepEqual(asCasey, existing, "the signed-in thief's own address");
	assert.equal(await knownUser(), credentialBefore, "the existing credential is not replaced");
	const signIn = async (email: string) => {
		const { correlationId, ...body } = await (
			await native("sign-in/email", { email, password: "Wrong-guess-pass-9" }, undefined, { "x-test-ip": nextIp() })
		).json();
		assert.ok(correlationId, JSON.stringify(body));
		return body;
	};
	assert.deepEqual(await signIn(known.s.recipient.email), await signIn(`nobody-${key()}@example.test`));

	const resumed = await untouched(f.admin, async () =>
		answer(await native("resume-registration", { requestKey: key(), invitationProof: known.i.proof }, B)),
	);
	assert.equal(resumed[1].code, "invitation_unavailable", "resume_allowed false");
	const seatless = await credentialed(`drifter-${key()}@example.test`);
	const drifted = await untouched(f.admin, async () =>
		answer(await native("resume-registration", { requestKey: key(), invitationProof: known.i.proof }, seatless.cookie)),
	);
	assert.equal(
		drifted[1].code,
		"invitation_unavailable",
		"nor for a seatless verified account that is not the recipient",
	);
	assert.equal(
		(await f.admin.select().from(t.invitation).where(eq(t.invitation.id, known.i.result.invitation.invitationId)))[0]!
			.state,
		"pending",
	);

	const email = unknown.s.recipient.email;
	await register(native, email, unknown.i);
	const first = await identityOf(email);
	assert.deepEqual([first.state, first.kind], ["pending_domain", "planter"]);
	for (const changed of [
		{ kind: "invitation", name: "Someone else", invitationProof: unknown.i.proof },
		{ kind: "discovery", name: "Alex" },
	]) {
		const again = await native(
			"register",
			{ ...changed, email: ` ${email.toUpperCase()} `, password: PASSWORD, requestKey: key() },
			undefined,
			{ "x-test-ip": nextIp() },
		);
		assert.deepEqual(await answer(again), [200, { status: "continue_identity_proof" }]);
		const now = await identityOf(email);
		assert.deepEqual(
			[now.id, now.state, now.kind, now.digest],
			[first.id, first.state, first.kind, first.digest],
			"a changed normalized intent neither replaces the saved one nor makes a second identity",
		);
	}
	assert.equal(await count(t.auth_user, eq(t.auth_user.email, email)), 1);
	assert.equal(await grants(), before);
	assert.equal(await q.seats(), q.before);
});

test("AC:AUTH-004 a committed resume whose response and session were lost replays its saved outcome for the same key, a changed payload under that key is a conflict, and a failed audit write leaves nothing", async () => {
	const c = caseOf("AUTH-004");
	const [fault] = c.subcases!;
	assert.equal(fault!.given.execution!.fault, "required_write_before_commit");
	assert.deepEqual(fault!.expected.event, []);
	const native = f.native("invitation_only");
	const email = `alex-${key()}@example.test`;
	const { s, i } = await invited(email);
	await register(native, email, i);
	const a = await identityOf(email);
	await f.admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, a.user));
	const first = await signedIn(native, email);
	const requestKey = key();
	const intent = { requestKey, invitationProof: i.proof };
	const audits = () => f.admin.$count(t.audit_event, eq(t.audit_event.actor_id, a.id!));

	const failed = await failingWrite(f.admin, { on: "audit_event", event: "INSERT" }, () =>
		untouched(f.admin, async () => answer(await native("resume-registration", intent, first.cookie))),
	);
	assert.equal(failed[0], 503, "required-write-failure");
	assert.deepEqual({ domain_writes: await liveSeats(a.id!), required_writes: await audits() }, fault!.expected.result);
	assert.deepEqual(await answer(await native("registration-status", undefined, first.cookie)), [
		200,
		{ status: "pending_domain", accountId: a.id },
	]);

	const committed = await native("resume-registration", intent, first.cookie);
	assert.equal(committed.status, 200);
	await committed.body?.cancel();
	const receipt = { status: "active", accountId: a.id };
	assert.equal(await liveSeats(a.id!), 1);
	const effects = await audits();
	assert.ok(effects > 0);
	await native("sign-out", {}, first.cookie);
	assert.deepEqual(await answer(await native("get-session", undefined, first.cookie)), [
		200,
		{ status: "unauthenticated" },
	]);
	const refreshed = await signedIn(native, email);
	assert.notEqual(refreshed.session, first.session);
	const replayed = await untouched(f.admin, async () =>
		answer(await native("resume-registration", intent, refreshed.cookie)),
	);
	assert.deepEqual(replayed, [200, receipt], "saved_outcome is the first commit's receipt");

	const sender = await f.actor(s.sender.session);
	const sent = await f.invitations.invite(sender, {
		requestKey: key(),
		expectedRevision: "1",
		input: { workspace: s.w, role: "admin", recipientEmail: email },
	});
	const changedRole = await f.proof(sent.invitation.invitationId);
	const s3 = await f.setup();
	const notMine = await f.invitation(s3);
	for (const [name, proof, code] of [
		["changed role", changedRole, "idempotency_conflict"],
		["changed recipient", notMine.proof, "invitation_unavailable"],
	] as const) {
		const conflict = await untouched(f.admin, async () =>
			answer(await native("resume-registration", { requestKey, invitationProof: proof }, refreshed.cookie)),
		);
		assert.equal(conflict[1].code, code, name);
		assert.equal(await audits(), effects, name + ": additional_effects 0");
	}
	assert.equal(c.expected.result.error_code, "idempotency_conflict");
	assert.deepEqual(await answer(await native("resume-registration", intent, refreshed.cookie)), [200, receipt]);
	assert.equal(
		(await f.admin.select().from(t.invitation).where(eq(t.invitation.id, sent.invitation.invitationId)))[0]!.state,
		"pending",
	);
	assert.equal(await liveSeats(a.id!), 1);
});

test("AC:AUTH-005 a password change keeps only its initiating browser, a failed event never reverts it and is reported, refused and unknown calls change nothing, and budgets hold under concurrency", async () => {
	const c = caseOf("AUTH-005");
	const args = c.action.arguments;
	assert.equal(args.revokeOtherSessions, true);
	const { credentials } = credentialWorld();
	const A = await credentialAccount(`alex-${key()}@example.test`, str(args.current_password));
	const A2 = await nativeLogin(A);
	const other = await credentialAccount();
	const change = (who: { id: string; session: string }, current: string, next = str(args.new_password)) =>
		credentials.changePassword(own(who), { currentPassword: current, newPassword: next, confirmPassword: next });
	const identifier = (email: string) => createHmac("sha256", SECRET).update(email).digest("hex");
	const failures = (email: string) =>
		f.admin.$count(
			t.admission_attempt,
			and(eq(t.admission_attempt.identifier_hash, identifier(email)), eq(t.admission_attempt.state, "failed")),
		);
	const changed = () =>
		f.admin.$count(
			t.audit_event,
			and(eq(t.audit_event.tenant_id, A.id), eq(t.audit_event.action, "identity.credential_changed")),
		);
	const sessions = () => f.admin.$count(t.auth_session, eq(t.auth_session.user_id, A.user));

	assert.equal((await change(A, "Wrong-current-pass-0")).status, "refused");
	assert.equal((await change(other, "Wrong-current-pass-0")).status, "refused");
	assert.deepEqual([await failures(A.email), await failures(other.email)], [1, 1]);
	const unknown = await failingWrite(f.admin, { on: "auth_account", event: "UPDATE" }, () => change(A, A.password));
	assert.equal(unknown.status, "unknown");
	assert.deepEqual([await sessions(), await changed()], [2, 0]);
	for (const cookie of [A.cookie, A2.cookie]) assert.equal(await liveUser(cookie), A.user);

	issued.length = 0;
	reported.length = 0;
	const outcome = await failingWrite(
		f.admin,
		{ on: "audit_event", event: "INSERT", when: "NEW.action='identity.credential_changed'" },
		() => change(A, A.password),
	);
	assert.ok(outcome.status === "succeeded");
	assert.deepEqual(outcome.reporting, { status: "pending_investigation" });
	assert.deepEqual(
		reported,
		[{ correlationId: outcome.correlationId, outcome: "reporting_pending" }],
		"reporting_failure_observable",
	);
	assert.equal(await changed(), 0);
	const initiating = jar(new Response(null, { headers: issued.map((v) => ["set-cookie", v] as [string, string]) }));
	assert.equal(await liveUser(initiating), A.user, "initiating_session live");
	assert.equal(await liveUser(A2.cookie), null, "other_sessions revoked");
	assert.equal(await sessions(), 1);
	const oldLogin = await credentialWorld().auth.api.signInEmail({
		body: { email: A.email, password: A.password },
		asResponse: true,
	});
	assert.equal(oldLogin.status, 401, "event_failure_reverts_password false");
	const fresh = await nativeLogin({ ...A, password: str(args.new_password) });
	assert.equal(await failures(A.email), 0, "a success clears its own identifier's failures");
	assert.equal(await failures(other.email), 1, "and nobody else's");

	const attempts = await Promise.all(
		Array.from({ length: 7 }, () => change(fresh, "Wrong-current-pass-0", "Fixture-third-pass-3")),
	);
	assert.deepEqual(new Set(attempts.map((r) => r.status)), new Set(["refused"]));
	assert.equal(await failures(A.email), 5, "concurrent failures reserve exactly the five-attempt budget");
	assert.equal((await change(fresh, fresh.password, "Fixture-third-pass-3")).status, "refused");
	assert.equal(await liveUser(fresh.cookie), A.user);

	const ip = "198.51.100.77";
	const crowd = await Promise.all(Array.from({ length: 4 }, () => credentialAccount()));
	for (const who of crowd) trustedIps.set(who.session, ip);
	await Promise.all(crowd.flatMap((who) => Array.from({ length: 5 }, () => change(who, "Wrong-current-pass-0"))));
	const late = await credentialAccount();
	trustedIps.set(late.session, ip);
	assert.equal(
		(await change(late, late.password)).status,
		"refused",
		"twenty trusted-IP failures refuse the right password",
	);
	trustedIps.set(late.session, "198.51.100.78");
	assert.equal((await change(late, late.password)).status, "succeeded");
});

async function resetProof(email: string) {
	assert.equal((await g.req("request-password-reset", { email })).status, 200);
	await g.dispatch();
	const effect = g.effects.filter((v) => v.to === email && v.text.startsWith("Reset your password")).at(-1);
	return (
		new URL(effect?.text.split("\n")[2] ?? assert.fail("no reset mail")).searchParams.get("token") ?? assert.fail()
	);
}
const gSession = async (cookie: string) => (await g.req("get-session", undefined, cookie)).json();

test("AC:AUTH-005 a password reset revokes every prior session, and an expired or consumed reset proof changes nothing", async () => {
	g.setIp("127.0.8.1");
	const email = `reset-${key()}@example.test`;
	await nativeRegister(g, email);
	const [c1, c2] = [cookieOf(await signIn(g, email)), cookieOf(await signIn(g, email))];
	const proof = await resetProof(email);
	const next = { proof, newPassword: "Fixture-reset-pass-5", confirmPassword: "Fixture-reset-pass-5" };
	assert.equal((await g.req("reset-password", next)).status, 200);
	for (const c of [c1, c2]) assert.deepEqual(await gSession(c), { status: "unauthenticated" });
	const consumed = await g.req("reset-password", {
		...next,
		newPassword: "Fixture-reset-pass-6",
		confirmPassword: "Fixture-reset-pass-6",
	});
	assert.equal(consumed.status, 400);
	assert.equal((await consumed.json()).code, "invalid_proof");
	const expired = await resetProof(email);
	await g.db.execute(
		sql`UPDATE auth_verification SET expires_at=clock_timestamp()-interval '1 second' WHERE identifier=${"reset-password:" + expired}`,
	);
	const late = await g.req("reset-password", {
		proof: expired,
		newPassword: "Fixture-reset-pass-7",
		confirmPassword: "Fixture-reset-pass-7",
	});
	assert.deepEqual([late.status, (await late.json()).code], [400, "invalid_proof"]);
	assert.equal((await signIn(g, email, "Fixture-reset-pass-5")).status, 200);
	assert.equal((await signIn(g, email, "Fixture-reset-pass-7")).status, 401);
});

test("AC:AUTH-008 Better Auth owns the credential and a PostgreSQL session with no cookie cache or second store: renewal, proof storage, concurrent changes, origin and trusted ingress hold, and a pending account reaches no business data", async () => {
	const c = caseOf("AUTH-008");
	const setup = c.given["behavior-inputs"]!;
	assert.deepEqual([setup.session_store, setup.cookie_cache, setup.secondary_store], ["PostgreSQL", false, null]);
	const options = g.service.auth.options;
	assert.equal("secondaryStorage" in options, false, "secondary_store null");
	assert.notEqual(options.session?.cookieCache?.enabled, true, "cookie_cache false");
	assert.equal(options.advanced?.trustedProxyHeaders, false);

	g.setIp("127.0.8.2");
	const email = `session-${key()}@example.test`;
	assert.equal((await nativeRegister(g, email)).status, 200);
	const [credential] = await g.db
		.execute<{ provider_id: string; password_hash: string }>(
			sql`SELECT a.provider_id,a.password_hash FROM auth_account a JOIN auth_user u ON u.id=a.user_id WHERE u.email=${email}`,
		)
		.then((r) => r.rows);
	assert.equal(credential!.provider_id, "credential", "credential_owner Better Auth");
	assert.notEqual(credential!.password_hash, password);
	const holders = await g.db.execute<{ t: string }>(
		sql`SELECT table_name::text||'.'||column_name::text AS t FROM information_schema.columns
			WHERE table_schema=current_schema() AND (column_name ILIKE '%password%' OR column_name ILIKE '%secret%') ORDER BY 1`,
	);
	assert.deepEqual(
		holders.rows.map((r) => r.t),
		["auth_account.password_hash"],
	);

	const c1 = cookieOf(await signIn(g, email));
	const pending = await gSession(c1);
	assert.equal(pending.status, "pending_domain");
	const viewer = await readViewer(g.runtime, sessionId.parse(pending.sessionId));
	assert.equal(viewer?.authority ?? null, null, "pending_account_business_access false");
	assert.equal(
		(await RequestActor.resolve(g.runtime, sessionId.parse(pending.sessionId))) instanceof RequestActor,
		false,
	);
	assert.deepEqual(await (await g.req("resume-registration", { requestKey: key() }, c1)).json(), {
		status: "pending_domain",
		accountId: pending.accountId,
	});
	assert.equal(await g.db.$count(t.seat, eq(t.seat.account_id, pending.accountId)), 0);

	await g.db.execute(
		sql`UPDATE auth_session SET expires_at=clock_timestamp()+interval '14 days',updated_at=clock_timestamp()-interval '16 days' WHERE id=${pending.sessionId}`,
	);
	const renewed = await g.req("get-session", undefined, c1);
	assert.ok(cookieOf(renewed), "the renewal sets the cookie again");
	await renewed.body?.cancel();
	const { rows } = await g.db.execute<{ seconds: number }>(
		sql`SELECT extract(epoch FROM(expires_at-clock_timestamp()))::int seconds FROM auth_session WHERE id=${pending.sessionId}`,
	);
	assert.ok(rows[0]!.seconds >= 2591990 && rows[0]!.seconds <= 2592000);

	const [c2, c3] = await Promise.all([signIn(g, email), signIn(g, email)]).then((r) => r.map(cookieOf));
	const [s2, s3] = [await gSession(c2!), await gSession(c3!)];
	assert.notEqual(s2.sessionId, s3.sessionId);
	const raced = await Promise.all([
		g.req("sign-out", {}, c2),
		g.req("sign-out", {}, c2),
		g.req("get-session", undefined, c3),
	]);
	assert.deepEqual(await Promise.all(raced.map((r) => r.json())), [
		{ status: "signed_out" },
		{ status: "signed_out" },
		s3,
	]);
	assert.deepEqual(await gSession(c2!), { status: "unauthenticated" });
	await g.db.delete(t.auth_session).where(eq(t.auth_session.id, s3.sessionId));
	assert.deepEqual(await gSession(c3!), { status: "unauthenticated" }, "every request reads PostgreSQL");

	const proof = await resetProof(email);
	const stored = await g.db.execute<{ value: string; seconds: number }>(
		sql`SELECT value,extract(epoch FROM(expires_at-created_at))::int seconds FROM auth_verification WHERE identifier=${"reset-password:" + proof}`,
	);
	assert.equal(stored.rows.length, 1, "the proof is stored in the authentication database");
	assert.ok(Math.abs(stored.rows[0]!.seconds - IDENTITY_LINK_SECONDS) <= 1);
	const mailed = await g.db.execute<{ n: number }>(
		sql`SELECT count(*)::int n FROM mail m WHERE m::text LIKE ${"%" + proof + "%"}`,
	);
	assert.equal(mailed.rows[0]!.n, 0, "the outbox holds no readable proof");

	for (const origin of ["", "https://evil.example", g.origin + ".evil.example"])
		assert.equal((await g.req("sign-in/email", { email, password }, undefined, { origin })).status, 403);
	const hostStatus = await new Promise<number>((resolve, reject) => {
		const r = httpRequest(g.origin + "/api/auth/get-session", { headers: { host: "evil.example" } }, (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		r.on("error", reject);
		r.end();
	});
	assert.equal(hostStatus, 403);
	g.setIp(null);
	const untrusted = await g.req(
		"register",
		{ kind: "discovery", name: "Synthetic", email: `ingress-${key()}@example.test`, password, requestKey: key() },
		undefined,
		{ "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" },
	);
	assert.equal(untrusted.status, 503, "a client IP header is not trusted ingress");
	assert.equal((await untrusted.json()).code, "admission_unavailable");
	g.setIp("127.0.8.2");
});

const deletion = deletionOperations({
	queue: (tx, i) =>
		queueJobs(tx, [
			{
				tenant: i.subject.id,
				kind: "lifecycle_purge",
				subject: i.witnessId,
				key: "purge/" + i.requestId,
				revision: i.revision,
				eligibleAt: i.eligibleAt,
			},
		]),
	workspaceNotice: async () => {},
});
const one = async <R extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
	(await f.admin.execute<R>(query)).rows[0] ?? assert.fail("no row");
const witnessOf = (subject: string) =>
	one<{ id: string; state: string; request_id: string; revision: string; cancel_until: Date }>(
		sql`SELECT id,state,request_id,request_revision::text AS revision,cancel_until FROM lifecycle_witness WHERE opaque_subject_id=${subject}`,
	);

test("AC:AUTH-006 a pending account or church deletion cancels only with a native fresh proof before the deadline; at and after it, and with the old request, nothing cancels and ordinary data stays closed", async (context) => {
	const c = caseOf("AUTH-006");
	const steps = [c, ...c.subcases!];
	const given = c.given["delete-A"]!;
	const deadline = new Date(str(given.cancel_until)).toISOString();
	assert.deepEqual(
		steps.map((step) => step.clock.now),
		c.given["case-input"]!.attempts,
	);
	const { credentials } = credentialWorld();
	context.mock.timers.enable({ apis: ["Date"], now: Date.parse(str(given.requested_at)) });
	const instant = (at: string) => context.mock.timers.setTime(Date.parse(at));
	for (const kind of ["account", "plant"] as const) {
		instant(str(given.requested_at));
		let owner = await credentialAccount();
		const P = await frozenAt(str(given.requested_at), async () => {
			const P = await f.workspace("plant", { timezone: "America/Chicago" });
			await f.seat(owner, P, kind === "plant" ? "owner" : "admin");
			if (kind === "account") await f.seat(await f.account(), P, "owner");
			return P;
		});
		const subject = kind === "account" ? { kind, id: owner.id } : { kind, id: P.id };
		const ctx = () => ({
			session: sessionId.parse(owner.session),
			selected:
				subject.kind === "account"
					? { kind: "account" as const, id: accountId.parse(owner.id) }
					: { kind: "plant" as const, id: P.id },
		});
		const revisionOf = async () =>
			String(
				(
					await one<{ r: string }>(
						sql`SELECT revision::text AS r FROM ${sql.identifier(kind === "account" ? "account" : "plant")} WHERE id=${subject.id}`,
					)
				).r,
			);
		const ask = async () => {
			const input = kind === "account" ? { confirmed: true } : { plant: P, confirmed: true };
			const command = { input, expectedRevision: await revisionOf(), requestKey: key() };
			const reply = await frozenAt(str(given.requested_at), () =>
				gatedTransaction(f.db, (tx) =>
					kind === "account"
						? deletion.requestAccountDeletion(tx, ctx(), command)
						: deletion.requestWorkspaceDeletion(tx, ctx(), command),
				),
			);
			assert.equal(reply.status, "ok", JSON.stringify(reply));
			return witnessOf(subject.id);
		};
		const ordinary = async () => {
			const viewer = await readViewer(f.db, sessionId.parse(owner.session));
			if (kind === "account") return viewer?.authority != null;
			const actor = await gatedTransaction(f.db, (tx) =>
				currentActor(tx, sessionId.parse(owner.session), { kind: "plant", id: tenantId.parse(P.id) }, false),
			);
			return actor.status === "active";
		};
		const requested = await ask();
		assert.deepEqual([requested.state, new Date(requested.cancel_until).toISOString()], ["pending_deletion", deadline]);
		const request = { subject, requestId: requested.request_id };
		assert.equal(await ordinary(), false, `${kind}: the ordinary session is closed while the deletion is pending`);
		if (kind === "account") assert.equal(await liveUser(owner.cookie), null, "and revoked");
		const open = async (at: string) => {
			instant(at);
			const opened = await frozenAt(at, () =>
				kind === "account"
					? credentials.openAccountDeletion({ email: owner.email, password: owner.password }, "198.51.100.61")
					: credentials.openWorkspaceDeletion({ email: owner.email, password: owner.password }, "198.51.100.61"),
			);
			assert.equal(opened.status, "ok", JSON.stringify(opened));
			assert.ok(opened.status === "ok");
			assert.deepEqual([opened.value.subject, opened.value.requestId], [subject, request.requestId]);
			return openedDeletion(opened.value.session, request);
		};
		const cancel = (at: string, proof: Awaited<ReturnType<typeof open>>, which = request) =>
			frozenAt(at, () =>
				gatedTransaction(f.db, (tx) => {
					const command = { input: which, expectedRevision: requested.revision, requestKey: key() };
					return kind === "account"
						? deletion.cancelAccountDeletion(tx, proof, command)
						: deletion.cancelWorkspaceDeletion(tx, proof, command);
				}),
			);
		const ordered = [steps[1]!, steps[2]!, steps[0]!];
		const proofs: Awaited<ReturnType<typeof open>>[] = [];
		for (const step of ordered) {
			const at = step.clock.now;
			const proof = await open(at);
			proofs.push(proof);
			const expected = step.expected.result;
			const reply = expected.cancel_allowed
				? await cancel(at, proof)
				: await untouched(f.admin, () => cancel(at, proof));
			const allowed = reply.status === "ok" && "value" in reply && reply.value.status === "cancelled";
			assert.equal(allowed, expected.cancel_allowed, `${kind} ${step.name ?? "before-deadline"}`);
			if (!allowed) {
				assert.ok(reply.status === "refused" && "error" in reply, JSON.stringify(reply));
				assert.equal(reply.error.code, "deadline_passed", `${kind} ${at}`);
				const w = await witnessOf(subject.id);
				assert.equal(w.state, "pending_deletion", "the purge has not run yet and the request still holds");
				assert.equal(
					await f.admin.$count(t.job, and(eq(t.job.subject_record_id, w.id), eq(t.job.state, "ready"))),
					1,
					"its purge is due but delayed",
				);
				assert.equal(await ordinary(), expected.ordinary_data_allowed, `${kind} ${at}: ordinary data`);
			} else
				assert.equal(
					await ordinary(),
					expected.ordinary_data_before_cancel,
					`${kind}: no ordinary data before the cancel`,
				);
		}
		assert.equal((await witnessOf(subject.id)).state, "cancelled");
		owner = await nativeLogin(owner);
		assert.equal(await ordinary(), true, `${kind}: a new sign-in reads ordinary data again once cancelled`);
		const again = await ask();
		assert.notEqual(again.request_id, request.requestId);
		const before = steps[0]!.clock.now;
		const stale = await untouched(f.admin, async () => ({
			oldProof: await cancel(before, proofs.at(-1)!, { subject, requestId: again.request_id }),
			oldRequest: await cancel(before, proofs.at(-1)!),
		}));
		for (const reply of Object.values(stale))
			assert.equal(reply.status === "ok", c.expected.result.old_request_cancel_allowed, JSON.stringify(reply));
		assert.equal((await witnessOf(subject.id)).state, "pending_deletion");
	}
});

test("AC:AUTH-007 the last Owner's account deletion needs manual resolution and names no substitute, and a platform grant, a lead Person or an organization association never unions into a seat", async () => {
	const c = caseOf("AUTH-007");
	assert.equal(c.action.arguments.confirmation, "Delete my account");
	const s = await f.setup();
	const A = s.sender;
	const lead = await f.account("active");
	const associated = await f.account("active");
	await f.seat(lead, s.w, "admin");
	const org = await f.workspace("sending_church");
	await f.admin.execute(
		sql`INSERT INTO platform_grant(account_id,capability) VALUES(${A.id},'feedback_triage'),(${lead.id},'recovery_operator')`,
	);
	for (const who of [A, lead])
		await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
				commitment_state,pipeline_position,state,created_at,linked_account_id)
			VALUES(${key()},${s.w.id},${s.w.id},'Alex','other','leader','adult','unknown',1,'live',clock_timestamp(),${who.id})`);
	for (const who of [A, associated])
		await f.admin.insert(t.affiliation).values({
			account_id: who.id,
			organization_id: org.id,
			accepted_at: new Date(),
			share_people: false,
			share_meetings: false,
			share_tasks: false,
			share_ministry_teams: false,
			share_wiki: false,
			share_activity: false,
			shared_findings: false,
		});
	const seats = async () =>
		JSON.stringify(
			await f.admin
				.select({ account: t.seat.account_id, role: t.seat.role, ended: t.seat.ended_at })
				.from(t.seat)
				.where(eq(t.seat.plant_id, s.w.id))
				.orderBy(t.seat.account_id),
		);
	const roster = await seats();
	const { revision } = (
		await f.admin.select({ revision: t.account.revision }).from(t.account).where(eq(t.account.id, A.id))
	)[0]!;
	const reply = await untouched(f.admin, () =>
		gatedTransaction(f.db, (tx) =>
			deletion.requestAccountDeletion(
				tx,
				{ session: sessionId.parse(A.session), selected: { kind: "account", id: A.id } },
				{ input: { confirmed: true }, expectedRevision: String(revision), requestKey: key() },
			),
		),
	);
	assert.ok(reply.status === "refused" && "error" in reply, JSON.stringify(reply));
	assert.equal(reply.error.code, "manual_owner_exception_required", "manual_resolution_required");
	assert.equal(
		await f.admin.$count(t.lifecycle_witness, eq(t.lifecycle_witness.opaque_subject_id, A.id)),
		0,
		"purge_allowed false",
	);
	assert.equal(await seats(), roster, "substitute_Owner null: no seat changed role");
	assert.equal(
		await f.admin.$count(t.seat, and(eq(t.seat.plant_id, s.w.id), eq(t.seat.role, "owner"), isNull(t.seat.ended_at))),
		1,
	);
	assert.equal(await businessAccess(A.session), true, "the Owner keeps the account it could not delete");

	await f.admin
		.update(t.seat)
		.set({ ended_at: sql`clock_timestamp()` })
		.where(and(eq(t.seat.account_id, lead.id), eq(t.seat.plant_id, s.w.id)));
	const sender = await f.actor(A.session);
	const ordinary = async (recipient: { email: string }) => {
		const sent = await f.invitations.invite(sender, {
			requestKey: key(),
			expectedRevision: "1",
			input: { workspace: s.w, role: "member", recipientEmail: recipient.email },
		});
		const proof = await f.proof(sent.invitation.invitationId);
		return { requestKey: key(), expectedRevision: "1", input: { invitationId: sent.invitation.invitationId, proof } };
	};
	const accepted = await f.invitations.accept(lead.session, await ordinary(lead));
	assert.equal(accepted.seat.role, "member", "the ended Admin comes back with exactly the invited role");
	assert.deepEqual(
		await f.admin
			.select({ role: t.seat.role })
			.from(t.seat)
			.where(and(eq(t.seat.account_id, lead.id), isNull(t.seat.ended_at))),
		[{ role: "member" }],
	);
	assert.equal(await count(t.person, and(eq(t.person.linked_account_id, lead.id), eq(t.person.plant_id, s.w.id))), 1);
	const refused = await f.invitations.accept(associated.session, await ordinary(associated)).then(
		() => null,
		(e: unknown) => (e instanceof Error && "code" in e ? e.code : String(e)),
	);
	assert.equal(refused, "invitation_unavailable", "an organization association never unions with a first seat");
	assert.equal(await liveSeats(associated.id), 0);
	const again = await gatedTransaction(f.db, (tx) =>
		deletion.requestAccountDeletion(
			tx,
			{ session: sessionId.parse(A.session), selected: { kind: "account", id: A.id } },
			{ input: { confirmed: true }, expectedRevision: String(revision), requestKey: key() },
		),
	);
	assert.ok(again.status === "refused" && "error" in again);
	assert.equal(again.error.code, "manual_owner_exception_required", "a new member is no substitute Owner either");
});
