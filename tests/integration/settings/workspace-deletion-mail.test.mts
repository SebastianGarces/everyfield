import "../platform/setup.mts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeDatabase } from "../../../packages/db/src/client.ts";
import { and, eq, sql } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { deletionOperations, issueRestrictedDeletionSession } from "../../../packages/domain/src/settings/index.ts";
import { notificationCategory } from "../../../packages/contracts/src/settings/values.ts";
import { settingsMail, settingsMailPass } from "../../../apps/web/src/features/settings/mail.ts";
import { deadline } from "../../../apps/web/src/features/settings/deletion-mail.ts";
import { createMailService, type MailPayload } from "../../../apps/web/src/server/jobs/mail.ts";
import { queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import { executeWrites } from "../../../packages/domain/src/operations/writes.ts";
import { testDatabase } from "../../support/test-database.mts";
import { ok, refusedWith, seeds } from "../../support/fixture.mts";

// T-272 (audit peo-1): a church workspace deletion request, and its cancel, email every seat open at that commit. Each
// notice is queued in the witness's own write through the settings mount's own effect, and the settings mail pass
// hands it to a capturing email service only while the settings mail rule still allows it.

const database = await testDatabase({ prefix: "t272", roles: { runtime: ["runtime"] }, max: 6 });
const { admin } = database;
const db = database.pools.runtime;
const seed = seeds(admin);
const hex = () => randomBytes(32).toString("hex");
Object.assign(process.env, {
	IDENTITY_DATABASE_URL: database.logins.runtime.url.href,
	IDENTITY_ORIGIN: "https://app.example.test",
	IDENTITY_MAIL_KEY: hex(),
	IDENTITY_ADDRESS_KEY: hex(),
	IDENTITY_MAIL_FROM: "everyfield@example.test",
});
const effects = settingsMail()!;
// As the settings mount wires it (apps/web/src/features/settings/server.ts).
const deletion = deletionOperations({
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
	workspaceNotice: effects.workspaceNotice,
});
const denied = refusedWith({ details: {} });
const addressHash = (address: string) =>
	createHmac("sha256", Buffer.from(process.env.IDENTITY_ADDRESS_KEY!, "hex"))
		.update(address.trim().toLowerCase())
		.digest("hex");

after(async () => {
	const pools = (globalThis as Record<symbol, Map<string, Parameters<typeof closeDatabase>[0]>>)[
		Symbol.for("everyfield.web.pools")
	];
	await Promise.all([...(pools?.values() ?? [])].map((pool) => closeDatabase(pool)));
	await database.close();
});

type Person = Awaited<ReturnType<typeof seed.actor>>;
type Church = { id: string; kind: "plant" };

/** One run of the settings mail pass through an email service that accepts and records every email. */
async function pass() {
	const sent: MailPayload[] = [];
	const run = settingsMailPass({
		async send(payload) {
			sent.push(payload);
			return { kind: "accepted", id: `captured-${randomUUID()}` };
		},
		async lookup() {
			return { kind: "unknown" };
		},
	})!;
	await run(100, Date.now() + 30_000);
	return sent;
}
/** A church with an Owner and the given seats, after a pass sends whatever earlier tests left due. */
async function church(roles: ("admin" | "member")[] = ["admin", "member"]) {
	await pass();
	const p = (await seed.plant({ name: `Harvest Point ${randomUUID().slice(0, 4)}` })) as Church;
	const owner = await seed.actor(p as never, "owner", { user: { name: "Olivia Owner" } });
	const seats: Person[] = [];
	for (const role of roles) seats.push(await seed.actor(p as never, role));
	return { p, owner, seats };
}
/** A fresh session for an account, as signing in again gives one. */
async function signIn(a: Person) {
	const session = randomUUID();
	await admin.insert(t.auth_session).values({
		id: session,
		user_id: a.user,
		token: hex(),
		expires_at: new Date(Date.now() + 86400_000),
	});
	return { ...a, session };
}
async function request(a: Person, p: Church, requestKey = randomUUID()) {
	const [row] = await admin.select({ revision: t.plant.revision }).from(t.plant).where(eq(t.plant.id, p.id));
	return db.transaction((tx) =>
		deletion.requestWorkspaceDeletion(
			tx,
			{ session: a.session, selected: p } as never,
			{ requestKey, expectedRevision: row!.revision, input: { plant: p, confirmed: true } } as never,
		),
	);
}
/** The Owner's restricted session for the request, then the cancel, as "Keep the workspace" sends it. */
async function cancel(owner: Person, p: Church, status: { requestId: string; revision: string }) {
	const proof = await admin.transaction((tx) =>
		issueRestrictedDeletionSession(tx, { subject: p, requestId: status.requestId }, async () => ({
			accountId: owner.id,
			provenAt: new Date(),
		})),
	);
	return db.transaction((tx) =>
		deletion.cancelWorkspaceDeletion(tx, proof, {
			requestKey: randomUUID(),
			expectedRevision: status.revision,
			input: { subject: p, requestId: status.requestId },
		} as never),
	);
}
/** The notice rows of one kind for one request: recipient account and state. */
async function notices(kind: "requested" | "cancelled", requestId: string) {
	const rows = await admin
		.select({ tenant: t.mail.tenant_id, recipient: t.mail.recipient_account_id, state: t.mail.state })
		.from(t.mail)
		.where(eq(t.mail.logical_key, `workspace-deletion/${kind}/${requestId}`));
	for (const r of rows) assert.equal(r.tenant, r.recipient);
	return Object.fromEntries(rows.map((r) => [r.recipient!, r.state]));
}
const allNotices = async () =>
	Number(
		(await admin.execute(sql`SELECT count(*)::int AS n FROM mail WHERE logical_key LIKE 'workspace-deletion/%'`))
			.rows[0]!.n,
	);
const to = (sent: MailPayload[]) => sent.map((m) => m.to).sort();
const witnessOf = async (p: Church) =>
	(
		await admin
			.select()
			.from(t.lifecycle_witness)
			.where(and(eq(t.lifecycle_witness.kind, "plant"), eq(t.lifecycle_witness.opaque_subject_id, p.id)))
	)[0]!;
/** Any mail the church itself owns, queued through the shared mail service with a rule that allows everything. */
const churchMail = createMailService({
	db,
	encryptionKey: Buffer.from(process.env.IDENTITY_MAIL_KEY!, "hex"),
	addressKey: Buffer.from(process.env.IDENTITY_ADDRESS_KEY!, "hex"),
	from: "everyfield@example.test",
	authorize: async (_tx, list) => new Set(list.map((m) => m.id)),
	transport: { send: async () => ({ kind: "refused", retryable: true }), lookup: async () => ({ kind: "unknown" }) },
});
async function queueChurchMail(p: Church, a: Person, logicalKey: string) {
	const writes: Parameters<typeof churchMail.append>[2] = [];
	const id = await churchMail.append(
		admin,
		{
			owner: { kind: "plant", id: p.id },
			purpose: "notification",
			logicalKey,
			recipient: a.id,
			address: a.email,
			content: { subject: "Church news", text: "Church news" },
			operation: null,
			notice: null,
			eligibleAt: new Date().toISOString(),
		},
		writes,
	);
	await executeWrites(admin, writes);
	return id;
}
const mailState = async (id: string) =>
	(await admin.select({ state: t.mail.state }).from(t.mail).where(eq(t.mail.id, id)))[0]!.state;

test("T-272 AC1 AC2 AC3 AC10: a deletion request emails every open seat its own copy; the church's other mail stays stopped", async () => {
	const { p, owner, seats } = await church();
	const [seatedAdmin, member] = seats as [Person, Person];
	await admin.update(t.account).set({ personal_timezone: "America/New_York" }).where(eq(t.account.id, owner.id));
	await admin.update(t.account).set({ personal_timezone: "Asia/Tokyo" }).where(eq(t.account.id, seatedAdmin.id));
	const older = await queueChurchMail(p, member, `security/${randomUUID()}`);

	const pending = ok(await request(owner, p));
	const w = await witnessOf(p);
	assert.equal(w.cancel_until!.toISOString(), pending.cancelUntil);
	// One requested notice per open seat, the requesting Owner's included, each owned by its own account.
	assert.deepEqual(await notices("requested", pending.requestId), {
		[owner.id]: "pending",
		[seatedAdmin.id]: "pending",
		[member.id]: "pending",
	});
	assert.equal(await mailState(older), "cancelled");
	// Church mail queued after the request, ordinary or with a notice's key, is refused at send time.
	const ordinary = await queueChurchMail(p, member, `security/${randomUUID()}`);
	const lookalike = await queueChurchMail(p, owner, `workspace-deletion/requested/${pending.requestId}`);

	const sent = await pass();
	assert.deepEqual(to(sent), [owner.email, seatedAdmin.email, member.email].sort());
	assert.equal(await mailState(ordinary), "cancelled");
	assert.equal(await mailState(lookalike), "cancelled");
	const copy = (a: Person) => sent.find((m) => m.to === a.email)!;
	for (const m of sent) {
		assert.match(m.subject, new RegExp(`^Harvest Point .* is scheduled for deletion$`));
		assert.match(m.text, /Olivia Owner asked to delete the Harvest Point .* workspace/);
		assert.match(m.text, /Church access is paused for everyone until /);
		assert.match(m.text, /Only Olivia Owner, the Owner who asked, can cancel the deletion before then\./);
		// No sign-in token, signed URL or church page; no erasure date; a service notice with no unsubscribe link.
		assert.doesNotMatch(m.text, /token|\?|\/settings|\/home|erase|will be deleted on/i);
		assert.equal(m.headers, undefined);
		assert.doesNotMatch(m.text, /Unsubscribe/);
	}
	// The deadline is the stored cancel_until in each recipient's own zone, named; the church's zone when unset.
	const zoned = (zone: string) => deadline(pending.cancelUntil, zone);
	assert.match(copy(owner).text, new RegExp(`until ${escape(zoned("America/New_York"))}\\.`));
	assert.match(copy(seatedAdmin).text, new RegExp(`until ${escape(zoned("Asia/Tokyo"))}\\.`));
	assert.match(copy(member).text, new RegExp(`until ${escape(zoned("America/Chicago"))}\\.`));
	assert.match(zoned("Asia/Tokyo"), /^[A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M \(Asia\/Tokyo\)$/);
	// Only the Owner's copy says how to keep the workspace; the others say to contact the Owner.
	assert.match(
		copy(owner).text,
		/go to https:\/\/app\.example\.test\/workspace-deletion, sign in with your email and password, and choose "Keep the workspace"\./,
	);
	for (const a of [seatedAdmin, member]) {
		assert.match(copy(a).text, /To keep the workspace, contact Olivia Owner, the church's Owner\./);
		assert.doesNotMatch(copy(a).text, /https?:/);
	}
});
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("T-272 AC4 AC5: a cancel emails each seat still open; an unsent notice goes only while its request still stands", async () => {
	const { p, owner, seats } = await church();
	const [seatedAdmin, member] = seats as [Person, Person];
	const r1 = ok(await request(owner, p));
	await admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.account_id, member.id));
	ok(await cancel(owner, p, r1));
	assert.deepEqual(await notices("cancelled", r1.requestId), { [owner.id]: "pending", [seatedAdmin.id]: "pending" });

	// The cancelled request's own notices are not sent; the cancel notices are.
	let sent = await pass();
	assert.deepEqual(to(sent), [owner.email, seatedAdmin.email].sort());
	for (const m of sent) {
		assert.match(m.subject, /^Harvest Point .* is no longer being deleted$/);
		assert.match(m.text, /The church is back\.\n\nSign in to Everyfield again to use it\./);
	}
	assert.deepEqual(await notices("requested", r1.requestId), {
		[owner.id]: "cancelled",
		[seatedAdmin.id]: "cancelled",
		[member.id]: "cancelled",
	});

	// A new request replaces an unsent request notice and stops an unsent cancel notice.
	const r2 = ok(await request(await signIn(owner), p));
	ok(await cancel(owner, p, r2));
	const r3 = ok(await request(await signIn(owner), p));
	sent = await pass();
	assert.deepEqual(to(sent), [owner.email, seatedAdmin.email].sort());
	for (const m of sent) assert.match(m.subject, /is scheduled for deletion$/);
	assert.deepEqual(await notices("requested", r2.requestId), {
		[owner.id]: "cancelled",
		[seatedAdmin.id]: "cancelled",
	});
	assert.deepEqual(await notices("cancelled", r2.requestId), {
		[owner.id]: "cancelled",
		[seatedAdmin.id]: "cancelled",
	});
	assert.deepEqual(await notices("requested", r3.requestId), { [owner.id]: "accepted", [seatedAdmin.id]: "accepted" });
	// Other church mail stays stopped while the workspace is pending deletion.
	const later = await queueChurchMail(p, seatedAdmin, `security/${randomUUID()}`);
	assert.deepEqual(await pass(), []);
	assert.equal(await mailState(later), "cancelled");
});

test("T-272 AC6: at send time a notice goes only to an account still seated, at the same address, with no personal deletion pending", async () => {
	const changes: [string, (a: Person) => Promise<unknown>][] = [
		["seat ended", (a) => admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.account_id, a.id))],
		[
			"address changed",
			(a) =>
				admin
					.update(t.auth_user)
					.set({ email: `${randomUUID()}@example.test` })
					.where(eq(t.auth_user.id, a.user)),
		],
		[
			"personal deletion pending",
			(a) =>
				admin.insert(t.lifecycle_witness).values({
					kind: "account",
					opaque_subject_id: a.id,
					account_id: a.id,
					request_id: randomUUID(),
					requester_id: a.id,
					requester_opaque_id: a.id,
					request_revision: "1",
					state: "pending_deletion",
					requested_at: new Date(),
					cancel_until: new Date(Date.now() + 30 * 86400_000),
					witness_checkpoint: "1",
					cleanup_state: "not_started",
				}),
		],
	];
	for (const [name, change] of changes) {
		const { p, owner, seats } = await church(["member"]);
		const [member] = seats as [Person];
		const r = ok(await request(owner, p));
		await change(member);
		assert.deepEqual(to(await pass()), [owner.email], name);
		assert.deepEqual(
			await notices("requested", r.requestId),
			{ [owner.id]: "accepted", [member.id]: "cancelled" },
			name,
		);
	}
});

test("T-272 AC7: replays and refusals queue no notice", async () => {
	const { p, owner, seats } = await church();
	const before = await allNotices();
	// An Admin or a Member cannot request it.
	for (const a of seats) denied(await request(a, p));
	assert.equal(await allNotices(), before);
	const key = randomUUID();
	const pending = ok(await request(owner, p, key));
	assert.equal(await allNotices(), before + 3);
	// The same command again, from a fresh sign-in, queues nothing more.
	await request(await signIn(owner), p, key);
	assert.equal(await allNotices(), before + 3);
	ok(await cancel(owner, p, pending));
	assert.equal(await allNotices(), before + 6);
	const again = ok(await cancel(owner, p, pending));
	assert.equal(again.status, "cancelled");
	assert.equal(await allNotices(), before + 6);

	// A cancel at or after the stored deadline is refused and queues nothing.
	const late = await church();
	const requestId = randomUUID();
	await admin.insert(t.lifecycle_witness).values({
		kind: "plant",
		opaque_subject_id: late.p.id,
		plant_id: late.p.id,
		request_id: requestId,
		requester_id: late.owner.id,
		requester_opaque_id: late.owner.id,
		request_revision: "1",
		state: "pending_deletion",
		requested_at: new Date(Date.now() - 31 * 86400_000),
		cancel_until: new Date(Date.now() - 86400_000),
		witness_checkpoint: "1",
		cleanup_state: "not_started",
	});
	denied(await cancel(late.owner, late.p, { requestId, revision: "1" }), "deadline_passed");
	assert.equal(await allNotices(), before + 6);
});

test("T-272 AC8: notices are service mail: notification settings never hold them back, the suppression list does", async () => {
	const { p, owner, seats } = await church();
	const [suppressed, quiet] = seats as [Person, Person];
	const bounce = randomUUID();
	await admin.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${bounce},${"seed-" + bounce},${"seed-" + bounce},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
	await admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
		VALUES(${addressHash(suppressed.email)},'hard_bounce',${bounce},clock_timestamp())`);
	for (const category of notificationCategory.options)
		// Every choice the settings allow, switched off (a category with no email choice refuses the email row).
		for (const channel of ["email", "in_app"])
			await admin
				.execute(
					sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
				VALUES (${quiet.id},${category},${channel},false,1)`,
				)
				.catch((error) => assert.equal(error.cause?.code, "23514"));
	const r = ok(await request(owner, p));
	const sent = await pass();
	assert.deepEqual(to(sent), [owner.email, quiet.email].sort());
	assert.equal((await notices("requested", r.requestId))[suppressed.id], "refused");
});
