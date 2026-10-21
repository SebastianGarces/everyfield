import { sendOnboardingRelationships } from "../../../apps/web/src/server/jobs/notifications.ts";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { sql, eq, and } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import {
	createSettingsProducer,
	createLifecycleCleanup,
	issueRestrictedDeletionSession,
	createAccountCredentials,
	uploadAvatar,
	readAvatar,
} from "../../../packages/domain/src/settings/index.ts";
import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { enqueueJob, queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { identityAuth } from "../../../packages/domain/src/identity/auth.ts";
import { currentActor, readViewer } from "../../../packages/domain/src/access/session.ts";
const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const ci =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!ci && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved development or disposable CI database allowed");
if (!ci) source.searchParams.set("sslmode", "verify-full");
const schema = "wp010_" + randomUUID().replaceAll("-", ""),
	role = "wp010_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 8,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db, cleanupDb, authDb, api, onboarding, mail, producerDeps;
let faults = false;
const origin = "http://settings.localhost";
const ingress = new Map();
const deliveries = [];
const secret = randomBytes(40).toString("hex");
const ok = (r) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value;
};
const denied = (r, code = "unavailable") => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.error.code, code);
	assert.deepEqual(r.error.details, {});
};
const command = (input = {}, expectedRevision = "1", requestKey = randomUUID()) => ({
	input,
	expectedRevision,
	requestKey,
});
const ctx = (a, selected = { kind: "account", id: a.id }) => ({
	session: a.session,
	selected,
});
const call = (name, a, v, selected) => db.transaction((tx) => api[name](tx, ctx(a, selected), v));
/** The viewer the settings mount passes: the request actor and the user row of the session's Better Auth lookup. */
async function viewerOf(a) {
	const v = await readViewer(db, a.session);
	if (!v?.authority) return null;
	const user = await admin.execute(
		sql`SELECT u.name, u.email, u.email_verified FROM auth_session s JOIN auth_user u ON u.id=s.user_id WHERE s.id=${a.session}`,
	);
	const { name, email, email_verified } = user.rows[0];
	return { authority: v.authority, principal: { display_name: name, email, verified: email_verified } };
}
/** One section read the way the settings mount runs it: on the pool, with the request's viewer. */
const section = async (a, request) => api.getSection(db, await viewerOf(a), request);
async function actor() {
	const a = { id: randomUUID(), user: randomUUID(), session: randomUUID() };
	await admin.execute(
		sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES(${a.user},'Synthetic',${a.user + "@example.test"},true)`,
	);
	await admin
		.insert(t.account)
		.values({ id: a.id, auth_user_id: a.user, registration_state: "active", registration_kind: "planter" });
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${a.session},${a.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
	);
	return a;
}
async function plant(a = undefined) {
	a ??= await actor();
	const [row] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
	const result = ok(
		await db.transaction((tx) =>
			onboarding.createPlant(tx, ctx(a), command({ name: "Harvest Point", confirmed: true }, row.revision)),
		),
	);
	return { a, p: result.plant, result };
}
async function seat(p, role = "admin") {
	const a = await actor();
	await admin.insert(t.seat).values({ plant_id: p.id, account_id: a.id, role, accepted_at: new Date(), revision: "1" });
	return a;
}
const effect = async (tx, input) => {
	if (faults) throw Error("intent_fault");
	return enqueueJob(tx, {
		tenant: input.owner.id,
		kind: "notification",
		subject: input.owner.id,
		key: `settings/${input.kind}/${input.operationId}/${input.revision}`,
		revision: input.revision,
		eligibleAt: new Date().toISOString(),
	});
};
before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	for (const [suffix, cap] of [
		["", "everyfield_runtime"],
		["_cleanup", "everyfield_cleanup"],
		["_auth", "everyfield_auth"],
	]) {
		const password = randomBytes(32).toString("hex"),
			name = role + suffix;
		await admin.execute(
			sql.raw(
				`CREATE ROLE ${name} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
			),
		);
		await admin.execute(sql.raw(`GRANT ${cap} TO ${name}`));
		const url = new URL(source);
		url.username = name;
		url.password = password;
		const client = createDatabase({
			connectionString: url.href,
			max: 8,
			options: `-c search_path=${schema},pg_catalog,pg_temp`,
		});
		if (suffix === "") db = client;
		else if (suffix === "_cleanup") cleanupDb = client;
		else authDb = client;
	}
	mail = createMailService({
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "test@example.test",
		authorize: async (_tx, mail) => new Set(mail.map((m) => m.id)),
		transport: {
			send: async () => {
				throw Error("No real mail");
			},
			lookup: async () => {
				throw Error("No real mail");
			},
		},
	});
	const organizationEffects = {
		invitation: async () => {},
		notice: (tx, i) => {
			if (faults) throw Error("notice_fault");
			return queueJobs(tx, [
				{
					tenant: i.pair.organization.id,
					kind: "notification",
					subject: i.relationshipId,
					key: "sharing/" + i.eventId,
					revision: i.revision,
					eligibleAt: new Date().toISOString(),
				},
			]);
		},
		invalidate: (tx, i) =>
			queueJobs(
				tx,
				i.owners.map((owner) => ({
					tenant: owner.id,
					kind: "assessment",
					subject: i.sourceId,
					key: "invalidate/" + i.sourceId + "/" + i.revision,
					revision: i.revision,
					eligibleAt: new Date().toISOString(),
				})),
			),
	};
	const organizations = createOrganizationAdapter(organizationEffects, { candidates: async () => [] });
	const credentials = createAccountCredentials({
		db,
		authDb,
		admissionDb: admin,
		origin,
		secret,
		request: async (c) => {
			const request = ingress.get(c.session);
			if (!request) throw Error("missing_native_request");
			return { request, trustedIp: "198.51.100.21" };
		},
		responseCookies: async () => {},
		deliverVerification: async (i) => {
			deliveries.push(i);
		},
		securityNotice: async (tx, i) => {
			if (faults) throw Error("security_intent_fault");
			return await mail.enqueue(tx, {
				owner: { kind: "account", id: i.accountId },
				purpose: "notification",
				logicalKey: "security/" + i.correlationId,
				recipient: i.accountId,
				address: i.address,
				content: { subject: "Security update", text: "Your sign-in details changed." },
				operation: null,
				notice: null,
				eligibleAt: new Date().toISOString(),
			});
		},
	});
	producerDeps = {
		organizations,
		organizationEffects,
		effects: {
			replan: effect,
			invalidate: async (tx, i) => {
				await enqueueJob(tx, {
					tenant: i.owner.id,
					kind: "assessment",
					subject: i.owner.id,
					key: "settings-material/" + i.operationId,
					revision: i.revision,
					eligibleAt: new Date().toISOString(),
				});
				if (faults) throw Error("invalidate_fault");
			},
		},
		suppression: async () => "unavailable",
		avatarCleanup: {
			enqueue: async (tx, i) => {
				await enqueueJob(tx, {
					tenant: i.accountId,
					kind: "object_cleanup",
					subject: i.fileId,
					key: "avatar/" + i.fileId,
					revision: "1",
					eligibleAt: i.eligibleAt,
				});
				if (faults) throw Error("cleanup_intent_fault");
			},
		},
		deletion: {
			enqueue: async (tx, i) => {
				await enqueueJob(tx, {
					tenant: i.subject.id,
					kind: "lifecycle_purge",
					subject: i.witnessId,
					key: "purge/" + i.requestId,
					revision: i.revision,
					eligibleAt: i.eligibleAt,
				});
				if (faults) throw Error("purge_intent_fault");
			},
		},
		credentials,
	};
	api = createSettingsProducer(producerDeps);
	onboarding = createOnboardingProducer({
		relationships: (tx, inputs) => sendOnboardingRelationships(tx, inputs, mail),
		enqueue: async (tx, i, command) => {
			mail.append(
				tx,
				{
					owner: { kind: "account", id: i.accountId },
					purpose: "notification",
					logicalKey: "onboarding/" + i.operationId,
					recipient: i.accountId,
					address: i.address,
					content: { subject: "Saved", text: "Saved" },
					operation: i.operationId,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				command.writes,
			);
		},
	});
});
after(async () => {
	for (const client of [db, cleanupDb, authDb]) if (client) await closeDatabase(client);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		for (const suffix of ["", "_cleanup", "_auth"])
			await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role + suffix}`));
	} finally {
		await closeDatabase(admin);
	}
});

test("AC:TARGET-IDN-010 AC:TARGET-IDN-011 AC:ROLE43-002 AC:ROLE43-005 scoped settings preserve nullable locality and reject stale or foreign saves", async () => {
	const f = await plant(),
		other = await plant(),
		adminActor = await seat(f.p),
		member = await seat(f.p, "member");
	denied(await call("saveSection", f.a, command({ section: "account", name: "Wrong context" }), f.p));
	const initial = ok(await section(f.a, { section: "plant", plant: f.p }));
	assert.equal(initial.values.timeZone, "America/Chicago");
	assert.deepEqual(initial.values.digest, { cadence: "weekly", weekday: 0, hour: 16 });
	const v = command({
		section: "plant",
		plant: f.p,
		change: {
			kind: "profile",
			patch: { name: " New Name ", street: "123 Private Street", city: null, stateProvince: "TX", country: null },
		},
	});
	const saved = ok(await call("saveSection", adminActor, v, f.p));
	assert.equal(saved.current.values.profile.name, "New Name");
	assert.equal(saved.current.values.profile.street, "123 Private Street");
	assert.equal(saved.current.values.profile.city, null);
	assert.equal(saved.current.revision, "2");
	denied(await call("saveSection", member, command(v.input, "2"), f.p));
	denied(await call("saveSection", other.a, command(v.input, "2"), other.p));
	denied(await call("saveSection", f.a, command(v.input), f.p), "conflict");
	const replay = ok(await call("saveSection", adminActor, v, f.p));
	assert.deepEqual(replay, saved);
	assert.equal(replay.current.revision, "2");
	const noop = ok(await call("saveSection", f.a, command(v.input, "2"), f.p));

	assert.equal(noop.current.revision, "2");
	faults = true;
	await assert.rejects(
		call("saveSection", f.a, command({ ...v.input, change: { kind: "digest", value: { cadence: "off" } } }, "2"), f.p),
		/invalidate_fault/,
	);
	faults = false;
	assert.equal(ok(await section(f.a, { section: "plant", plant: f.p })).revision, "2");
	const self = ok(await section(member, { section: "account" }));
	assert.deepEqual(self.personalTimezone, { status: "unconfirmed" });
	const name = ok(await call("saveSection", member, command({ section: "account", name: " Member Updated " })));
	assert.equal(name.current.name, "Member Updated");
});

test("AC:WP010-IDN-012 account preferences keep exact category/channel choices independent and scoped", async () => {
	const a = await actor();
	let current = ok(await section(a, { section: "notifications" }));
	assert.equal(current.values.choices.length, 19);
	assert.equal(current.values.oversightCadence, null);
	assert.equal(current.values.suppression, "unavailable");
	const saved = ok(
		await call(
			"saveSection",
			a,
			command({
				section: "notifications",
				patch: { kind: "channel", choice: { category: "task_due", channel: "email", enabled: false } },
			}),
		),
	);
	assert.equal(
		saved.current.values.choices.find((c) => c.category === "task_due" && c.channel === "email").enabled,
		false,
	);
	assert.equal(
		saved.current.values.choices.find((c) => c.category === "task_overdue" && c.channel === "email").enabled,
		true,
	);
	assert.equal(
		saved.current.values.choices.find((c) => c.category === "task_due" && c.channel === "in_app").enabled,
		true,
	);
	denied(
		await call(
			"saveSection",
			a,
			command({ section: "notifications", patch: { kind: "oversight_cadence", cadence: "daily" } }, "2"),
		),
	);
	const f = await plant();
	const cadence = ok(
		await call(
			"saveSection",
			a,
			command({ section: "notifications", patch: { kind: "planter_cadence", cadence: "daily" } }, "2"),
		),
	);
	assert.equal(cadence.current.values.planterCadence, "daily");
});

test("AC:TARGET-IDN-031 AC:TARGET-IDN-032 AC:TARGET-TSK-018 personal zones canonicalize independently, require bound previews, and roll back required intents", async () => {
	const a = await actor();
	const p = ok(await call("previewPersonalTimezone", a, { timeZone: "US/Central" }));
	assert.equal(p.newZone, "America/Chicago");
	assert.deepEqual(p.preference, { status: "unconfirmed" });
	const s = ok(
		await call(
			"setPersonalTimezone",
			a,
			command({ timeZone: "america/chicago", previewId: p.previewId, confirmed: true }, p.expectedRevision),
		),
	);
	assert.deepEqual(s.preference, { status: "confirmed", timeZone: "America/Chicago", revision: "2" });
	assert.deepEqual(ok(await section(a, { section: "account" })).personalTimezone, s.preference);
	const f = await plant(a);
	const church = ok(await section(a, { section: "plant", plant: f.p }));
	assert.equal(church.values.timeZone, "America/Chicago");
	assert.deepEqual(church.values.digest, { cadence: "weekly", weekday: 0, hour: 16 });
	const v = ok(await call("previewPersonalTimezone", a, { timeZone: "America/New_York" }));
	const foreign = await actor();
	denied(
		await call(
			"setPersonalTimezone",
			foreign,
			command({ timeZone: "America/New_York", previewId: v.previewId, confirmed: true }),
		),
		"stale_preview",
	);
	faults = true;
	await assert.rejects(
		call(
			"setPersonalTimezone",
			a,
			command({ timeZone: "America/New_York", previewId: v.previewId, confirmed: true }, v.expectedRevision),
		),
		/intent_fault/,
	);
	faults = false;
	assert.equal(ok(await section(a, { section: "account" })).personalTimezone.timeZone, "America/Chicago");
});

test("INV-private-calendar: revoked seat keeps its personal preference but cannot invoke the author calendar", async () => {
	const f = await plant();
	const calls = { preview: 0, apply: 0 };
	const producer = createSettingsProducer({
		...producerDeps,
		personalCalendar: {
			preview: async () => {
				calls.preview++;
			},
			apply: async () => {
				calls.apply++;
			},
		},
	});
	const preview = (zone) => db.transaction((tx) => producer.previewPersonalTimezone(tx, ctx(f.a), { timeZone: zone }));
	const apply = (p) =>
		db.transaction((tx) =>
			producer.setPersonalTimezone(
				tx,
				ctx(f.a),
				command({ timeZone: p.newZone, previewId: p.previewId, confirmed: true }, p.expectedRevision),
			),
		);
	const first = ok(await preview("America/New_York"));
	assert.equal(ok(await apply(first)).preference.timeZone, "America/New_York");
	assert.deepEqual(calls, { preview: 1, apply: 1 });
	const [seat] = await admin.select().from(t.seat).where(eq(t.seat.account_id, f.a.id));
	await admin.insert(t.lifecycle_witness).values({
		kind: "seat",
		opaque_subject_id: seat.id,
		seat_id: seat.id,
		request_revision: "1",
		state: "revoked",
		witness_checkpoint: "1",
		cleanup_state: "not_started",
	});
	const next = ok(await preview("Europe/Paris"));
	assert.deepEqual(ok(await apply(next)).preference, { status: "confirmed", timeZone: "Europe/Paris", revision: "3" });
	assert.deepEqual(calls, { preview: 1, apply: 1 });
});

test("AC:TARGET-IDN-011 AC:TARGET-TSK-018 church zone preview is actor/revision/source-bound and preserves existing appointment instants and task dates", async () => {
	const f = await plant(),
		m = await seat(f.p, "member");
	const preview = ok(await call("previewPlantTimezone", f.a, { plant: f.p, timeZone: "US/Eastern" }, f.p));
	assert.equal(preview.newZone, "America/New_York");
	assert.equal(preview.oldZone, "America/Chicago");
	denied(
		await call(
			"setPlantTimezone",
			m,
			command({ plant: f.p, timeZone: "America/New_York", previewId: preview.previewId }),
			f.p,
		),
	);
	denied(
		await call("setPlantTimezone", f.a, command({ plant: f.p, timeZone: "UTC", previewId: preview.previewId }), f.p),
		"stale_preview",
	);
	const changed = ok(
		await call(
			"setPlantTimezone",
			f.a,
			command({ plant: f.p, timeZone: "America/New_York", previewId: preview.previewId }),
			f.p,
		),
	);
	assert.equal(changed.status, "changed");
	assert.equal(changed.revision, "2");
	assert.equal(changed.timeZone, "America/New_York");
	const p = ok(await call("previewPlantTimezone", f.a, { plant: f.p, timeZone: "America/New_York" }, f.p));
	const no = ok(
		await call(
			"setPlantTimezone",
			f.a,
			command({ plant: f.p, timeZone: "America/New_York", previewId: p.previewId }, "2"),
			f.p,
		),
	);
	assert.equal(no.status, "noop");
	assert.equal(no.revision, "2");
});

async function restricted(a, subject, status) {
	return admin.transaction((tx) =>
		issueRestrictedDeletionSession(tx, { subject, requestId: status.requestId }, async () => ({
			accountId: a.id,
			provenAt: new Date(),
		})),
	);
}
test("AC:DEL58-001 AC:DEL58-002 AC:DEL58-003 AC:DEL58-005 AC:TARGET-IDN-026 AC:ROLE43-017 AC:WP010-KNOW-069 personal deletion suspends immediately and only fresh exact proof cancels", async () => {
	const f = await plant(),
		member = await seat(f.p, "member");
	const ordinaryAdmin = await seat(f.p, "admin");
	denied(await call("requestWorkspaceDeletion", ordinaryAdmin, command({ plant: f.p, confirmed: true }), f.p));
	denied(await call("requestAccountDeletion", f.a, command({ confirmed: true })), "manual_owner_exception_required");
	denied(await call("requestWorkspaceDeletion", member, command({ plant: f.p, confirmed: true }), f.p));
	const pending = ok(await call("requestAccountDeletion", member, command({ confirmed: true })));
	assert.equal(pending.status, "pending_deletion");
	assert.equal(Date.parse(pending.cancelUntil) - Date.parse(pending.requestedAt), 30 * 86400_000);
	assert.equal(await viewerOf(member), null);
	assert.equal((await admin.select().from(t.auth_session).where(eq(t.auth_session.id, member.session))).length, 0);
	const proof = await restricted(member, { kind: "account", id: member.id }, pending);
	const request = { subject: { kind: "account", id: member.id }, requestId: pending.requestId };
	const visible = ok(await db.transaction((tx) => api.getAccountDeletionStatus(tx, proof, request)));
	assert.deepEqual(visible, pending);
	denied(
		await db.transaction((tx) =>
			api.getAccountDeletionStatus(tx, proof, { ...request, subject: { kind: "account", id: f.a.id } }),
		),
		"proof_invalid",
	);
	const cancelled = ok(
		await db.transaction((tx) => api.cancelAccountDeletion(tx, proof, command(request, pending.revision))),
	);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.requestId, pending.requestId);
	assert.equal(cancelled.cancelUntil, pending.cancelUntil);
	assert.equal(await viewerOf(member), null);
	assert.equal((await admin.select().from(t.auth_session).where(eq(t.auth_session.id, member.session))).length, 0);
	const repeat = ok(
		await db.transaction((tx) => api.cancelAccountDeletion(tx, proof, command(request, pending.revision))),
	);
	assert.deepEqual(repeat, cancelled);
	const user = ok(await section(f.a, { section: "plant", plant: f.p }));
	assert.equal(user.values.profile.name, "Harvest Point");
});

test("INV-lifecycle: first-witness deletion waits for an in-flight edit; later reads and writes deny", async () => {
	const a = await actor();
	let release, entered;
	const ready = new Promise((r) => (entered = r)),
		gate = new Promise((r) => (release = r));
	const edit = db.transaction(async (tx) => {
		const r = ok(await api.saveSection(tx, ctx(a), command({ section: "account", name: "Serialized Name" })));
		entered();
		await gate;
		return r;
	});
	await ready;
	const deletion = call("requestAccountDeletion", a, command({ confirmed: true }, "2"));
	release();
	const [saved, pending] = await Promise.all([edit, deletion]);
	assert.equal(saved.current.name, "Serialized Name");
	assert.equal(ok(pending).status, "pending_deletion");
	denied(await call("saveSection", a, command({ section: "account", name: "Too Late" }, "2")));
});

test("INV-settings: concurrent account edits serialize before taking session share locks", async () => {
	const a = await actor();
	let entered, release;
	const ready = new Promise((r) => (entered = r)),
		gate = new Promise((r) => (release = r));
	const blocking = admin.transaction(async (tx) => {
		await tx.select().from(t.auth_user).where(eq(t.auth_user.id, a.user)).for("update");
		entered();
		await gate;
	});
	await ready;
	const pids = [];
	const edits = ["First name", "Second name"].map((name) =>
		db.transaction(async (tx) => {
			pids.push((await tx.execute(sql`SELECT pg_backend_pid() AS id`)).rows[0].id);
			return api.saveSection(tx, ctx(a), command({ section: "account", name }));
		}),
	);
	const settled = Promise.allSettled(edits);
	try {
		let waiting = false;
		for (let i = 0; i < 100; i++) {
			const rows = (
				await admin.execute(
					sql`SELECT pid FROM pg_stat_activity WHERE pid IN (${pids[0] ?? 0},${pids[1] ?? 0}) AND wait_event_type='Lock'`,
				)
			).rows;
			if (rows.length === 2) {
				waiting = true;
				break;
			}
		}
		assert.equal(waiting, true, "both real edits reached their lock wait");
	} finally {
		release();
	}
	await blocking;
	const results = await settled;
	assert.equal(
		results.every((r) => r.status === "fulfilled"),
		true,
		JSON.stringify(results),
	);
	const replies = results.map((r) => r.value);
	assert.equal(replies.filter((r) => r.status === "ok").length, 1);
	denied(
		replies.find((r) => r.status === "refused"),
		"conflict",
	);
	assert.equal(ok(await section(a, { section: "account" })).revision, "2");
});

async function overdue(a, subject) {
	const at = new Date(Date.now() - 31 * 86400_000),
		requestId = randomUUID();
	const [w] = await admin
		.insert(t.lifecycle_witness)
		.values({
			kind: subject.kind,
			opaque_subject_id: subject.id,
			account_id: subject.kind === "account" ? subject.id : null,
			plant_id: subject.kind === "plant" ? subject.id : null,
			request_id: requestId,
			requester_id: a.id,
			requester_opaque_id: a.id,
			request_revision: "1",
			state: "pending_deletion",
			requested_at: at,
			cancel_until: new Date(at.getTime() + 30 * 86400_000),
			witness_checkpoint: "1",
			cleanup_state: "not_started",
		})
		.returning();
	return {
		status: "pending_deletion",
		subject,
		requestId,
		revision: "1",
		requestedAt: w.requested_at.toISOString(),
		cancelUntil: w.cancel_until.toISOString(),
	};
}
test("AC:WP010-KNOW-072 AC:WP010-KNOW-073 AC:DEL58-009 deadline refuses cancellation; retryable witnessed purge preserves church-owned onboarding and People facts", async () => {
	const f = await plant();
	const subject = { kind: "account", id: f.a.id };
	const p = await overdue(f.a, subject);
	const proof = await restricted(f.a, subject, p);
	denied(
		await db.transaction((tx) =>
			api.cancelAccountDeletion(tx, proof, command({ subject, requestId: p.requestId }, p.revision)),
		),
		"deadline_passed",
	);
	let complete = false;
	const purge = createLifecycleCleanup(cleanupDb, {
		authorize: async () => true,
		removeOwnedResources: async () => complete,
	});
	const input = { subject, requestId: p.requestId, revision: p.revision };
	assert.deepEqual(await purge(input), { status: "purging" });
	let [w] = await admin.select().from(t.lifecycle_witness).where(eq(t.lifecycle_witness.opaque_subject_id, subject.id));
	assert.equal(w.state, "purging");
	assert.equal(w.live_purged_at, null);
	const [shared] = await admin.select().from(t.person).where(eq(t.person.id, f.result.ownerSeat.personId));
	assert.equal(shared.linked_account_id, null);
	assert.equal(shared.display_name, "Synthetic");
	const [setup] = await admin.select().from(t.onboarding_setup).where(eq(t.onboarding_setup.plant_id, f.p.id));

	assert.equal(setup.plant_id, f.p.id);
	const [creation] = await admin.select().from(t.audit_event).where(eq(t.audit_event.id, setup.creation_operation_id));
	assert.deepEqual(Object.keys(creation.result).sort(), ["creation", "plant"]);
	const [user] = await admin.select().from(t.auth_user).where(eq(t.auth_user.id, f.a.user));
	assert.equal(user.name, "Removed account");
	assert.equal(user.email, `removed-${f.a.id}@removed.invalid`);
	complete = true;
	const done = await purge(input);
	assert.equal(done.status, "purged");
	assert.equal(Date.parse(done.copyExpiresAt) - Date.parse(done.livePurgedAt), 7 * 86400_000);
	assert.deepEqual(await purge(input), done);
	await assert.rejects(purge({ ...input, requestId: randomUUID() }), /conflict/);
	const [church] = await admin.select().from(t.plant).where(eq(t.plant.id, f.p.id));
	assert.equal(church.name, "Harvest Point");
});

test("AC:WP010-KNOW-072 AC:DEL58-005 workspace purge hides and removes only its content; unrelated church survives", async () => {
	const f = await plant(),
		other = await plant();
	const subject = { kind: "plant", id: f.p.id };
	const p = await overdue(f.a, subject);
	assert.equal(await viewerOf(f.a), null);
	assert.equal(ok(await section(other.a, { section: "plant", plant: other.p })).values.profile.name, "Harvest Point");
	const purge = createLifecycleCleanup(cleanupDb, {
		authorize: async () => true,
		removeOwnedResources: async () => true,
	});
	const done = await purge({ subject, requestId: p.requestId, revision: p.revision });
	assert.equal(done.status, "purged");
	assert.equal((await admin.select().from(t.person).where(eq(t.person.plant_id, f.p.id))).length, 0);
	assert.equal(
		(await admin.select().from(t.onboarding_setup).where(eq(t.onboarding_setup.plant_id, f.p.id))).length,
		0,
	);
	assert.equal(
		(await admin.select().from(t.phase_transition).where(eq(t.phase_transition.plant_id, other.p.id))).length,
		1,
	);
});

test("AC:TARGET-IDN-006 AC:SEC-07 AC:PROVIDER48-002 avatar verifies private bytes, atomically changes the reference and denies old/foreign versions", async () => {
	const a = await actor(),
		foreign = await actor();
	const bytes = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
		"base64",
	);
	const objects = new Map();
	const storage = {
		bucket: "synthetic-only",
		client: {
			send: async (command) => {
				const i = command.input;
				switch (command.constructor.name) {
					case "GetBucketAclCommand":
						return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
					case "PutObjectCommand":
						assert.match(i.Key, new RegExp(`^private/${a.id}/[a-f0-9-]{36}$`));
						assert.equal(i.ACL, "private");
						assert.equal(i.CacheControl, "private, no-store");
						objects.set(i.Key, Buffer.from(i.Body));
						return {};
					case "GetObjectCommand": {
						const body = objects.get(i.Key);
						return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
					}
					default:
						throw Error("unexpected provider operation");
				}
			},
		},
	};
	const upload = ok(await call("requestAvatarUpload", a, { mime: "image/png", byteLength: bytes.length }));
	await assert.rejects(uploadAvatar(db, storage, ctx(foreign), { uploadId: upload.uploadId, bytes }), /unavailable/);
	await assert.rejects(
		uploadAvatar(db, storage, ctx(a), { uploadId: upload.uploadId, bytes: Buffer.from("not a png") }),
		/invalid_avatar/,
	);
	await uploadAvatar(db, storage, ctx(a), { uploadId: upload.uploadId, bytes });
	const saved = ok(await call("finalizeAvatar", a, command({ uploadId: upload.uploadId })));
	assert.deepEqual(saved, { status: "available", avatar: { accountId: a.id, versionId: upload.uploadId } });
	assert.deepEqual(await readAvatar(db, storage, ctx(a), upload.uploadId), bytes);
	denied(await call("getAvatar", foreign, { versionId: upload.uploadId }));
	const clear = ok(await call("removeAvatar", a, command({}, "2")));
	assert.deepEqual(clear, { status: "absent" });
	denied(await call("getAvatar", a, { versionId: upload.uploadId }));
});

let signInAuth;
async function credentialActor() {
	signInAuth ??= identityAuth({
		db: authDb,
		origin,
		secret,
		deliver: async () => {
			throw Error("not expected");
		},
	});
	const email = randomUUID() + "@example.test",
		password = "Initial secret 2468!";
	const signed = await signInAuth.api.signUpEmail({ body: { name: "Credential User", email, password } });
	const id = randomUUID();
	await admin
		.insert(t.account)
		.values({ id, auth_user_id: signed.user.id, registration_state: "active", registration_kind: "planter" });
	await admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, signed.user.id));
	return login({ id, user: signed.user.id, email, password });
}
async function login(a) {
	const r = await signInAuth.api.signInEmail({ body: { email: a.email, password: a.password }, asResponse: true });
	assert.equal(r.status, 200);
	const cookie = r.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	const request = new Request(origin + "/api/settings", { method: "POST", headers: { origin, cookie } });
	const s = await signInAuth.api.getSession({ headers: request.headers });
	ingress.set(s.session.id, request);
	return { ...a, session: s.session.id };
}
test("AC:AUTH-005 AC:AUTH-006 AC:AUTH-007 AC:TARGET-IDN-007 AC:ROLE43-018 email proof is requester-bound, superseded, 24 hours, unique, and preserves account/Person identity", async () => {
	const a = await credentialActor(),
		b = await credentialActor();
	const church = await plant(a);
	await admin
		.update(t.person)
		.set({ email: "crm-contact@example.test" })
		.where(eq(t.person.id, church.result.ownerSeat.personId));
	const requested = ok(await call("requestEmailChange", a, { newEmail: " " + randomUUID() + "@Example.Test " }));
	assert.equal(requested.status, "verification_requested");
	const first = deliveries.at(-1);
	assert.equal((await call("confirmEmailChange", b, { proof: first.token })).status, "refused");
	ok(await call("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }));
	const second = deliveries.at(-1);
	assert.equal((await call("confirmEmailChange", a, { proof: first.token })).status, "refused");
	const proofs = await admin.select().from(t.identity_proof).where(eq(t.identity_proof.account_id, a.id));
	assert.equal(proofs.filter((p) => p.superseded_at !== null).length, 1);
	const active = proofs.find((p) => p.superseded_at === null);
	const expiry = active.expires_at.getTime();
	assert.equal(Math.round((expiry - Date.now()) / 3600_000), 24);
	const result = await call("confirmEmailChange", a, { proof: second.token });
	assert.equal(result.status, "succeeded");
	assert.equal(result.action, "email_changed");
	assert.equal(result.reporting.status, "recorded");
	const [account] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
	assert.equal(account.auth_user_id, a.user);
	const [user] = await admin.select().from(t.auth_user).where(eq(t.auth_user.id, a.user));
	assert.equal(user.email, second.address);
	const [person] = await admin.select().from(t.person).where(eq(t.person.id, church.result.ownerSeat.personId));
	assert.equal(person.linked_account_id, a.id);
	assert.equal(person.email, "crm-contact@example.test");
	assert.equal((await call("confirmEmailChange", a, { proof: second.token })).status, "refused");
});

test("AC:TARGET-IDN-008 AC:ROLE43-018 password proof precedes unchanged refusal; supported revocation and reporting failures stay truthful", async () => {
	const a = await credentialActor(),
		other = await login(a);
	const initial = await admin.select().from(t.auth_session).where(eq(t.auth_session.user_id, a.user));
	assert.equal(initial.length, 2);
	const input = {
		currentPassword: "wrong secret",
		newPassword: "Replacement secret 2468!",
		confirmPassword: "Replacement secret 2468!",
	};
	assert.equal((await call("changePassword", a, input)).status, "refused");
	assert.equal(
		(
			await call("changePassword", a, {
				currentPassword: a.password,
				newPassword: a.password,
				confirmPassword: a.password,
			})
		).status,
		"refused",
	);
	faults = true;
	const changed = await call("changePassword", a, { ...input, currentPassword: a.password });
	faults = false;
	assert.equal(changed.status, "succeeded");
	assert.deepEqual(changed.reporting, { status: "pending_investigation" });
	const sessions = await admin.select().from(t.auth_session).where(eq(t.auth_session.user_id, a.user));
	assert.equal(sessions.length, 1);
	assert.equal(
		sessions.some((s) => s.id === other.session),
		false,
	);
	assert.equal(
		sessions.some((s) => s.id === a.session),
		false,
	);
	const fresh = await login({ ...a, password: input.newPassword });
	assert.equal(ok(await section(fresh, { section: "account" })).email, a.email);
	const [count] = await admin
		.select({ n: sql`count(*)::int` })
		.from(t.audit_event)
		.where(and(eq(t.audit_event.tenant_id, a.id), eq(t.audit_event.action, "identity.credential_changed")));
	assert.equal(count.n, 0);
});

async function organization() {
	const id = randomUUID(),
		a = await actor(),
		o = { kind: "organization", id, organizationKind: "sending_network" };
	await admin
		.insert(t.organization)
		.values({ id, kind: "sending_network", name: "Network", timezone: "UTC", material_revision: "1" });
	await admin.insert(t.seat).values({ account_id: a.id, organization_id: id, role: "owner", accepted_at: new Date() });
	return { o, a };
}
test("AC:ORG55-001 AC:ORG55-007 AC:TARGET-IDN-026 organization profile and exact-pair sharing use the shared producers with one revision/audit/intent set", async () => {
	const f = await plant(),
		g = await plant(),
		org = await organization();
	const [relationship] = await admin
		.insert(t.affiliation)
		.values({
			plant_id: f.p.id,
			organization_id: org.o.id,
			accepted_at: new Date(),
			share_people: true,
			share_meetings: false,
			share_tasks: false,
			share_ministry_teams: true,
			share_wiki: false,
			share_activity: true,
			shared_findings: true,
			consent_revision: "1",
			revision: "1",
		})
		.returning();
	const input = {
		section: "affiliations",
		plant: f.p,
		organization: org.o,
		relationshipId: relationship.id,
		expectedConsentRevision: "1",
		patch: { teams: false, activityPush: false },
	};
	const saved = ok(await call("saveSection", f.a, command(input), f.p));
	assert.equal(saved.current.values.consentRevision, "2");
	assert.equal(saved.current.values.choices.ministry_teams, false);
	assert.equal(saved.current.values.choices.activity, false);
	assert.equal(saved.current.values.choices.people, true);
	assert.equal(saved.current.values.choices.shared_findings, true);

	denied(await call("saveSection", g.a, command(input), g.p));
	denied(await call("saveSection", org.a, command({ ...input, expectedConsentRevision: "2" }, "2"), org.o));
	denied(await call("saveSection", f.a, command(input, "2"), f.p), "conflict");
	const next = { ...input, expectedConsentRevision: "2", patch: { people: false } };
	faults = true;
	await assert.rejects(call("saveSection", f.a, command(next, "2"), f.p), /notice_fault/);
	faults = false;
	assert.equal(
		(await admin.select().from(t.affiliation).where(eq(t.affiliation.id, relationship.id)))[0].consent_revision,
		"2",
	);
	const profile = ok(
		await call(
			"saveSection",
			org.a,
			command({
				section: "organization",
				organization: org.o,
				patch: { name: " New Network ", contactEmail: "contact@example.test" },
			}),
			org.o,
		),
	);
	assert.equal(profile.current.values.profile.name, "New Network");
	assert.equal(profile.current.values.revision, "2");
	const noop = ok(
		await call(
			"saveSection",
			org.a,
			command({ section: "organization", organization: org.o, patch: { name: "New Network" } }, "2"),
			org.o,
		),
	);

	assert.equal(noop.current.values.revision, "2");
	const wrong = { ...org.o, organizationKind: "sending_church" };
	denied(await section(org.a, { section: "organization", organization: wrong }));
});

test("INV-lifecycle: an account root read serializes first-witness deletion even before any witness exists", async () => {
	const { liveOwner } = await import("../../../packages/domain/src/access/session.ts");
	const a = await actor();
	let entered, release;
	const ready = new Promise((r) => (entered = r)),
		gate = new Promise((r) => (release = r));
	const reading = db.transaction(async (tx) => {
		assert.equal(await liveOwner(tx, { kind: "account", id: a.id }), true);
		entered();
		await gate;
	});
	await ready;
	let pid,
		started,
		done = false;
	const running = new Promise((r) => (started = r));
	const deletion = db.transaction(async (tx) => {
		pid = (await tx.execute(sql`SELECT pg_backend_pid() AS id`)).rows[0].id;
		started();
		const result = await api.requestAccountDeletion(tx, ctx(a), command({ confirmed: true }));
		done = true;
		return result;
	});
	await running;
	try {
		let blocked = false;
		for (let i = 0; i < 60 && !done; i++) {
			const [state] = (await admin.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`)).rows;
			if (state?.wait_event_type === "Lock") {
				blocked = true;
				break;
			}
		}
		assert.equal(blocked, true);
		assert.equal(done, false);
	} finally {
		release();
	}
	await reading;
	assert.equal(ok(await deletion).status, "pending_deletion");
});

test("INV-preference-migration: grouped existing choices become independent exact pairs without resetting values or revisions", async () => {
	const { readFile } = await import("node:fs/promises");
	const migration = await readFile(
		new URL("../../../packages/db/migrations/0010_settings.sql", import.meta.url),
		"utf8",
	);
	const a = await actor();
	const block = migration
		.split("-- BEGIN NOTIFICATION PREFERENCE DATA")[1]
		.split("-- END NOTIFICATION PREFERENCE DATA")[0];
	await admin.transaction(async (tx) => {
		await tx.execute(
			sql`ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_ck_1,DROP CONSTRAINT notification_preference_ck_6`,
		);
		await tx.execute(
			sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision,revision) VALUES(${a.id},'task','email',false,7,9),(${a.id},'task','in_app',true,7,9),(${a.id},'meeting','in_app',false,7,9)`,
		);
		await tx.execute(sql.raw(block));
		for (const match of migration.matchAll(/ALTER TABLE "notification_preference" ADD CONSTRAINT[^;]+;/g))
			await tx.execute(sql.raw(match[0]));
	});
	const rows = await admin
		.select({
			category: t.notification_preference.category,
			channel: t.notification_preference.channel,
			enabled: t.notification_preference.enabled,
			revision: t.notification_preference.revision,
			unsubscribe: t.notification_preference.unsubscribe_revision,
		})
		.from(t.notification_preference)
		.where(eq(t.notification_preference.account_id, a.id))
		.orderBy(t.notification_preference.category, t.notification_preference.channel);
	assert.deepEqual(rows, [
		{ category: "meeting_announcement", channel: "in_app", enabled: false, revision: "9", unsubscribe: "7" },
		{ category: "meeting_reminder", channel: "in_app", enabled: false, revision: "9", unsubscribe: "7" },
		{ category: "task_due", channel: "email", enabled: false, revision: "9", unsubscribe: "7" },
		{ category: "task_due", channel: "in_app", enabled: true, revision: "9", unsubscribe: "7" },
		{ category: "task_overdue", channel: "email", enabled: false, revision: "9", unsubscribe: "7" },
		{ category: "task_overdue", channel: "in_app", enabled: true, revision: "9", unsubscribe: "7" },
	]);
});

test("AC:B03-017 AC:TARGET-TSK-018 church timezone preserves date-only tasks and one-time appointments while binding preview to future sources", async () => {
	const f = await plant(),
		task = randomUUID(),
		meeting = randomUUID();
	await admin.insert(t.task).values({
		id: task,
		plant_id: f.p.id,
		title: "Future task",
		category: "general",
		priority: "medium",
		status: "not_started",
		created_at: new Date(),
		due_kind: "date_only",
		due_date: "2099-01-15",
	});
	await admin.insert(t.meeting).values({
		id: meeting,
		plant_id: f.p.id,
		type: "vision_meeting",
		title: "One-time appointment",
		local_date: "2099-01-15",
		local_time: "09:00:00",
		timezone: "America/Chicago",
		starts_at: new Date("2099-01-15T15:00:00Z"),
		resolver_version: "1",
		status: "planning",
		attendance_revision: "1",
	});
	const preview = ok(await call("previewPlantTimezone", f.a, { plant: f.p, timeZone: "America/New_York" }, f.p));
	assert.deepEqual(preview.preservedTaskDates, [{ id: task, date: "2099-01-15" }]);
	assert.deepEqual(preview.reminders, [
		{ id: task, before: "2099-01-15T15:00:00.000Z", after: "2099-01-15T14:00:00.000Z" },
		{ id: task, before: "2099-01-16T15:00:00.000Z", after: "2099-01-16T14:00:00.000Z" },
	]);
	assert.deepEqual(preview.meetings, []);
	await admin.update(t.task).set({ revision: "2" }).where(eq(t.task.id, task));
	denied(
		await call(
			"setPlantTimezone",
			f.a,
			command({ plant: f.p, timeZone: "America/New_York", previewId: preview.previewId }),
			f.p,
		),
		"stale_preview",
	);
	const fresh = ok(await call("previewPlantTimezone", f.a, { plant: f.p, timeZone: "America/New_York" }, f.p));
	ok(
		await call(
			"setPlantTimezone",
			f.a,
			command({ plant: f.p, timeZone: "America/New_York", previewId: fresh.previewId }),
			f.p,
		),
	);
	const [after] = await admin.select().from(t.task).where(eq(t.task.id, task));
	assert.equal(after.due_date, "2099-01-15");
	const [appointment] = await admin.select().from(t.meeting).where(eq(t.meeting.id, meeting));
	assert.equal(appointment.starts_at.toISOString(), "2099-01-15T15:00:00.000Z");
	assert.equal(appointment.timezone, "America/Chicago");
});

test("AC:TARGET-TSK-018 frozen schedule previews disclose fold/gap policy and ignore the host timezone", async () => {
	const { frozenClock, instant } = await import("../../../packages/contracts/src/common/index.ts");
	for (const [asOf, hour, warning, before, after] of [
		["2026-10-25T12:00:00.000Z", 1, "dst_fold_earlier", "2026-11-01T06:00:00.000Z", "2026-11-01T05:00:00.000Z"],
		["2027-03-07T12:00:00.000Z", 2, "dst_gap_shifted", "2027-03-14T08:00:00.000Z", "2027-03-14T07:00:00.000Z"],
	]) {
		const f = await plant();
		ok(await call("setDigestSchedule", f.a, command({ plant: f.p, schedule: { cadence: "daily", hour } }), f.p));
		const frozen = createSettingsProducer({ ...producerDeps, clock: frozenClock(instant.parse(asOf)) });
		const preview = ok(
			await db.transaction((tx) =>
				frozen.previewPlantTimezone(tx, ctx(f.a, f.p), { plant: f.p, timeZone: "America/New_York" }),
			),
		);
		assert.equal(preview.asOf, asOf);
		assert.deepEqual(preview.warnings, [warning, "more_results"]);
		assert.deepEqual(
			preview.digests.find((d) => d.before === before),
			{ id: f.p.id, before, after },
		);
		const saved = ok(
			await db.transaction((tx) =>
				frozen.setPlantTimezone(
					tx,
					ctx(f.a, f.p),
					command({ plant: f.p, timeZone: "America/New_York", previewId: preview.previewId }, "2"),
				),
			),
		);
		assert.equal(saved.status, "changed");
	}
});

test("AC:WP010-IDN-012 exact task preference reaches enqueue and dispatch; church digest OFF stops owed delivery", async () => {
	const { createNotificationService } = await import("../../../apps/web/src/server/jobs/notifications.ts");
	const { createDigestService } = await import("../../../apps/web/src/server/jobs/digest.ts");
	const { claimDue } = await import("../../../apps/web/src/server/jobs/queue.ts");
	const f = await plant(),
		task = randomUUID();
	await admin.insert(t.task).values({
		id: task,
		plant_id: f.p.id,
		title: "Dispatch task",
		category: "general",
		priority: "medium",
		status: "not_started",
		assignee_id: f.a.id,
		created_at: new Date(),
		due_kind: "date_only",
		due_date: "2099-01-15",
	});
	const sent = [];
	const sender = createMailService({
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "test@example.test",
		authorize: async (_tx, mail) => new Set(mail.map((m) => m.id)),
		transport: {
			send: async (input) => {
				sent.push(input);
				return { kind: "accepted", id: randomUUID() };
			},
			lookup: async () => ({ kind: "unknown" }),
		},
	});
	const notifications = createNotificationService({
		mail: sender,
		eligible: async (tx, inputs) => {
			const data = inputs.map((v, n) => ({ n, recipient: v.recipient, owner: v.owner.id }));
			const r = await tx.execute(
				sql`SELECT i.n FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) i(n int,recipient uuid,owner uuid) JOIN seat s ON s.account_id=i.recipient AND s.plant_id=i.owner AND s.ended_at IS NULL`,
			);
			return inputs.map((v, n) => (r.rows.some((r) => r.n === n) ? { address: "test@example.test" } : null));
		},
	});
	const initialPreferences = ok(await section(f.a, { section: "notifications" }));
	const notice = (category, occurrence) => ({
		owner: f.p,
		recipient: f.a.id,
		source: { kind: "task", id: task, revision: "1" },
		category,
		occurrence,
		title: "Task update",
		text: "Task update",
		operation: null,
		eligibleAt: new Date().toISOString(),
	});
	ok(
		await call(
			"saveSection",
			f.a,
			command(
				{
					section: "notifications",
					patch: { kind: "channel", choice: { category: "task_due", channel: "email", enabled: false } },
				},
				initialPreferences.revision,
			),
		),
	);
	const due = await db.transaction((tx) => notifications.enqueue(tx, notice("task_due", "due")));
	assert.equal(due.mail, null);
	const overdue = await db.transaction((tx) => notifications.enqueue(tx, notice("task_overdue", "overdue")));
	assert.match(overdue.mail, /^[a-f0-9-]{36}$/);
	ok(
		await call(
			"saveSection",
			f.a,
			command(
				{
					section: "notifications",
					patch: { kind: "channel", choice: { category: "task_overdue", channel: "email", enabled: false } },
				},
				String(BigInt(initialPreferences.revision) + 1n),
			),
		),
	);
	const [outbox] = await admin.select().from(t.mail).where(eq(t.mail.id, overdue.mail));
	await admin
		.update(t.job)
		.set({ eligible_at: new Date(Date.now() - 1000) })
		.where(eq(t.job.id, outbox.job_id));
	const claims = await claimDue(db, ["mail"], 100);
	const claim = claims.find((c) => c.id === outbox.job_id);
	assert.equal(claim.kind, "mail");
	assert.deepEqual(await sender.dispatch(claim), { kind: "not_dispatched" });
	assert.deepEqual(sent, []);
	const profile = ok(await section(f.a, { section: "plant", plant: f.p }));
	ok(
		await call("setDigestSchedule", f.a, command({ plant: f.p, schedule: { cadence: "off" } }, profile.revision), f.p),
	);
	const digest = createDigestService({
		origin,
		nativePath: () => "/settings",
		mail: sender,
		eligible: async () => ({ address: "test@example.test", cadence: "weekly" }),
		load: async () => {
			throw Error("OFF digest must not load church content");
		},
	});
	const result = await db.transaction((tx) => digest.generateOwed(tx, f.p, f.a.id, "2099-01-18T23:00:00Z"));
	assert.deepEqual(result, { kind: "disabled" });
});

test("AC:TARGET-IDN-007 AC:TARGET-IDN-008 native credential budgets use own login rather than target and refuse exhausted password failures", async () => {
	const a = await credentialActor();
	for (let i = 0; i < 3; i++) ok(await call("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }));
	denied(await call("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }), "temporary");
	const b = await credentialActor();
	const input = {
		currentPassword: "Incorrect secret",
		newPassword: "Budget replacement 2468!",
		confirmPassword: "Budget replacement 2468!",
	};
	for (let i = 0; i < 5; i++) assert.equal((await call("changePassword", b, input)).status, "refused");
	assert.equal((await call("changePassword", b, { ...input, currentPassword: b.password })).status, "refused");
	const old = await login(b);
	assert.equal(ok(await section(old, { section: "account" })).email, b.email);
});

test("AC:WP005-KNOW-069 AC:WP005-KNOW-072 AC:WP010-KNOW-069 AC:WP010-KNOW-072 AC:TARGET-IDN-032 account purge removes personal bodies while preserving church documents", async () => {
	const { deleteUnreferencedObject } = await import("../../../packages/db/src/schema/storage.ts");
	const f = await plant(),
		subject = { kind: "account", id: f.a.id };
	const file = randomUUID(),
		key = `private/${f.a.id}/${randomUUID()}`,
		bytes = Buffer.from("x"),
		objects = new Map([[key, bytes]]);
	await admin.insert(t.file_object).values({
		id: file,
		tenant_id: f.a.id,
		purpose: "avatar",
		opaque_key: key,
		media_type: "image/png",
		max_bytes: "1",
		byte_count: "1",
		sha256: createHash("sha256").update(bytes).digest("hex"),
		state: "ready",
		upload_key: randomUUID(),
		claim_generation: "0",
	});
	await admin.update(t.account).set({ avatar_object_id: file }).where(eq(t.account.id, f.a.id));
	const docs = [];
	for (const tenant of [f.a.id, f.p.id]) {
		const id = randomUUID(),
			version = randomUUID(),
			body = tenant === f.a.id ? "Personal document body" : "Church-owned document body";
		await admin.insert(t.document).values({ id, tenant_id: tenant, kind: "native", title: "Synthetic document" });
		await admin.insert(t.document_revision).values({
			id: version,
			tenant_id: tenant,
			document_id: id,
			version_number: 1,
			body,
			content_hash: createHash("sha256").update(body).digest("hex"),
			recorded_at: new Date(),
		});
		await admin.update(t.document).set({ current_revision_id: version }).where(eq(t.document.id, id));
		docs.push({ id, version });
	}
	const pending = await overdue(f.a, subject),
		input = { subject, requestId: pending.requestId, revision: pending.revision };
	let timeout = true;
	const storage = {
		bucket: "synthetic-only",
		client: {
			send: async (command) => {
				assert.equal(command.constructor.name, "DeleteObjectCommand");
				assert.equal(command.input.Key, key);
				if (timeout) throw Error("provider_timeout");
				objects.delete(key);
				return {};
			},
		},
	};
	const purge = createLifecycleCleanup(cleanupDb, {
		authorize: async () => true,
		removeOwnedResources: async () => {
			const removed = await deleteUnreferencedObject(
				cleanupDb,
				storage,
				async (tx, identity) => {
					const [w] = await tx
						.select()
						.from(t.lifecycle_witness)
						.where(
							and(
								eq(t.lifecycle_witness.opaque_subject_id, subject.id),
								eq(t.lifecycle_witness.request_id, pending.requestId),
								eq(t.lifecycle_witness.state, "purging"),
							),
						);
					return w && identity.tenant_id === subject.id ? { kind: "system", cause: "object_cleanup" } : null;
				},
				file,
			);
			return removed.status === "inaccessible";
		},
	});
	assert.deepEqual(await purge(input), { status: "purging" });
	assert.equal(objects.size, 1);
	const [w] = await admin
		.select()
		.from(t.lifecycle_witness)
		.where(eq(t.lifecycle_witness.opaque_subject_id, subject.id));
	assert.equal(w.live_purged_at, null);
	assert.equal(
		(await admin.select().from(t.document_revision).where(eq(t.document_revision.id, docs[0].version))).length,
		0,
	);
	const [shared] = await admin.select().from(t.document_revision).where(eq(t.document_revision.id, docs[1].version));
	assert.equal(shared.body, "Church-owned document body");
	timeout = false;
	const done = await purge(input);
	assert.equal(done.status, "purged");
	assert.equal(objects.size, 0);
	assert.equal((await admin.select().from(t.file_object).where(eq(t.file_object.id, file)))[0].state, "purged");
});

test("INV-settings-preview: expiry is checked independently from actor, subject, revision, source and zone matching", async () => {
	const f = await plant();
	const plantPreview = ok(await call("previewPlantTimezone", f.a, { plant: f.p, timeZone: "America/New_York" }, f.p));
	await admin
		.update(t.settings_preview)
		.set({ expires_at: new Date(Date.now() - 1000) })
		.where(eq(t.settings_preview.id, plantPreview.previewId));
	denied(
		await call(
			"setPlantTimezone",
			f.a,
			command({ plant: f.p, timeZone: "America/New_York", previewId: plantPreview.previewId }),
			f.p,
		),
		"stale_preview",
	);
	const personal = ok(await call("previewPersonalTimezone", f.a, { timeZone: "America/New_York" }));
	await admin
		.update(t.settings_preview)
		.set({ expires_at: new Date(Date.now() - 1000) })
		.where(eq(t.settings_preview.id, personal.previewId));
	denied(
		await call(
			"setPersonalTimezone",
			f.a,
			command(
				{ timeZone: "America/New_York", previewId: personal.previewId, confirmed: true },
				personal.expectedRevision,
			),
		),
		"stale_preview",
	);
	assert.deepEqual(ok(await section(f.a, { section: "account" })).personalTimezone, {
		status: "unconfirmed",
	});
	const fresh = ok(await call("previewPersonalTimezone", f.a, { timeZone: "UTC" }));
	const saved = ok(
		await call(
			"setPersonalTimezone",
			f.a,
			command({ timeZone: "UTC", previewId: fresh.previewId, confirmed: true }, fresh.expectedRevision),
		),
	);
	assert.deepEqual(saved.preference, { status: "confirmed", timeZone: "UTC", revision: "2" });
});

let recording = false;
const statements = [];
/** One section read the way the settings mount runs it, with every statement the database receives. */
async function mountRead(a, request) {
	const viewer = await viewerOf(a);
	statements.length = 0;
	recording = true;
	try {
		const value = await api.getSection(db, viewer, request);
		return { value: ok(value), statements: [...statements] };
	} finally {
		recording = false;
	}
}
test("INV-performance: each settings section reads in one statement on the pool, without a transaction", async () => {
	const instrumented = new WeakSet();
	db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args) {
			if (recording) statements.push(typeof args[0] === "string" ? args[0] : args[0].text);
			return Reflect.apply(query, this, args);
		};
	});
	const f = await plant(),
		org = await organization();
	const [team] = await admin
		.insert(t.team)
		.values({ plant_id: f.p.id, name: "Worship", state: "active", sort_order: 0 })
		.returning();
	await admin.insert(t.affiliation).values({
		plant_id: f.p.id,
		organization_id: org.o.id,
		accepted_at: new Date(),
		share_people: true,
		share_meetings: false,
		share_tasks: false,
		share_ministry_teams: false,
		share_wiki: false,
		share_activity: false,
		shared_findings: false,
		consent_revision: "1",
		revision: "1",
	});
	const sharing = { plant: f.p, organization: org.o };
	// The notifications row adds one suppression lookup in the web mount; this test's suppression list reads nothing.
	const reads = [
		[f.a, { section: "account" }, (v) => [v.name, v.email], ["Synthetic", f.a.user + "@example.test"]],
		[f.a, { section: "notifications" }, (v) => [v.values.planterCadence, v.values.oversightCadence], ["weekly", null]],
		[
			f.a,
			{ section: "plant", plant: f.p },
			(v) => [v.values.profile.name, v.values.timeZone],
			["Harvest Point", "America/Chicago"],
		],
		[f.a, { section: "teams", plant: f.p, teamId: team.id }, (v) => [v.name, v.revision], ["Worship", "1"]],
		[org.a, { section: "organization", organization: org.o }, (v) => [v.values.profile.name], ["Network"]],
		[
			f.a,
			{ section: "affiliations", ...sharing },
			(v) => [v.values.view, v.values.choices.people],
			["plant_administration", true],
		],
		[
			org.a,
			{ section: "affiliations", ...sharing },
			(v) => [v.values.view, v.values.availability.people],
			["organization", true],
		],
	];
	for (const [a, request, observe, expected] of reads) {
		const read = await mountRead(a, request);
		assert.deepEqual(observe(read.value), expected, request.section);
		assert.equal(read.statements.length, 1, `${request.section}: ${read.statements.join("\n")}`);
	}
});
