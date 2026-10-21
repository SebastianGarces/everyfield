import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { randomBytes } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { createNotificationService } from "../../../apps/web/src/server/jobs/notifications.ts";
import { enqueueJob, queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import { deletionOperations, issueRestrictedDeletionSession } from "../../../packages/domain/src/settings/deletion.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "../identity/invitations-support.mts";
import { peopleWriter, withPeopleWrite } from "../../../packages/domain/src/people/index.ts";
import { guestsWriter, meetingsWriter, withMeetingsWrite } from "../../../packages/domain/src/meetings/index.ts";
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
	// Meetings at the native boundary: the bound actor, one replay check, one locked read and one write statement.
	const meetingWrite = (name, body) => measure("native.meetings." + name, () => withMeetingsWrite(f.db, actor, body));
	const scheduled = await meetingWrite("schedule", (tx, ctx) =>
		meetingsWriter.schedule(tx, ctx, {
			requestKey: randomUUID(),
			input: {
				type: "vision_meeting",
				date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
				time: "18:00",
				guests: [created.value.person.id],
			},
		}),
	);
	assert.equal(scheduled.status, "ok");
	if (scheduled.status !== "ok") throw Error("schedule_refused");
	const answered = await meetingWrite("correctRsvp", (tx, ctx) =>
		guestsWriter.correctRsvp(tx, ctx, {
			requestKey: randomUUID(),
			// The guest row the schedule created.
			expectedRevision: "1",
			input: { meetingId: scheduled.value.meeting.id, personId: created.value.person.id, rsvp: "confirmed" },
		}),
	);
	assert.equal(answered.status, "ok");
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
	const unused = async () => {
		throw Error("unexpected_profile_collaborator");
	};
	// Each effect is rows the command runs inside its one write statement (D70); the mount does the same.
	const proofs = new Map();
	const organizations = createOrganizationAdapter(
		{
			invitation: (tx, i, writes) => {
				proofs.set(i.invitationId, i.proof);
				return f.mail.append(
					tx,
					{
						owner: i.owner,
						purpose: "relationship_invitation",
						logicalKey: "relationship/" + i.invitationId + "/" + i.operationId,
						recipient: null,
						address: i.recipientEmail,
						content: { subject: i.inviterDescription, text: "native " + i.proof },
						operation: i.operationId,
						notice: null,
						eligibleAt: new Date().toISOString(),
					},
					writes,
				);
			},
			notice: (tx, i) =>
				queueJobs(tx, [
					{
						tenant: i.pair.kind === "plant" ? i.pair.subject.id : i.pair.organization.id,
						kind: "notification",
						subject: i.relationshipId,
						key: i.kind + "/" + i.eventId,
						revision: i.revision,
						eligibleAt: new Date().toISOString(),
					},
				]),
			invalidate: (_tx, i) =>
				sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${i.sourceId} AND kind IN ('assessment','digest') AND state IN ('ready','retry_wait','claimed')`,
		},
		{ candidates: unused },
	);
	const orgUpdated = await measure("native.organizations.profile", () =>
		f.db.transaction(async (tx) => {
			assert.ok(await orgActor.bind(tx, org.w));
			return organizations["organizations.updateProfile"](tx, orgActor.session, org.w, {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { organization: org.w, patch: { name: "Native organization" } },
			});
		}),
	);
	assert.equal(orgUpdated.status, "committed");
	const orgProfile = await f.db.transaction((tx) =>
		organizations["organizations.getProfile"](tx, orgActor.session, org.w, { organization: org.w }),
	);
	assert.equal(orgProfile.profile.name, "Native organization");
	// Relationship writes at the native boundary: the write gate, one locked read, one replay check, one write statement.
	const pair = { kind: "plant", subject: s.w, organization: org.w };
	const linked = await f.db.execute(
		sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings) VALUES(${s.w.id},${org.w.id},clock_timestamp(),true,true,true,true,true,true,true) RETURNING id`,
	);
	const ended = await measure("native.organizations.end", () =>
		f.db.transaction(async (tx) => {
			assert.ok(await orgActor.bind(tx, org.w));
			return organizations["associations.end"](tx, orgActor.session, org.w, {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { relationshipId: linked.rows[0].id, pair, confirmed: true, reason: "Native end" },
			});
		}),
	);
	assert.equal(ended.status, "committed");
	const plantRevision = (await f.db.execute(sql`SELECT revision FROM plant WHERE id=${s.w.id}`)).rows[0].revision;
	const invited = await measure("native.organizations.invite", () =>
		f.db.transaction(async (tx) => {
			assert.ok(await actor.bind(tx, s.w));
			return organizations["associations.invite"](tx, actor.session, s.w, {
				requestKey: randomUUID(),
				expectedRevision: plantRevision,
				input: { pair, recipientEmail: org.sender.email },
			});
		}),
	);
	assert.equal(invited.status, "pending");
	const accepted = await measure("native.organizations.accept", () =>
		f.db.transaction(async (tx) => {
			assert.ok(await orgActor.bind(tx, org.w));
			return organizations["associations.acceptInvitation"](tx, orgActor.session, org.w, {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { invitationId: invited.invitationId, proof: proofs.get(invited.invitationId), decision: "accept" },
			});
		}),
	);
	assert.equal(accepted.status, "accepted");
	assert.equal(accepted.relationship.id, linked.rows[0].id);
	assert.equal(accepted.relationship.revision, "3");

	const a = await f.account(),
		self = await f.actor(a.session),
		context = {
			session: self.session,
			selected: self.actor.context.owner,
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
	if (profile.status !== "ok") throw Error("profile_refused");
	// One church submission with two changes is one write: one audit row naming both, under one request key.
	const churchKey = randomUUID();
	const church = await measure("settings.saveChurch", () =>
		withSettingsWrite(f.db, actor, plantContext, (tx) =>
			sections.saveChurch(tx, plantContext, {
				requestKey: churchKey,
				expectedRevision: profile.value.current.revision,
				input: {
					plant: s.w,
					changes: [
						{ kind: "profile", patch: { city: "Native city" } },
						{ kind: "inactivity", value: { warningDays: 10, alertDays: 40 } },
					],
				},
			}),
		),
	);
	assert.equal(church.status, "ok");
	if (church.status !== "ok") throw Error("church_refused");
	const churchAudit = await f.db.execute(
		sql`SELECT metadata FROM audit_event WHERE command_id = (SELECT id FROM audit_event WHERE request_key = ${churchKey})`,
	);
	assert.equal(churchAudit.rows.length, 1);
	assert.deepEqual(Object.keys(churchAudit.rows[0].metadata.diff).sort(), ["alertDays", "city", "warningDays"]);
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
				expectedRevision: church.value.current.revision,
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
