import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { testDatabase } from "../../support/test-database.mts";
import { sql, eq } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { createAccountCredentials } from "../../../packages/domain/src/settings/index.ts";
import { settingsApi } from "../settings/settings-api.mts";
import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { identityAuth } from "../../../packages/domain/src/identity/auth.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { ok } from "../../support/fixture.mts";

// REQ-IDN-032: a requested deletion finishes on its own. The account or church requests deletion through the real
// settings operation; once the cancellation deadline has passed, the every-minute scheduled run claims the purge job and
// purges on the cleanup login. Runs on a suite schema of the shared development (or disposable CI) database, with three
// logins (runtime, cleanup, auth) and a synthetic private bucket.
const database = await testDatabase({
	prefix: "t128",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"], auth: ["auth"] },
});
const { admin } = database;
const { runtime: db, cleanup: cleanupDb, auth: authDb } = database.pools;
let api, onboarding, credentials, signInAuth;
const origin = "http://purge.localhost";
const secret = randomBytes(40).toString("hex"),
	cron = "cron-" + randomUUID();
const ingress = new Map();

// The private bucket: deletes succeed unless `failing` says the provider times out.
const objects = new Map();
let failing = 0;
const storage = {
	bucket: "synthetic-only",
	client: {
		send: async (command) => {
			assert.equal(command.constructor.name, "DeleteObjectCommand");
			if (failing > 0) {
				failing--;
				throw Error("provider_timeout");
			}
			objects.delete(command.input.Key);
			return {};
		},
	},
};
let tick;
async function run() {
	const response = await tick(
		new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${cron}` } }),
	);
	assert.equal(response.status, 200);
	return response.json();
}

const command = (input = {}, expectedRevision = "1") => ({ input, expectedRevision, requestKey: randomUUID() });
const ctx = (a, selected = { kind: "account", id: a.id }) => ({ session: a.session, selected });

before(async () => {
	const organizationEffects = {
		invitation: async () => {},
		invalidate: (tx) => queueJobs(tx, []),
	};
	credentials = createAccountCredentials({
		db,
		authDb,
		admissionDb: admin,
		origin,
		secret,
		request: async (c) => {
			const request = ingress.get(c.session);
			if (!request) throw Error("missing_native_request");
			return { request, trustedIp: "198.51.100.21", viewer: null };
		},
		responseCookies: async () => {},
		deliverVerification: async () => {},
		securityNotice: async () => {},
	});
	api = settingsApi({
		organizations: createOrganizationAdapter(organizationEffects, { candidates: async () => [] }),
		organizationEffects,
		effects: { replan: async () => {} },
		suppression: async () => "unavailable",
		avatarCleanup: { queue: (tx) => queueJobs(tx, []) },
		// As the settings mount queues it (apps/web/src/features/settings/server.ts).
		deletion: {
			queue: (tx, i) =>
				queueJobs(tx, [
					{
						tenant: i.subject.id,
						kind: "lifecycle_purge",
						subject: i.witnessId,
						key: `purge/${i.requestId}`,
						revision: i.revision,
						eligibleAt: i.eligibleAt,
					},
				]),
			// Notice mail is covered by workspace-deletion-mail.test.mts.
			workspaceNotice: async () => {},
		},
		credentials,
	});
	onboarding = createOnboardingProducer({ relationships: async () => {}, enqueue: async () => {} });
	signInAuth = identityAuth({
		db: authDb,
		origin,
		secret,
		deliver: async () => {
			throw Error("not expected");
		},
	});
	tick = scheduledJobs({ secret: cron, db, storage, cleanup: cleanupDb, reminders: null, digests: null, mail: null });
});
after(database.close);

const signIn = (a) => signInAuth.api.signInEmail({ body: { email: a.email, password: a.password }, asResponse: true });
/** A signed-up account with a password and a live session, as Better Auth creates it. */
async function member() {
	const email = randomUUID() + "@example.test",
		password = "Initial secret 2468!";
	const signed = await signInAuth.api.signUpEmail({ body: { name: "Purge User", email, password } });
	const id = randomUUID();
	await admin
		.insert(t.account)
		.values({ id, auth_user_id: signed.user.id, registration_state: "active", registration_kind: "planter" });
	await admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, signed.user.id));
	const r = await signIn({ email, password });
	assert.equal(r.status, 200);
	const cookie = r.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	const request = new Request(origin + "/api/settings", { method: "POST", headers: { origin, cookie } });
	const s = await signInAuth.api.getSession({ headers: request.headers });
	ingress.set(s.session.id, request);
	return { id, user: signed.user.id, email, password, session: s.session.id };
}
/**
 * One private file the tenant owns, with its bytes in the bucket. It is referenced as a live file is (an account's
 * avatar, or a church person's photo), so the scheduled orphan sweep leaves it for the purge.
 */
async function file(tenant) {
	const [account] = await admin.select({ id: t.account.id }).from(t.account).where(eq(t.account.id, tenant));
	const id = randomUUID(),
		key = `private/${tenant}/${randomUUID()}`,
		bytes = Buffer.from("synthetic");
	objects.set(key, bytes);
	await admin.insert(t.file_object).values({
		id,
		tenant_id: tenant,
		purpose: account ? "avatar" : "person_photo",
		opaque_key: key,
		media_type: "image/png",
		max_bytes: String(bytes.length),
		byte_count: String(bytes.length),
		sha256: createHash("sha256").update(bytes).digest("hex"),
		state: "ready",
		upload_key: randomUUID(),
		claim_generation: "0",
	});
	if (account) await admin.update(t.account).set({ avatar_object_id: id }).where(eq(t.account.id, tenant));
	else {
		const [person] = await admin
			.select({ id: t.person.id })
			.from(t.person)
			.where(eq(t.person.plant_id, tenant))
			.limit(1);
		await admin.update(t.person).set({ photo_object_id: id }).where(eq(t.person.id, person.id));
	}
	return { id, key };
}
const revisionOf = async (id) => (await admin.select().from(t.account).where(eq(t.account.id, id)))[0].revision;
const witnessOf = async (subject) =>
	(await admin.select().from(t.lifecycle_witness).where(eq(t.lifecycle_witness.opaque_subject_id, subject)))[0];
const jobOf = async (witness) =>
	(
		await admin
			.select()
			.from(t.job)
			.where(sql`${t.job.kind}='lifecycle_purge' AND ${t.job.subject_record_id}=${witness}`)
	)[0];
/**
 * The 30 days pass: the request and its purge job move back, as if made 31 days ago. The witness clock is immutable
 * (trigger witness_clock), so the suite's schema owner lifts that trigger for this one update only.
 */
async function graceEnds(witness) {
	await admin.transaction(async (tx) => {
		await tx.execute(sql`ALTER TABLE lifecycle_witness DISABLE TRIGGER witness_clock`);
		await tx.execute(
			sql`UPDATE lifecycle_witness SET requested_at=requested_at-interval '31 days',cancel_until=cancel_until-interval '31 days' WHERE id=${witness}`,
		);
		// Deferred checks on the row run now, so the trigger can return.
		await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
		await tx.execute(sql`ALTER TABLE lifecycle_witness ENABLE TRIGGER witness_clock`);
		await tx.execute(
			sql`UPDATE job SET eligible_at=eligible_at-interval '31 days' WHERE kind='lifecycle_purge' AND subject_record_id=${witness}`,
		);
	});
}
const openDeletion = (a) => credentials.openAccountDeletion({ email: a.email, password: a.password }, null);

test("AC:TARGET-IDN-032 after Delete my account and the grace period, a scheduled tick purges the account and the old login is refused", async () => {
	const a = await member();
	const avatar = await file(a.id);
	await admin.update(t.account).set({ avatar_object_id: avatar.id }).where(eq(t.account.id, a.id));
	const pending = ok(
		await db.transaction((tx) => api.requestAccountDeletion(tx, ctx(a), command({ confirmed: true }, "1"))),
	);
	assert.equal(pending.status, "pending_deletion");
	// Before the purge the password opens the restricted deletion page for this request.
	const opened = await openDeletion(a);
	assert.equal(opened.status, "ok", JSON.stringify(opened));
	assert.equal(opened.value.requestId, pending.requestId);
	const w = await witnessOf(a.id);

	// Inside the grace period a tick leaves the request and its job alone.
	const early = await run();
	assert.equal(early.purged, 0);
	assert.equal((await witnessOf(a.id)).state, "pending_deletion");
	const waiting = await jobOf(w.id);
	assert.deepEqual([waiting.state, waiting.attempt_count], ["ready", 0]);

	await graceEnds(w.id);
	const done = await run();
	assert.equal(done.status, "ok");
	assert.equal(done.purged, 1);
	const purged = await witnessOf(a.id);
	assert.equal(purged.state, "purged");
	assert.equal(purged.request_id, pending.requestId);
	assert.notEqual(purged.live_purged_at, null);
	assert.equal(purged.copy_expires_at.getTime() - purged.live_purged_at.getTime(), 7 * 86400_000);
	assert.equal((await jobOf(w.id)).state, "succeeded");
	assert.equal(objects.has(avatar.key), false);
	assert.equal((await admin.select().from(t.file_object).where(eq(t.file_object.id, avatar.id)))[0].state, "purged");

	// The old email and password no longer sign in, and the deletion page asks for proof again.
	const rejected = await signIn(a);
	assert.notEqual(rejected.status, 200);
	assert.deepEqual(await openDeletion(a), { status: "refused", code: "proof_invalid" });
	assert.equal(await readViewer(db, a.session), null);

	// A later tick finds nothing more to purge.
	assert.equal((await run()).purged, 0);
});

test("AC:TARGET-IDN-032 a removal the provider does not confirm keeps the account purging and hidden until a later tick confirms it", async () => {
	const a = await member();
	const kept = await file(a.id);
	ok(
		await db.transaction(async (tx) =>
			api.requestAccountDeletion(tx, ctx(a), command({ confirmed: true }, await revisionOf(a.id))),
		),
	);
	const w = await witnessOf(a.id);
	await graceEnds(w.id);
	failing = 1;
	const first = await run();
	assert.equal(first.purged, 0);
	const hidden = await witnessOf(a.id);
	assert.deepEqual([hidden.state, hidden.live_purged_at], ["purging", null]);
	const retry = await jobOf(w.id);
	assert.equal(retry.state, "retry_wait");
	assert.equal(retry.error_code, "removal_unconfirmed");
	assert.equal(objects.has(kept.key), true);
	assert.deepEqual(await openDeletion(a), { status: "refused", code: "proof_invalid" });

	// Not yet due: the retry waits for its backoff.
	assert.equal((await run()).purged, 0);
	assert.equal((await jobOf(w.id)).state, "retry_wait");

	await admin.execute(sql`UPDATE job SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=${retry.id}`);
	const second = await run();
	assert.equal(second.purged, 1);
	assert.equal((await witnessOf(a.id)).state, "purged");
	assert.equal((await jobOf(w.id)).state, "succeeded");
	assert.equal(objects.has(kept.key), false);
});

test("AC:TARGET-IDN-032 a cancelled request's purge job is superseded and purges nothing", async () => {
	const a = await member();
	const kept = await file(a.id);
	const pending = ok(
		await db.transaction(async (tx) =>
			api.requestAccountDeletion(tx, ctx(a), command({ confirmed: true }, await revisionOf(a.id))),
		),
	);
	const opened = ok(await openDeletion(a));
	const request = { subject: opened.subject, requestId: opened.requestId };
	ok(await db.transaction((tx) => api.cancelAccountDeletion(tx, opened.session, command(request, pending.revision))));
	const w = await witnessOf(a.id);
	// The job still comes due at the original deadline.
	await admin.execute(
		sql`UPDATE job SET eligible_at=eligible_at-interval '31 days' WHERE kind='lifecycle_purge' AND subject_record_id=${w.id}`,
	);
	assert.equal((await run()).purged, 0);
	const job = await jobOf(w.id);
	assert.deepEqual([job.state, job.error_code], ["superseded", "not_current"]);
	assert.equal((await witnessOf(a.id)).state, "cancelled");
	assert.equal(objects.has(kept.key), true);
});

test("AC:TARGET-IDN-032 AC:DEL58-005 a workspace deletion purges through the same worker and leaves an unrelated church intact", async () => {
	const church = async () => {
		const a = await member();
		const created = ok(
			await db.transaction((tx) =>
				onboarding.createPlant(tx, ctx(a), command({ name: "Harvest Point", confirmed: true }, "1")),
			),
		);
		return { a, p: created.plant };
	};
	const deleted = await church(),
		other = await church();
	const [doomed, kept] = [await file(deleted.p.id), await file(other.p.id)];
	const [plant] = await admin.select().from(t.plant).where(eq(t.plant.id, deleted.p.id));
	ok(
		await db.transaction((tx) =>
			api.requestWorkspaceDeletion(
				tx,
				ctx(deleted.a, deleted.p),
				command({ plant: deleted.p, confirmed: true }, plant.revision),
			),
		),
	);
	const w = await witnessOf(deleted.p.id);
	assert.equal(w.kind, "plant");
	await graceEnds(w.id);
	assert.equal((await run()).purged, 1);
	const purged = await witnessOf(deleted.p.id);
	assert.equal(purged.state, "purged");
	assert.equal(purged.copy_expires_at.getTime() - purged.live_purged_at.getTime(), 7 * 86400_000);
	assert.equal((await jobOf(w.id)).state, "succeeded");
	assert.equal((await admin.select().from(t.person).where(eq(t.person.plant_id, deleted.p.id))).length, 0);
	assert.equal(objects.has(doomed.key), false);
	// The unrelated church keeps its name, its people and its file.
	const [survivor] = await admin.select().from(t.plant).where(eq(t.plant.id, other.p.id));
	assert.equal(survivor.name, "Harvest Point");
	assert.ok((await admin.select().from(t.person).where(eq(t.person.plant_id, other.p.id))).length > 0);
	assert.equal(objects.has(kept.key), true);
	assert.equal((await witnessOf(other.p.id)) ?? null, null);
});

test("INV-executor: without the cleanup login the tick skips the purge, runs the other workers and still answers 200", async () => {
	const a = await member();
	ok(
		await db.transaction(async (tx) =>
			api.requestAccountDeletion(tx, ctx(a), command({ confirmed: true }, await revisionOf(a.id))),
		),
	);
	const w = await witnessOf(a.id);
	await graceEnds(w.id);
	for (const config of [
		{ storage, cleanup: null },
		{ storage: null, cleanup: cleanupDb },
	]) {
		const skip = scheduledJobs({ secret: cron, db, reminders: null, digests: null, mail: null, ...config });
		const response = await skip(
			new Request("http://localhost/api/cron/jobs", { headers: { authorization: `Bearer ${cron}` } }),
		);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.deepEqual([body.status, body.purged], ["ok", 0]);
	}
	assert.equal((await witnessOf(a.id)).state, "pending_deletion");
	assert.equal((await jobOf(w.id)).state, "ready");
	assert.equal((await run()).purged, 1);
});
