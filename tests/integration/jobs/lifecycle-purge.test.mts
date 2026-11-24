import "../platform/setup.mts";
import { openedDeletion } from "../../support/deletion-cookie.mts";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { S3Client } from "../../../packages/db/src/schema/storage.ts";
import { accountId, sessionId } from "../../../packages/contracts/src/common/values.ts";
import type { SettingsContext } from "../../../packages/contracts/src/settings/server.ts";
import { testDatabase } from "../../support/test-database.mts";
import { sql, eq } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { createAccountCredentials } from "../../../packages/domain/src/settings/index.ts";
import { settingsApi } from "../settings/settings-api.mts";
import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { identityAuth } from "../../../packages/domain/src/identity/auth.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { ok } from "../../support/fixture.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const database = await testDatabase({
	prefix: "t128",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"], auth: ["auth"] },
});
const { admin } = database;
const { runtime: db, cleanup: cleanupDb, auth: authDb } = database.pools;
let credentials: ReturnType<typeof createAccountCredentials>;
let api: ReturnType<typeof settingsApi<typeof credentials>>;
let onboarding: ReturnType<typeof createOnboardingProducer>;
let signInAuth: ReturnType<typeof identityAuth>;
const origin = "http://purge.localhost";
const secret = randomBytes(40).toString("hex");
const ingress = new Map<string, Request>();

const objects = new Map<string, Buffer>();
let failing = 0;
class DeletingClient extends S3Client {
	constructor() {
		super({
			region: "us-east-1",
			endpoint: "https://example.invalid",
			forcePathStyle: true,
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
	}
	override async send(command: { input: { Key?: string } }) {
		assert.equal(command.constructor.name, "DeleteObjectCommand");
		if (failing > 0) {
			failing--;
			throw Error("provider_timeout");
		}
		objects.delete(String(command.input.Key));
		return {};
	}
}
const storage = { bucket: "synthetic-only", client: new DeletingClient() };
let tick: ReturnType<typeof scheduledJobs>;
async function run() {
	const response = await tick();
	assert.equal(response.status, 200);
	return response.json();
}

const command = (input = {}, expectedRevision = "1") => ({ input, expectedRevision, requestKey: randomUUID() });
type Member = { id: string; user: string; email: string; password: string; session: SettingsContext["session"] };
const ctx = (a: Member, selected: SettingsContext["selected"] = { kind: "account", id: accountId.parse(a.id) }) => ({
	session: a.session,
	selected,
});

before(async () => {
	const organizationEffects: Parameters<typeof createOrganizationAdapter>[0] = {
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
		diagnostic: () => {},
		responseCookies: async () => {},
		deliverVerification: async () => {},
		securityNotice: async () => randomUUID(),
	});
	api = settingsApi({
		organizations: createOrganizationAdapter(organizationEffects, {
			candidates: () => sql`SELECT NULL::uuid WHERE false`,
		}),
		organizationEffects,
		effects: { replan: async () => randomUUID() },
		suppression: async () => "unavailable",
		avatarCleanup: { queue: (tx) => queueJobs(tx, []) },
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
	tick = scheduledJobs({ db, storage, cleanup: cleanupDb, effects: null, digests: null, mail: null });
});
after(database.close);

const signIn = (a: Pick<Member, "email" | "password">) =>
	signInAuth.api.signInEmail({ body: { email: a.email, password: a.password }, asResponse: true });
async function member(): Promise<Member> {
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
	assert.ok(s);
	ingress.set(s.session.id, request);
	return { id, user: signed.user.id, email, password, session: sessionId.parse(s.session.id) };
}
async function file(tenant: string) {
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
		const person = (
			await admin.select({ id: t.person.id }).from(t.person).where(eq(t.person.plant_id, tenant)).limit(1)
		)[0]!;
		await admin.update(t.person).set({ photo_object_id: id }).where(eq(t.person.id, person.id));
	}
	return { id, key };
}
const revisionOf = async (id: string) =>
	(await admin.select().from(t.account).where(eq(t.account.id, id)))[0]!.revision;
const witnessesOf = (subject: string) =>
	admin.select().from(t.lifecycle_witness).where(eq(t.lifecycle_witness.opaque_subject_id, subject));
const witnessOf = async (subject: string) => (await witnessesOf(subject))[0]!;
const jobOf = async (witness: string) =>
	(
		await admin
			.select()
			.from(t.job)
			.where(sql`${t.job.kind}='lifecycle_purge' AND ${t.job.subject_record_id}=${witness}`)
	)[0]!;
async function graceEnds(witness: string) {
	await admin.transaction(async (tx) => {
		await tx.execute(sql`ALTER TABLE lifecycle_witness DISABLE TRIGGER witness_clock`);
		await tx.execute(
			sql`UPDATE lifecycle_witness SET requested_at=requested_at-interval '31 days',cancel_until=cancel_until-interval '31 days' WHERE id=${witness}`,
		);
		await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
		await tx.execute(sql`ALTER TABLE lifecycle_witness ENABLE TRIGGER witness_clock`);
		await tx.execute(
			sql`UPDATE job SET eligible_at=eligible_at-interval '31 days' WHERE kind='lifecycle_purge' AND subject_record_id=${witness}`,
		);
	});
}
const openDeletion = (a: Member) => credentials.openAccountDeletion({ email: a.email, password: a.password }, null);

test("AC:TARGET-IDN-032 after Delete my account and the grace period, a scheduled tick purges the account and the old login is refused", async () => {
	const a = await member();
	const avatar = await file(a.id);
	await admin.update(t.account).set({ avatar_object_id: avatar.id }).where(eq(t.account.id, a.id));
	const pending = ok(
		await gatedTransaction(db, (tx) => api.requestAccountDeletion(tx, ctx(a), command({ confirmed: true }, "1"))),
	);
	assert.equal(pending.status, "pending_deletion");
	const opened = await openDeletion(a);
	assert.equal(opened.status, "ok", JSON.stringify(opened));
	assert.equal(opened.value.requestId, pending.requestId);
	const w = await witnessOf(a.id);

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
	assert.equal(purged.copy_expires_at!.getTime() - purged.live_purged_at!.getTime(), 7 * 86400_000);
	assert.equal((await jobOf(w.id)).state, "succeeded");
	assert.equal(objects.has(avatar.key), false);
	assert.equal((await admin.select().from(t.file_object).where(eq(t.file_object.id, avatar.id)))[0]!.state, "purged");

	const rejected = await signIn(a);
	assert.notEqual(rejected.status, 200);
	assert.deepEqual(await openDeletion(a), { status: "refused", code: "proof_invalid" });
	assert.equal(await readViewer(db, a.session), null);

	assert.equal((await run()).purged, 0);
});

test("AC:TARGET-IDN-032 a removal the provider does not confirm keeps the account purging and hidden until a later tick confirms it", async () => {
	const a = await member();
	const kept = await file(a.id);
	ok(
		await gatedTransaction(db, async (tx) =>
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
		await gatedTransaction(db, async (tx) =>
			api.requestAccountDeletion(tx, ctx(a), command({ confirmed: true }, await revisionOf(a.id))),
		),
	);
	const opened = ok(await openDeletion(a));
	const request = { subject: opened.subject, requestId: opened.requestId };
	const proof = await openedDeletion(opened.session, request);
	ok(await gatedTransaction(db, (tx) => api.cancelAccountDeletion(tx, proof, command(request, pending.revision))));
	const w = await witnessOf(a.id);
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
			await gatedTransaction(db, (tx) =>
				onboarding.createPlant(
					tx,
					{ session: a.session, selected: { kind: "account", id: accountId.parse(a.id) } },
					command({ name: "Harvest Point", confirmed: true }, "1"),
				),
			),
		);
		return { a, p: created.plant };
	};
	const deleted = await church(),
		other = await church();
	const [doomed, kept] = [await file(deleted.p.id), await file(other.p.id)];
	const plant = (await admin.select().from(t.plant).where(eq(t.plant.id, deleted.p.id)))[0]!;
	ok(
		await gatedTransaction(db, (tx) =>
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
	assert.equal(purged.copy_expires_at!.getTime() - purged.live_purged_at!.getTime(), 7 * 86400_000);
	assert.equal((await jobOf(w.id)).state, "succeeded");
	assert.equal((await admin.select().from(t.person).where(eq(t.person.plant_id, deleted.p.id))).length, 0);
	assert.equal(objects.has(doomed.key), false);
	const survivor = (await admin.select().from(t.plant).where(eq(t.plant.id, other.p.id)))[0]!;
	assert.equal(survivor.name, "Harvest Point");
	assert.ok((await admin.select().from(t.person).where(eq(t.person.plant_id, other.p.id))).length > 0);
	assert.equal(objects.has(kept.key), true);
	assert.deepEqual(await witnessesOf(other.p.id), []);
});

test("INV-executor: without the cleanup login the tick skips the purge, runs the other workers and still answers 200", async () => {
	const a = await member();
	ok(
		await gatedTransaction(db, async (tx) =>
			api.requestAccountDeletion(tx, ctx(a), command({ confirmed: true }, await revisionOf(a.id))),
		),
	);
	const w = await witnessOf(a.id);
	await graceEnds(w.id);
	for (const config of [
		{ storage, cleanup: null },
		{ storage: null, cleanup: cleanupDb },
	]) {
		const skip = scheduledJobs({ db, effects: null, digests: null, mail: null, ...config });
		const response = await skip();
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.deepEqual([body.status, body.purged], ["ok", 0]);
	}
	assert.equal((await witnessOf(a.id)).state, "pending_deletion");
	assert.equal((await jobOf(w.id)).state, "ready");
	assert.equal((await run()).purged, 1);
});
