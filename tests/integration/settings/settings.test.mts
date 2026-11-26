import "../platform/setup.mts";
import { openedDeletion } from "../../support/deletion-cookie.mts";
import { sendOnboardingRelationships } from "../../../packages/domain/src/jobs/notifications.ts";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { testDatabase, type Database } from "../../support/test-database.mts";
import { statementText } from "../identity/invitations-support.mts";
import { accountId, tenantId, sessionId, type Owner } from "../../../packages/contracts/src/common/index.ts";
import type { SettingsContext, SettingsReply } from "../../../packages/contracts/src/settings/server.ts";
import type { SectionResult } from "../../../packages/contracts/src/settings/index.ts";
import { S3Client, type PrivateStorage } from "../../../packages/db/src/schema/storage.ts";
import { z } from "../../../packages/contracts/node_modules/zod/index.js";
import { sql, eq, and } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import {
	createLifecycleCleanup,
	createAccountCredentials,
	uploadAvatar,
	readAvatar,
	readLeadPlanter,
	withSettingsWrite,
	type CredentialConfig,
	type DeletionSubject,
	type SettingsEffects,
} from "../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../packages/domain/src/settings/deletion.ts";
import { settingsApi } from "./settings-api.mts";
import {
	createOrganizationAdapter,
	type OrganizationEffects,
} from "../../../packages/domain/src/organizations/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { enqueueJob, queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { createMailService, suppressionOf, type MailPayload } from "../../../packages/domain/src/jobs/mail.ts";
import { identityAuth } from "../../../packages/domain/src/identity/auth.ts";
import { readViewer, RequestActor, type WriteTx } from "../../../packages/domain/src/access/session.ts";
import { createSeatService } from "../../../packages/domain/src/identity/seats.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { createPrivateCare } from "../../../packages/domain/src/intelligence/index.ts";
import { PeopleReadContext, peopleReader, readPersonPhotos } from "../../../packages/domain/src/people/index.ts";
import { listPeopleRequest } from "../../../packages/contracts/src/people/index.ts";
import { insertTasks } from "../task-assignees.mts";
import { ok, refusedWith, waitingOnLock } from "../../support/fixture.mts";
import { recorded } from "../../support/recorded.mts";
import { frozenClock, instant, type Instant } from "../../../packages/contracts/src/common/index.ts";
import { overdueAt } from "../../../packages/contracts/src/tasks/index.ts";
import { taskReader } from "../../../packages/domain/src/tasks/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
const database = await testDatabase({
	prefix: "wp010",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"], auth: ["auth"] },
	max: 8,
});
const { admin } = database;
const { runtime: db, cleanup: cleanupDb, auth: authDb } = database.pools;
type Credentials = ReturnType<typeof createAccountCredentials>;
type Deps = Parameters<typeof settingsApi<Credentials>>[0];
type Api = ReturnType<typeof settingsApi<Credentials>>;
type Value<F> = F extends (...args: never[]) => Promise<SettingsReply<infer V>> ? V : never;
type Operation<V> = (tx: WriteTx, context: SettingsContext, raw: unknown) => Promise<SettingsReply<V>>;
type WriteName = {
	[K in keyof Api]: Api[K] extends Operation<Value<Api[K]>> ? K : never;
}[keyof Api];
type Writes = { [K in WriteName]: Operation<Value<Api[K]>> };
type CredentialName = "requestEmailChange" | "confirmEmailChange" | "changePassword";
type SectionName = SectionResult["section"];
type SectionOf<K extends SectionName> = Extract<SectionResult, { section: K }>;
type SavedSection = Value<Api["saveSection"]>["current"];
type SavedOf<K extends SectionName> = Extract<SavedSection, { section: K }>;
type Viewer = NonNullable<Awaited<ReturnType<typeof viewerOf>>>;
type Plant = Extract<Owner, { kind: "plant" }>;
type Session = { id: string; session: string };
type Account = Awaited<ReturnType<typeof actor>>;
type Login = { id: Account["id"]; user: string; email: string; password: string };
let api: Api,
	onboarding: ReturnType<typeof createOnboardingProducer>,
	mail: ReturnType<typeof createMailService>,
	producerDeps: Deps;
let faults = false;
const origin = "http://settings.localhost";
const ingress = new Map<string, Request>();
const trustedIps = new Map<string, string>();
const deliveries: Parameters<CredentialConfig["deliverVerification"]>[1][] = [];
const diagnostics: Parameters<CredentialConfig["diagnostic"]>[0][] = [];
const issued: string[] = [];
const notices: { accountId: string; address: string; action: string }[] = [];
const secret = randomBytes(40).toString("hex");
const denied = refusedWith({ details: {} });
const command = <const Input extends object>(
	input: Input,
	expectedRevision = "1",
	requestKey: string = randomUUID(),
) => ({
	input,
	expectedRevision,
	requestKey,
});
const ctx = (a: Session, selected: Owner = { kind: "account", id: accountId.parse(a.id) }): SettingsContext => ({
	session: sessionId.parse(a.session),
	selected,
});
const call = <K extends WriteName>(name: K, a: Session, v: object, selected?: Owner) => {
	const writes: Writes = api;
	return gatedTransaction(db, (tx) => writes[name](tx, ctx(a, selected), v));
};
const credential = <K extends CredentialName>(name: K, a: Session, v: Parameters<Credentials[K]>[1]) => {
	const operations: {
		[N in CredentialName]: (
			context: SettingsContext,
			input: Parameters<Credentials[N]>[1],
		) => ReturnType<Credentials[N]>;
	} = producerDeps.credentials;
	return operations[name](ctx(a), v);
};
const isSection = <T extends { section: SectionName }, K extends SectionName>(
	value: T,
	name: K,
): value is Extract<T, { section: K }> => value.section === name;
async function save<K extends SectionName>(
	a: Session,
	v: { input: { section: K } },
	selected?: Owner,
): Promise<SettingsReply<{ current: SavedOf<K> }>> {
	const reply = await call("saveSection", a, v, selected);
	if (reply.status !== "ok") return reply;
	const { current } = reply.value;
	assert.ok(isSection<SavedSection, K>(current, v.input.section));
	return { status: "ok", value: { current } };
}
async function viewerOf(a: { session: string }) {
	const v = await readViewer(db, sessionId.parse(a.session));
	if (!v?.authority) return null;
	const user = await admin.execute<{ name: string; email: string; email_verified: boolean }>(
		sql`SELECT u.name, u.email, u.email_verified FROM auth_session s JOIN auth_user u ON u.id=s.user_id WHERE s.id=${a.session}`,
	);
	const { name, email, email_verified } = user.rows[0]!;
	return { authority: v.authority, principal: { display_name: name, email, verified: email_verified } };
}
async function seen(a: { session: string }): Promise<Viewer> {
	const viewer = await viewerOf(a);
	assert.ok(viewer);
	return viewer;
}
async function readSection<K extends SectionName>(
	viewer: Viewer,
	request: { section: K } & Record<string, unknown>,
): Promise<SettingsReply<SectionOf<K>>> {
	const reply = await api.getSection(db, viewer, request);
	if (reply.status !== "ok") return reply;
	assert.ok(isSection<SectionResult, K>(reply.value, request.section));
	return { status: "ok", value: reply.value };
}
const section = async <K extends SectionName>(
	a: { session: string },
	request: { section: K } & Record<string, unknown>,
) => readSection(await seen(a), request);
async function actor() {
	const a = { id: accountId.parse(randomUUID()), user: randomUUID(), session: sessionId.parse(randomUUID()) };
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
async function plant(a?: Pick<Account, "id" | "session"> & { user: string }) {
	a ??= await actor();
	const [row] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
	const result = ok(
		await gatedTransaction(db, (tx) =>
			onboarding.createPlant(
				tx,
				{ session: a.session, selected: { kind: "account", id: a.id } },
				command({ name: "Harvest Point", confirmed: true }, row!.revision),
			),
		),
	);
	return { a, p: result.plant, result };
}
async function seated(a: Account) {
	const { p } = await plant();
	await admin
		.insert(t.seat)
		.values({ plant_id: p.id, account_id: a.id, role: "member", accepted_at: new Date(), revision: "1" });
	return a;
}
async function seat(p: Plant, role: "admin" | "member" = "admin") {
	const a = await actor();
	await admin.insert(t.seat).values({ plant_id: p.id, account_id: a.id, role, accepted_at: new Date(), revision: "1" });
	return a;
}
const effect: SettingsEffects["replan"] = async (tx, input) => {
	if (faults) throw Error("intent_fault");
	return enqueueJob(tx, {
		tenant: input.owner.id,
		kind: "digest",
		subject: input.owner.id,
		key: `settings/${input.kind}/${input.operationId}/${input.revision}`,
		revision: input.revision,
		eligibleAt: new Date().toISOString(),
	});
};
before(async () => {
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
	const organizationEffects: OrganizationEffects = {
		invitation: async () => {},
		invalidate: (_tx, i) => {
			if (faults) throw Error("grant_fault");
			return sql`UPDATE job SET state='superseded' WHERE subject_record_id=${sql.param(i.sourceId)} AND kind='digest' AND state='ready'`;
		},
	};
	const organizations = createOrganizationAdapter(organizationEffects, {
		candidates: () => sql`SELECT NULL::uuid WHERE false`,
	});
	const credentials = createAccountCredentials({
		db,
		authDb,
		admissionDb: admin,
		origin,
		secret,
		request: async (c) => {
			const request = ingress.get(c.session);
			if (!request) throw Error("missing_native_request");
			const v = await viewerOf({ session: c.session });
			const viewer = v && {
				accountId: v.authority.actor.accountId,
				email: v.principal.email,
				verified: v.principal.verified,
			};
			return { request, trustedIp: trustedIps.get(c.session) ?? "198.51.100.21", viewer };
		},
		responseCookies: async (_c, cookies) => void issued.push(...cookies),
		diagnostic: (value) => diagnostics.push(value),
		deliverVerification: async (_tx, i) => {
			deliveries.push(i);
		},
		securityNotice: async (tx, i, writes) => {
			if (faults) throw Error("security_intent_fault");
			notices.push({ accountId: i.accountId, address: i.address, action: i.action });
			return await mail.append(
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
			);
		},
	});
	producerDeps = {
		organizations,
		organizationEffects,
		effects: {
			replan: effect,
		},
		suppression: async () => "unavailable",
		avatarCleanup: {
			queue: (tx, i) => {
				if (faults) throw Error("cleanup_intent_fault");
				return queueJobs(tx, [
					{
						tenant: i.accountId,
						kind: "object_cleanup",
						subject: i.fileId,
						key: "avatar/" + i.fileId,
						revision: "1",
						eligibleAt: i.eligibleAt,
					},
				]);
			},
		},
		deletion: {
			queue: (tx, i) => {
				if (faults) throw Error("purge_intent_fault");
				return queueJobs(tx, [
					{
						tenant: i.subject.id,
						kind: "lifecycle_purge",
						subject: i.witnessId,
						key: "purge/" + i.requestId,
						revision: i.revision,
						eligibleAt: i.eligibleAt,
					},
				]);
			},
			workspaceNotice: async () => {},
		},
		credentials,
	};
	api = settingsApi(producerDeps);
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
after(database.close);

test("AC:TARGET-IDN-010 AC:TARGET-IDN-011 AC:ROLE43-002 AC:ROLE43-005 scoped settings preserve nullable locality and reject stale or foreign saves", async () => {
	const f = await plant(),
		other = await plant(),
		adminActor = await seat(f.p),
		member = await seat(f.p, "member");
	denied(await save(f.a, command({ section: "account", name: "Wrong context" }), f.p));
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
	const saved = ok(await save(adminActor, v, f.p));
	assert.equal(saved.current.values.profile.name, "New Name");
	assert.equal(saved.current.values.profile.street, "123 Private Street");
	assert.equal(saved.current.values.profile.city, null);
	assert.equal(saved.current.revision, "2");
	denied(await save(member, command(v.input, "2"), f.p));
	denied(await save(other.a, command(v.input, "2"), other.p));
	denied(await save(f.a, command(v.input), f.p), "conflict");
	const replay = ok(await save(adminActor, v, f.p));
	assert.deepEqual(replay, saved);
	assert.equal(replay.current.revision, "2");
	const noop = ok(await save(f.a, command(v.input, "2"), f.p));

	assert.equal(noop.current.revision, "2");
	faults = true;
	await assert.rejects(
		save(f.a, command({ ...v.input, change: { kind: "digest", value: { cadence: "off" } } }, "2"), f.p),
		/intent_fault/,
	);
	faults = false;
	assert.equal(ok(await section(f.a, { section: "plant", plant: f.p })).revision, "2");
	const self = ok(await section(member, { section: "account" }));
	assert.deepEqual(self.personalTimezone, { status: "unconfirmed" });
	const name = ok(await save(member, command({ section: "account", name: " Member Updated " })));
	assert.equal(name.current.name, "Member Updated");
});

test("AC:TARGET-IDN-012 account preferences keep exact category/channel choices independent and scoped", async () => {
	const a = await seated(await actor());
	const current = ok(await section(a, { section: "notifications" }));
	assert.equal(current.values.choices.length, 20);
	assert.deepEqual(
		current.values.choices.filter((c) => c.category === "scheduled_email_unsubscribe"),
		[{ category: "scheduled_email_unsubscribe", channel: "in_app", enabled: true }],
	);
	assert.equal(current.values.oversightCadence, null);
	assert.equal(current.values.suppression, "unavailable");
	const saved = ok(
		await save(
			a,
			command({
				section: "notifications",
				patch: { kind: "channel", choice: { category: "task_due", channel: "email", enabled: false } },
			}),
		),
	);
	assert.equal(
		saved.current.values.choices.find((c) => c.category === "task_due" && c.channel === "email")!.enabled,
		false,
	);
	assert.equal(
		saved.current.values.choices.find((c) => c.category === "task_overdue" && c.channel === "email")!.enabled,
		true,
	);
	assert.equal(
		saved.current.values.choices.find((c) => c.category === "task_due" && c.channel === "in_app")!.enabled,
		true,
	);
	denied(
		await save(a, command({ section: "notifications", patch: { kind: "oversight_cadence", cadence: "daily" } }, "2")),
	);
	await plant();
	const cadence = ok(
		await save(a, command({ section: "notifications", patch: { kind: "planter_cadence", cadence: "daily" } }, "2")),
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
	const kept = ok(await section(a, { section: "account" })).personalTimezone;
	assert.ok(kept.status === "confirmed");
	assert.equal(kept.timeZone, "America/Chicago");
});

test("INV-private-calendar: ended seat keeps its personal preference but cannot invoke the author calendar", async () => {
	const f = await plant();
	const calls = { preview: 0, apply: 0 };
	const producer = settingsApi({
		...producerDeps,
		personalCalendar: {
			preview: async () => {
				calls.preview++;
			},
			apply: async () => {
				calls.apply++;
				return true;
			},
		},
	});
	const preview = (zone: string) =>
		gatedTransaction(db, (tx) => producer.previewPersonalTimezone(tx, ctx(f.a), { timeZone: zone }));
	const apply = (p: { newZone: string; previewId: string; expectedRevision: string }) =>
		gatedTransaction(db, (tx) =>
			producer.setPersonalTimezone(
				tx,
				ctx(f.a),
				command({ timeZone: p.newZone, previewId: p.previewId, confirmed: true }, p.expectedRevision),
			),
		);
	const first = ok(await preview("America/New_York"));
	assert.equal(ok(await apply(first)).preference.timeZone, "America/New_York");
	assert.deepEqual(calls, { preview: 1, apply: 1 });
	await admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.account_id, f.a.id));
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

async function restricted(a: { id: string }, subject: DeletionSubject, status: { requestId: string }) {
	return openedDeletion(
		gatedTransaction(admin, (tx) =>
			issueRestrictedDeletionSession(tx, { subject, requestId: status.requestId }, async () => ({
				accountId: a.id,
				provenAt: new Date(),
			})),
		),
		{ subject, requestId: status.requestId },
	);
}
test("AC:DEL58-001 AC:DEL58-002 AC:DEL58-003 AC:DEL58-005 AC:TARGET-IDN-026 AC:ROLE43-017 AC:DEL58-004 personal deletion suspends immediately and only fresh exact proof cancels", async () => {
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
	const request = { subject: { kind: "account" as const, id: member.id }, requestId: pending.requestId };
	const visible = ok(await gatedTransaction(db, (tx) => api.getAccountDeletionStatus(tx, proof, request)));
	assert.deepEqual(visible, pending);
	denied(
		await gatedTransaction(db, (tx) =>
			api.getAccountDeletionStatus(tx, proof, { ...request, subject: { kind: "account", id: f.a.id } }),
		),
		"proof_invalid",
	);
	const cancelled = ok(
		await gatedTransaction(db, (tx) => api.cancelAccountDeletion(tx, proof, command(request, pending.revision))),
	);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.requestId, pending.requestId);
	assert.equal(cancelled.cancelUntil, pending.cancelUntil);
	assert.equal(await viewerOf(member), null);
	assert.equal((await admin.select().from(t.auth_session).where(eq(t.auth_session.id, member.session))).length, 0);
	const repeat = ok(
		await gatedTransaction(db, (tx) => api.cancelAccountDeletion(tx, proof, command(request, pending.revision))),
	);
	assert.deepEqual(repeat, cancelled);
	const user = ok(await section(f.a, { section: "plant", plant: f.p }));
	assert.equal(user.values.profile.name, "Harvest Point");
});

test("INV-lifecycle: first-witness deletion waits for an in-flight edit; later reads and writes deny", async () => {
	const a = await actor();
	const { promise: ready, resolve: entered } = Promise.withResolvers<void>(),
		{ promise: gate, resolve: release } = Promise.withResolvers<void>();
	const edit = gatedTransaction(db, async (tx) => {
		const r = ok(await api.saveSection(tx, ctx(a), command({ section: "account", name: "Serialized Name" })));
		entered();
		await gate;
		return r;
	});
	await ready;
	const deletion = call("requestAccountDeletion", a, command({ confirmed: true }, "2"));
	release();
	const [saved, pending] = await Promise.all([edit, deletion]);
	assert.ok(saved.current.section === "account");
	assert.equal(saved.current.name, "Serialized Name");
	assert.equal(ok(pending).status, "pending_deletion");
	denied(await save(a, command({ section: "account", name: "Too Late" }, "2")));
});

test("INV-settings: concurrent account edits serialize before taking session share locks", async () => {
	const a = await actor();
	const { promise: ready, resolve: entered } = Promise.withResolvers<void>(),
		{ promise: gate, resolve: release } = Promise.withResolvers<void>();
	const blocking = admin.transaction(async (tx) => {
		await tx.select().from(t.auth_user).where(eq(t.auth_user.id, a.user)).for("update");
		entered();
		await gate;
	});
	await ready;
	const pids: number[] = [];
	const edits = ["First name", "Second name"].map((name) =>
		gatedTransaction(db, async (tx) => {
			pids.push((await tx.execute<{ id: number }>(sql`SELECT pg_backend_pid() AS id`)).rows[0]!.id);
			return api.saveSection(tx, ctx(a), command({ section: "account", name }));
		}),
	);
	const settled = Promise.allSettled(edits);
	try {
		assert.equal(await waitingOnLock(admin, { pids, count: 2 }), true, "both real edits reached their lock wait");
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
	const replies = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
	assert.equal(replies.filter((r) => r.status === "ok").length, 1);
	denied(
		replies.find((r) => r.status === "refused")!,
		"conflict",
	);
	assert.equal(ok(await section(a, { section: "account" })).revision, "2");
});

async function overdue(a: { id: string }, subject: DeletionSubject) {
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
		requestedAt: w!.requested_at!.toISOString(),
		cancelUntil: w!.cancel_until!.toISOString(),
	};
}
test("AC:DEL58-007 AC:DEL58-008 AC:DEL58-009 deadline refuses cancellation; retryable witnessed purge preserves church-owned onboarding and People facts", async () => {
	const f = await plant();
	const subject = { kind: "account" as const, id: f.a.id };
	const p = await overdue(f.a, subject);
	const proof = await restricted(f.a, subject, p);
	denied(
		await gatedTransaction(db, (tx) =>
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
	const [w] = await admin
		.select()
		.from(t.lifecycle_witness)
		.where(eq(t.lifecycle_witness.opaque_subject_id, subject.id));
	assert.equal(w!.state, "purging");
	assert.equal(w!.live_purged_at, null);
	const [shared] = await admin.select().from(t.person).where(eq(t.person.id, f.result.ownerSeat.personId));
	assert.equal(shared!.linked_account_id, null);
	assert.equal(shared!.display_name, "Synthetic");
	const [setup] = await admin.select().from(t.onboarding_setup).where(eq(t.onboarding_setup.plant_id, f.p.id));

	assert.equal(setup!.plant_id, f.p.id);
	const [creation] = await admin.select().from(t.audit_event).where(eq(t.audit_event.id, setup!.creation_operation_id));
	assert.deepEqual(Object.keys(z.record(z.string(), z.unknown()).parse(creation!.result)).sort(), [
		"creation",
		"plant",
	]);
	const [user] = await admin.select().from(t.auth_user).where(eq(t.auth_user.id, f.a.user));
	assert.equal(user!.name, "Removed account");
	assert.equal(user!.email, `removed-${f.a.id}@removed.invalid`);
	complete = true;
	const done = await purge(input);
	assert.equal(done.status, "purged");
	assert.equal(Date.parse(done.copyExpiresAt) - Date.parse(done.livePurgedAt), 7 * 86400_000);
	assert.deepEqual(await purge(input), done);
	await assert.rejects(purge({ ...input, requestId: randomUUID() }), /conflict/);
	const [church] = await admin.select().from(t.plant).where(eq(t.plant.id, f.p.id));
	assert.equal(church!.name, "Harvest Point");
});

test("AC:DEL58-007 AC:DEL58-005 workspace purge hides and removes only its content; unrelated church survives", async () => {
	const f = await plant(),
		other = await plant();
	const subject = { kind: "plant" as const, id: f.p.id };
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

test("AC:DEL58-005: purging one church workspace leaves each person's own account and the seats of other churches and organizations untouched", async () => {
	const f = await plant(),
		other = await plant(),
		network = await organization();
	const member = await seat(f.p, "member"),
		otherAdmin = await seat(other.p, "admin");
	const p = await overdue(f.a, { kind: "plant", id: f.p.id });
	const purge = createLifecycleCleanup(cleanupDb, {
		authorize: async () => true,
		removeOwnedResources: async () => true,
	});
	assert.equal((await purge({ subject: p.subject, requestId: p.requestId, revision: p.revision })).status, "purged");
	for (const a of [f.a, member]) {
		const [account] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
		assert.equal(account!.registration_state, "active");
		const [user] = await admin.select().from(t.auth_user).where(eq(t.auth_user.id, a.user));
		assert.deepEqual([user!.name, user!.email], ["Synthetic", a.user + "@example.test"]);
	}
	const open = await admin.execute(
		sql`SELECT account_id, role FROM seat WHERE ended_at IS NULL AND account_id IN (${other.a.id}::uuid, ${otherAdmin.id}::uuid, ${network.a.id}::uuid) ORDER BY role`,
	);
	assert.deepEqual(
		new Set(open.rows.map((r) => `${r.account_id}/${r.role}`)),
		new Set([`${other.a.id}/owner`, `${otherAdmin.id}/admin`, `${network.a.id}/owner`]),
	);
	assert.equal(ok(await section(other.a, { section: "plant", plant: other.p })).values.profile.name, "Harvest Point");
	assert.equal(
		ok(await section(otherAdmin, { section: "plant", plant: other.p })).values.profile.name,
		"Harvest Point",
	);
	ok(await section(network.a, { section: "organization", organization: network.o }));
});

test("AC:TARGET-IDN-006 AC:SEC-07 AC:PROVIDER48-002 avatar verifies private bytes, atomically changes the reference and denies old/foreign versions", async () => {
	const a = await actor(),
		foreign = await actor();
	const bytes = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
		"base64",
	);
	const storage = photoStorage((i) => {
		assert.match(i.Key, new RegExp(`^private/${a.id}/[a-f0-9-]{36}$`));
		assert.equal(i.ACL, "private");
		assert.equal(i.CacheControl, "private, no-store");
	});
	const upload = ok(await call("requestAvatarUpload", a, { mime: "image/png", byteLength: bytes.length }));
	await assert.rejects(uploadAvatar(db, storage, ctx(foreign), { uploadId: upload.uploadId, bytes }), /unavailable/);
	await assert.rejects(
		uploadAvatar(db, storage, ctx(a), { uploadId: upload.uploadId, bytes: Buffer.from("not a png") }),
		/invalid_avatar/,
	);
	await uploadAvatar(db, storage, ctx(a), { uploadId: upload.uploadId, bytes });
	const saved = ok(await call("finalizeAvatar", a, command({ uploadId: upload.uploadId })));
	assert.deepEqual(saved, { status: "available", avatar: { accountId: a.id, versionId: upload.uploadId } });
	assert.deepEqual(await readAvatar(db, storage, ctx(a), { accountId: a.id, versionId: upload.uploadId }), bytes);
	const { promise: locked, resolve: entered } = Promise.withResolvers<void>(),
		{ promise: held, resolve: release } = Promise.withResolvers<void>();
	const holder = admin.transaction(async (tx) => {
		await tx.execute(sql`SELECT 1 FROM auth_session WHERE id=${a.session} FOR UPDATE`);
		entered();
		await held;
	});
	await locked;
	try {
		const done = new AbortController();
		const read = readAvatar(db, storage, ctx(a), { accountId: a.id, versionId: upload.uploadId }).finally(() =>
			done.abort(),
		);
		const waited = await waitingOnLock(db, { signal: done.signal });
		assert.equal(waited, false, "photo read waited for the session lock");
		assert.deepEqual(await read, bytes);
	} finally {
		release();
		await holder;
	}
	denied(await call("getAvatar", foreign, { versionId: upload.uploadId }));
	const clear = ok(await call("removeAvatar", a, command({}, "2")));
	assert.deepEqual(clear, { status: "absent" });
	denied(await call("getAvatar", a, { versionId: upload.uploadId }));
});

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);
const objectInput = z.object({
	Key: z.string(),
	ACL: z.string().optional(),
	CacheControl: z.string().optional(),
	Body: z.instanceof(Uint8Array).optional(),
});
type ObjectInput = z.output<typeof objectInput>;
class StubClient extends S3Client {
	answer: (operation: string, input: unknown) => object;
	constructor(answer: (operation: string, input: unknown) => object) {
		super({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
		this.answer = answer;
	}
	override async send(command: { input: object }) {
		return this.answer(command.constructor.name, command.input);
	}
}
const stubStorage = (answer: StubClient["answer"]): PrivateStorage => ({
	bucket: "synthetic-only",
	client: new StubClient(answer),
});
function photoStorage(stored: (input: ObjectInput) => void = () => {}) {
	const objects = new Map<string, Buffer>();
	return stubStorage((operation, input) => {
		switch (operation) {
			case "GetBucketAclCommand":
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			case "PutObjectCommand": {
				const i = objectInput.parse(input);
				stored(i);
				objects.set(i.Key, Buffer.from(i.Body!));
				return {};
			}
			case "GetObjectCommand": {
				const body = objects.get(objectInput.parse(input).Key)!;
				return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
			}
			default:
				throw Error("unexpected provider operation");
		}
	});
}
type Photo = { accountId: string; versionId: string };
async function setPhoto(storage: PrivateStorage, a: Session) {
	const upload = ok(await call("requestAvatarUpload", a, { mime: "image/png", byteLength: PNG.length }));
	await uploadAvatar(db, storage, ctx(a), { uploadId: upload.uploadId, bytes: PNG });
	const [row] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
	ok(await call("finalizeAvatar", a, command({ uploadId: upload.uploadId }, row!.revision)));
	return { accountId: a.id, versionId: upload.uploadId };
}
const photoRead = (storage: PrivateStorage, a: Session, photo: Photo) =>
	readAvatar(db, storage, ctx(a), photo).then(
		(bytes) => (Buffer.from(bytes).equals(PNG) ? "bytes" : "wrong bytes"),
		(error) => (error.message === "unavailable" ? "refused" : error.message),
	);
async function newSession(a: Pick<Account, "id"> & { user: string }) {
	const session = randomUUID();
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${session},${a.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
	);
	return { ...a, session };
}

test("AC:TARGET-IDN-006: seat holders in the same church load each other's current photo; nobody else does", async () => {
	const storage = photoStorage();
	const f = await plant(),
		member = await seat(f.p, "member"),
		other = await plant(),
		network = await organization(),
		seatless = await actor();
	const owner = await setPhoto(storage, f.a),
		memberPhoto = await setPhoto(storage, member);
	const read = (who: Session, photo: Photo) => photoRead(storage, who, photo);

	assert.equal(await read(member, owner), "bytes");
	assert.equal(await read(f.a, memberPhoto), "bytes");
	assert.equal(await read(f.a, owner), "bytes");
	for (const who of [other.a, network.a, seatless]) {
		assert.equal(await read(who, owner), "refused");
		assert.equal(await read(who, memberPhoto), "refused");
	}
	const peer = await actor();
	await admin
		.insert(t.seat)
		.values({ account_id: peer.id, organization_id: network.o.id, role: "member", accepted_at: new Date() });
	const networkPhoto = await setPhoto(storage, network.a);
	assert.equal(await read(peer, networkPhoto), "bytes");
	assert.equal(await read(f.a, networkPhoto), "refused");
	assert.equal(await read(member, { accountId: member.id, versionId: owner.versionId }), "refused");

	assert.equal(await read({ id: member.id, session: randomUUID() }, owner), "refused");
	assert.equal(await read({ id: member.id, session: seatless.session }, owner), "refused");
	const own = await setPhoto(storage, seatless);
	assert.equal(await read(seatless, own), "bytes");
	await admin.execute(
		sql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${seatless.session}`,
	);
	assert.equal(await read(seatless, own), "refused");

	const replaced = await setPhoto(storage, f.a);
	assert.equal(await read(f.a, owner), "refused");
	assert.equal(await read(member, owner), "refused");
	assert.equal(await read(member, replaced), "bytes");
	const [row] = await admin.select().from(t.account).where(eq(t.account.id, f.a.id));
	ok(await call("removeAvatar", f.a, command({}, row!.revision)));
	assert.equal(await read(f.a, replaced), "refused");
	assert.equal(await read(member, replaced), "refused");

	const current = await setPhoto(storage, f.a);
	assert.equal(await read(member, current), "bytes");
	await admin.execute(
		sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${member.id} AND plant_id=${f.p.id}`,
	);
	assert.equal(await read(member, current), "refused");
	assert.equal(await read(f.a, memberPhoto), "refused");
	assert.equal(await read(member, memberPhoto), "bytes");
});

test("AC:TARGET-IDN-006: an overseeing organization and its plant load each other's photos while the link is current", async () => {
	const storage = photoStorage();
	const f = await plant(),
		staff = await seat(f.p, "member"),
		church = await organization(),
		director = await actor(),
		outsider = await organization();
	await admin
		.insert(t.seat)
		.values({ account_id: director.id, organization_id: church.o.id, role: "member", accepted_at: new Date() });
	const [link] = await admin
		.insert(t.affiliation)
		.values({
			plant_id: f.p.id,
			organization_id: church.o.id,
			accepted_at: new Date(),
			share_people: false,
			share_meetings: false,
			share_tasks: false,
			share_ministry_teams: false,
			share_wiki: false,
			share_activity: false,
			shared_findings: false,
		})
		.returning();
	const planter = await setPhoto(storage, f.a),
		staffPhoto = await setPhoto(storage, staff),
		directorPhoto = await setPhoto(storage, director);
	const read = (who: Session, photo: Photo) => photoRead(storage, who, photo);

	for (const who of [church.a, director]) {
		assert.equal(await read(who, planter), "bytes");
		assert.equal(await read(who, staffPhoto), "bytes");
	}
	assert.equal(await read(staff, directorPhoto), "bytes");
	assert.equal(await read(f.a, directorPhoto), "bytes");
	assert.equal(await read(outsider.a, planter), "refused");
	assert.equal(await read(outsider.a, directorPhoto), "refused");
	assert.equal(await read(staff, await setPhoto(storage, outsider.a)), "refused");

	await admin.execute(
		sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${director.id} AND organization_id=${church.o.id}`,
	);
	assert.equal(await read(director, planter), "refused");
	assert.equal(await read(staff, directorPhoto), "refused");
	await admin.execute(
		sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${staff.id} AND plant_id=${f.p.id}`,
	);
	assert.equal(await read(church.a, staffPhoto), "refused");
	assert.equal(await read(staff, await setPhoto(storage, church.a)), "refused");

	assert.equal(await read(church.a, planter), "bytes");
	await admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${link!.id}`);
	assert.equal(await read(church.a, planter), "refused");
});

test("AC:TARGET-IDN-006: a committed personal or church workspace deletion request hides the photos it reaches", async () => {
	const storage = photoStorage();
	const f = await plant(),
		leaving = await seat(f.p, "member");
	const photo = await setPhoto(storage, leaving);
	assert.equal(await photoRead(storage, f.a, photo), "bytes");
	const [row] = await admin.select().from(t.account).where(eq(t.account.id, leaving.id));
	ok(await call("requestAccountDeletion", leaving, command({ confirmed: true }, row!.revision)));
	assert.equal(await photoRead(storage, f.a, photo), "refused");
	assert.equal(await photoRead(storage, await newSession(leaving), photo), "refused");

	const church = await plant(),
		member = await seat(church.p, "member");
	const ownerPhoto = await setPhoto(storage, church.a);
	const memberPhoto = await setPhoto(storage, member);
	assert.equal(await photoRead(storage, member, ownerPhoto), "bytes");
	const [plantRow] = await admin.select().from(t.plant).where(eq(t.plant.id, church.p.id));
	ok(
		await call(
			"requestWorkspaceDeletion",
			church.a,
			command({ plant: church.p, confirmed: true }, plantRow!.revision),
			church.p,
		),
	);
	const again = await newSession(member);
	assert.equal(await photoRead(storage, again, ownerPhoto), "refused");
	assert.equal(await photoRead(storage, await newSession(church.a), memberPhoto), "refused");
	assert.equal(await photoRead(storage, again, memberPhoto), "bytes");
});

test("AC:TARGET-IDN-006: the Seats roster and the People list name each visible photo by its account and version", async () => {
	const storage = photoStorage();
	const f = await plant(),
		member = await seat(f.p, "member"),
		plain = await seat(f.p, "member"),
		former = await seat(f.p, "member");
	const ownerPhoto = await setPhoto(storage, f.a),
		memberPhoto = await setPhoto(storage, member),
		formerPhoto = await setPhoto(storage, former);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${former.id}`);

	const roster = async (a: Session) => {
		const { authority } = await seen(a);
		const list = await createSeatService(db).list(authority, { workspace: f.p });
		return Object.fromEntries(list.items.map((s) => [s.displayName + "/" + s.status, s.avatar]));
	};
	await admin.execute(
		sql`UPDATE auth_user u SET name=n.name FROM (VALUES (${f.a.user}::uuid,'Owner'),(${member.user}::uuid,'Member'),(${plain.user}::uuid,'Plain'),(${former.user}::uuid,'Former')) n(id,name) WHERE u.id=n.id`,
	);
	const expected = {
		"Owner/active": ownerPhoto,
		"Member/active": memberPhoto,
		"Plain/active": null,
		"Former/removed": null,
	};
	assert.deepEqual(await roster(f.a), expected);
	assert.deepEqual(await roster(member), expected);
	assert.doesNotMatch(JSON.stringify(await roster(f.a)), /private\/|https?:/);
	assert.equal(formerPhoto.accountId, former.id);

	const person = async (name: string, linked?: string) => {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at,linked_account_id)
			VALUES(${id},${f.p.id},${f.p.id},${name},'other','prospect','unknown','unknown',0,'live',clock_timestamp(),${linked ?? null})`);
		return id;
	};
	const linked = await person("Linked", member.id),
		both = (
			await admin
				.select({ id: t.person.id })
				.from(t.person)
				.where(and(eq(t.person.plant_id, f.p.id), eq(t.person.linked_account_id, f.a.id)))
		)[0]!.id,
		unlinked = await person("Unlinked"),
		leftChurch = await person("Left", former.id);
	const crm = randomUUID();
	await admin.insert(t.file_object).values({
		id: crm,
		tenant_id: f.p.id,
		purpose: "person_photo",
		opaque_key: `private/${f.p.id}/${randomUUID()}`,
		media_type: "image/png",
		max_bytes: "1",
		byte_count: "1",
		sha256: createHash("sha256").update("x").digest("hex"),
		state: "ready",
		upload_key: crm,
		claim_generation: "0",
	});
	await admin.update(t.person).set({ photo_object_id: crm }).where(eq(t.person.id, both));
	const { authority } = await seen(plain);
	const page = ok(
		await gatedTransaction(db, (tx) =>
			peopleReader.listPeople(tx, new PeopleReadContext(authority), listPeopleRequest.parse({ page: 1, limit: 100 })),
		),
	);
	const photos = Object.fromEntries(page.photos.map((p) => [p.personId, p.photo]));
	assert.deepEqual(photos[linked], { kind: "account", ...memberPhoto });
	assert.deepEqual(photos[both], { kind: "person", personId: both, versionId: crm });
	assert.equal(photos[unlinked], undefined);
	assert.equal(photos[leftChurch], undefined);
});

let signInAuth: ReturnType<typeof identityAuth>;
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
	const id = accountId.parse(randomUUID());
	await admin
		.insert(t.account)
		.values({ id, auth_user_id: signed.user.id, registration_state: "active", registration_kind: "planter" });
	await admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, signed.user.id));
	return login({ id, user: signed.user.id, email, password });
}
async function login(a: Login) {
	const r = await signInAuth.api.signInEmail({ body: { email: a.email, password: a.password }, asResponse: true });
	assert.equal(r.status, 200);
	const cookie = r.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	const request = new Request(origin + "/api/settings", { method: "POST", headers: { origin, cookie } });
	const s = await signInAuth.api.getSession({ headers: request.headers });
	assert.ok(s);
	ingress.set(s.session.id, request);
	return { ...a, session: sessionId.parse(s.session.id) };
}
const openWorkspace = (a: Login, password = a.password) =>
	producerDeps.credentials.openWorkspaceDeletion({ email: a.email, password }, null);
const PROOF_REFUSED = { status: "refused", code: "proof_invalid" };
async function credentialSeat(p: Plant, role: "admin" | "member") {
	const a = await credentialActor();
	await admin.insert(t.seat).values({ plant_id: p.id, account_id: a.id, role, accepted_at: new Date(), revision: "1" });
	return a;
}
test("AC:TARGET-IDN-026 AC:TARGET-IDN-032: only the Owner requests workspace deletion; every seat loses access; only the Owner's fresh proof opens and cancels it", async () => {
	const owner = await credentialActor();
	const f = await plant(owner);
	const member = await credentialSeat(f.p, "member"),
		seatedAdmin = await credentialSeat(f.p, "admin");
	const [church] = await admin.select().from(t.plant).where(eq(t.plant.id, f.p.id));
	const ask = (a: Session) =>
		call("requestWorkspaceDeletion", a, command({ plant: f.p, confirmed: true }, church!.revision), f.p);
	denied(await ask(member));
	denied(await ask(seatedAdmin));
	assert.deepEqual(await openWorkspace(owner), PROOF_REFUSED);
	const seatOf = async (a: Session) => {
		const context = (await viewerOf(a))?.authority.actor.context;
		return context?.kind === "seat" ? { kind: context.kind, owner: context.owner, role: context.role } : null;
	};
	const seats = { [owner.id]: "owner", [member.id]: "member", [seatedAdmin.id]: "admin" };
	for (const a of [owner, member, seatedAdmin])
		assert.deepEqual(await seatOf(a), { kind: "seat", owner: f.p, role: seats[a.id] });

	const pending = ok(await ask(owner));
	assert.equal(pending.status, "pending_deletion");
	assert.deepEqual(pending.subject, { kind: "plant", id: f.p.id });
	assert.equal(Date.parse(pending.cancelUntil) - Date.parse(pending.requestedAt), 30 * 86400_000);
	const [w] = await admin
		.select()
		.from(t.lifecycle_witness)
		.where(and(eq(t.lifecycle_witness.kind, "plant"), eq(t.lifecycle_witness.opaque_subject_id, f.p.id)));
	assert.equal(w!.cancel_until!.toISOString(), pending.cancelUntil);
	for (const a of [owner, member, seatedAdmin]) assert.equal(await viewerOf(a), null);
	assert.equal(await viewerOf(await login(member)), null);

	assert.deepEqual(await openWorkspace(owner, "Wrong secret 1234!"), PROOF_REFUSED);
	assert.deepEqual(await openWorkspace(member), PROOF_REFUSED);
	assert.deepEqual(await openWorkspace(await credentialActor()), PROOF_REFUSED);
	assert.deepEqual(
		await producerDeps.credentials.openAccountDeletion({ email: owner.email, password: owner.password }, null),
		PROOF_REFUSED,
	);

	const opened = await openWorkspace(owner);
	assert.ok(opened.status === "ok", JSON.stringify(opened));
	assert.deepEqual(opened.value.subject, { kind: "plant", id: f.p.id });
	const request = { subject: opened.value.subject, requestId: opened.value.requestId };
	const proof = await openedDeletion(opened.value.session, request);
	assert.deepEqual(ok(await gatedTransaction(db, (tx) => api.getWorkspaceDeletionStatus(tx, proof, request))), pending);
	const cancelled = ok(
		await gatedTransaction(db, (tx) => api.cancelWorkspaceDeletion(tx, proof, command(request, pending.revision))),
	);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.cancelUntil, pending.cancelUntil);
	assert.deepEqual(await openWorkspace(owner), PROOF_REFUSED);

	for (const a of [owner, member, seatedAdmin])
		assert.deepEqual(await seatOf(await login(a)), { kind: "seat", owner: f.p, role: seats[a.id] });
	assert.equal(
		ok(await section(await login(owner), { section: "plant", plant: f.p })).values.profile.name,
		"Harvest Point",
	);
});

test("AC:DEL58-007: a workspace cancel after the stored deadline is refused even before the purge runs", async () => {
	const owner = await credentialActor();
	const f = await plant(owner);
	const p = await overdue(owner, { kind: "plant", id: f.p.id });
	const opened = await openWorkspace(owner);
	assert.ok(opened.status === "ok", JSON.stringify(opened));
	const request = { subject: opened.value.subject, requestId: opened.value.requestId };
	const proof = await openedDeletion(opened.value.session, request);
	const late = ok(await gatedTransaction(db, (tx) => api.getWorkspaceDeletionStatus(tx, proof, request)));
	assert.deepEqual(late, p);
	denied(
		await gatedTransaction(db, (tx) => api.cancelWorkspaceDeletion(tx, proof, command(request, late.revision))),
		"deadline_passed",
	);
	const [w] = await admin
		.select()
		.from(t.lifecycle_witness)
		.where(and(eq(t.lifecycle_witness.kind, "plant"), eq(t.lifecycle_witness.opaque_subject_id, f.p.id)));
	assert.equal(w!.state, "pending_deletion");
});

test("AC:TARGET-IDN-007 AC:ROLE43-018 email proof is requester-bound, superseded, 24 hours, unique, and preserves account/Person identity", async () => {
	const a = await credentialActor(),
		b = await credentialActor();
	const church = await plant(a);
	await admin
		.update(t.person)
		.set({ email: "crm-contact@example.test" })
		.where(eq(t.person.id, church.result.ownerSeat.personId));
	const requested = ok(await credential("requestEmailChange", a, { newEmail: " " + randomUUID() + "@Example.Test " }));
	assert.equal(requested.status, "verification_requested");
	const first = deliveries.at(-1)!;
	assert.equal((await credential("confirmEmailChange", b, { proof: first.token })).status, "refused");
	const dbNow = async () =>
		Date.parse((await admin.execute<{ t: string }>(sql`SELECT clock_timestamp()::text AS t`)).rows[0]!.t);
	const earliest = await dbNow();
	ok(await credential("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }));
	const latest = await dbNow();
	const second = deliveries.at(-1)!;
	assert.equal((await credential("confirmEmailChange", a, { proof: first.token })).status, "refused");
	const proofs = await admin.select().from(t.identity_proof).where(eq(t.identity_proof.account_id, a.id));
	assert.equal(proofs.filter((p) => p.superseded_at !== null).length, 1);
	const active = proofs.find((p) => p.superseded_at === null)!;
	const expiry = active.expires_at.getTime();
	assert.ok(expiry >= earliest + 86_400_000 && expiry <= latest + 86_400_000 + 1, String(expiry - earliest));
	const result = await credential("confirmEmailChange", a, { proof: second.token });
	assert.equal(result.status, "succeeded");
	assert.equal(result.action, "email_changed");
	assert.equal(result.reporting.status, "recorded");
	const [account] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
	assert.equal(account!.auth_user_id, a.user);
	const [user] = await admin.select().from(t.auth_user).where(eq(t.auth_user.id, a.user));
	assert.equal(user!.email, second.address);
	const [person] = await admin.select().from(t.person).where(eq(t.person.id, church.result.ownerSeat.personId));
	assert.equal(person!.linked_account_id, a.id);
	assert.equal(person!.email, "crm-contact@example.test");
	assert.equal((await credential("confirmEmailChange", a, { proof: second.token })).status, "refused");
});

test("INV-proof-link: opening an email-change link writes nothing and its proof still confirms the change", async () => {
	const { NextRequest } = createRequire(new URL("../../../apps/web/package.json", import.meta.url))("next/server");
	const { proxy, EMAIL_CHANGE_PROOF_COOKIE } = await import("../../../apps/web/src/proxy.ts");
	const a = await credentialActor();
	ok(await credential("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }));
	const mailed = deliveries.at(-1)!;
	const state = async () =>
		JSON.stringify({
			proofs: await admin.select().from(t.identity_proof).where(eq(t.identity_proof.account_id, a.id)),
			user: await admin.select().from(t.auth_user).where(eq(t.auth_user.id, a.user)),
			audit: (await admin.execute(sql`SELECT count(*)::int AS n FROM audit_event`)).rows[0]!.n,
		});
	const before = await state();
	const opened = proxy(
		new NextRequest(`https://everyfield.test/confirm-email?token=${encodeURIComponent(mailed.token)}`),
	);
	assert.equal(opened.status, 307);
	const kept = opened.cookies.get(EMAIL_CHANGE_PROOF_COOKIE)?.value;
	assert.equal(kept, mailed.token);
	assert.equal(await state(), before);
	const result = await credential("confirmEmailChange", a, { proof: kept });
	assert.equal(result.status, "succeeded");
	const [user] = await admin.select().from(t.auth_user).where(eq(t.auth_user.id, a.user));
	assert.equal(user!.email, mailed.address);
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
	assert.equal((await credential("changePassword", a, input)).status, "refused");
	assert.equal(
		(
			await credential("changePassword", a, {
				currentPassword: a.password,
				newPassword: a.password,
				confirmPassword: a.password,
			})
		).status,
		"refused",
	);
	faults = true;
	const changed = await credential("changePassword", a, { ...input, currentPassword: a.password });
	faults = false;
	assert.equal(changed.status, "succeeded");
	assert.deepEqual(changed.reporting, { status: "pending_investigation" });
	assert.deepEqual(diagnostics.splice(0), [{ correlationId: changed.correlationId, outcome: "reporting_pending" }]);
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
	assert.equal(count!.n, 0);
});

async function organization() {
	const id = tenantId.parse(randomUUID()),
		a = await actor(),
		o = { kind: "organization" as const, id, organizationKind: "sending_network" as const };
	await admin
		.insert(t.organization)
		.values({ id, kind: "sending_network", name: "Network", timezone: "UTC", material_revision: "1" });
	await admin.insert(t.seat).values({ account_id: a.id, organization_id: id, role: "owner", accepted_at: new Date() });
	return { o, a };
}
test("AC:CASE-NTF-004 an organization member who never saved an oversight choice sees the bell on, email off and daily", async () => {
	const { a } = await organization();
	const current = ok(await section(a, { section: "notifications" }));
	const oversight = (channel: "email" | "in_app") =>
		current.values.choices.find((c) => c.category === "oversight_digest" && c.channel === channel)!.enabled;
	assert.deepEqual([oversight("in_app"), oversight("email"), current.values.oversightCadence], [true, false, "daily"]);
	const saved = ok(
		await save(
			a,
			command({ section: "notifications", patch: { kind: "oversight_cadence", cadence: "weekly" } }, current.revision),
		),
	);
	const after = (channel: "email" | "in_app") =>
		saved.current.values.choices.find((c) => c.category === "oversight_digest" && c.channel === channel)!.enabled;
	assert.deepEqual([after("in_app"), after("email"), saved.current.values.oversightCadence], [true, false, "weekly"]);
});
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
		section: "affiliations" as const,
		plant: f.p,
		organization: org.o,
		relationshipId: relationship!.id,
		expectedConsentRevision: "1",
		patch: { teams: false, activityPush: false },
	};
	const saved = ok(await save(f.a, command(input), f.p));
	assert.equal(saved.current.values.consentRevision, "2");
	assert.equal(saved.current.values.choices.ministry_teams, false);
	assert.equal(saved.current.values.choices.activity, false);
	assert.equal(saved.current.values.choices.people, true);
	assert.equal(saved.current.values.choices.shared_findings, true);

	denied(await save(g.a, command(input), g.p));
	denied(await save(org.a, command({ ...input, expectedConsentRevision: "2" }, "2"), org.o));
	denied(await save(f.a, command(input, "2"), f.p), "conflict");
	const next = { ...input, expectedConsentRevision: "2", patch: { people: false } };
	faults = true;
	await assert.rejects(save(f.a, command(next, "2"), f.p), /grant_fault/);
	faults = false;
	assert.equal(
		(await admin.select().from(t.affiliation).where(eq(t.affiliation.id, relationship!.id)))[0]!.consent_revision,
		"2",
	);
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT tenant_id,producer_key,source_revision::text AS revision FROM job WHERE kind='notification' AND subject_record_id=${relationship!.id}`,
			)
		).rows,
		[{ tenant_id: f.p.id, producer_key: "affiliation/sharing/2", revision: "2" }],
	);
	const profile = ok(
		await save(
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
		await save(
			org.a,
			command({ section: "organization", organization: org.o, patch: { name: "New Network" } }, "2"),
			org.o,
		),
	);

	assert.equal(noop.current.values.revision, "2");
	const wrong = { ...org.o, organizationKind: "sending_church" as const };
	denied(await section(org.a, { section: "organization", organization: wrong }));
});

test("AC:ORG55-001 AC:TARGET-IDN-026 an organization's own Owner or Admin edits its name and contact; a Member, another organization or a kind, billing, transfer or deletion field changes nothing", async () => {
	const f = await plant();
	const footprint = async () =>
		(
			await admin.execute<
				Record<string, unknown>
			>(sql`SELECT (SELECT count(*)::int FROM audit_event) audits,(SELECT count(*)::int FROM job) jobs,
				(SELECT count(*)::int FROM mail) mail,(SELECT count(*)::int FROM notice) notices,(SELECT count(*)::int FROM lifecycle_witness) deletions,
				(SELECT md5(string_agg(o::text,'' ORDER BY o.id)) FROM organization o) organizations,
				(SELECT md5(string_agg(s::text,'' ORDER BY s.id)) FROM seat s) seats`)
		).rows[0]!;
	for (const organizationKind of ["sending_church", "sending_network"] as const)
		for (const role of ["owner", "admin"] as const) {
			const make = async () => {
				const id = tenantId.parse(randomUUID());
				await admin
					.insert(t.organization)
					.values({ id, kind: organizationKind, name: "Before", timezone: "UTC", material_revision: "1" });
				const o = { kind: "organization" as const, id, organizationKind };
				const seated = async (r: "owner" | "admin" | "member") => {
					const a = await actor();
					await admin
						.insert(t.seat)
						.values({ account_id: a.id, organization_id: id, role: r, accepted_at: new Date() });
					return a;
				};
				return { o, owner: await seated("owner"), admin: await seated("admin"), member: await seated("member") };
			};
			const own = await make(),
				foreign = await make();
			const patch = { name: "Sending Church One", contactEmail: "office@example.test" };
			const input = { section: "organization" as const, organization: own.o, patch };
			const update = (a: Session, selected: Owner, v: object) =>
				gatedTransaction(db, async (tx) => {
					await RequestActor.claimWrite(tx, sessionId.parse(a.session), selected);
					return producerDeps.organizations["organizations.updateProfile"](tx, sessionId.parse(a.session), selected, v);
				});
			const before = await footprint();
			for (const [who, selected] of [
				[own.member, own.o],
				[foreign.admin, foreign.o],
				[foreign.owner, foreign.o],
				[foreign.admin, own.o],
				[f.a, f.p],
			] as const) {
				denied(await save(who, command(input), selected));
				await assert.rejects(update(who, selected, command({ organization: own.o, patch })), /^Error: unavailable$/);
			}
			for (const extra of [
				{ kind: "sending_network" },
				{ organizationKind: "sending_network" },
				{ billing: { plan: "pro" } },
				{ ownerId: foreign.owner.id },
				{ transferTo: foreign.owner.id },
				{ delete: true },
			]) {
				denied(
					await save(own[role], command({ ...input, patch: { ...patch, ...extra } } as typeof input), own.o),
					"invalid_input",
				);
				await assert.rejects(
					update(own[role], own.o, command({ organization: own.o, patch: { ...patch, ...extra } })),
					(e: Error) => e.name === "ZodError",
				);
			}
			const other = organizationKind === "sending_church" ? "sending_network" : "sending_church";
			const rekinded = { ...own.o, organizationKind: other } as const;
			denied(await save(own[role], command({ ...input, organization: rekinded }), own.o));
			denied(await save(own[role], command(input, "9"), own.o), "conflict");
			await assert.rejects(
				update(own[role], own.o, command({ organization: own.o, patch }, "9")),
				/^Error: stale_revision$/,
			);
			for (const target of [own.o, f.p])
				for (const selected of [own.o, f.p]) {
					const reply = await call(
						"requestWorkspaceDeletion",
						own[role],
						command({ plant: target, confirmed: true }),
						selected,
					);
					assert.equal(reply.status, "refused", "an organization seat deletes no workspace");
				}
			assert.deepEqual(await footprint(), before);
			const request = command(input);
			const saved = ok(await save(own[role], request, own.o));
			assert.equal(saved.current.values.profile.name, "Sending Church One");
			assert.equal(saved.current.values.profile.contactEmail, "office@example.test");
			assert.deepEqual(ok(await save(own[role], request, own.o)), saved, "the same request answers the same receipt");
			const after = await footprint();
			assert.deepEqual(
				{ ...after, organizations: before.organizations },
				{ ...before, audits: Number(before.audits) + 1 },
				"one audit and no mail, notice, job or seat",
			);
			assert.deepEqual(
				(
					await admin.execute(
						sql`SELECT action,actor_id FROM audit_event WHERE tenant_id=${own.o.id} AND subject_id=${own.o.id}`,
					)
				).rows,
				[{ action: "organization.profile_changed", actor_id: own[role].id }],
			);
			assert.deepEqual(
				(await admin.execute(sql`SELECT kind,name,contact_email,revision::text FROM organization WHERE id=${own.o.id}`))
					.rows,
				[{ kind: organizationKind, name: "Sending Church One", contact_email: "office@example.test", revision: "2" }],
			);
			await update(own[role], own.o, command({ organization: own.o, patch: { name: "Sending One" } }, "2"));
			const read = async (who: Session) => {
				const r = ok(await section(who, { section: "organization", organization: own.o }));
				assert.ok(r.values.status === "available");
				return [r.values.profile.name, r.values.profile.contactEmail, r.values.revision];
			};
			for (const who of [own.owner, own.admin, own.member])
				assert.deepEqual(await read(who), ["Sending One", "office@example.test", "3"]);
			denied(await section(foreign.admin, { section: "organization", organization: own.o }));
			denied(await section(f.a, { section: "organization", organization: own.o }));
		}
});

test("INV-lifecycle: an account root read serializes first-witness deletion even before any witness exists", async () => {
	const { liveOwner } = await import("../../../packages/domain/src/access/session.ts");
	const a = await actor();
	const { promise: ready, resolve: entered } = Promise.withResolvers<void>(),
		{ promise: gate, resolve: release } = Promise.withResolvers<void>();
	const reading = gatedTransaction(db, async (tx) => {
		assert.equal(await liveOwner(tx, { kind: "account", id: a.id }), true);
		entered();
		await gate;
	});
	await ready;
	let pid: number | undefined;
	const done = new AbortController();
	const { promise: running, resolve: started } = Promise.withResolvers<void>();
	const deletion = gatedTransaction(db, async (tx) => {
		pid = (await tx.execute<{ id: number }>(sql`SELECT pg_backend_pid() AS id`)).rows[0]!.id;
		started();
		const result = await api.requestAccountDeletion(tx, ctx(a), command({ confirmed: true }));
		done.abort();
		return result;
	});
	await running;
	try {
		assert.equal(await waitingOnLock(admin, { pids: [pid], signal: done.signal }), true);
		assert.equal(done.signal.aborted, false);
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
		.split("-- BEGIN NOTIFICATION PREFERENCE DATA")[1]!
		.split("-- END NOTIFICATION PREFERENCE DATA")[0]!;
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
	assert.equal(after!.due_date, "2099-01-15");
	const [appointment] = await admin.select().from(t.meeting).where(eq(t.meeting.id, meeting));
	assert.equal(appointment!.starts_at.toISOString(), "2099-01-15T15:00:00.000Z");
	assert.equal(appointment!.timezone, "America/Chicago");
});

test("AC:TARGET-TSK-018 frozen schedule previews disclose fold/gap policy and ignore the host timezone", async () => {
	const { frozenClock, instant } = await import("../../../packages/contracts/src/common/index.ts");
	for (const [asOf, hour, warning, before, after] of [
		["2026-10-25T12:00:00.000Z", 1, "dst_fold_earlier", "2026-11-01T06:00:00.000Z", "2026-11-01T05:00:00.000Z"],
		["2027-03-07T12:00:00.000Z", 2, "dst_gap_shifted", "2027-03-14T08:00:00.000Z", "2027-03-14T07:00:00.000Z"],
	]) {
		const f = await plant();
		ok(await call("setDigestSchedule", f.a, command({ plant: f.p, schedule: { cadence: "daily", hour } }), f.p));
		const frozen = settingsApi({ ...producerDeps, clock: frozenClock(instant.parse(asOf)) });
		const preview = ok(
			await gatedTransaction(db, (tx) =>
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
			await gatedTransaction(db, (tx) =>
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

test("AC:TARGET-IDN-012 exact task preference reaches enqueue and dispatch; church digest OFF stops owed delivery", async () => {
	const { createNotificationService } = await import("../../../packages/domain/src/jobs/notifications.ts");
	const { createDigestWorker, planDigests } = await import("../../../packages/domain/src/jobs/digest.ts");
	const { claimDue } = await import("../../../packages/domain/src/jobs/queue.ts");
	const f = await plant(),
		task = randomUUID();
	await insertTasks(admin, [
		{
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
		},
	]);
	const sent: MailPayload[] = [];
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
	const notice = (category: "task_due" | "task_overdue", occurrence: string) => ({
		owner: f.p,
		recipient: f.a.id,
		source: { kind: "task" as const, id: task, revision: "1" },
		category,
		occurrence,
		title: "Task update",
		text: "Task update",
		operation: null,
		eligibleAt: new Date().toISOString(),
	});
	ok(
		await save(
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
	const due = await gatedTransaction(db, (tx) => notifications.enqueue(tx, notice("task_due", "due")));
	assert.equal(due.mail, null);
	const overdue = await gatedTransaction(db, (tx) => notifications.enqueue(tx, notice("task_overdue", "overdue")));
	assert.ok(overdue.mail);
	assert.match(overdue.mail, /^[a-f0-9-]{36}$/);
	ok(
		await save(
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
	assert.ok(outbox?.job_id);
	await admin
		.update(t.job)
		.set({ eligible_at: sql`clock_timestamp()-interval '1 second'` })
		.where(eq(t.job.id, outbox.job_id));
	const claims = await claimDue(db, ["mail"], 100);
	const claim = claims.find((c) => c.id === outbox.job_id)!;
	assert.equal(claim.kind, "mail");
	assert.deepEqual(await sender.dispatch(claim), { kind: "not_dispatched" });
	assert.deepEqual(sent, []);
	const profile = ok(await section(f.a, { section: "plant", plant: f.p }));
	ok(
		await call("setDigestSchedule", f.a, command({ plant: f.p, schedule: { cadence: "off" } }, profile.revision), f.p),
	);
	const digests = createDigestWorker({ mail: sender, origin });
	for (const at of ["2099-01-11T23:00:00.000Z", "2099-01-18T23:00:00.000Z"]) {
		await planDigests(db, at);
		await digests.run(db, at, 100);
	}
	const [owed] = (
		await admin.execute(sql`SELECT (SELECT count(*) FROM digest_coverage WHERE recipient_id=${f.a.id})::int AS coverage,
			(SELECT count(*) FROM notice WHERE recipient_id=${f.a.id} AND category='digest')::int AS notices,
			(SELECT count(*) FROM mail WHERE recipient_account_id=${f.a.id} AND purpose='planter_digest')::int AS mail`)
	).rows;
	assert.deepEqual(owed, { coverage: 0, notices: 0, mail: 0 });
});

test("AC:TARGET-IDN-007 AC:TARGET-IDN-008 native credential budgets use own login rather than target and refuse exhausted password failures", async () => {
	const a = await credentialActor();
	for (let i = 0; i < 3; i++)
		ok(await credential("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }));
	denied(await credential("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }), "temporary");
	const b = await credentialActor();
	const input = {
		currentPassword: "Incorrect secret",
		newPassword: "Budget replacement 2468!",
		confirmPassword: "Budget replacement 2468!",
	};
	for (let i = 0; i < 5; i++) assert.equal((await credential("changePassword", b, input)).status, "refused");
	assert.equal((await credential("changePassword", b, { ...input, currentPassword: b.password })).status, "refused");
	const old = await login(b);
	assert.equal(ok(await section(old, { section: "account" })).email, b.email);
});

test("AC:TARGET-IDN-007 an email change whose send throws is unknown and gives its try back", async () => {
	const a = await credentialActor();
	trustedIps.set(a.session, "198.51.100.31");
	const live = ingress.get(a.session)!;
	ingress.set(a.session, new Request(live.url, { method: "POST", headers: { origin } }));
	denied(await credential("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }), "unknown");
	ingress.set(a.session, live);
	for (let i = 0; i < 3; i++)
		ok(await credential("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }));
	denied(await credential("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }), "temporary");
});

test("AC:DEL58-004 AC:DEL58-007 AC:TARGET-IDN-032 account purge removes personal bodies while preserving church documents", async () => {
	const { deleteUnreferencedObject } = await import("../../../packages/db/src/schema/storage.ts");
	const f = await plant(),
		subject = { kind: "account" as const, id: f.a.id };
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
	const storage = stubStorage((operation, input) => {
		assert.equal(operation, "DeleteObjectCommand");
		assert.equal(objectInput.parse(input).Key, key);
		if (timeout) throw Error("provider_timeout");
		objects.delete(key);
		return {};
	});
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
					return w && identity.tenant_id === subject.id
						? { kind: "system" as const, cause: "object_cleanup" as const }
						: null;
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
	assert.equal(w!.live_purged_at, null);
	assert.equal(
		(await admin.select().from(t.document_revision).where(eq(t.document_revision.id, docs[0]!.version))).length,
		0,
	);
	const [shared] = await admin.select().from(t.document_revision).where(eq(t.document_revision.id, docs[1]!.version));
	assert.equal(shared!.body, "Church-owned document body");
	timeout = false;
	const done = await purge(input);
	assert.equal(done.status, "purged");
	assert.equal(objects.size, 0);
	assert.equal((await admin.select().from(t.file_object).where(eq(t.file_object.id, file)))[0]!.state, "purged");
});

test("AC:ORG55-006 AC:DEL58-004 deleting a login hides its check-ins, avatar and own documents on the next read and keeps the church's; the purge removes them, keeps the church's and gives their author to no one", async () => {
	const { deleteUnreferencedObject } = await import("../../../packages/db/src/schema/storage.ts");
	const storage = photoStorage();
	const f = await plant(),
		a = await seat(f.p, "admin"),
		subject = { kind: "account" as const, id: a.id };
	await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id IN (${a.id},${f.a.id})`);
	const person = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${person},${f.p.id},${f.p.id},
		'Alex Admin','other','leader','adult','unknown',1,'live',clock_timestamp(),${a.id})`);
	const photo = await setPhoto(storage, a);
	const care = createPrivateCare();
	const mine = (await seen(a)).authority;
	const week = ok(await care.readCurrent(db, mine, {}));
	const answers = { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" };
	ok(
		await care.save(db, mine, {
			requestKey: randomUUID(),
			expectedRevision: week.revision,
			input: { answers, note: "CARE-CANARY" },
		}),
	);
	const doc = async (tenant: string, title: string) => {
		const id = randomUUID(),
			version = randomUUID();
		await admin.insert(t.document).values({ id, tenant_id: tenant, kind: "native", title });
		await admin.insert(t.document_revision).values({
			id: version,
			tenant_id: tenant,
			document_id: id,
			version_number: 1,
			body: `${title} body`,
			content_hash: createHash("sha256").update(`${title} body`).digest("hex"),
			recorded_at: new Date(),
		});
		await admin.update(t.document).set({ current_revision_id: version }).where(eq(t.document.id, id));
		return { id, version };
	};
	const DA = await doc(a.id, "Private plan"),
		DP = await doc(f.p.id, "Church plan");

	const owner = async () => {
		const { authority } = await seen(f.a);
		const directory = ok(
			await gatedTransaction(db, (tx) =>
				peopleReader.listPeople(tx, new PeopleReadContext(authority), listPeopleRequest.parse({ page: 1, limit: 100 })),
			),
		);
		const photos = ok(await readPersonPhotos(db, new PeopleReadContext(authority), { personIds: [person] }));
		const files = ok(await documentsWriter.listOwned(db, authority, {})).documents.map((d) => d.id);
		return {
			listed: directory.items.filter((x) => x.id === person).map((x) => x.displayName),
			photo: photos.photos.length,
			bytes: await photoRead(storage, f.a, photo),
			files,
			text: JSON.stringify([directory, photos]),
		};
	};
	const rows = async () =>
		(
			await admin.execute<{
				weeks: number;
				others: number;
				da: number;
				dp: number;
				moved: number;
				linked: string | null;
			}>(
				sql`SELECT (SELECT count(*)::int FROM private_week WHERE author_id=${a.id}) weeks,
				(SELECT count(*)::int FROM private_week WHERE author_id=${f.a.id}) others,
				(SELECT count(*)::int FROM document_revision WHERE id=${DA.version}) da,
				(SELECT count(*)::int FROM document_revision WHERE id=${DP.version} AND body='Church plan body') dp,
				(SELECT count(*)::int FROM document WHERE id=${DA.id} AND tenant_id<>${a.id}) moved,
				(SELECT linked_account_id::text FROM person WHERE id=${person}) linked`,
			)
		).rows[0]!;
	const before = await owner();
	assert.deepEqual([before.listed, before.photo, before.bytes], [["Alex Admin"], 1, "bytes"]);
	assert.deepEqual(before.files, [DP.id], "another account's own file is never in the church's list");
	assert.equal(before.text.includes("CARE-CANARY"), false);

	const revision = (await admin.select().from(t.account).where(eq(t.account.id, a.id)))[0]!.revision;
	const pending = ok(await call("requestAccountDeletion", a, command({ confirmed: true }, revision)));
	const hidden = await owner();
	assert.deepEqual([hidden.listed, hidden.photo, hidden.bytes], [["Alex Admin"], 0, "refused"]);
	assert.deepEqual(hidden.files, [DP.id]);
	assert.equal(await viewerOf(a), null);
	const mineNow = await care.readCurrent(db, mine, {});
	assert.equal(mineNow.status === "refused" && mineNow.error.code, "access_denied");
	const ownFiles = await documentsWriter.listOwned(db, mine, {});
	assert.equal(ownFiles.status, "refused", "the deleted login reads no file of its own");
	assert.deepEqual(
		{ ...(await rows()), linked: undefined },
		{ weeks: 1, others: 0, da: 1, dp: 1, moved: 0, linked: undefined },
	);

	const early = createLifecycleCleanup(cleanupDb, {
		authorize: async () => true,
		removeOwnedResources: async () => {
			throw Error("nothing is removed before the deadline");
		},
	});
	const waiting = await early({ subject, requestId: pending.requestId, revision: pending.revision }).catch(
		(e: Error) => e,
	);
	assert.deepEqual(waiting instanceof Error ? waiting.message : waiting.status, "deadline_passed");
	assert.deepEqual(
		{ ...(await rows()), linked: undefined },
		{ weeks: 1, others: 0, da: 1, dp: 1, moved: 0, linked: undefined },
		"the material is kept for the 30 days",
	);

	await admin.transaction(async (tx) => {
		await tx.execute(sql`ALTER TABLE lifecycle_witness DISABLE TRIGGER USER`);
		await tx.execute(sql`UPDATE lifecycle_witness SET requested_at=requested_at-interval '31 days',
			cancel_until=cancel_until-interval '31 days' WHERE opaque_subject_id=${a.id}`);
		await tx.execute(sql`ALTER TABLE lifecycle_witness ENABLE TRIGGER USER`);
	});
	const deleted: string[] = [];
	const bucket = stubStorage((operation, input) => {
		assert.equal(operation, "DeleteObjectCommand");
		deleted.push(objectInput.parse(input).Key);
		return {};
	});
	const purge = createLifecycleCleanup(cleanupDb, {
		authorize: async () => true,
		removeOwnedResources: async () => {
			const removed = await deleteUnreferencedObject(
				cleanupDb,
				bucket,
				async (_tx, identity) =>
					identity.tenant_id === subject.id ? { kind: "system" as const, cause: "object_cleanup" as const } : null,
				photo.versionId,
			);
			return removed.status === "inaccessible";
		},
	});
	const church = async () =>
		(
			await admin.execute(sql`SELECT (SELECT count(*)::int FROM audit_event WHERE tenant_id=${f.p.id}) audits,
				(SELECT count(*)::int FROM notice) notices,(SELECT count(*)::int FROM mail) mail,
				(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM document d WHERE d.tenant_id=${f.p.id}) documents,
				(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM seat s WHERE s.account_id=${f.a.id}) seats`)
		).rows[0];
	const unmoved = await church();
	const done = await purge({ subject, requestId: pending.requestId, revision: pending.revision });
	assert.equal(done.status, "purged");
	assert.equal(deleted.length, 1);
	assert.deepEqual(await rows(), { weeks: 0, others: 0, da: 0, dp: 1, moved: 0, linked: null });
	assert.deepEqual(
		await church(),
		unmoved,
		"the purge adds no church event, notice or mail and moves nothing to anyone",
	);
	assert.deepEqual(
		(await admin.execute(sql`SELECT count(*)::int n FROM document_revision WHERE body='Private plan body'`)).rows,
		[{ n: 0 }],
	);
	const after = await owner();
	assert.deepEqual([after.listed, after.photo, after.bytes], [["Alex Admin"], 0, "refused"]);
	assert.deepEqual(after.files, [DP.id], "DA is not visible and DP is retained");
	const kept = await admin.execute(sql`SELECT d::text AS row FROM document d WHERE d.tenant_id=${f.p.id}`);
	assert.equal(JSON.stringify(kept.rows).includes(a.id), false, "no private author on the church's document");
});

test("INV-settings-preview: expiry is checked independently from actor, subject, revision, source and zone matching", async () => {
	const f = await plant();
	const plantPreview = ok(await call("previewPlantTimezone", f.a, { plant: f.p, timeZone: "America/New_York" }, f.p));
	await admin
		.update(t.settings_preview)
		.set({ expires_at: sql`clock_timestamp()-interval '1 second'` })
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
		.set({ expires_at: sql`clock_timestamp()-interval '1 second'` })
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
const statements: string[] = [];
async function mountRead<K extends SectionName>(a: Session, request: { section: K } & Record<string, unknown>) {
	const viewer = await seen(a);
	statements.length = 0;
	recording = true;
	try {
		const value = await readSection(viewer, request);
		return { value: ok(value), statements: [...statements] };
	} finally {
		recording = false;
	}
}
const mounted = <K extends SectionName>(
	a: Session,
	request: { section: K } & Record<string, unknown>,
	observe: (value: SectionOf<K>) => unknown[],
	expected: unknown[],
) => ({
	section: request.section,
	expected,
	read: async () => {
		const { value, statements } = await mountRead(a, request);
		return { observed: observe(value), statements };
	},
});
const instrumented = new WeakSet();
function instrument(...pools: Database[]) {
	for (const pool of pools)
		pool.$client.on("acquire", (client) => {
			if (instrumented.has(client)) return;
			instrumented.add(client);
			const query = client.query;
			client.query = function (...args: unknown[]) {
				if (recording) statements.push(statementText(args[0]));
				return Reflect.apply(query, this, args);
			};
		});
}
test("INV-performance: each settings section reads in one statement on the pool, without a transaction", async () => {
	instrument(db);
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
	const reads = [
		mounted(f.a, { section: "account" }, (v) => [v.name, v.email], ["Synthetic", f.a.user + "@example.test"]),
		mounted(f.a, { section: "notifications" }, (v) => [v.values.planterCadence, v.values.oversightCadence], [
			"weekly",
			null,
		]),
		mounted(f.a, { section: "plant", plant: f.p }, (v) => [v.values.profile.name, v.values.timeZone], [
			"Harvest Point",
			"America/Chicago",
		]),
		mounted(f.a, { section: "teams", plant: f.p, teamId: team!.id }, (v) => [v.name, v.revision], ["Worship", "1"]),
		mounted(
			org.a,
			{ section: "organization", organization: org.o },
			(v) => {
				assert.ok(v.values.status === "available");
				return [v.values.profile.name];
			},
			["Network"],
		),
		mounted(
			f.a,
			{ section: "affiliations", ...sharing },
			(v) => {
				assert.ok("choices" in v.values);
				return [v.values.view, v.values.choices.people];
			},
			["plant_administration", true],
		),
		mounted(
			org.a,
			{ section: "affiliations", ...sharing },
			(v) => {
				assert.ok("availability" in v.values);
				return [v.values.view, v.values.availability.people];
			},
			["organization", true],
		),
	];
	for (const { section, expected, read } of reads) {
		const { observed, statements } = await read();
		assert.deepEqual(observed, expected, section);
		assert.equal(statements.length, 1, `${section}: ${statements.join("\n")}`);
	}
});
test("INV-authority: a settings read checks seat, role, session and lifecycle again; a viewer that lost them since its lookup reads nothing", async () => {
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
	type Request = { section: SectionName } & Record<string, unknown>;
	const church: Request[] = [
		{ section: "plant", plant: f.p },
		{ section: "teams", plant: f.p, teamId: team!.id },
		{ section: "affiliations", plant: f.p, organization: org.o },
	];
	const cases: [string, () => Promise<Account>, Request[], (a: Account) => PromiseLike<unknown>][] = [
		[
			"admin downgraded to member",
			() => seat(f.p),
			church,
			(a) => admin.update(t.seat).set({ role: "member", revision: "2" }).where(eq(t.seat.account_id, a.id)),
		],
		[
			"admin seat removed",
			() => seat(f.p),
			church,
			(a) => admin.update(t.seat).set({ ended_at: new Date(), revision: "2" }).where(eq(t.seat.account_id, a.id)),
		],
		[
			"organization seat removed",
			async () => {
				const a = await actor();
				await admin
					.insert(t.seat)
					.values({ account_id: a.id, organization_id: org.o.id, role: "admin", accepted_at: new Date() });
				return a;
			},
			[
				{ section: "organization", organization: org.o },
				{ section: "affiliations", plant: f.p, organization: org.o },
			],
			(a) => admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.account_id, a.id)),
		],
		[
			"session signed out",
			() => actor(),
			[{ section: "account" }, { section: "notifications" }],
			(a) => admin.delete(t.auth_session).where(eq(t.auth_session.id, a.session)),
		],
	];
	for (const [change, make, requests, mutate] of cases) {
		const a = await make();
		const viewer = await seen(a);
		for (const request of requests) ok(await api.getSection(db, viewer, request));
		await mutate(a);
		for (const request of requests)
			assert.equal((await api.getSection(db, viewer, request)).status, "refused", `${change}: ${request.section}`);
	}
});
test("BUG-3213d18: notifications read the account's saved choices and an organization seat's digest", async () => {
	const org = await organization();
	await admin.execute(
		sql`INSERT INTO notification_preference(account_id,category,channel,enabled,cadence,unsubscribe_revision) VALUES(${org.a.id},'task_due','email',false,null,1),(${org.a.id},'planter_digest','email',true,'daily',1),(${org.a.id},'oversight_digest','email',true,'daily',1)`,
	);
	const read = ok(await section(org.a, { section: "notifications" }));
	const choice = (category: string, channel: string) =>
		read.values.choices.find((c) => c.category === category && c.channel === channel)?.enabled;
	assert.equal(choice("task_due", "email"), false);
	assert.equal(choice("task_due", "in_app"), true);
	assert.deepEqual(
		read.values.choices.filter((c) => c.category === "oversight_digest").map((c) => [c.channel, c.enabled]),
		[
			["email", true],
			["in_app", true],
		],
	);
	assert.equal(read.values.planterCadence, "daily");
	assert.equal(read.values.oversightCadence, "daily");
	const patch = { kind: "channel", choice: { category: "task_due", channel: "email", enabled: true } };
	ok(await save(org.a, command({ section: "notifications", patch }, read.revision)));
	const [stored] = await admin
		.select()
		.from(t.notification_preference)
		.where(
			and(
				eq(t.notification_preference.account_id, org.a.id),
				eq(t.notification_preference.category, "task_due"),
				eq(t.notification_preference.channel, "email"),
			),
		);
	assert.equal(stored!.enabled, true);
	const reload = ok(await section(org.a, { section: "notifications" }));
	assert.equal(reload.values.choices.find((c) => c.category === "task_due" && c.channel === "email")!.enabled, true);
});

async function mountWrite<V>(a: Session, body: (tx: WriteTx, context: SettingsContext) => Promise<SettingsReply<V>>) {
	const viewer = await seen(a),
		context = ctx(a);
	statements.length = 0;
	recording = true;
	try {
		const value = ok(await withSettingsWrite(db, viewer.authority, context, (tx) => body(tx, context)));
		return { value, count: statements.length };
	} finally {
		recording = false;
	}
}
const auditOf = (requestKey: string) =>
	admin.execute(
		sql`SELECT action, metadata, result FROM audit_event WHERE command_id=(SELECT id FROM audit_event WHERE request_key=${requestKey})`,
	);
test("INV-performance: photo, own time zone and deletion writes use a fixed small statement count and one audit row naming only fields", async () => {
	instrument(db);
	const a = await actor();
	const upload = await mountWrite(a, (tx, c) => api.requestAvatarUpload(tx, c, { mime: "image/png", byteLength: 68 }));
	await admin
		.update(t.file_object)
		.set({ state: "ready", byte_count: "68", sha256: "0".repeat(64) })
		.where(eq(t.file_object.id, upload.value.uploadId));
	const finalizeKey = randomUUID();
	const finalized = await mountWrite(a, (tx, c) =>
		api.finalizeAvatar(tx, c, command({ uploadId: upload.value.uploadId }, "1", finalizeKey)),
	);
	assert.deepEqual(finalized.value, {
		status: "available",
		avatar: { accountId: a.id, versionId: upload.value.uploadId },
	});
	const retriedPhoto = await mountWrite(a, (tx, c) =>
		api.finalizeAvatar(tx, c, command({ uploadId: upload.value.uploadId }, "1", finalizeKey)),
	);
	assert.deepEqual(retriedPhoto.value, finalized.value);
	const removeKey = randomUUID();
	const removed = await mountWrite(a, (tx, c) => api.removeAvatar(tx, c, command({}, "2", removeKey)));
	assert.deepEqual(removed.value, { status: "absent" });
	const preview = await mountWrite(a, (tx, c) => api.previewPersonalTimezone(tx, c, { timeZone: "Europe/Paris" }));
	const zoneKey = randomUUID();
	const zone = await mountWrite(a, (tx, c) =>
		api.setPersonalTimezone(
			tx,
			c,
			command({ timeZone: "Europe/Paris", previewId: preview.value.previewId, confirmed: true }, "1", zoneKey),
		),
	);
	assert.deepEqual(zone.value.preference, { status: "confirmed", timeZone: "Europe/Paris", revision: "2" });
	const retried = await mountWrite(a, (tx, c) =>
		api.setPersonalTimezone(
			tx,
			c,
			command({ timeZone: "Europe/Paris", previewId: preview.value.previewId, confirmed: true }, "1", zoneKey),
		),
	);
	assert.deepEqual(retried.value, zone.value);
	const deletionKey = randomUUID();
	const deletion = await mountWrite(a, (tx, c) =>
		api.requestAccountDeletion(tx, c, command({ confirmed: true }, "4", deletionKey)),
	);
	assert.equal(deletion.value.status, "pending_deletion");
	for (const [key, field] of [
		[finalizeKey, "avatar"],
		[removeKey, "avatar"],
		[zoneKey, "personalTimezone"],
	] as const) {
		const rows = (await auditOf(key)).rows;
		assert.equal(rows.length, 1, field);
		assert.deepEqual(rows[0]!.metadata, { section: "account", diff: { [field]: true } });
	}
	assert.equal((await auditOf(deletionKey)).rows.length, 1);
	assert.deepEqual((await auditOf(zoneKey)).rows[0]!.result, { revision: "2" });
	assert.deepEqual((await auditOf(finalizeKey)).rows[0]!.result, {});
	assert.deepEqual((await auditOf(removeKey)).rows[0]!.result, {});
});

test("AC:DEL58-002 INV-performance: a fresh password proof opens only the account's current request; status and cancel stay small", async () => {
	instrument(db);
	const a = await credentialActor();
	const [row] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
	const pending = ok(await call("requestAccountDeletion", a, command({ confirmed: true }, row!.revision)));
	const open = (password: string) => producerDeps.credentials.openAccountDeletion({ email: a.email, password }, null);
	assert.deepEqual(await open("Wrong secret 1234!"), { status: "refused", code: "proof_invalid" });
	const opened = await open(a.password);
	assert.ok(opened.status === "ok", JSON.stringify(opened));
	assert.deepEqual(opened.value.subject, { kind: "account", id: a.id });
	assert.equal(opened.value.requestId, pending.requestId);
	assert.equal(await viewerOf(await login(a)), null);
	const request = { subject: opened.value.subject, requestId: opened.value.requestId };
	const proof = await openedDeletion(opened.value.session, request);
	const measured = async <V,>(body: (tx: WriteTx) => Promise<SettingsReply<V>>) => {
		statements.length = 0;
		recording = true;
		try {
			return { value: ok(await gatedTransaction(db, body)), count: statements.length };
		} finally {
			recording = false;
		}
	};
	const status = await measured((tx) => api.getAccountDeletionStatus(tx, proof, request));
	assert.deepEqual(status.value, pending);
	const cancelled = await measured((tx) => api.cancelAccountDeletion(tx, proof, command(request, pending.revision)));
	assert.equal(cancelled.value.status, "cancelled");
	assert.equal(status.count, 5);
	const fresh = await login(a);
	assert.notEqual(await viewerOf(fresh), null);
	ok(await section(fresh, { section: "account" }));
});

test("INV-statements: settings writes lock their related rows in one statement each", async () => {
	instrument(db);
	const counted = async <V,>(body: () => Promise<V>) => {
		statements.length = 0;
		recording = true;
		try {
			return { value: await body(), count: statements.length };
		} finally {
			recording = false;
		}
	};
	const calls = { preview: 0, apply: 0 };
	const producer = settingsApi({
		...producerDeps,
		personalCalendar: {
			preview: async () => void calls.preview++,
			apply: async () => !!++calls.apply,
		},
	});
	const owner = await credentialActor();
	const f = await plant(owner);
	const solo = await credentialActor();
	await credentialSeat(f.p, "member");
	await admin.insert(t.task).values({
		id: randomUUID(),
		plant_id: f.p.id,
		title: "Future task",
		category: "general",
		priority: "medium",
		status: "not_started",
		created_at: new Date(),
		due_kind: "date_only",
		due_date: "2099-01-15",
	});
	const run = <V,>(body: (tx: WriteTx, context: SettingsContext) => Promise<SettingsReply<V>>, selected?: Owner) =>
		counted(async () => ok(await gatedTransaction(db, (tx) => body(tx, ctx(owner, selected)))));

	const personal = await run((tx, c) => producer.previewPersonalTimezone(tx, c, { timeZone: "Europe/Paris" }));
	const personalSet = await run((tx, c) =>
		producer.setPersonalTimezone(
			tx,
			c,
			command({ timeZone: "Europe/Paris", previewId: personal.value.previewId, confirmed: true }, "1"),
		),
	);
	assert.deepEqual(personalSet.value.preference, { status: "confirmed", timeZone: "Europe/Paris", revision: "2" });
	assert.deepEqual(calls, { preview: 1, apply: 1 });
	const seatless = await gatedTransaction(db, (tx) =>
		producer.previewPersonalTimezone(tx, ctx(solo), { timeZone: "Asia/Tokyo" }),
	);
	ok(
		await gatedTransaction(db, (tx) =>
			producer.setPersonalTimezone(
				tx,
				ctx(solo),
				command({ timeZone: "Asia/Tokyo", previewId: ok(seatless).previewId, confirmed: true }, "1"),
			),
		),
	);
	assert.deepEqual(calls, { preview: 1, apply: 1 });

	const church = await run(
		(tx, c) => producer.previewPlantTimezone(tx, c, { plant: f.p, timeZone: "America/New_York" }),
		f.p,
	);
	const churchSet = await run(
		(tx, c) =>
			producer.setPlantTimezone(
				tx,
				c,
				command(
					{ plant: f.p, timeZone: "America/New_York", previewId: church.value.previewId },
					church.value.expectedRevision,
				),
			),
		f.p,
	);
	assert.equal(churchSet.value.status, "changed");

	const [root] = await admin.select().from(t.plant).where(eq(t.plant.id, f.p.id));
	const viewer = await seen(owner);
	const requested = await counted(async () =>
		ok(
			await withSettingsWrite(db, viewer.authority, ctx(owner, f.p), (tx) =>
				producer.requestWorkspaceDeletion(
					tx,
					ctx(owner, f.p),
					command({ plant: f.p, confirmed: true }, root!.revision),
				),
			),
		),
	);
	assert.equal(requested.value.status, "pending_deletion");
	const opened = await openWorkspace(owner);
	assert.ok(opened.status === "ok");
	const request = { subject: opened.value.subject, requestId: opened.value.requestId };
	const proof = await openedDeletion(opened.value.session, request);
	const cancel = () =>
		gatedTransaction(db, (tx) =>
			producer.cancelWorkspaceDeletion(tx, proof, command(request, requested.value.revision)),
		);
	const [ownerSeat] = await admin.select().from(t.seat).where(eq(t.seat.account_id, owner.id));
	await admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.id, ownerSeat!.id));
	denied(await cancel());
	await admin.update(t.seat).set({ ended_at: null }).where(eq(t.seat.id, ownerSeat!.id));
	const cancelled = await counted(async () => ok(await cancel()));
	assert.equal(cancelled.value.status, "cancelled");

	const [account] = await admin.select().from(t.account).where(eq(t.account.id, solo.id));
	const pending = ok(await call("requestAccountDeletion", solo, command({ confirmed: true }, account!.revision)));
	const openedAccount = await counted(() =>
		producerDeps.credentials.openAccountDeletion({ email: solo.email, password: solo.password }, null),
	);
	assert.ok(openedAccount.value.status === "ok");
	assert.deepEqual(openedAccount.value.value.subject, { kind: "account", id: solo.id });
	assert.equal(openedAccount.value.value.requestId, pending.requestId);

	assert.deepEqual(
		{
			previewPersonalTimezone: personal.count,
			setPersonalTimezone: personalSet.count,
			setPlantTimezone: churchSet.count,
			requestWorkspaceDeletion: requested.count,
			cancelWorkspaceDeletion: cancelled.count,
			openAccountDeletion: openedAccount.count,
		},
		{
			previewPersonalTimezone: 7,
			setPersonalTimezone: 9,
			setPlantTimezone: 9,
			requestWorkspaceDeletion: 8,
			cancelWorkspaceDeletion: 8,
			openAccountDeletion: 5,
		},
	);
});

test("INV-account-revision people/peo-3: Your account and notifications share one revision; a save in one moves the other's and the old revision is refused", async () => {
	const a = await seated(await actor());
	const account = ok(await section(a, { section: "account" }));
	const notifications = ok(await section(a, { section: "notifications" }));
	assert.equal(notifications.revision, account.revision);
	const toggle = { kind: "channel", choice: { category: "task_due", channel: "email", enabled: false } };
	const named = ok(await save(a, command({ section: "account", name: "Shared Revision" }, account.revision)));
	assert.notEqual(named.current.revision, account.revision);
	assert.equal(ok(await section(a, { section: "notifications" })).revision, named.current.revision);
	const stale = await save(a, command({ section: "notifications", patch: toggle }, account.revision));
	assert.equal(stale.status, "refused", JSON.stringify(stale));
	assert.equal(stale.error.code, "conflict");
	const toggled = ok(await save(a, command({ section: "notifications", patch: toggle }, named.current.revision)));
	assert.equal(ok(await section(a, { section: "account" })).revision, toggled.current.revision);
	denied(await save(a, command({ section: "account", name: "Too Old" }, named.current.revision)), "conflict");
	assert.equal(ok(await section(a, { section: "account" })).name, "Shared Revision");
});

test("an organization's Owner offers its plants a gathering milestone in its profile; a Member reads it and is refused a save with nothing written", async () => {
	const org = await organization();
	const member = await actor();
	await admin
		.insert(t.seat)
		.values({ account_id: member.id, organization_id: org.o.id, role: "member", accepted_at: new Date() });
	const offered = async (a: Session) => {
		const { values } = ok(await section(a, { section: "organization", organization: org.o }));
		assert.ok(values.status === "available");
		return values.profile.gatheringMilestone;
	};
	const milestone = (value: object) => ({
		section: "organization" as const,
		organization: org.o,
		patch: { gatheringMilestone: value },
	});
	const stored = async () =>
		(
			await admin.execute(
				sql`SELECT gathering_milestone_offered AS offered,gathering_milestone_name AS name,
				gathering_milestone_description AS description,revision::text AS revision FROM organization WHERE id=${org.o.id}`,
			)
		).rows[0];
	assert.deepEqual(await offered(org.a), {
		offered: false,
		name: null,
		description: null,
	});

	const saved = ok(
		await save(
			org.a,
			command(
				milestone({ offered: true, name: " Constituted as a church ", description: "Adopts its constitution.\r\n" }),
			),
			org.o,
		),
	);
	const value = { offered: true, name: "Constituted as a church", description: "Adopts its constitution." };
	assert.deepEqual(saved.current.values.profile.gatheringMilestone, value);
	assert.deepEqual(await offered(org.a), value);
	assert.deepEqual(await offered(member), value);
	const audit = (
		await admin.execute(
			sql`SELECT after_value FROM audit_event WHERE subject_id=${org.o.id} AND action='organization.profile_changed' ORDER BY recorded_at DESC LIMIT 1`,
		)
	).rows[0]!.after_value;
	assert.deepEqual(audit, {
		gathering_milestone_offered: true,
		gathering_milestone_name: "Constituted as a church",
		gathering_milestone_description: "Adopts its constitution.",
	});

	const before = await stored();
	denied(await save(member, command(milestone({ offered: false, name: null, description: null }), "2"), org.o));
	assert.deepEqual(await stored(), before);

	for (const bad of [
		{ offered: true, name: "  ", description: null },
		{ offered: true, name: "a".repeat(121), description: null },
		{ offered: true, name: "Constituted", description: "a".repeat(2001) },
	])
		denied(await save(org.a, command(milestone(bad), "2"), org.o), "invalid_input");
	assert.deepEqual(await stored(), before);
	ok(
		await save(
			org.a,
			command(milestone({ offered: true, name: "a".repeat(120), description: "a".repeat(2000) }), "2"),
			org.o,
		),
	);
	ok(await save(org.a, command(milestone({ offered: false, name: "a".repeat(120), description: null }), "3"), org.o));
	assert.deepEqual(await stored(), { offered: false, name: "a".repeat(120), description: null, revision: "4" });
});

const ZONE_EDIT_AT = instant.parse("2026-10-13T16:00:00.000Z");
const DUE = "2026-10-13";
const FIXED = "2026-10-20T15:00:00.000Z";
const CHICAGO_MIDNIGHT = instant.parse("2026-10-14T05:00:00Z");
const AUCKLAND_MIDNIGHT = instant.parse("2026-10-13T11:00:00Z");
const justBefore = (at: Instant) => instant.parse(new Date(Date.parse(at) - 1).toISOString());

async function zoneChurch() {
	const f = await plant(),
		zoneAdmin = await seat(f.p),
		member = await seat(f.p, "member"),
		foreign = await plant();
	const [past, later, meeting] = [randomUUID(), randomUUID(), randomUUID()];
	await insertTasks(
		admin,
		[
			{ id: past, title: "Due today", due_date: DUE },
			{ id: later, title: "Due later", due_date: "2026-10-20" },
		].map((task) => ({
			...task,
			plant_id: f.p.id,
			category: "general" as const,
			priority: "medium" as const,
			status: "not_started" as const,
			created_at: new Date(),
			due_kind: "date_only" as const,
		})),
	);
	await admin.insert(t.meeting).values({
		id: meeting,
		plant_id: f.p.id,
		type: "vision_meeting",
		title: "Fixed appointment",
		local_date: "2026-10-20",
		local_time: "10:00:00",
		timezone: "America/Chicago",
		starts_at: new Date(FIXED),
		resolver_version: "1",
		status: "planning",
		attendance_revision: "1",
	});
	const frozen = settingsApi({ ...producerDeps, clock: frozenClock(ZONE_EDIT_AT) });
	const preview = (who: Session, timeZone: string, selected: Plant = f.p) =>
		gatedTransaction(db, (tx) => frozen.previewPlantTimezone(tx, ctx(who, selected), { plant: f.p, timeZone }));
	const set = (who: Session, q: ReturnType<typeof command>, selected: Plant = f.p) =>
		gatedTransaction(db, (tx) => frozen.setPlantTimezone(tx, ctx(who, selected), q));
	const change = (zone: string, previewId: string, expectedRevision = "1", requestKey: string = randomUUID()) =>
		command({ plant: f.p, timeZone: zone, previewId }, expectedRevision, requestKey);
	const stored = async () => ({
		plant: (
			await admin.execute(
				sql`SELECT timezone,revision::text,material_revision::text AS material FROM plant WHERE id=${f.p.id}`,
			)
		).rows[0],
		tasks: (
			await admin.execute(
				sql`SELECT title,due_kind,due_date::text,due_time,due_at,timezone,revision::text FROM task WHERE plant_id=${f.p.id} ORDER BY title`,
			)
		).rows,
		meeting: (
			await admin.execute(
				sql`SELECT local_date::text,local_time::text,timezone,starts_at=${FIXED}::timestamptz AS fixed,revision::text FROM meeting WHERE id=${meeting}`,
			)
		).rows[0],
	});
	const effects = async () =>
		(
			await admin.execute(sql`SELECT (SELECT count(*)::int FROM audit_event WHERE tenant_id=${f.p.id} AND action='plant.profile_changed' AND subject_type<>'command') AS events,
				(SELECT count(*)::int FROM audit_event WHERE tenant_id=${f.p.id}) AS audits,
				(SELECT count(*)::int FROM job WHERE tenant_id=${f.p.id} AND producer_key LIKE 'settings/plant_timezone/%') AS intents,
				(SELECT count(*)::int FROM notice WHERE tenant_id=${f.p.id}) AS notices`)
		).rows[0];
	const reader = await RequestActor.resolve(db, zoneAdmin.session);
	assert.ok(reader instanceof RequestActor);
	const overdueTask = async (asOf: Instant) => {
		const page = ok(await gatedTransaction(db, (tx) => taskReader.list(tx, reader, { asOf })));
		const row = page.items.find((i: { id: string }) => i.id === past);
		assert.ok(row);
		return row.overdue;
	};
	return { ...f, zoneAdmin, member, foreign, past, later, preview, set, change, stored, effects, overdueTask };
}

test("AC:B03-013 AC:B03-015 AC:TARGET-IDN-011 a church zone preview shows every moved time and keeps due dates and fixed appointments, and the change moves only the boundaries it showed", async () => {
	const c = await zoneChurch();
	const start = await c.stored();
	const quiet = await c.effects();
	denied(await c.preview(c.member, "Pacific/Auckland"));
	denied(await c.preview(c.foreign.a, "Pacific/Auckland", c.foreign.p));
	const preview = ok(await c.preview(c.zoneAdmin, "Pacific/Auckland"));
	assert.deepEqual(preview, {
		previewId: preview.previewId,
		plant: c.p,
		expectedRevision: "1",
		asOf: ZONE_EDIT_AT,
		expiresAt: "2026-10-13T16:15:00.000Z",
		oldZone: "America/Chicago",
		newZone: "Pacific/Auckland",
		meetings: [],
		digests: [
			{ id: c.p.id, before: "2026-10-18T21:00:00.000Z", after: "2026-10-18T03:00:00.000Z" },
			{ id: c.p.id, before: "2026-10-25T21:00:00.000Z", after: "2026-10-25T03:00:00.000Z" },
		],
		reminders: [
			{ id: c.past, before: "2026-10-14T14:00:00.000Z", after: "2026-10-13T20:00:00.000Z" },
			{ id: c.later, before: "2026-10-20T14:00:00.000Z", after: "2026-10-19T20:00:00.000Z" },
			{ id: c.later, before: "2026-10-21T14:00:00.000Z", after: "2026-10-20T20:00:00.000Z" },
		].sort((a, b) => a.id.localeCompare(b.id)),
		preservedTaskDates: [
			{ id: c.past, date: DUE },
			{ id: c.later, date: "2026-10-20" },
		].sort((a, b) => a.id.localeCompare(b.id)),
		completeness: "bounded",
		warnings: ["more_results"],
	});
	const { date } = preview.preservedTaskDates.find((d) => d.id === c.past)!;
	const boundary = (zone: typeof preview.newZone, at: Instant) =>
		[justBefore(at), at].map((asOf) => overdueAt({ kind: "local_date", date }, zone, asOf));
	assert.equal(date, DUE);
	assert.deepEqual(boundary(preview.newZone, AUCKLAND_MIDNIGHT), [false, true]);
	assert.deepEqual(boundary(preview.oldZone, CHICAGO_MIDNIGHT), [false, true]);
	assert.deepEqual(await c.stored(), start, "a preview changes nothing");
	assert.deepEqual(await c.effects(), quiet, "a preview records nothing");
	assert.deepEqual(
		[await c.overdueTask(justBefore(CHICAGO_MIDNIGHT)), await c.overdueTask(CHICAGO_MIDNIGHT)],
		[false, true],
	);

	const q = c.change("Pacific/Auckland", preview.previewId);
	denied(await c.set(c.member, q));
	denied(await c.set(c.foreign.a, q, c.foreign.p));
	denied(await c.set(c.a, q), "stale_preview");
	assert.deepEqual([await c.stored(), await c.effects()], [start, quiet]);
	const changed = ok(await c.set(c.zoneAdmin, q));
	assert.equal(changed.status, "changed");
	assert.equal(changed.timeZone, "Pacific/Auckland");
	assert.deepEqual(ok(await c.set(c.zoneAdmin, q)), changed, "the same intent again answers the same change");
	const after = await c.stored();
	assert.deepEqual([after.tasks, after.meeting], [start.tasks, start.meeting]);
	assert.deepEqual(after.meeting, {
		local_date: "2026-10-20",
		local_time: "10:00:00",
		timezone: "America/Chicago",
		fixed: true,
		revision: "1",
	});
	assert.deepEqual(after.plant, {
		timezone: "Pacific/Auckland",
		revision: "2",
		material: String(Number(start.plant!.material) + 1),
	});
	const counted = z.object({ events: z.int(), audits: z.int(), intents: z.int(), notices: z.int() });
	const base = counted.parse(quiet);
	assert.deepEqual(await c.effects(), {
		events: base.events + 1,
		audits: base.audits + 1,
		intents: base.intents + 1,
		notices: base.notices,
	});
	assert.deepEqual(
		[await c.overdueTask(justBefore(AUCKLAND_MIDNIGHT)), await c.overdueTask(AUCKLAND_MIDNIGHT)],
		[false, true],
	);
});

test("AC:B03-017 of two zone edits reviewed on one church state one wins and one is refused, the same zone adds nothing and a failed replanning insert leaves the church as it was", async () => {
	const c = await zoneChurch();
	const quiet = z
		.object({ events: z.int(), audits: z.int(), intents: z.int(), notices: z.int() })
		.parse(await c.effects());
	const previews = {
		auckland: ok(await c.preview(c.zoneAdmin, "Pacific/Auckland")),
		london: ok(await c.preview(c.zoneAdmin, "Europe/London")),
	};
	const start = await c.stored();
	await admin.execute(
		sql.raw(`CREATE FUNCTION "${database.schema}".refuse_zone_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
			IF NEW.tenant_id='${c.p.id}' AND NEW.producer_key LIKE 'settings/plant_timezone/%' THEN RAISE EXCEPTION 'replan_intent_insert'; END IF;
			RETURN NEW; END $$`),
	);
	await admin.execute(
		sql.raw(
			`CREATE TRIGGER refuse_zone_intent BEFORE INSERT ON job FOR EACH ROW EXECUTE FUNCTION "${database.schema}".refuse_zone_intent()`,
		),
	);
	const q = c.change("Pacific/Auckland", previews.auckland.previewId);
	try {
		await assert.rejects(c.set(c.zoneAdmin, q), (e) => {
			assert.ok(e instanceof Error);
			assert.match(String(e.cause ?? e), /replan_intent_insert/);
			return true;
		});
	} finally {
		await admin.execute(sql.raw("DROP TRIGGER refuse_zone_intent ON job"));
	}
	assert.deepEqual(await c.stored(), start);
	assert.equal(start.plant!.timezone, "America/Chicago");
	assert.equal(start.plant!.revision, "1");
	assert.deepEqual(await c.effects(), quiet);

	const replies = await Promise.all([
		c.set(c.zoneAdmin, q),
		c.set(c.zoneAdmin, c.change("Europe/London", previews.london.previewId)),
	]);
	const winners = replies.filter((r) => r.status === "ok");
	assert.equal(winners.length, 1, JSON.stringify(replies));
	denied(
		replies.find((r) => r.status === "refused")!,
		"conflict",
	);
	const won = ok(winners[0]!);
	assert.equal(won.status, "changed");
	const one = { ...quiet, events: quiet.events + 1, audits: quiet.audits + 1, intents: quiet.intents + 1 };
	assert.deepEqual(await c.effects(), one);
	assert.deepEqual([(await c.stored()).plant!.timezone, (await c.stored()).plant!.revision], [won.timeZone, "2"]);
	denied(
		await c.set(c.zoneAdmin, c.change("Pacific/Auckland", previews.auckland.previewId, "1", randomUUID())),
		"conflict",
	);
	const same = ok(await c.preview(c.zoneAdmin, won.timeZone));
	const noop = ok(await c.set(c.zoneAdmin, c.change(won.timeZone, same.previewId, "2")));
	assert.equal(noop.status, "noop");
	assert.equal(noop.revision, "2");
	const settled = z
		.object({ events: z.int(), audits: z.int(), intents: z.int(), notices: z.int() })
		.parse(await c.effects());
	assert.deepEqual([settled.events, settled.intents, settled.notices], [one.events, one.intents, one.notices]);
});

test("AC:ROLE43-002 only the Owner's confirmed request deletes the church workspace, and nobody's request reaches another login", async () => {
	const f = await plant(),
		other = await plant();
	const roles = { Admin: await seat(f.p), Member: await seat(f.p, "member"), CRM_lead: await seat(f.p, "member") };
	const team = randomUUID(),
		person = randomUUID();
	await admin.insert(t.person).values({
		id: person,
		tenant_id: f.p.id,
		plant_id: f.p.id,
		display_name: "Lead planter",
		source: "other",
		stage: "leader",
		adult_classification: "adult",
		commitment_state: "unknown",
		pipeline_position: "1",
		state: "live",
		created_at: new Date(),
		linked_account_id: roles.CRM_lead.id,
	});
	await admin.insert(t.team).values({
		id: team,
		plant_id: f.p.id,
		name: "Plant leadership",
		state: "active",
		sort_order: 1,
		leader_person_id: person,
		leader_source: "explicit",
	});
	const revisionOf = async (p: Plant) =>
		String((await admin.execute(sql`SELECT revision::text AS r FROM plant WHERE id=${p.id}`)).rows[0]!.r);
	const footprint = async () =>
		(
			await admin.execute(sql`SELECT (SELECT count(*)::int FROM lifecycle_witness) AS witnesses,
				(SELECT count(*)::int FROM audit_event) AS audits,(SELECT count(*)::int FROM job) AS jobs,
				(SELECT count(*)::int FROM mail) AS mail,(SELECT count(*)::int FROM auth_session) AS sessions`)
		).rows[0];
	const revision = await revisionOf(f.p);
	const q = command({ plant: f.p, confirmed: true }, revision);
	const before = await footprint();
	for (const who of Object.values(roles)) denied(await call("requestWorkspaceDeletion", who, q, f.p));
	denied(await call("requestWorkspaceDeletion", other.a, q, other.p));
	for (const input of [{ plant: f.p }, { plant: f.p, confirmed: false }, { plant: f.p, confirmed: "Delete" }])
		denied(await call("requestWorkspaceDeletion", f.a, command(input, revision), f.p), "invalid_input");
	denied(await call("requestWorkspaceDeletion", f.a, command({ plant: other.p, confirmed: true }, revision), f.p));
	denied(
		await call("requestWorkspaceDeletion", f.a, command({ plant: f.p, confirmed: true }, revision + "0"), f.p),
		"conflict",
	);
	for (const who of [f.a, ...Object.values(roles)])
		denied(
			await call("requestAccountDeletion", who, command({ confirmed: true }), {
				kind: "account",
				id: other.a.id,
			}),
		);
	denied(
		await call("requestAccountDeletion", f.a, command({ confirmed: true, account: roles.Member.id })),
		"invalid_input",
	);
	assert.deepEqual(await footprint(), before, "a refused request changes nothing");
	const pending = ok(await call("requestWorkspaceDeletion", f.a, q, f.p));
	assert.equal(pending.status, "pending_deletion");
	assert.deepEqual(pending.subject, { kind: "plant", id: f.p.id });
	denied(await call("requestWorkspaceDeletion", f.a, q, f.p));
	const recorded = await admin.execute(
		sql`SELECT tenant_id,actor_id,subject_id FROM audit_event WHERE action='plant.deletion_requested' AND subject_id=${f.p.id}`,
	);
	assert.deepEqual(recorded.rows, [{ tenant_id: f.p.id, actor_id: f.a.id, subject_id: f.p.id }]);
	const witnesses = await admin.execute(
		sql`SELECT kind,state FROM lifecycle_witness WHERE plant_id=${f.p.id} OR account_id IN (${f.a.id},${roles.Member.id})`,
	);
	assert.deepEqual(witnesses.rows, [{ kind: "plant", state: "pending_deletion" }]);
	assert.equal(await viewerOf(roles.Admin), null);
	assert.ok(await viewerOf(other.a), "another church keeps its access");
});

test("AC:ROLE43-018 a person deletes only their own login, loses access at once, can cancel for 30 days and their check-ins go to nobody", async (context) => {
	const f = await plant(),
		self = await seat(f.p),
		second = await seat(f.p);
	const care = createPrivateCare();
	const resolved = async (who: Session) => {
		const found = await RequestActor.resolve(db, sessionId.parse(who.session));
		assert.ok(found instanceof RequestActor);
		return found;
	};
	for (const who of [self, second])
		await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${who.id}`);
	const answers = { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" };
	const [mine, theirs] = [await resolved(self), await resolved(second)];
	ok(
		await care.save(db, mine, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { answers, note: "CARE-CANARY" },
		}),
	);
	const weeks = async () =>
		(
			await admin.execute(
				sql`SELECT author_id,count(*)::int AS n FROM private_week WHERE plant_id=${f.p.id} GROUP BY author_id ORDER BY author_id`,
			)
		).rows;
	const mineOnly = [{ author_id: self.id, n: 1 }];
	const request = async (who: Session, subject: string) =>
		call("requestAccountDeletion", who, command({ confirmed: true }), {
			kind: "account",
			id: accountId.parse(subject),
		});
	denied(await request(second, self.id));
	denied(await request(f.a, self.id));
	assert.deepEqual(await weeks(), mineOnly);
	assert.equal(await admin.$count(t.lifecycle_witness, eq(t.lifecycle_witness.account_id, self.id)), 0);

	context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-13T16:00:00Z") });
	let deleting;
	try {
		deleting = await recorded(admin, () => request(self, self.id));
	} finally {
		context.mock.timers.reset();
	}
	const pending = ok(deleting.value);
	assert.deepEqual(
		deleting.added,
		{ audits: ["account.deletion_requested"], jobs: ["lifecycle_purge"], notices: 0, mail: 0 },
		"one audit row and the purge the 30 days allow",
	);
	assert.equal(pending.status, "pending_deletion");
	assert.deepEqual(
		[pending.requestedAt, pending.cancelUntil],
		["2026-10-13T16:00:00.000Z", "2026-11-12T16:00:00.000Z"],
	);
	const [purge] = await admin
		.select({ at: t.job.eligible_at })
		.from(t.job)
		.where(eq(t.job.producer_key, "purge/" + pending.requestId));
	assert.equal(purge!.at.toISOString(), pending.cancelUntil, "nothing is purged inside the 30 days");
	assert.equal(await viewerOf(self), null);
	assert.equal((await RequestActor.resolve(db, sessionId.parse(self.session))) instanceof RequestActor, false);
	assert.equal((await care.readCurrent(db, mine, {})).status, "refused");
	denied(await save(self, command({ section: "account", name: "Too late" }, "2")));
	denied(await request(self, self.id));
	const other = ok(await care.readCurrent(db, theirs, {}));
	assert.deepEqual([other.week.answer, other.revision], [null, "0"]);
	assert.deepEqual(await weeks(), mineOnly, "the held check-in keeps its author");
	assert.ok(await viewerOf(second));

	const undecided = await seat(f.p);
	const requested = ok(await request(undecided, undecided.id));
	assert.equal(await viewerOf(undecided), null);
	const own = { subject: { kind: "account" as const, id: undecided.id }, requestId: requested.requestId };
	const proof = await restricted(undecided, own.subject, requested);
	const cancel = () =>
		gatedTransaction(db, (tx) => api.cancelAccountDeletion(tx, proof, command(own, requested.revision)));
	assert.equal(ok(await cancel()).status, "cancelled");
	assert.ok(await viewerOf(await newSession(undecided)), "signing in again works after the cancel");

	const late = await seat(f.p);
	const expired = await overdue(late, { kind: "account", id: late.id });
	const lateProof = await restricted(late, expired.subject, expired);
	denied(
		await gatedTransaction(db, (tx) =>
			api.cancelAccountDeletion(
				tx,
				lateProof,
				command({ subject: { kind: "account" as const, id: late.id }, requestId: expired.requestId }, expired.revision),
			),
		),
		"deadline_passed",
	);
	assert.deepEqual(await weeks(), mineOnly);

	const gone = await seat(f.p);
	ok(
		await care.save(
			db,
			await (async () => {
				await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${gone.id}`);
				return resolved(gone);
			})(),
			{ requestKey: randomUUID(), expectedRevision: "0", input: { answers, note: "" } },
		),
	);
	const subject = { kind: "account" as const, id: gone.id };
	const due = await overdue(gone, subject);
	const cleanup = createLifecycleCleanup(cleanupDb, {
		authorize: async () => true,
		removeOwnedResources: async () => true,
	});
	const done = await cleanup({ subject, requestId: due.requestId, revision: due.revision });
	assert.equal(done.status, "purged");
	assert.equal(Date.parse(done.copyExpiresAt) - Date.parse(done.livePurgedAt), 7 * 86400_000);
	assert.deepEqual(await weeks(), mineOnly, "a purge removes only its author's check-ins");
});

test("AC:ROLE43-018 a former lead who lost the seat keeps no access to the church", async () => {
	const f = await plant(),
		lead = await seat(f.p);
	const before = await seen(lead);
	assert.equal((await readSection(before, { section: "plant", plant: f.p })).status, "ok");
	await admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.account_id, lead.id));
	denied(await readSection(before, { section: "plant", plant: f.p }));
	denied(
		await save(
			lead,
			command({ section: "plant", plant: f.p, change: { kind: "profile", patch: { city: "Waco" } } }),
			f.p,
		),
	);
});

const total = async (query: ReturnType<typeof sql>) => Number((await admin.execute<{ n: number }>(query)).rows[0]!.n);
const written = async () =>
	(
		await admin.execute(
			sql`SELECT (SELECT count(*)::int FROM audit_event) events,(SELECT count(*)::int FROM mail) mail,(SELECT count(*)::int FROM job) jobs,(SELECT count(*)::int FROM notice) notices`,
		)
	).rows[0];
async function failingWrite(table: string, when: string, body: () => Promise<void>, condition = "true") {
	await admin.execute(
		sql.raw(
			`CREATE SEQUENCE failed_writes;CREATE FUNCTION fail_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN IF ${condition} THEN PERFORM nextval('failed_writes');RAISE EXCEPTION 'synthetic_write_failure'; END IF; RETURN NEW; END $$;
			 CREATE TRIGGER fail_write BEFORE ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_write()`,
		),
	);
	try {
		await body();
		return await total(sql`SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS n FROM failed_writes`);
	} finally {
		await admin.execute(
			sql.raw(`DROP TRIGGER fail_write ON ${table};DROP FUNCTION fail_write();DROP SEQUENCE failed_writes`),
		);
	}
}
const revisionOf = async (a: { id: string }) =>
	(await admin.select().from(t.account).where(eq(t.account.id, a.id)))[0]!.revision;
const currentAvatar = async (a: { id: string }) =>
	(await admin.select().from(t.account).where(eq(t.account.id, a.id)))[0]!.avatar_object_id;

test("AC:TARGET-IDN-006 a photo whose reference cannot be written keeps the old one; a failed old-byte deletion keeps the new one; foreign, empty, wrong-type and oversized uploads are refused", async () => {
	const { runDueObjectCleanup } = await import("../../../packages/domain/src/jobs/object-cleanup.ts");
	const a = await actor(),
		b = await actor(),
		storage = photoStorage();
	const v1 = await setPhoto(storage, a);
	for (const upload of [
		{ mime: "image/png", byteLength: 0 },
		{ mime: "image/png", byteLength: 3 * 1024 * 1024 + 1 },
		{ mime: "image/gif", byteLength: PNG.length },
		{ mime: "text/html", byteLength: PNG.length },
		{ mime: "image/png", byteLength: PNG.length, key: "private/other/key" },
	])
		denied(await call("requestAvatarUpload", a, upload), "invalid_input");
	const staged = ok(await call("requestAvatarUpload", a, { mime: "image/png", byteLength: PNG.length }));
	for (const bytes of [Buffer.alloc(0), Buffer.from("GIF89a"), Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)])])
		await assert.rejects(uploadAvatar(db, storage, ctx(a), { uploadId: staged.uploadId, bytes }));
	await uploadAvatar(db, storage, ctx(a), { uploadId: staged.uploadId, bytes: PNG });
	const v2 = { accountId: a.id, versionId: staged.uploadId };
	const before = await written();
	denied(await call("finalizeAvatar", b, command({ uploadId: staged.uploadId }, await revisionOf(b))));
	assert.equal(await currentAvatar(b), null);
	const key = randomUUID();
	const reviewed = await revisionOf(a);
	const finalize = () => call("finalizeAvatar", a, command({ uploadId: staged.uploadId }, reviewed, key));
	for (const [table, when, condition] of [
		["account", "UPDATE", "NEW.avatar_object_id IS DISTINCT FROM OLD.avatar_object_id"],
		["audit_event", "INSERT", "true"],
	] as const) {
		await failingWrite(table, when, async () => assert.rejects(finalize()), condition);
		assert.equal(await currentAvatar(a), v1.versionId, table);
		assert.equal(await photoRead(storage, a, v1), "bytes");
		assert.equal(await photoRead(storage, a, v2), "refused");
		for (const photo of [v1, v2]) {
			assert.equal(await photoRead(storage, b, photo), "refused");
			denied(await call("getAvatar", b, { versionId: photo.versionId }));
		}
	}
	faults = true;
	try {
		await assert.rejects(finalize(), /cleanup_intent_fault/);
	} finally {
		faults = false;
	}
	assert.deepEqual(await written(), before);
	const cleanups = (photo: Photo) =>
		total(
			sql`SELECT count(*)::int AS n FROM job WHERE kind='object_cleanup' AND subject_record_id=${photo.versionId} AND eligible_at<=clock_timestamp()`,
		);
	assert.deepEqual([await cleanups(v1), await cleanups(v2)], [0, 0]);
	assert.equal(
		await total(
			sql`SELECT count(*)::int AS n FROM job WHERE kind='object_cleanup' AND subject_record_id=${v2.versionId}`,
		),
		1,
		"the orphan's cleanup is already scheduled",
	);
	assert.equal((await admin.select().from(t.file_object).where(eq(t.file_object.id, v1.versionId)))[0]!.state, "ready");

	ok(await finalize());
	const saved = await written();
	assert.deepEqual(ok(await finalize()), { status: "available", avatar: v2 });
	assert.deepEqual(await written(), saved, "a retry writes nothing more");
	assert.equal(await currentAvatar(a), v2.versionId);
	assert.equal(await photoRead(storage, a, v1), "refused", "the cached older version is no longer served");
	assert.equal(await photoRead(storage, a, v2), "bytes");
	await admin.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE kind='object_cleanup' AND subject_record_id=${v1.versionId}`,
	);
	const refused: string[] = [];
	const refusing = stubStorage((operation) => {
		refused.push(operation);
		throw Error("synthetic_delete_failure");
	});
	assert.equal(await runDueObjectCleanup(db, refusing, 50), 0);
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT state,error_code,attempt_count FROM job WHERE kind='object_cleanup' AND subject_record_id=${v1.versionId}`,
			)
		).rows,
		[{ state: "retry_wait", error_code: "provider_unknown", attempt_count: 1 }],
		"the failed deletion ran and waits for its retry",
	);
	assert.ok(refused.includes("DeleteObjectCommand"), refused.join());
	assert.equal(await currentAvatar(a), v2.versionId);
	assert.equal(await photoRead(storage, a, v2), "bytes");
	assert.equal(await photoRead(storage, a, v1), "refused");
});

let ipBlock = 0;
async function ownIpActor() {
	const a = await credentialActor();
	trustedIps.set(a.session, `198.51.100.${100 + ipBlock++}`);
	return a;
}
const emailOf = async (a: { user: string }) =>
	(await admin.select().from(t.auth_user).where(eq(t.auth_user.id, a.user)))[0]!.email;
const emailEvents = (a: { id: string }) =>
	total(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${a.id} AND action='identity.email_changed'`);

test("AC:TARGET-IDN-007 a confirmed email change notifies the old address once, and a failed recording is reported without undoing the change", async () => {
	const zone = process.env.TZ;
	process.env.TZ = "Pacific/Kiritimati";
	try {
		for (const recording of ["recorded", "pending_investigation"]) {
			const a = await ownIpActor();
			const church = await plant(a);
			const person = church.result.ownerSeat.personId;
			await admin.update(t.person).set({ email: "crm@example.test" }).where(eq(t.person.id, person));
			const other = await login(a);
			const target = randomUUID() + "@example.test";
			ok(await credential("requestEmailChange", a, { newEmail: target }));
			const { token } = deliveries.at(-1)!;
			const mailed = notices.length;
			let result: Awaited<ReturnType<Credentials["confirmEmailChange"]>> | undefined;
			const confirm = async () => {
				result = await credential("confirmEmailChange", a, { proof: token });
			};
			if (recording === "recorded") await confirm();
			else await failingWrite("audit_event", "INSERT", confirm, "NEW.action='identity.email_changed'");
			assert.ok(result?.status === "succeeded");
			assert.deepEqual([result.accountId, result.action, result.reporting.status], [a.id, "email_changed", recording]);
			assert.equal(await emailOf(a), target);
			const [row] = await admin.select().from(t.person).where(eq(t.person.id, person));
			assert.deepEqual([row!.linked_account_id, row!.email], [a.id, "crm@example.test"]);
			const recorded = recording === "recorded" ? 1 : 0;
			assert.equal(await emailEvents(a), recorded);
			assert.equal(
				await total(
					sql`SELECT count(*)::int AS n FROM mail WHERE recipient_account_id=${a.id} AND logical_key LIKE 'security/%'`,
				),
				recorded,
			);
			assert.deepEqual(notices.slice(mailed).at(-1), { accountId: a.id, address: a.email, action: "email_changed" });
			if (!recorded) assert.equal(diagnostics.splice(0).at(-1)?.outcome, "reporting_pending");
			assert.equal((await credential("confirmEmailChange", other, { proof: token })).status, "refused");
			assert.equal(await emailEvents(a), recorded);
		}
	} finally {
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	}
});

test("AC:TARGET-IDN-007 a wrong owner, an expired, a superseded or an occupied email proof changes nothing and records nothing", async () => {
	const b = await ownIpActor();
	const rows: [string, (a: Login & Session, token: string) => Promise<Session>, string?][] = [
		["wrong owner", async () => b],
		[
			"expired",
			async (a) => {
				await admin.execute(sql`UPDATE identity_proof SET expires_at=clock_timestamp() WHERE account_id=${a.id}`);
				return a;
			},
		],
		[
			"superseded",
			async (a) => {
				ok(await credential("requestEmailChange", a, { newEmail: randomUUID() + "@example.test" }));
				return a;
			},
		],
		["occupied", async (a) => a, "occupied"],
	];
	for (const [name, arrange, occupied] of rows) {
		const a = await ownIpActor();
		const church = await plant(a);
		const person = church.result.ownerSeat.personId;
		await admin.update(t.person).set({ email: "crm@example.test" }).where(eq(t.person.id, person));
		const target = randomUUID() + "@example.test";
		ok(await credential("requestEmailChange", a, { newEmail: target }));
		const { token } = deliveries.at(-1)!;
		if (occupied) await admin.update(t.auth_user).set({ email: target }).where(eq(t.auth_user.id, b.user));
		const who = await arrange(a, token);
		const before = await written(),
			mailed = notices.length;
		assert.equal((await credential("confirmEmailChange", who, { proof: token })).status, "refused", name);
		assert.equal(await emailOf(a), a.email, name);
		assert.equal((await admin.select().from(t.person).where(eq(t.person.id, person)))[0]!.email, "crm@example.test");
		assert.deepEqual(await written(), before, name);
		assert.equal(notices.length, mailed, name);
		assert.equal(await emailEvents(a), 0);
	}
	const c = await ownIpActor();
	const before = await written();
	const answers: string[] = [];
	for (const name of ["one", "two", "three", "four"]) {
		const reply = await credential("requestEmailChange", c, { newEmail: `${name}-${c.id}@example.test` });
		answers.push(reply.status === "refused" && "error" in reply ? reply.error.code : reply.status);
	}
	assert.deepEqual(answers, ["ok", "ok", "ok", "temporary"]);
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT identifier_hash,count(*)::int AS n FROM admission_attempt WHERE kind='email_change' AND identifier_hash=${createHmac("sha256", secret).update(c.email).digest("hex")} GROUP BY 1`,
			)
		).rows.map((row) => row.n),
		[3],
	);
	assert.deepEqual(await written(), before);
	const raced = await ownIpActor();
	ok(await credential("requestEmailChange", raced, { newEmail: raced.id + "@example.test" }));
	const { token } = deliveries.at(-1)!;
	const [confirmed, changed] = await Promise.all([
		credential("confirmEmailChange", raced, { proof: token }),
		credential("changePassword", raced, {
			currentPassword: raced.password,
			newPassword: "Raced secret 13579!",
			confirmPassword: "Raced secret 13579!",
		}),
	]);
	const email = confirmed.status === "succeeded" ? raced.id + "@example.test" : raced.email;
	assert.equal(await emailOf(raced), email);
	const password = changed.status === "succeeded" ? "Raced secret 13579!" : raced.password;
	assert.ok((await login({ ...raced, email, password })).session);
	assert.equal(await emailEvents(raced), confirmed.status === "succeeded" ? 1 : 0);
});

test("AC:TARGET-IDN-008 a password change keeps only the browser that made it, and an unknown outcome is tried once with no success event", async () => {
	const a = await credentialActor(),
		[other, stale] = [await login(a), await login(a)];
	const input = {
		currentPassword: a.password,
		newPassword: "Fixture-new-pass-2",
		confirmPassword: "Fixture-new-pass-2",
	};
	const events = () =>
		total(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${a.id} AND action='identity.credential_changed'`,
		);
	for (const forged of [
		{ ...input, accountId: other.id },
		{ ...input, sessionId: other.session },
		{ ...input, currentPassword: "short", newPassword: "x", confirmPassword: "x" },
	])
		assert.equal((await credential("changePassword", a, forged)).status, "refused");
	const stranger = await credentialActor();
	assert.equal(
		(await producerDeps.credentials.changePassword(ctx(a, { kind: "account", id: stranger.id }), input)).status,
		"refused",
	);
	assert.equal(await events(), 0);
	const attempts = await failingWrite("auth_account", "UPDATE", async () => {
		assert.equal((await credential("changePassword", a, input)).status, "unknown");
	});
	assert.equal(attempts, 1);
	assert.equal(await events(), 0);
	assert.equal((await admin.select().from(t.auth_session).where(eq(t.auth_session.user_id, a.user))).length, 3);

	issued.length = 0;
	await failingWrite(
		"audit_event",
		"INSERT",
		async () => {
			const changed = await credential("changePassword", a, input);
			assert.ok(changed.status === "succeeded");
			assert.deepEqual(changed.reporting, { status: "pending_investigation" });
		},
		"NEW.action='identity.credential_changed'",
	);
	assert.equal(await events(), 0);
	const live = async (cookie: string) =>
		(await signInAuth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id ?? null;
	const initiating = issued.map((v) => v.split(";")[0]).join("; ");
	assert.equal(await live(initiating), a.user, "the initiating browser's session stays live");
	for (const gone of [other, stale]) assert.equal(await live(ingress.get(gone.session)!.headers.get("cookie")!), null);
	assert.equal((await admin.select().from(t.auth_session).where(eq(t.auth_session.user_id, a.user))).length, 1);
	const refusedLogin = await signInAuth.api.signInEmail({
		body: { email: a.email, password: a.password },
		asResponse: true,
	});
	assert.equal(refusedLogin.status, 401);
	const fresh = await login({ ...a, password: input.newPassword });
	assert.equal((await credential("changePassword", fresh, input)).status, "refused", "a stale password tab");
	assert.equal(await events(), 0);

	const next = { currentPassword: input.newPassword, newPassword: "Fixture-third-pass-3" };
	const mailed = notices.length;
	const { value: normal, added } = await recorded(admin, () =>
		credential("changePassword", fresh, { ...next, confirmPassword: next.newPassword }),
	);
	assert.ok(normal.status === "succeeded");
	assert.equal(normal.reporting.status, "recorded");
	assert.deepEqual(
		added,
		{ audits: ["identity.credential_changed"], jobs: ["mail"], notices: 0, mail: 1 },
		"one audit row and one security mail",
	);
	assert.deepEqual(notices.slice(mailed), [{ accountId: a.id, address: a.email, action: "password_changed" }]);
	assert.equal(await events(), 1);
	assert.ok((await login({ ...a, password: next.newPassword })).session);
});

test("AC:TARGET-IDN-010 an Owner or Admin sharing save changes only the named categories of one exact organization, once, and refuses every stale, foreign or malformed one", async () => {
	for (const role of ["owner", "admin"] as const) {
		const f = await plant(),
			org = await organization(),
			second = await organization(),
			adminActor = await seat(f.p),
			member = await seat(f.p, "member"),
			foreign = await plant();
		const who = role === "owner" ? f.a : adminActor;
		const link = async (o: typeof org, choices: Partial<typeof t.affiliation.$inferInsert>) =>
			(
				await admin
					.insert(t.affiliation)
					.values({
						plant_id: f.p.id,
						organization_id: o.o.id,
						accepted_at: new Date(),
						share_people: false,
						share_meetings: true,
						share_tasks: false,
						share_ministry_teams: false,
						share_wiki: true,
						share_activity: true,
						shared_findings: false,
						consent_revision: "7",
						revision: "4",
						...choices,
					})
					.returning()
			)[0]!;
		const first = await link(org, {}),
			other = await link(second, { share_people: true, share_meetings: false, shared_findings: true });
		const row = async (id: string) => (await admin.select().from(t.affiliation).where(eq(t.affiliation.id, id)))[0]!;
		const base = {
			section: "affiliations" as const,
			plant: f.p,
			organization: org.o,
			relationshipId: first.id,
			expectedConsentRevision: "7",
			patch: { teams: true, activityPush: false } as object,
		};
		const start = await written();
		for (const [bad, code] of [
			[{ ...base, patch: {} }, "invalid_input"],
			[{ ...base, patch: { teams: true, unknown: true } }, "invalid_input"],
			[{ ...base, patch: { shared_findings: true, shareIntelligence: true } }, "invalid_input"],
			[{ ...base, expectedConsentRevision: "6" }, "conflict"],
			[{ ...base, relationshipId: other.id }, "unavailable"],
			[{ ...base, organization: { ...org.o, organizationKind: "sending_church" as const } }, "unavailable"],
			[{ ...base, relationshipId: randomUUID() }, "unavailable"],
		] as const)
			denied(await call("saveSection", who, command(bad, "4"), f.p), code);
		denied(await call("saveSection", who, command(base, "3"), f.p), "conflict");
		denied(await call("saveSection", member, command(base, "4"), f.p));
		denied(await call("saveSection", org.a, command(base, "4"), org.o));
		denied(await call("saveSection", foreign.a, command(base, "4"), foreign.p));
		faults = true;
		try {
			await assert.rejects(call("saveSection", who, command(base, "4"), f.p), /grant_fault/);
		} finally {
			faults = false;
		}
		await failingWrite("audit_event", "INSERT", async () =>
			assert.rejects(call("saveSection", who, command(base, "4"), f.p)),
		);
		assert.deepEqual([await row(first.id), await row(other.id)], [first, other]);
		assert.deepEqual(await written(), start);

		const outcomes = () =>
			total(sql`SELECT count(*)::int AS n FROM audit_event WHERE action='sharing.changed' AND subject_id=${first.id}`);
		const sharing = command(base, "4");
		const saved = ok(await save(who, sharing, f.p));
		assert.equal(saved.current.values.consentRevision, "8");
		assert.deepEqual(saved.current.values.choices, {
			people: false,
			meetings: true,
			tasks: false,
			ministry_teams: true,
			wiki: true,
			activity: false,
			shared_findings: false,
		});
		const once = { row: await row(first.id), writes: await written() };
		assert.equal(await outcomes(), 1);
		assert.deepEqual(ok(await save(who, sharing, f.p)), saved);
		assert.deepEqual({ row: await row(first.id), writes: await written() }, once);
		assert.deepEqual(await row(other.id), other);

		const findings = ok(
			await save(
				who,
				command({ ...base, expectedConsentRevision: "8", patch: { shared_findings: true } }, once.row.revision),
				f.p,
			),
		);
		assert.equal(findings.current.values.consentRevision, "9");
		assert.deepEqual(findings.current.values.choices, { ...saved.current.values.choices, shared_findings: true });
		assert.deepEqual(
			Object.keys(findings.current.values.choices).filter((key) =>
				/finding|intelligence|insight|health|ni\b/i.test(key),
			),
			["shared_findings"],
		);
		assert.equal(await outcomes(), 2);
		const after = await row(first.id);
		assert.deepEqual(await row(other.id), other);
		const read = ok(await section(who, { section: "affiliations", plant: f.p, organization: org.o }));
		assert.deepEqual(read.values, findings.current.values);
		await admin.update(t.affiliation).set({ ended_at: new Date() }).where(eq(t.affiliation.id, first.id));
		denied(await call("saveSection", who, command({ ...base, expectedConsentRevision: "9" }, after.revision), f.p));
	}
});

test("AC:TARGET-IDN-011 equal warning and alert days refuse the whole church save, clears and partial localities stay independent, and oversight never holds the street", async () => {
	const { getPlant, listPlants } = await import("../../../packages/domain/src/oversight/index.ts");
	const f = await plant(),
		org = await organization();
	const street = "77 Hidden Street " + randomUUID();
	await admin.insert(t.affiliation).values({
		plant_id: f.p.id,
		organization_id: org.o.id,
		accepted_at: new Date(),
		share_people: true,
		share_meetings: true,
		share_tasks: true,
		share_ministry_teams: true,
		share_wiki: true,
		share_activity: true,
		shared_findings: true,
	});
	const church = async (changes: object[], revision: string) =>
		withSettingsWrite(db, (await seen(f.a)).authority, ctx(f.a, f.p), (tx) =>
			api.saveChurch(tx, ctx(f.a, f.p), command({ plant: f.p, changes }, revision)),
		);
	const row = async () => (await admin.select().from(t.plant).where(eq(t.plant.id, f.p.id)))[0]!;
	const oversight = async () => {
		const { authority } = await seen(org.a);
		const shown = [await listPlants(db, authority), await getPlant(db, authority, f.p.id)];
		assert.ok(shown[0] && shown[1], "the organization sees its plant");
		const text = JSON.stringify(shown);
		return { street: text.includes(street) || /"street"/.test(text), city: text.includes("Austin") };
	};
	const profile = (patch: object) => ({ kind: "profile", patch });
	ok(await church([profile({ street, city: "Austin", stateProvince: null, country: null })], "1"));
	assert.deepEqual(await oversight(), { street: false, city: true });
	const before = { row: await row(), writes: await written() };
	const inactivity = (warningDays: number, alertDays: number) => ({
		kind: "inactivity",
		value: { warningDays, alertDays },
	});
	for (const changes of [
		[inactivity(7, 7), profile({ street: null })],
		[inactivity(8, 7)],
		[inactivity(0, 7)],
		[inactivity(7, 366)],
		[profile({ name: "   " })],
		[profile({ street: "x".repeat(501) })],
		[profile({})],
		[{ kind: "digest", value: { cadence: "weekly", weekday: 7, hour: 16 } }],
		[{ kind: "digest", value: { cadence: "daily", hour: 24 } }],
	])
		denied(await church(changes, "2"), "invalid_input");
	denied(
		await call("updatePlantProfile", f.a, command({ plant: f.p, patch: { street: null, warning_days: 7 } }, "2"), f.p),
		"invalid_input",
	);
	denied(await call("previewPlantTimezone", f.a, { plant: f.p, timeZone: "Mars/Olympus" }, f.p), "invalid_input");
	assert.deepEqual({ row: await row(), writes: await written() }, before);
	assert.deepEqual([before.row.street, before.row.city, before.row.state_province], [street, "Austin", null]);

	ok(await church([inactivity(7, 8), profile({ street: null })], "2"));
	const cleared = await row();
	assert.deepEqual(
		[cleared.street, cleared.city, cleared.state_province, cleared.country, cleared.warning_days, cleared.alert_days],
		[null, "Austin", null, null, 7, 8],
	);
	assert.deepEqual(await oversight(), { street: false, city: true });
	assert.deepEqual([cleared.timezone, cleared.digest_weekday, cleared.digest_hour], ["America/Chicago", 0, 16]);
});

test("AC:TARGET-IDN-012 a person saves only their own allowed choices, and an organization's enabled push cannot override a plant that shares no activity", async () => {
	const { createDigestWorker, planDigests } = await import("../../../packages/domain/src/jobs/digest.ts");
	const f = await plant(),
		b = await plant(),
		org = await organization();
	const a = f.a;
	const choice = (enabled: boolean) => ({
		section: "notifications" as const,
		patch: { kind: "channel" as const, choice: { category: "task_due" as const, channel: "email" as const, enabled } },
	});
	const prefs = async (who: Session) =>
		(
			await admin.execute(
				sql`SELECT category,channel,enabled,cadence FROM notification_preference WHERE account_id=${who.id} ORDER BY 1,2`,
			)
		).rows;
	const state = async () => ({
		a: await prefs(a),
		b: await prefs(b.a),
		revision: await revisionOf(b.a),
		writes: await written(),
	});
	const before = await state();
	denied(await call("saveSection", a, command(choice(false), await revisionOf(a)), { kind: "account", id: b.a.id }));
	denied(await call("saveSection", a, command(choice(false), await revisionOf(a)), f.p));
	for (const input of [
		{ ...choice(false), accountId: b.a.id },
		{
			...choice(false),
			patch: { kind: "channel", choice: { category: "private_care", channel: "email", enabled: true } },
		},
		{ ...choice(false), patch: { kind: "channel", choice: { category: "task_due", channel: "sms", enabled: true } } },
		{ ...choice(false), patch: { kind: "planter_cadence", cadence: "hourly" } },
	])
		denied(await call("saveSection", a, command(input, await revisionOf(a))), "invalid_input");
	await failingWrite("notification_preference", "INSERT", async () =>
		assert.rejects(call("saveSection", a, command(choice(false), "2"))),
	);
	denied(await call("saveSection", a, command(choice(false), "99")), "conflict");
	assert.deepEqual(await state(), before);
	const shown = ok(await section(a, { section: "notifications" }));
	assert.equal(shown.values.choices.find((c) => c.category === "task_due" && c.channel === "email")!.enabled, true);
	ok(await save(a, command(choice(false), shown.revision)));
	assert.deepEqual(await prefs(b.a), before.b);
	assert.deepEqual(await prefs(a), [{ category: "task_due", channel: "email", enabled: false, cadence: null }]);

	const link = randomUUID();
	await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${link},${f.p.id},${org.o.id},clock_timestamp()-interval '9 days',true,true,true,true,true,false,true)`);
	let revision = ok(await section(org.a, { section: "notifications" })).revision;
	for (const channel of ["email", "in_app"] as const)
		revision = ok(
			await save(
				org.a,
				command(
					{
						section: "notifications",
						patch: { kind: "channel", choice: { category: "oversight_digest", channel, enabled: true } },
					},
					revision,
				),
			),
		).current.revision;
	const sent: MailPayload[] = [];
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
	const digests = createDigestWorker({ mail: sender, origin });
	const day = async (at: string) => {
		await admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,occurred_at,recorded_at)
			VALUES(${f.p.id},${a.id},'people.updated','edit','command',${f.p.id},${at}::timestamptz-interval '30 hours',${at}::timestamptz-interval '30 hours')`);
		await planDigests(db, at);
		await digests.run(db, at, 100);
		return (
			await admin.execute(sql`SELECT (SELECT count(*)::int FROM notice WHERE recipient_id=${org.a.id}) notices,
				(SELECT count(*)::int FROM mail WHERE recipient_account_id=${org.a.id}) mail`)
		).rows[0];
	};
	for (const at of ["2098-03-03T20:00:00.000Z", "2098-03-04T20:00:00.000Z", "2098-03-05T20:00:00.000Z"])
		assert.deepEqual(await day(at), { notices: 0, mail: 0 }, "sharing off sends nothing");
	await admin.execute(sql`UPDATE affiliation SET share_activity=true WHERE id=${link}`);
	const shared = await day("2098-03-06T20:00:00.000Z");
	assert.deepEqual(shared, { notices: 1, mail: 1 }, "the same push does send once the plant shares activity");
});

test("AC:WP010-IDN-012 the notifications section shows its own account's current mailbox suppression and nothing of its private check-in", async () => {
	const { a } = await plant();
	await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${a.id}`);
	const care = createPrivateCare();
	const { authority } = await seen(a);
	const week = ok(await care.readCurrent(db, authority, {}));
	ok(
		await care.save(db, authority, {
			requestKey: randomUUID(),
			expectedRevision: week.revision,
			input: {
				answers: { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" },
				note: "CARE-CANARY-WP010",
			},
		}),
	);
	const key = randomBytes(32);
	const hash = (email: string) => createHmac("sha256", key).update(email).digest("hex");
	const own = settingsApi({ ...producerDeps, suppression: (on, email) => suppressionOf(on, hash(email)) });
	const read = async (who: Session) => {
		const value = ok(await own.getSection(db, await seen(who), { section: "notifications" }));
		assert.ok(value.section === "notifications");
		return value;
	};
	const suppress = async (email: string) => {
		const event = randomUUID();
		await admin.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
			VALUES(${event},${event},${event},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
		await admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
			VALUES(${hash(email)},'hard_bounce',${event},clock_timestamp())`);
	};
	assert.equal((await read(a)).values.suppression, "clear");
	const b = await plant();
	await suppress(await emailOf(a));
	const before = await written();
	const section = await read(a);
	assert.equal(section.accountId, a.id);
	assert.equal(section.values.suppression, "suppressed");
	assert.equal((await read(b.a)).values.suppression, "clear");
	denied(await own.getSection(db, await seen(a), { section: "notifications", accountId: b.a.id }), "invalid_input");
	const text = JSON.stringify(section);
	assert.equal(/care|check.?in|strain|struggl|spiritual|pace|CANARY/i.test(text), false, text);
	assert.deepEqual(await written(), before);
	await admin
		.update(t.auth_user)
		.set({ email: "moved-" + (await emailOf(a)) })
		.where(eq(t.auth_user.id, a.user));
	assert.equal((await read(a)).values.suppression, "clear", "an old mailbox's suppression is not the current one's");
});

test("AC:TARGET-IDN-028 a revoked or expired session reads no private check-in, and the refusal is the same whether one exists", async () => {
	const care = createPrivateCare();
	const canary = "CARE-CANARY-TARGET-IDN-028";
	const person = async (withNote: boolean) => {
		const { a } = await plant();
		await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${a.id}`);
		const { authority } = await seen(a);
		const week = ok(await care.readCurrent(db, authority, {}));
		if (withNote)
			ok(
				await care.save(db, authority, {
					requestKey: randomUUID(),
					expectedRevision: week.revision,
					input: {
						answers: { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" },
						note: canary,
					},
				}),
			);
		return { a, authority };
	};
	const [author, empty] = [await person(true), await person(false)];
	assert.ok(JSON.stringify(ok(await care.readCurrent(db, author.authority, {}))).includes(canary));
	for (const end of [sql`expires_at=clock_timestamp()-interval '1 second'`, null]) {
		const answers: string[] = [];
		for (const person of [author, empty]) {
			const a = await newSession(person.a);
			const { authority } = await seen(a);
			assert.equal((await care.readCurrent(db, authority, {})).status, "ok", "the session reads before it ends");
			const before = await written();
			if (end) await admin.execute(sql`UPDATE auth_session SET ${end} WHERE id=${a.session}`);
			else await admin.execute(sql`DELETE FROM auth_session WHERE id=${a.session}`);
			assert.equal(await viewerOf(a), null);
			const read = await care.readCurrent(db, authority, {});
			assert.equal(read.status, "refused");
			answers.push(JSON.stringify(read, (key, value: unknown) => (key === "correlationId" ? null : value)));
			assert.deepEqual(await written(), before);
		}
		assert.equal(answers[0], answers[1]);
		assert.equal(answers[0]!.includes(canary), false);
	}
});

test("AC:TARGET-IDN-014 the Owner of a church converted from Discovery hands the lead planter role to another live person in Settings", async () => {
	const a = await actor();
	await admin
		.update(t.account)
		.set({ registration_kind: "discovery", registration_state: "pending_domain" })
		.where(eq(t.account.id, a.id));
	const as = { session: a.session, selected: { kind: "account" as const, id: a.id } };
	const [row] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
	const started = ok(
		await gatedTransaction(db, (tx) => onboarding.createDiscovery(tx, as, command({}, row!.revision))),
	);
	if (started.status !== "active") assert.fail(JSON.stringify(started));
	const converted = ok(
		await gatedTransaction(db, (tx) =>
			onboarding.convertDiscovery(
				tx,
				as,
				command(
					{
						discoveryId: started.profile.discoveryId,
						name: "Grace Hill",
						confirmed: true,
						relationships: [],
						ended: [],
					},
					started.profile.revision,
				),
			),
		),
	);
	const p = converted.plant,
		planter = converted.ownerSeat.personId;
	const other = await plant(),
		adminSeat = await seat(p),
		member = await seat(p, "member");
	const addPerson = async (plantId: string, name: string) => {
		const id = randomUUID();
		await admin.insert(t.person).values({
			id,
			tenant_id: plantId,
			plant_id: plantId,
			display_name: name,
			source: "other",
			stage: "prospect",
			adult_classification: "adult",
			commitment_state: "unknown",
			pipeline_position: "1",
			state: "live",
			created_at: new Date(),
		});
		return id;
	};
	const ana = await addPerson(p.id, "Ana Lee"),
		outsider = await addPerson(other.p.id, "Outside Person");
	const present = <T,>(value: T | null) => value ?? assert.fail("no lead planter read");
	const read = async (who: Session) => readLeadPlanter(db, (await seen(who)).authority);
	const first = present(await read(a));
	assert.equal(first.canEdit, true);
	assert.deepEqual(first.lead?.holder, { personId: planter, name: "Synthetic" });
	assert.deepEqual(
		first.people.map((x) => x.name),
		["Ana Lee", "Synthetic"],
	);
	const forMember = present(await read(member));
	assert.deepEqual([forMember.canEdit, forMember.lead?.holder?.name, forMember.people], [false, "Synthetic", []]);

	const hand = (personId: string, expected: string = first.revision) => command({ plant: p, personId }, expected);
	const v = hand(ana);
	denied(await call("setLeadPlanter", adminSeat, v, p));
	denied(await call("setLeadPlanter", member, v, p));
	denied(await call("setLeadPlanter", a, hand(outsider), p), "invalid_subject");
	denied(await call("setLeadPlanter", a, hand(ana, "99"), p), "conflict");
	assert.deepEqual(present(await read(a)), first, "refusals change nothing");

	const saved = ok(await call("setLeadPlanter", a, v, p));
	assert.deepEqual(saved, { plant: p, revision: String(BigInt(first.revision) + 1n), personId: ana });
	assert.deepEqual(ok(await call("setLeadPlanter", a, v, p)), saved, "a replay returns the first answer");
	const after = present(await read(a));
	assert.deepEqual([after.revision, after.lead?.holder], [saved.revision, { personId: ana, name: "Ana Lee" }]);
	const tenures = await admin.execute(sql`SELECT tn.person_id, tn.ended_on IS NULL AS open, tm.leader_person_id
		FROM team_tenure tn JOIN team_role r ON r.id=tn.role_id JOIN team tm ON tm.id=r.team_id
		WHERE tn.plant_id=${p.id}::uuid ORDER BY tn.ended_on NULLS LAST`);
	assert.deepEqual(tenures.rows, [
		{ person_id: planter, open: false, leader_person_id: ana },
		{ person_id: ana, open: true, leader_person_id: ana },
	]);
	const audit = await admin.execute(
		sql`SELECT tenant_id, kind FROM audit_event WHERE action='roles.changed' AND subject_id=${after.lead!.roleId}::uuid`,
	);
	assert.deepEqual(audit.rows, [{ tenant_id: p.id, kind: "assign" }]);
	const same = ok(await call("setLeadPlanter", a, hand(ana, saved.revision), p));
	assert.equal(same.revision, saved.revision, "naming the current lead again changes nothing");
});
