import { randomBytes } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { createNotificationService } from "../../../apps/web/src/server/jobs/notifications.ts";
import { enqueueJob } from "../../../apps/web/src/server/jobs/queue.ts";
import { deletionOperations, issueRestrictedDeletionSession } from "../../../packages/domain/src/settings/deletion.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "../identity/invitations-support.mts";
import { organizationPeople, peopleWriter, withPeopleWrite } from "../../../packages/domain/src/people/index.ts";
import { createOnboardingProducer, withOnboardingWrite } from "../../../packages/domain/src/onboarding/index.ts";
import { withSettingsWrite } from "../../../packages/domain/src/settings/index.ts";
import { sectionOperations } from "../../../packages/domain/src/settings/sections.ts";
import { sendOnboardingRelationships } from "../../../apps/web/src/server/jobs/notifications.ts";
import { measure } from "./counter.mjs";

// Exercise the outer request boundary too; the existing suites also cover tool producers and races.
const f = await fixture();
try {
	const s = await f.setup(),
		actor = await f.actor(s.sender.session);
	const run = (name, body) => measure("native.people." + name, () => withPeopleWrite(f.db, actor, body));
	const created = await run("createPerson", (tx, ctx) =>
		peopleWriter.createPerson(tx, ctx, { requestKey: randomUUID(), input: { displayName: "Synthetic native" } }),
	);
	assert.equal(created.status, "ok");
	if (created.status !== "ok") throw Error("create_refused");
	const changed = await run("updatePerson", (tx, ctx) =>
		peopleWriter.updatePerson(tx, ctx, {
			requestKey: randomUUID(),
			expectedRevision: created.value.person.revision,
			input: { personId: created.value.person.id, patch: { displayName: "Changed" } },
		}),
	);
	assert.equal(changed.status, "ok");
	if (changed.status !== "ok") throw Error("update_refused");
	assert.equal(changed.value.person.displayName, "Changed");
	const note = await run("addNote", (tx, ctx) =>
		peopleWriter.addNote(tx, ctx, {
			requestKey: randomUUID(),
			expectedRevision: changed.value.person.revision,
			input: { personId: changed.value.person.id, body: "Synthetic note" },
		}),
	);
	assert.equal(note.status, "ok");
	const ordinary = await f.account(),
		ordinarySeat = await f.seat(ordinary, s.w, "admin");
	const role = await f.seats.changeOrdinaryRole(actor, s.w, {
		requestKey: randomUUID(),
		expectedRevision: "1",
		input: { seatId: ordinarySeat, expectedRole: "admin", to: "member" },
	});
	assert.equal(role.revision, "2");

	const org = await f.setup("sending_church"),
		orgActor = await f.actor(org.sender.session);
	const orgCreated = await withPeopleWrite(f.db, orgActor, (tx, ctx) =>
		organizationPeople.create(tx, ctx, { requestKey: randomUUID(), input: { displayName: "Organization native" } }),
	);
	assert.equal(orgCreated.status, "ok");
	if (orgCreated.status !== "ok") throw Error("org_create");
	const orgUpdated = await withPeopleWrite(f.db, orgActor, (tx, ctx) =>
		organizationPeople.update(tx, ctx, {
			requestKey: randomUUID(),
			expectedRevision: orgCreated.value.person.revision,
			input: { personId: orgCreated.value.person.id, patch: { displayName: "Updated organization native" } },
		}),
	);
	assert.equal(orgUpdated.status, "ok");

	const a = await f.account(),
		self = await f.actor(a.session),
		context = {
			session: self.session,
			selected: self.actor.context.owner,
			purpose: "native",
			origin: { kind: "native" },
		};
	const unexpected = async () => {
		throw Error("unexpected_collaborator");
	};
	const sections = sectionOperations({
		organizations: {},
		organizationEffects: {},
		effects: {
			invalidate: async (tx, i) => {
				await enqueueJob(tx, {
					tenant: i.owner.id,
					kind: "assessment",
					subject: i.owner.id,
					key: "native/" + i.operationId,
					revision: i.revision,
					eligibleAt: new Date().toISOString(),
				});
			},
			replan: unexpected,
		},
		suppression: unexpected,
	});
	const saved = await measure("native.settings.account", () =>
		withSettingsWrite(f.db, self, context, (tx) =>
			sections.saveSection(tx, context, {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { section: "account", name: "Native account" },
			}),
		),
	);
	assert.equal(saved.status, "ok");
	if (saved.status !== "ok") throw Error("settings_refused");
	assert.equal(saved.value.current.name, "Native account");
	const plantContext = {
		session: actor.session,
		selected: actor.actor.context.owner,
		purpose: "native",
		origin: { kind: "native" },
	};
	const profile = await measure("settings.updatePlantProfile", () =>
		withSettingsWrite(f.db, actor, plantContext, (tx) =>
			sections.updatePlantProfile(tx, plantContext, {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { plant: s.w, patch: { name: "Native plant" } },
			}),
		),
	);
	assert.equal(profile.status, "ok");
	const deletion = deletionOperations({
		async enqueue(tx, i) {
			await enqueueJob(tx, {
				tenant: i.subject.id,
				kind: "lifecycle_purge",
				subject: i.witnessId,
				key: "native/" + i.requestId,
				revision: i.revision,
				eligibleAt: i.eligibleAt,
			});
		},
	});
	const requested = await measure("settings.requestWorkspaceDeletion", () =>
		withSettingsWrite(f.db, actor, plantContext, (tx) =>
			deletion.requestWorkspaceDeletion(tx, plantContext, {
				requestKey: randomUUID(),
				expectedRevision: "2",
				input: { plant: s.w, confirmed: true },
			}),
		),
	);
	assert.equal(requested.status, "ok");
	if (requested.status !== "ok") throw Error("deletion_request");
	const proof = await f.db.transaction((tx) =>
		issueRestrictedDeletionSession(tx, { subject: s.w, requestId: requested.value.requestId }, async () => ({
			accountId: s.sender.id,
			provenAt: new Date(Date.now() - 100),
		})),
	);
	const cancelled = await measure("settings.cancelWorkspaceDeletion", () =>
		f.db.transaction((tx) =>
			deletion.cancelWorkspaceDeletion(tx, proof, {
				requestKey: randomUUID(),
				expectedRevision: requested.value.revision,
				input: { subject: s.w, requestId: requested.value.requestId },
			}),
		),
	);
	assert.equal(cancelled.status, "ok");

	const mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "native@example.test",
		authorize: async (_tx, values) => new Set(values.map((v) => v.id)),
		transport: {
			send: async () => ({ kind: "unknown" }),
			lookup: async () => ({ kind: "accepted", id: "synthetic-provider" }),
		},
	});
	const notifications = createNotificationService({
		mail,
		eligible: async (_tx, values) => values.map(() => ({ address: s.sender.email })),
	});
	const meeting = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision) VALUES(${meeting},${s.w.id},'orientation','Synthetic meeting','2099-01-15','10:00','UTC','2099-01-15T10:00:00Z','temporal-v1','ready',1)`,
	);
	const reminders = await f.db.transaction((tx) =>
		notifications.syncMeetingReminders(tx, {
			base: {
				owner: s.w,
				recipient: s.sender.id,
				source: { kind: "meeting", id: meeting, revision: "1" },
				title: "Meeting reminder",
				text: "Synthetic reminder",
				operation: null,
			},
			date: "2099-01-15",
			time: "10:00:00",
			zone: "UTC",
			scheduled: true,
			startsAt: "2099-01-15T10:00:00Z",
			asOf: "2099-01-01T00:00:00Z",
		}),
	);
	assert.ok(reminders.length > 0);
	const mailId = reminders[0].mail;
	assert.ok(mailId);
	await f.admin.execute(
		sql`UPDATE mail SET state='unknown',provider_message_id='synthetic-provider' WHERE id=${mailId}`,
	);
	assert.deepEqual(await mail.reconcileUnknownOutcome(mailId), { kind: "accepted", id: "synthetic-provider" });

	await f.admin.execute(sql`UPDATE meeting SET revision=2,status='cancelled' WHERE id=${meeting}`);
	const cancelledNotices = await f.db.transaction((tx) =>
		notifications.cancelForEntity(tx, s.w.id, { kind: "meeting", id: meeting, revision: "2" }),
	);
	assert.equal(cancelledNotices, undefined);

	const onboarding = createOnboardingProducer({
		relationships: (tx, inputs) => sendOnboardingRelationships(tx, inputs, f.mail),
		async enqueue(tx, input, command) {
			f.mail.append(
				tx,
				{
					owner: { kind: "account", id: input.accountId },
					purpose: "discovery_receipt",
					logicalKey: "native/" + input.operationId,
					recipient: input.accountId,
					address: input.address,
					content: { subject: "Saved", text: "Saved" },
					operation: input.operationId,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				command.writes,
			);
		},
	});
	const discovery = await measure("native.onboarding.createDiscovery", () =>
		withOnboardingWrite(f.db, self, context, (tx) =>
			onboarding.createDiscovery(tx, context, { requestKey: randomUUID(), expectedRevision: "2", input: {} }),
		),
	);
	assert.equal(discovery.status, "ok");
} finally {
	await f.close();
}
