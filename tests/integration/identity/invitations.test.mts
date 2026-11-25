import "../platform/setup.mts";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTaskWriter, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { accountId } from "../../../packages/contracts/src/common/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { codeOf, fixture, key, noReminders, outcome, statementText, type Fixture } from "./invitations-support.mts";
import { waitingOnLock } from "../../support/fixture.mts";
import { and, eq, inArray, isNull, sql } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { assigneesOf, assignedCount, insertTasks } from "../task-assignees.mts";
type Review = Awaited<ReturnType<Fixture["seats"]["readRemoval"]>>;
let f: Fixture;
const sent: string[] = [];
before(async () => {
	f = await fixture();
	f.db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...q: unknown[]) {
			sent.push(statementText(q[0]));
			return Reflect.apply(query, this, q);
		};
	});
});
after(async () => {
	await f?.close();
});
const denied = (promise: Promise<unknown>, code = "invitation_unavailable") =>
	assert.rejects(promise, (e) => {
		assert.equal(codeOf(e), code);
		return true;
	});
const count = async (...[table, predicate]: Parameters<Fixture["admin"]["$count"]>) => f.admin.$count(table, predicate);

test("AC:TARGET-IDN-017 AC:TARGET-IDN-003 AC:ROLE43-006 ordinary invitation hides account resolution and persists hashed expiring proof", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		description = await f.invitations.describe({ proof: i.proof });
	assert.equal(description.status, "pending");
	assert.ok(description.subject.purpose === "seat");
	assert.equal(description.subject.role, "member");
	assert.equal(description.workspaceName, "Synthetic plant");
	assert.equal("recipientEmail" in description, false);
	const row = (
		await f.admin.select().from(t.invitation).where(eq(t.invitation.id, i.result.invitation.invitationId))
	)[0]!;
	assert.equal(row.token_hash, createHash("sha256").update(i.proof).digest("hex"));
	assert.equal(new Date(i.result.invitation.expiresAt).getTime() - row.created_at.getTime(), 30 * 86400000);
	assert.equal(JSON.stringify(i.result).includes("accountExists"), false);
	assert.equal(JSON.stringify(i.result).includes(i.proof), false);
	assert.deepEqual(await f.invitations.invite(await f.actor(s.sender.session), i.command), i.result);

	const sent = f.effects.findLast((e) => e.text.includes(i.proof) || e.text.includes(encodeURIComponent(i.proof)))!;
	assert.match(sent.text, /\/invitation#proof=\S+/);
	assert.doesNotMatch(sent.text, /[?&]proof=/);
});
test("INV-invitations: opening a seat invitation with its live proof writes nothing and the proof still accepts it", async () => {
	const s = await f.setup(),
		i = await f.invitation(s);
	const state = async () =>
		JSON.stringify({
			invitation: await f.admin
				.select()
				.from(t.invitation)
				.where(eq(t.invitation.id, i.result.invitation.invitationId)),
			audit: await count(t.audit_event, sql`true`),
			seats: await count(t.seat, sql`true`),
		});
	const before = await state();
	assert.equal((await f.invitations.describe({ proof: i.proof })).status, "pending");
	assert.equal(await state(), before);
	const accepted = await f.invitations.accept(s.recipient.session, i.claim);
	assert.equal(accepted.seat.role, "member");
});
test("AC:TARGET-IDN-002 AC:TARGET-IDN-030 AC:SCHEMA-002 INV-acceptance: concurrent same-intent claim activates one seat, Person, receipt and security intent", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		[a, b] = await Promise.all([
			f.invitations.accept(s.recipient.session, i.claim),
			f.invitations.accept(s.recipient.session, i.claim),
		]);
	assert.deepEqual(a, b);
	assert.equal(a.registrationState, "active");
	assert.equal(a.seat.role, "member");
	assert.equal(a.accountId, s.recipient.id);

	assert.equal(await count(t.seat, and(eq(t.seat.account_id, s.recipient.id), isNull(t.seat.ended_at))), 1);
	assert.equal(
		await count(t.person, and(eq(t.person.plant_id, s.w.id), eq(t.person.linked_account_id, s.recipient.id))),
		1,
	);

	assert.ok(a.seat.kind === "plant");
	const person = (await f.admin.select().from(t.person).where(eq(t.person.id, a.seat.personId)))[0]!;
	assert.equal(person.adult_classification, "unknown");
	assert.equal(await count(t.team_tenure, eq(t.team_tenure.person_id, person.id)), 0);
	await denied(f.invitations.accept(s.recipient.session, { ...i.claim, requestKey: key() }));
});
test("AC:TARGET-IDN-030 INV-atomicity: required outbox or receipt failure rolls back token seat Person activation and receipt", async () => {
	const s = await f.setup(),
		i = await f.invitation(s);
	f.setMailFault(true);
	try {
		await assert.rejects(f.invitations.accept(s.recipient.session, i.claim), /synthetic_outbox_failure/);
	} finally {
		f.setMailFault(false);
	}
	const row = (
		await f.admin.select().from(t.invitation).where(eq(t.invitation.id, i.result.invitation.invitationId))
	)[0]!;
	const account = (await f.admin.select().from(t.account).where(eq(t.account.id, s.recipient.id)))[0]!;
	assert.equal(row.state, "pending");
	assert.equal(account.registration_state, "pending_domain");
	assert.equal(await count(t.seat, eq(t.seat.account_id, s.recipient.id)), 0);
	assert.equal(await count(t.person, eq(t.person.linked_account_id, s.recipient.id)), 0);
	await f.admin.execute(sql`REVOKE INSERT ON ${sql.identifier(f.schema)}.audit_event FROM everyfield_runtime`);
	try {
		await assert.rejects(f.invitations.accept(s.recipient.session, i.claim), (error) => {
			assert.ok(error instanceof Error);
			assert.equal(codeOf(error.cause), "42501");
			return true;
		});
	} finally {
		await f.admin.execute(sql`GRANT INSERT ON ${sql.identifier(f.schema)}.audit_event TO everyfield_runtime`);
	}
	assert.equal(
		(await f.admin.select().from(t.invitation).where(eq(t.invitation.id, i.result.invitation.invitationId)))[0]!.state,
		"pending",
	);
	assert.equal(await count(t.audit_event, eq(t.audit_event.request_key, i.claim.requestKey)), 0);
	const accepted = await f.invitations.accept(s.recipient.session, i.claim);
	assert.equal(accepted.status, "accepted");
});
test("AC:TEN-005 AC:SEC-02 AC:AUTH-002 AC:TARGET-IDN-003 AC:TARGET-IDN-017 INV-claim: wrong mailbox unverified account and deletion witness cannot claim", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		other = await f.account();
	await denied(f.invitations.accept(other.session, i.claim));
	await f.admin.update(t.auth_user).set({ email_verified: false }).where(eq(t.auth_user.id, s.recipient.user));
	await denied(f.invitations.accept(s.recipient.session, i.claim));
	await f.admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, s.recipient.user));
	const requested = new Date();
	await f.admin.insert(t.lifecycle_witness).values({
		id: key(),
		kind: "account",
		opaque_subject_id: s.recipient.id,
		account_id: s.recipient.id,
		state: "pending_deletion",
		request_id: key(),
		request_revision: "1",
		requested_at: requested,
		cancel_until: new Date(requested.getTime() + 30 * 86400000),
		witness_checkpoint: "1",
		cleanup_state: "not_started",
	});
	await denied(f.invitations.accept(s.recipient.session, i.claim));
	assert.equal(await count(t.seat, eq(t.seat.account_id, s.recipient.id)), 0);
	const s2 = await f.setup(),
		i2 = await f.invitation(s2);
	await f.admin.insert(t.lifecycle_witness).values({
		id: key(),
		kind: "plant",
		opaque_subject_id: s2.w.id,
		plant_id: s2.w.id,
		state: "pending_deletion",
		request_id: key(),
		request_revision: "1",
		requested_at: requested,
		cancel_until: new Date(requested.getTime() + 30 * 86400000),
		witness_checkpoint: "1",
		cleanup_state: "not_started",
	});
	await denied(f.invitations.accept(s2.recipient.session, i2.claim));
	assert.equal(await count(t.seat, eq(t.seat.account_id, s2.recipient.id)), 0);
});
test("INV-expiry: an accept or resume that waits on the workspace lock past expiry refuses", async () => {
	for (const via of ["accept", "resume"] as const) {
		const s = await f.setup(),
			i = await f.invitation(s),
			id = i.result.invitation.invitationId;
		await f.admin.execute(
			sql`UPDATE invitation SET created_at=clock_timestamp()-interval '720 hours'+interval '2.5 seconds' WHERE id=${id}`,
		);
		const { claim } = await f.admin.transaction(async (tx) => {
			const { pid } = (
				await tx
					.select({ pid: sql<number>`pg_backend_pid()` })
					.from(t.plant)
					.where(eq(t.plant.id, s.w.id))
					.for("update")
			)[0]!;
			const claim = outcome<unknown>(
				via === "accept"
					? f.invitations.accept(s.recipient.session, i.claim)
					: f.invitations.resume(s.recipient.session, i.proof, key()),
			);
			assert.equal(
				await waitingOnLock(f.admin, { blockedBy: pid }),
				true,
				`${via} must wait for the workspace root lock`,
			);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			return { claim };
		});
		const result = await claim;
		assert.equal(codeOf(result.error), "invitation_unavailable", via + ": " + JSON.stringify(result.value ?? null));
		assert.equal(await count(t.seat, eq(t.seat.account_id, s.recipient.id)), 0);
		assert.equal((await f.admin.select().from(t.invitation).where(eq(t.invitation.id, id)))[0]!.state, "pending");
	}
});
test("AC:TARGET-IDN-017 INV-tenancy: active seat or independent Discovery association refuses a first seat without moving grants", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		foreign = await f.workspace();
	await f.seat(s.recipient, foreign, "member");
	await f.admin.update(t.account).set({ registration_state: "active" }).where(eq(t.account.id, s.recipient.id));
	await denied(f.invitations.accept(s.recipient.session, i.claim));
	assert.equal(
		await count(
			t.seat,
			and(eq(t.seat.account_id, s.recipient.id), eq(t.seat.plant_id, foreign.id), isNull(t.seat.ended_at)),
		),
		1,
	);
	const s2 = await f.setup(),
		i2 = await f.invitation(s2),
		org = await f.workspace("sending_church");
	await f.admin.insert(t.affiliation).values({
		account_id: s2.recipient.id,
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
	await denied(f.invitations.accept(s2.recipient.session, i2.claim));
	assert.equal(await count(t.seat, eq(t.seat.account_id, s2.recipient.id)), 0);
});
test("AC:ROLE43-007 AC:TARGET-IDN-017 INV-token: revoke claim resend and expiry serialize with one winner", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		change = { requestKey: key(), expectedRevision: "1", input: { invitationId: i.result.invitation.invitationId } };
	const outcomes = await Promise.allSettled([
		f.invitations.revoke(await f.actor(s.sender.session), change),
		f.invitations.accept(s.recipient.session, i.claim),
	]);
	assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
	const s2 = await f.setup(),
		i2 = await f.invitation(s2);
	await denied(
		f.invitations.resend(await f.actor(s2.sender.session), {
			...change,
			requestKey: key(),
			input: { invitationId: i2.result.invitation.invitationId },
		}),
		"invitation_cooldown",
	);
	await f.admin
		.update(t.invitation)
		.set({
			resent_at: sql`clock_timestamp()-interval '61 seconds'`,
			created_at: sql`clock_timestamp()-interval '120 seconds'`,
		})
		.where(eq(t.invitation.id, i2.result.invitation.invitationId));
	const sent = await f.invitations.resend(await f.actor(s2.sender.session), {
		...change,
		requestKey: key(),
		input: { invitationId: i2.result.invitation.invitationId },
	});
	assert.ok("invitation" in sent);
	assert.equal(sent.invitation.revision, "2");
	assert.deepEqual(await f.invitations.describe({ proof: i2.proof }), { status: "unavailable" });
	await denied(f.invitations.accept(s2.recipient.session, i2.claim));
	const fresh = await f.proof(i2.result.invitation.invitationId);
	assert.notEqual(fresh, i2.proof);
	await f.admin
		.update(t.invitation)
		.set({ created_at: sql`clock_timestamp()-interval '720 hours'-interval '1 second'` })
		.where(eq(t.invitation.id, i2.result.invitation.invitationId));
	assert.deepEqual(await f.invitations.describe({ proof: fresh }), { status: "unavailable" });
});
test("AC:TARGET-IDN-017 INV-budget: rolling workspace address budget is persistent and isolated", async () => {
	const s = await f.setup();
	for (let n = 0; n < 3; n++) {
		const i = await f.invitation(s);
		await f.invitations.revoke(await f.actor(s.sender.session), {
			requestKey: key(),
			expectedRevision: "1",
			input: { invitationId: i.result.invitation.invitationId },
		});
	}
	await denied(
		f.invitations.invite(await f.actor(s.sender.session), {
			requestKey: key(),
			expectedRevision: "1",
			input: { workspace: s.w, role: "member", recipientEmail: s.recipient.email },
		}),
		"invitation_rate_limited",
	);
	const other = await f.setup();
	other.recipient.email = s.recipient.email;
	assert.deepEqual(
		(
			await f.invitations.invite(await f.actor(other.sender.session), {
				requestKey: key(),
				expectedRevision: "1",
				input: { workspace: other.w, role: "admin", recipientEmail: s.recipient.email },
			})
		).invitation.subject,
		{ purpose: "seat", workspace: other.w, role: "admin" },
	);
});
test("AC:ADR1-004 resident accept is addressed, atomic, consent-specific and seatless", async () => {
	const s = await f.setup("sending_church"),
		person = await f.resident(s.w),
		i = await f.invitation(s, person),
		claim = {
			...i.claim,
			input: { ...i.claim.input, decision: "accept", choices: { shareFoundations: true, shareMilestones: false } },
		};
	f.setMailFault(true);
	try {
		await assert.rejects(f.invitations.respondResident(s.recipient.session, claim), /synthetic_outbox_failure/);
	} finally {
		f.setMailFault(false);
	}
	assert.equal(await count(t.residency_link, eq(t.residency_link.person_id, person)), 0);
	const [a, b] = await Promise.all([
		f.invitations.respondResident(s.recipient.session, claim),
		f.invitations.respondResident(s.recipient.session, claim),
	]);
	assert.deepEqual(a, b);
	assert.ok(a.status === "accepted");
	assert.equal(a.consentRevision, "1");
	assert.deepEqual(a.choices, { shareFoundations: true, shareMilestones: false });
	assert.equal(await count(t.seat, eq(t.seat.account_id, s.recipient.id)), 0);
	assert.equal(await count(t.residency_link, eq(t.residency_link.person_id, person)), 1);
});
test("AC:ADR1-004 resident decline leaves account unchanged and retired or foreign Persons refuse", async () => {
	const s = await f.setup("sending_network"),
		p = await f.resident(s.w),
		i = await f.invitation(s, p),
		claim = { ...i.claim, input: { ...i.claim.input, decision: "decline" } };
	const a = await f.invitations.respondResident(s.recipient.session, claim);
	assert.equal(a.status, "declined");
	assert.deepEqual(await f.invitations.respondResident(s.recipient.session, claim), a);
	assert.equal(
		(await f.admin.select().from(t.account).where(eq(t.account.id, s.recipient.id)))[0]!.registration_state,
		"pending_domain",
	);
	const s2 = await f.setup("sending_church"),
		p2 = await f.resident(s2.w),
		i2 = await f.invitation(s2, p2);
	await f.admin.update(t.person).set({ state: "retired", retired_at: new Date() }).where(eq(t.person.id, p2));
	await denied(
		f.invitations.respondResident(s2.recipient.session, {
			...i2.claim,
			input: { ...i2.claim.input, decision: "accept", choices: { shareFoundations: false, shareMilestones: false } },
		}),
	);
});
test("AC:TARGET-IDN-019 AC:ROLE43-009 AC:ROLE43-017 roster and ordinary role changes preserve Owner and exact tenant", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		a = await f.invitations.accept(s.recipient.session, i.claim),
		list = await f.seats.list(await f.actor(s.recipient.session), { workspace: s.w });
	assert.equal(list.items.length, 2);
	assert.equal(list.items.find((x) => x.seatId === a.seat.seatId)!.joined.source, "accepted_invitation");
	assert.equal(JSON.stringify(list).includes(s.sender.email), false);
	const cmd = {
		requestKey: key(),
		expectedRevision: "1",
		input: { seatId: a.seat.seatId, expectedRole: "member", to: "admin" },
	};
	await denied(f.seats.appointAdmin(await f.actor(s.recipient.session), s.w, cmd));
	const changed = await f.seats.appointAdmin(await f.actor(s.sender.session), s.w, cmd);
	assert.equal(changed.revision, "2");
	assert.deepEqual(await f.seats.appointAdmin(await f.actor(s.sender.session), s.w, cmd), changed);
	const owner = list.items.find((x) => x.role === "owner")!;
	await denied(
		f.seats.remove(
			await f.actor(s.recipient.session),
			s.w,
			{
				requestKey: key(),
				expectedRevision: "1",
				input: { seatId: owner.seatId, expectedRole: "admin", handoffs: [] },
			},
			noReminders,
		),
		"protected_owner",
	);
	const demoted = await f.seats.demote(await f.actor(s.recipient.session), s.w, {
		requestKey: key(),
		expectedRevision: "2",
		input: { seatId: a.seat.seatId, expectedRole: "admin", to: "member" },
	});
	assert.equal(demoted.revision, "3");
	const membership = await f.seats.readCurrentMembership(s.recipient.session);
	assert.ok(membership.status === "active");
	assert.equal(membership.role, "member");
});
test("AC:TARGET-IDN-019 INV-removal: exact open-duty handoff retains Person and closed work while revoking all sessions", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		a = await f.invitations.accept(s.recipient.session, i.claim),
		open = key(),
		closed = key();
	await insertTasks(f.admin, [
		{
			id: open,
			plant_id: s.w.id,
			title: "Actionable",
			category: "general",
			priority: "medium",
			status: "not_started",
			created_at: new Date(),
			assignee_id: s.recipient.id,
			due_kind: "undated",
		},
		{
			id: closed,
			plant_id: s.w.id,
			title: "Complete",
			category: "general",
			priority: "medium",
			status: "complete",
			completed_at: new Date(),
			created_at: new Date(),
			assignee_id: s.recipient.id,
			due_kind: "undated",
		},
	]);
	const cmd = {
		requestKey: key(),
		expectedRevision: "1",
		input: { seatId: a.seat.seatId, expectedRole: "member", handoffs: [] },
	};
	await denied(f.seats.remove(await f.actor(s.sender.session), s.w, cmd, noReminders), "conflict");
	const result = await f.seats.remove(
		await f.actor(s.sender.session),
		s.w,
		{
			...cmd,
			requestKey: key(),
			input: {
				...cmd.input,
				handoffs: [{ kind: "assign", dutyId: open, expectedRevision: "1", recipientAccountId: s.sender.id }],
			},
		},
		noReminders,
	);
	assert.deepEqual(result.duties, [{ status: "moved", dutyId: open, recipientAccountId: s.sender.id }]);
	assert.deepEqual(await assigneesOf(f.admin, open), [s.sender.id]);
	assert.equal((await f.admin.select().from(t.task).where(eq(t.task.id, closed)))[0]!.status, "complete");
	assert.ok(a.seat.kind === "plant");
	assert.equal(
		(await f.admin.select().from(t.person).where(eq(t.person.id, a.seat.personId)))[0]!.linked_account_id,
		s.recipient.id,
	);
	assert.equal(await count(t.auth_session, eq(t.auth_session.user_id, s.recipient.user)), 0);
});

test("AC:TARGET-IDN-019 INV-removal-review: the review names exactly the duties remove requires and only eligible recipients", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		a = await f.invitations.accept(s.recipient.session, i.claim),
		open = key(),
		closed = key(),
		other = await f.setup();
	await insertTasks(f.admin, [
		{
			id: open,
			plant_id: s.w.id,
			title: "Call James",
			category: "general",
			priority: "medium",
			status: "not_started",
			created_at: new Date(),
			assignee_id: s.recipient.id,
			due_kind: "undated",
		},
		{
			id: closed,
			plant_id: s.w.id,
			title: "Complete",
			category: "general",
			priority: "medium",
			status: "complete",
			completed_at: new Date(),
			created_at: new Date(),
			assignee_id: s.recipient.id,
			due_kind: "undated",
		},
	]);
	const target = { seatId: a.seat.seatId };
	await denied(f.seats.readRemoval(s.recipient.session, s.w, target));
	await denied(f.seats.readRemoval(other.sender.session, s.w, target));
	await denied(f.seats.readRemoval(other.sender.session, other.w, target));
	const review = await f.seats.readRemoval(s.sender.session, s.w, target);
	assert.deepEqual(review.duties, [
		{ dutyId: open, expectedRevision: "1", kind: "task", label: "Call James", needsRecipient: false },
	]);
	assert.deepEqual(
		review.recipients.map((r) => r.accountId),
		[s.sender.id],
	);
	const result = await f.seats.remove(
		await f.actor(s.sender.session),
		s.w,
		{
			requestKey: key(),
			expectedRevision: review.expectedRevision,
			input: {
				seatId: review.seatId,
				expectedRole: review.expectedRole,
				handoffs: review.duties.map((d) => ({
					kind: "assign",
					dutyId: d.dutyId,
					expectedRevision: d.expectedRevision,
					recipientAccountId: review.recipients[0]!.accountId,
				})),
			},
		},
		noReminders,
	);
	assert.deepEqual(result.duties, [{ status: "moved", dutyId: open, recipientAccountId: s.sender.id }]);
	await denied(f.seats.readRemoval(s.sender.session, s.w, target));
});

async function statements<V>(body: () => Promise<V>) {
	const start = sent.length;
	return { result: await body(), sent: sent.slice(start) };
}

test("AC:TARGET-IDN-019 INV-removal-review-recipients: only eligible seats are offered, in a fixed number of unlocked statements", async () => {
	const s = await f.setup(),
		target = await f.account();
	const seatId = await f.seat(target, s.w, "member");
	const member = async (state = "active") => {
		const a = await f.account(state);
		return { account: a, seat: await f.seat(a, s.w, "member") };
	};
	const witness = (
		values: Omit<typeof t.lifecycle_witness.$inferInsert, "request_revision" | "witness_checkpoint" | "cleanup_state">,
	) =>
		f.admin.insert(t.lifecycle_witness).values({
			request_revision: "1",
			witness_checkpoint: "1",
			cleanup_state: "not_started",
			...values,
		});
	await member("pending_domain");
	const future = await member(),
		ended = await member(),
		blockedAccount = await member(),
		witnessed = await member();
	await f.admin
		.update(t.seat)
		.set({ accepted_at: new Date(Date.now() + 86400000) })
		.where(eq(t.seat.id, future.seat));
	await f.admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.id, ended.seat));
	const requested = new Date();
	await witness({
		kind: "account",
		opaque_subject_id: blockedAccount.account.id,
		account_id: blockedAccount.account.id,
		state: "pending_deletion",
		request_id: key(),
		requested_at: requested,
		cancel_until: new Date(requested.getTime() + 30 * 86400000),
	});
	await witness({
		kind: "account",
		opaque_subject_id: witnessed.account.id,
		account_id: witnessed.account.id,
		state: "cancelled",
		request_id: key(),
		requested_at: requested,
		cancel_until: new Date(requested.getTime() + 30 * 86400000),
		cancelled_at: requested,
	});
	const review = () => statements(() => f.seats.readRemoval(s.sender.session, s.w, { seatId }));
	const few = await review();
	const ids = (r: { result: Review }) => r.result.recipients.map((x) => x.accountId);
	const bySeat = (pairs: [string, string][]) => pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((p) => p[1]);
	const owner = (await f.admin.select().from(t.seat).where(eq(t.seat.account_id, s.sender.id)))[0]!;
	assert.deepEqual(
		ids(few),
		bySeat([
			[owner.id, s.sender.id],
			[witnessed.seat, witnessed.account.id],
		]),
	);
	assert.equal(few.result.recipients[0]!.displayName, "Synthetic person");
	const more: Awaited<ReturnType<typeof member>>[] = [];
	for (let n = 0; n < 4; n++) more.push(await member());
	const many = await review();
	assert.deepEqual(
		ids(many),
		bySeat([
			[owner.id, s.sender.id],
			[witnessed.seat, witnessed.account.id],
			...more.map((m): [string, string] => [m.seat, m.account.id]),
		]),
	);
	assert.equal(many.sent.length, few.sent.length);
	assert.deepEqual(
		many.sent.filter((q) => /\bfor\s+(update|share|no key update|key share)\b/i.test(q)),
		[],
	);
});

test("AC:TARGET-IDN-019 INV-removal-linked: a task with a linked obligation is one duty, and a closed linked task keeps its outcome", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		a = await f.invitations.accept(s.recipient.session, i.claim),
		[linked, settled] = [key(), key()],
		[open, closed] = [key(), key()];
	for (const id of [linked, settled]) {
		const meeting = key();
		await f.admin.execute(
			sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision) VALUES(${meeting},${s.w.id},'vision_meeting','Vision night','2026-10-20','18:00','America/Chicago','2026-10-20T23:00:00Z','1','completed',1)`,
		);
		await f.admin.execute(
			sql`INSERT INTO obligation(id,plant_id,meeting_id,kind,origin_at,origin_date,timezone,formula_version,due_date) VALUES(${id},${s.w.id},${meeting},'evaluation','2026-10-20T23:00:00Z','2026-10-20','America/Chicago','1','2026-10-30')`,
		);
	}
	await insertTasks(f.admin, [
		{
			id: open,
			plant_id: s.w.id,
			title: "Evaluate the visitor",
			category: "general",
			priority: "medium",
			status: "not_started",
			created_at: new Date(),
			assignee_id: s.recipient.id,
			due_kind: "undated",
			obligation_id: linked,
		},
		{
			id: closed,
			plant_id: s.w.id,
			title: "Evaluated",
			category: "general",
			priority: "medium",
			status: "complete",
			completed_at: new Date(),
			created_at: new Date(),
			assignee_id: s.recipient.id,
			due_kind: "undated",
			obligation_id: settled,
		},
	]);
	const review = await f.seats.readRemoval(s.sender.session, s.w, { seatId: a.seat.seatId });
	assert.deepEqual(
		review.duties.map((d) => [d.dutyId, d.kind]),
		[[open, "task"]],
	);
	const result = await f.seats.remove(
		await f.actor(s.sender.session),
		s.w,
		{
			requestKey: key(),
			expectedRevision: review.expectedRevision,
			input: {
				seatId: review.seatId,
				expectedRole: review.expectedRole,
				handoffs: [{ kind: "assign", dutyId: open, expectedRevision: "1", recipientAccountId: s.sender.id }],
			},
		},
		noReminders,
	);
	assert.deepEqual(result.duties, [{ status: "moved", dutyId: open, recipientAccountId: s.sender.id }]);
	assert.deepEqual(await assigneesOf(f.admin, open), [s.sender.id]);
	const kept = (await f.admin.select().from(t.task).where(eq(t.task.id, closed)))[0]!;
	assert.equal(kept.status, "complete");
	assert.deepEqual(await assigneesOf(f.admin, closed), [s.recipient.id]);
});

test("AC:TARGET-IDN-019 INV-removal-bound: 101 and 250 open duties are all reviewed, a stale one refuses, and one call hands them all over", async () => {
	for (const n of [101, 250]) {
		const s = await f.setup(),
			i = await f.invitation(s),
			a = await f.invitations.accept(s.recipient.session, i.claim),
			ids = Array.from({ length: n }, () => key());
		await insertTasks(
			f.admin,
			ids.map((id, k) => ({
				id,
				plant_id: s.w.id,
				title: `Task ${k + 1}`,
				category: "general",
				priority: "medium",
				status: "not_started",
				created_at: new Date(),
				assignee_id: s.recipient.id,
				due_kind: "undated",
			})),
		);
		const target = { seatId: a.seat.seatId };
		const command = (review: Review) => ({
			requestKey: key(),
			expectedRevision: review.expectedRevision,
			input: {
				seatId: review.seatId,
				expectedRole: review.expectedRole,
				handoffs: review.duties.map((d) => ({
					kind: "assign",
					dutyId: d.dutyId,
					expectedRevision: d.expectedRevision,
					recipientAccountId: s.sender.id,
				})),
			},
		});
		const stale = await f.seats.readRemoval(s.sender.session, s.w, target);
		assert.deepEqual(new Set(stale.duties.map((d) => d.dutyId)), new Set(ids));
		await f.admin
			.update(t.task)
			.set({ revision: "2" })
			.where(eq(t.task.id, ids[n - 1]!));
		await denied(f.seats.remove(await f.actor(s.sender.session), s.w, command(stale), noReminders), "conflict");
		assert.equal(await assignedCount(f.admin, s.sender.id, s.w.id), 0);
		const fresh = await f.seats.readRemoval(s.sender.session, s.w, target);
		const result = await f.seats.remove(await f.actor(s.sender.session), s.w, command(fresh), noReminders);
		assert.equal(result.duties.filter((d) => d.status === "moved").length, n);
		assert.equal(await assignedCount(f.admin, s.sender.id, s.w.id), n);
	}
});

test("AC:TARGET-IDN-002 AC:TARGET-IDN-003 AC:TARGET-IDN-030 AC:SEC-03 native invitation signup, sign-in and exact resume never activate from email equality", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		native = f.native("invitation_only"),
		address = key() + "@example.test",
		password = "Synthetic-native-password-1";
	const send = (body: object) => native("register", body, undefined, { "x-test-ip": "127.0.0.21" });
	const options = await native("registration-options?invitationProof=" + i.proof);
	const registrationOptions = await options.json();
	assert.equal(registrationOptions.invitation.kind, "plant_precreation");
	assert.deepEqual(registrationOptions.kinds, ["plant_precreation"]);
	assert.deepEqual((await (await native("registration-options")).json()).kinds, [
		"plant_precreation",
		"discovery",
		"sending_church",
		"sending_network",
	]);
	const unrelated = await send({
		kind: "invitation",
		name: "Synthetic",
		email: address,
		password,
		invitationProof: i.proof,
		requestKey: key(),
	});
	assert.deepEqual(await unrelated.json(), { status: "continue_identity_proof" });
	assert.equal(await count(t.auth_user, eq(t.auth_user.email, address)), 0);
	const duplicate = await send({
		kind: "invitation",
		name: "Synthetic",
		email: s.recipient.email,
		password,
		invitationProof: i.proof,
		requestKey: key(),
	});
	assert.deepEqual(await duplicate.json(), { status: "continue_identity_proof" });
	assert.equal(duplicate.headers.get("set-cookie"), null);
	const s2 = await f.setup(),
		newEmail = key() + "@example.test";
	s2.recipient.email = newEmail;
	const j = await f.invitation(s2);
	const created = await native(
		"register",
		{ kind: "invitation", name: "New invitee", email: newEmail, password, invitationProof: j.proof, requestKey: key() },
		undefined,
		{ "x-test-ip": "127.0.0.22" },
	);
	assert.deepEqual(await created.json(), { status: "continue_identity_proof" });
	const user = (await f.admin.select().from(t.auth_user).where(eq(t.auth_user.email, newEmail)))[0]!;
	const account = (await f.admin.select().from(t.account).where(eq(t.account.auth_user_id, user.id)))[0]!;
	assert.equal(account.registration_state, "pending_domain");
	assert.equal(await count(t.seat, eq(t.seat.account_id, account.id)), 0);
	const login = await native("sign-in/email", { email: newEmail, password });
	assert.equal(login.status, 200);
	const cookie = login.headers
			.getSetCookie()
			.map((v) => v.split(";")[0])
			.join("; "),
		intent = { requestKey: key(), invitationProof: j.proof };
	await native("resume-registration", intent, cookie).then(async (r) =>
		assert.equal((await r.json()).code, "invitation_unavailable"),
	);
	await f.admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, user.id));
	const resume = await native("resume-registration", intent, cookie),
		accepted = await resume.json();
	assert.equal(accepted.status, "active");
	assert.equal(accepted.accountId, account.id);
	assert.equal((await f.admin.select().from(t.seat).where(eq(t.seat.account_id, account.id)))[0]!.role, "member");

	assert.deepEqual(await (await native("resume-registration", intent, cookie)).json(), accepted);
	const foreign = await native("resume-registration", intent);
	assert.equal(foreign.status, 401);
});

test("AC:ADR1-004 INV-resident: foreign Person, foreign linked account and stale revision refuse with no link", async () => {
	const s = await f.setup("sending_church"),
		foreign = await f.setup("sending_network"),
		p = await f.resident(foreign.w);
	await denied(
		f.invitations.inviteResident(await f.actor(s.sender.session), {
			requestKey: key(),
			expectedRevision: "1",
			input: { organization: s.w, personId: p, recipientEmail: s.recipient.email },
		}),
	);
	const own = await f.resident(s.w),
		i = await f.invitation(s, own),
		claim = {
			...i.claim,
			input: { ...i.claim.input, decision: "accept", choices: { shareFoundations: false, shareMilestones: false } },
		};
	await denied(f.invitations.respondResident(s.recipient.session, { ...claim, expectedRevision: "2" }));
	await f.admin.update(t.person).set({ linked_account_id: foreign.recipient.id }).where(eq(t.person.id, own));
	await denied(f.invitations.respondResident(s.recipient.session, claim));
	assert.equal(await count(t.residency_link, eq(t.residency_link.person_id, own)), 0);
});

test("AC:ROLE43-006 INV-settings-member INV-invitations: pending and Member actors cannot send or list administrative invitations", async () => {
	const s = await f.setup(),
		i = await f.invitation(s);
	await denied(f.actor(s.recipient.session).then((a) => f.invitations.list(a, { workspace: s.w })));
	const accepted = await f.invitations.accept(s.recipient.session, i.claim);
	assert.equal(accepted.seat.role, "member");
	await denied(
		f.invitations.invite(await f.actor(s.recipient.session), {
			requestKey: key(),
			expectedRevision: "1",
			input: { workspace: s.w, role: "admin", recipientEmail: key() + "@example.test" },
		}),
	);
	await denied(f.invitations.list(await f.actor(s.recipient.session), { workspace: s.w }));
	const changed = { ...i.command, input: { ...i.command.input, role: "admin" } };
	await denied(f.invitations.invite(await f.actor(s.sender.session), changed), "idempotency_conflict");
});

test("INV-invitations: a seat invite or invitation list naming another workspace than the session's is refused and writes nothing", async () => {
	const s = await f.setup(),
		other = await f.setup(),
		pending = await f.invitation(other);
	const writes = async () => ({
		invitations: await count(t.invitation, sql`true`),
		audit: await count(t.audit_event, sql`true`),
		mail: f.effects.length,
	});
	const before = await writes();
	const sender = await f.actor(s.sender.session);
	for (const role of ["member", "admin"])
		await denied(
			f.invitations.invite(sender, {
				requestKey: key(),
				expectedRevision: "1",
				input: { workspace: other.w, role, recipientEmail: key() + "@example.test" },
			}),
		);
	await denied(f.invitations.list(sender, { workspace: other.w }));
	await denied(f.invitations.list(sender, { workspace: other.w, after: pending.result.invitation.invitationId }));
	await f.dispatch();
	assert.deepEqual(await writes(), before);
});

test("INV-invite-revision: a stale workspace revision refuses as conflict, a duplicate pending invitation stays unavailable", async () => {
	const s = await f.setup(),
		i = await f.invitation(s);
	await denied(
		f.invitations.invite(await f.actor(s.sender.session), { ...i.command, requestKey: key() }),
		"invitation_unavailable",
	);
	await f.admin.update(t.plant).set({ revision: "2" }).where(eq(t.plant.id, s.w.id));
	const before = await count(t.invitation, eq(t.invitation.tenant_id, s.w.id));
	await denied(
		f.invitations.invite(await f.actor(s.sender.session), {
			requestKey: key(),
			expectedRevision: "1",
			input: { workspace: s.w, role: "member", recipientEmail: key() + "@example.test" },
		}),
		"conflict",
	);
	assert.equal(await count(t.invitation, eq(t.invitation.tenant_id, s.w.id)), before);
	const sent = await f.invitations.invite(await f.actor(s.sender.session), {
		requestKey: key(),
		expectedRevision: "2",
		input: { workspace: s.w, role: "member", recipientEmail: key() + "@example.test" },
	});
	assert.equal(sent.invitation.status, "pending");
});
test("AC:ROLE43-006 C13: seats.list and invitations.list read nothing for an actor whose seat ended or role changed", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		admin = await f.account();
	const adminSeat = await f.seat(admin, s.w, "admin");
	const owner = await f.actor(s.sender.session),
		appointed = await f.actor(admin.session);
	assert.equal(
		(await f.invitations.list(owner, { workspace: s.w })).items[0]!.invitationId,
		i.result.invitation.invitationId,
	);
	assert.equal((await f.invitations.list(appointed, { workspace: s.w })).items.length, 1);
	assert.equal((await f.seats.list(appointed, { workspace: s.w })).items.length, 2);
	await f.admin.update(t.seat).set({ role: "member" }).where(eq(t.seat.id, adminSeat));
	await denied(f.invitations.list(appointed, { workspace: s.w }));
	assert.equal((await f.seats.list(appointed, { workspace: s.w })).items.length, 2);
	await f.admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.id, adminSeat));
	await denied(f.seats.list(appointed, { workspace: s.w }));
	await f.admin
		.update(t.seat)
		.set({ ended_at: new Date() })
		.where(and(eq(t.seat.account_id, s.sender.id), eq(t.seat.plant_id, s.w.id)));
	await denied(f.invitations.list(owner, { workspace: s.w }));
	await denied(f.seats.list(owner, { workspace: s.w }));
});

test("AC:TARGET-IDN-017 INV-mail: revoked invitation cancels its pending outbox handoff", async () => {
	const s = await f.setup(),
		result = await f.invitations.invite(await f.actor(s.sender.session), {
			requestKey: key(),
			expectedRevision: "1",
			input: { workspace: s.w, role: "admin", recipientEmail: s.recipient.email },
		}),
		before = f.effects.filter((e) => e.to === s.recipient.email).length;
	await f.invitations.revoke(await f.actor(s.sender.session), {
		requestKey: key(),
		expectedRevision: "1",
		input: { invitationId: result.invitation.invitationId },
	});
	await f.dispatch();
	assert.equal(f.effects.filter((e) => e.to === s.recipient.email).length, before);
	const mail = (await f.admin.select().from(t.mail).where(eq(t.mail.tenant_id, s.w.id)))[0]!;
	assert.equal(mail.state, "cancelled");
});

test("AC:ADR1-004 INV-person-reference: retirement and invitation revocation beat a waiting resident claim without a deadlock", async () => {
	const s = await f.setup("sending_church"),
		person = await f.resident(s.w),
		i = await f.invitation(s, person);
	const { claim } = await f.admin.transaction(async (tx) => {
		await tx.select({ id: t.person.id }).from(t.person).where(eq(t.person.id, person)).for("update");
		const { pid } = (
			await tx
				.select({ pid: sql<number>`pg_backend_pid()` })
				.from(t.person)
				.limit(1)
		)[0]!;
		const claim = outcome(
			f.invitations.respondResident(s.recipient.session, {
				...i.claim,
				input: { ...i.claim.input, decision: "accept", choices: { shareFoundations: true, shareMilestones: false } },
			}),
		);
		assert.equal(
			await waitingOnLock(f.admin, { blockedBy: pid }),
			true,
			"The claim must reach its competing Person lock",
		);
		await tx
			.update(t.person)
			.set({ state: "retired", retired_at: new Date(), revision: "2" })
			.where(eq(t.person.id, person));
		await tx
			.update(t.invitation)
			.set({ state: "revoked", revision: "2" })
			.where(eq(t.invitation.id, i.result.invitation.invitationId));
		return { claim };
	});
	const result = await claim;
	assert.equal(
		codeOf(result.error),
		"invitation_unavailable",
		JSON.stringify({ databaseCode: result.error instanceof Error ? codeOf(result.error.cause) : undefined }),
	);
	assert.equal(await count(t.residency_link, eq(t.residency_link.person_id, person)), 0);
	assert.equal(
		(await f.admin.select().from(t.invitation).where(eq(t.invitation.id, i.result.invitation.invitationId)))[0]!.state,
		"revoked",
	);
});

test("AC:ADR1-004 INV-relationship-race: contended existing affiliation refuses safely and the same intent resumes after commit", async () => {
	const s = await f.setup("sending_church"),
		person = await f.resident(s.w),
		i = await f.invitation(s, person),
		id = key();
	await f.admin.update(t.account).set({ registration_state: "active" }).where(eq(t.account.id, s.recipient.id));
	await f.admin.insert(t.affiliation).values({
		id,
		account_id: s.recipient.id,
		organization_id: s.w.id,
		accepted_at: new Date(),
		share_people: false,
		share_meetings: false,
		share_tasks: false,
		share_ministry_teams: false,
		share_wiki: false,
		share_activity: false,
		shared_findings: false,
	});
	const claim = {
		...i.claim,
		input: { ...i.claim.input, decision: "accept", choices: { shareFoundations: false, shareMilestones: true } },
	};
	await f.admin.transaction(async (tx) => {
		await tx.select({ id: t.affiliation.id }).from(t.affiliation).where(eq(t.affiliation.id, id)).for("update");
		await denied(f.invitations.respondResident(s.recipient.session, claim), "temporary");
	});
	assert.equal(await count(t.residency_link, eq(t.residency_link.person_id, person)), 0);
	const accepted = await f.invitations.respondResident(s.recipient.session, claim);
	assert.equal(accepted.status, "accepted");
	assert.equal(
		await count(
			t.affiliation,
			and(eq(t.affiliation.account_id, s.recipient.id), eq(t.affiliation.organization_id, s.w.id)),
		),
		1,
	);
	assert.deepEqual(accepted.choices, { shareFoundations: false, shareMilestones: true });
});

const effects = async () =>
	(
		await f.admin.execute<Record<string, number>>(
			sql`SELECT (SELECT count(*)::int FROM auth_user) users,(SELECT count(*)::int FROM account) accounts,
				(SELECT count(*)::int FROM seat) seats,(SELECT count(*)::int FROM person) people,
				(SELECT count(*)::int FROM audit_event) events,(SELECT count(*)::int FROM mail) mail`,
		)
	).rows[0]!;
const PASSWORD = "Fixture-new-pass-2";
const registerAt = (
	native: ReturnType<Fixture["native"]>,
	ip: string,
	email: string,
	kind: string,
	extra: Record<string, unknown> = {},
) =>
	native(
		"register",
		{
			kind,
			name: "Alex",
			email,
			password: PASSWORD,
			requestKey: key(),
			...(kind.startsWith("sending_") ? { organizationName: "Alex's organization" } : {}),
			...extra,
		},
		undefined,
		{ "x-test-ip": ip },
	);
async function signedIn(native: ReturnType<Fixture["native"]>, email: string) {
	const response = await native("sign-in/email", { email, password: PASSWORD });
	assert.equal(response.status, 200);
	return response.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
}
async function identityOf(email: string) {
	const rows = await f.admin
		.select({
			user: t.auth_user.id,
			id: t.account.id,
			state: t.account.registration_state,
			kind: t.account.registration_kind,
		})
		.from(t.auth_user)
		.leftJoin(t.account, eq(t.account.auth_user_id, t.auth_user.id))
		.where(eq(t.auth_user.email, email));
	assert.equal(rows.length, 1, email + " has one identity");
	const { user, id, state, kind } = rows[0]!;
	assert.ok(id);
	return { user, id, state, kind };
}
const verify = (user: string) =>
	f.admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, user));
const liveSeats = (account: string) => count(t.seat, and(eq(t.seat.account_id, account), isNull(t.seat.ended_at)));

test("AC:TARGET-IDN-002 two concurrent registrations of one address make one account of each type, which then holds at most the one seat it was provisioned", async () => {
	const native = f.native();
	const onboarding = createOnboardingProducer({ relationships: async () => {}, enqueue: async () => {} });
	let n = 0;
	for (const [kind, stored, workspace, seats] of [
		["plant_precreation", "planter", null, 1],
		["discovery", "discovery", null, 0],
		["sending_church", "sending_church", "sending_church", 1],
		["sending_network", "network", "sending_network", 1],
	] as const) {
		const email = key() + "@example.test";
		const answers = await Promise.all(
			[email, " " + email.toUpperCase() + " "].map((address) => registerAt(native, `127.0.2.${++n}`, address, kind)),
		);
		for (const answer of answers) {
			assert.deepEqual(await answer.json(), { status: "continue_identity_proof" });
			assert.equal(answer.headers.get("set-cookie"), null);
		}
		const a = await identityOf(email);
		assert.deepEqual([a.state, a.kind], ["pending_domain", stored]);
		assert.equal(await liveSeats(a.id), 0);
		await verify(a.user);
		const cookie = await signedIn(native, email);
		const { sessionId } = await (await native("get-session", undefined, cookie)).json();
		if (kind === "plant_precreation" || kind === "discovery") {
			const command = {
				requestKey: key(),
				expectedRevision: "1",
				input: kind === "discovery" ? {} : { name: "Harvest Point", confirmed: true },
			};
			const context = { session: sessionId, selected: { kind: "account" as const, id: accountId.parse(a.id) } };
			const provision = () =>
				gatedTransaction(f.db, async (tx) =>
					kind === "discovery"
						? (await onboarding.createDiscovery(tx, context, command)).status
						: (await onboarding.createPlant(tx, context, command)).status,
				);
			const replies = await Promise.all([provision(), provision()]);
			assert.deepEqual(replies, ["ok", "ok"]);
			assert.equal(await count(t.discovery, eq(t.discovery.account_id, a.id)), kind === "discovery" ? 1 : 0);
			assert.equal(await count(t.person, eq(t.person.linked_account_id, a.id)), kind === "discovery" ? 0 : 1);
		} else {
			const s = await f.setup(workspace!);
			s.recipient.email = email;
			const i = await f.invitation(s);
			const resumed = await Promise.all(
				[1, 2].map(() =>
					native("resume-registration", { requestKey: i.claim.requestKey, invitationProof: i.proof }, cookie),
				),
			);
			for (const r of resumed) assert.deepEqual(await r.json(), { status: "active", accountId: a.id });
		}
		assert.equal(await liveSeats(a.id), seats, kind);
		assert.equal((await identityOf(email)).state, "active");
		assert.equal((await registerAt(native, `127.0.2.${++n}`, email, "discovery")).status, 200);
		assert.deepEqual(await identityOf(email), { ...a, state: "active" });
	}
});

test("AC:TARGET-IDN-002 success, duplicate, malformed and refused registrations share one trusted IP's three an hour, and a refused one creates nobody", async () => {
	const open = f.native(),
		gated = f.native("invitation_only");
	const email = key() + "@example.test",
		late = key() + "@example.test";
	assert.equal((await registerAt(open, "127.0.3.1", email, "discovery")).status, 200);
	assert.equal((await registerAt(open, "127.0.3.1", email, "discovery")).status, 200);
	assert.equal((await registerAt(open, "127.0.3.1", "not-an-address", "discovery")).status, 422);
	const limited = await registerAt(open, "127.0.3.1", late, "discovery");
	assert.deepEqual([limited.status, (await limited.json()).code], [429, "rate_limited"]);
	const refused = [key() + "@example.test", key() + "@example.test", key() + "@example.test"];
	for (const address of refused) assert.equal((await registerAt(gated, "127.0.3.2", address, "discovery")).status, 200);
	assert.equal((await registerAt(open, "127.0.3.2", late, "discovery")).status, 429);
	assert.equal(await count(t.auth_user, inArray(t.auth_user.email, [late, ...refused])), 0);
	await identityOf(email);
});

test("AC:TARGET-IDN-003 an enabled gate admits only the configured code or a live addressed invitation, and never says whether an account exists", async () => {
	const gated = f.native("invitation_only"),
		closed = f.native("closed"),
		open = f.native();
	const s = await f.setup();
	const options = async (native: ReturnType<Fixture["native"]>, query = "") => {
		const response = await native("registration-options" + query);
		assert.equal(response.status, 200);
		return response.json();
	};
	const before = await effects();
	const refused = await options(gated, "?code=wrong-code");
	assert.equal(refused.mode, "invitation_only");
	assert.deepEqual(refused.invitation, { status: "unavailable" });
	for (const email of [s.recipient.email, key() + "@example.test"])
		assert.deepEqual(await options(gated, `?code=wrong-code&email=${encodeURIComponent(email)}`), refused);
	assert.equal((await options(gated)).mode, "invitation_only");
	assert.equal((await options(gated, "?code=approved-code")).mode, "open");
	assert.equal((await options(open, "?code=wrong-code")).mode, "open");
	assert.equal((await options(closed, "?code=approved-code")).mode, "closed");
	assert.equal(JSON.stringify(refused).includes("approved-code"), false);
	assert.deepEqual(await effects(), before);

	const register = async (native: ReturnType<Fixture["native"]>, ip: string, email: string, extra = {}) => {
		const response = await registerAt(native, ip, email, "discovery", extra);
		assert.deepEqual([response.status, await response.json()], [200, { status: "continue_identity_proof" }]);
		assert.equal(response.headers.get("set-cookie"), null);
		return count(t.auth_user, eq(t.auth_user.email, email));
	};
	const mail = () => key() + "@example.test";
	assert.equal(await register(gated, "127.0.4.1", mail(), { registrationCode: "wrong-code" }), 0);
	assert.equal(await register(gated, "127.0.4.1", mail()), 0);
	assert.equal(await register(gated, "127.0.4.1", s.recipient.email, { registrationCode: "wrong-code" }), 1);
	assert.equal(await register(closed, "127.0.4.2", mail(), { registrationCode: "approved-code" }), 0);
	assert.equal(await register(gated, "127.0.4.2", mail(), { registrationCode: "approved-code" }), 1);
	assert.equal(await register(open, "127.0.4.2", mail()), 1);

	let ip = 2;
	for (const [workspace, kind, stored] of [
		["plant", "plant_precreation", "planter"],
		["sending_church", "sending_church", "sending_church"],
		["sending_network", "sending_network", "network"],
	] as const) {
		const live = await f.setup(workspace);
		live.recipient.email = mail();
		const i = await f.invitation(live);
		const shown = await options(gated, "?code=wrong-code&invitationProof=" + encodeURIComponent(i.proof));
		assert.deepEqual(shown.kinds, [kind]);
		assert.equal(shown.invitation.kind, kind);
		assert.ok(shown.invitation.organizationName);
		const invited = (email: string, proof = i.proof) =>
			registerAt(gated, `127.0.4.${++ip}`, email, "invitation", { invitationProof: proof }).then((r) => r.json());
		const wrong = mail();
		for (const [email, proof] of [
			[wrong, i.proof],
			[live.recipient.email, "forged-proof"],
		] as const) {
			assert.deepEqual(await invited(email, proof), { status: "continue_identity_proof" });
			assert.equal(await count(t.auth_user, eq(t.auth_user.email, email)), 0);
		}
		const at = eq(t.invitation.id, i.result.invitation.invitationId);
		const { created_at } = (await f.admin.select().from(t.invitation).where(at))[0]!;
		for (const ended of [
			{ state: "revoked" as const, revision: "2" },
			{ created_at: new Date(created_at.getTime() - 31 * 86_400_000) },
		]) {
			await f.admin.update(t.invitation).set(ended).where(at);
			const gone = await options(gated, "?invitationProof=" + encodeURIComponent(i.proof));
			assert.deepEqual([gone.mode, gone.invitation], ["invitation_only", { status: "unavailable" }]);
			assert.deepEqual(await invited(live.recipient.email), { status: "continue_identity_proof" });
			assert.equal(await count(t.auth_user, eq(t.auth_user.email, live.recipient.email)), 0);
			await f.admin.update(t.invitation).set({ state: "pending", revision: "1", created_at }).where(at);
		}
		assert.deepEqual(await invited(live.recipient.email), { status: "continue_identity_proof" });
		const a = await identityOf(live.recipient.email);
		assert.deepEqual([a.state, a.kind], ["pending_domain", stored]);
		assert.equal(await liveSeats(a.id), 0);
	}
});

test("AC:TARGET-IDN-017 plant, sending-church and network invitations seat a new or seatless account once under concurrent accepts, and a lost response replays", async () => {
	for (const kind of ["plant", "sending_church", "sending_network"] as const)
		for (const state of ["pending_domain", "active"]) {
			const s = await f.setup(kind);
			s.recipient = await f.account(state);
			const i = await f.invitation(s);
			const [stranger, seatedElsewhere] = [await f.account(), await f.account()];
			await f.seat(seatedElsewhere, await f.workspace(), "member");
			for (const a of [stranger, seatedElsewhere]) await denied(f.invitations.accept(a.session, i.claim));
			for (const input of [
				{ ...i.claim.input, proof: "forged" },
				{ ...i.claim.input, invitationId: key() },
			])
				await denied(f.invitations.accept(s.recipient.session, { ...i.claim, input }));
			const before = await effects();
			const [first, second] = await Promise.all([
				f.invitations.accept(s.recipient.session, i.claim),
				f.invitations.accept(s.recipient.session, i.claim),
			]);
			assert.deepEqual(first, second);
			const after = await effects();
			const linked = kind === "plant" ? 1 : 0;
			assert.deepEqual([after.seats! - before.seats!, after.people! - before.people!], [1, linked], kind + state);
			assert.equal(await liveSeats(s.recipient.id), 1);
			assert.equal(await count(t.person, eq(t.person.linked_account_id, s.recipient.id)), linked);
			assert.deepEqual(await f.invitations.accept(s.recipient.session, i.claim), first);
			await denied(f.invitations.accept(s.recipient.session, { ...i.claim, requestKey: key() }));
			await denied(f.invitations.accept(stranger.session, i.claim));
			assert.deepEqual(await effects(), after);
		}
});

test("AC:TARGET-IDN-017 AC:TARGET-IDN-030 an accept, a revoke and a resend of one invitation have one winner, and a losing accept grants nothing", async () => {
	for (let n = 0; n < 4; n++) {
		const s = await f.setup(),
			i = await f.invitation(s);
		const id = i.result.invitation.invitationId;
		await f.admin
			.update(t.invitation)
			.set({
				resent_at: sql`clock_timestamp()-interval '61 seconds'`,
				created_at: sql`clock_timestamp()-interval '120 seconds'`,
			})
			.where(eq(t.invitation.id, id));
		const sender = await f.actor(s.sender.session);
		const change = () => ({ requestKey: key(), expectedRevision: "1", input: { invitationId: id } });
		const contenders = [
			() => f.invitations.accept(s.recipient.session, i.claim),
			() => f.invitations.revoke(sender, change()),
			() => f.invitations.resend(sender, change()),
		];
		const order = [...contenders.slice(n % 3), ...contenders.slice(0, n % 3)];
		const settled = await Promise.allSettled(order.map((run) => run()));
		assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
		const won = settled[order.indexOf(contenders[0]!)]!.status === "fulfilled";
		assert.equal(await liveSeats(s.recipient.id), won ? 1 : 0);
		assert.equal(await count(t.person, eq(t.person.linked_account_id, s.recipient.id)), won ? 1 : 0);
	}
});

test("AC:TARGET-IDN-030 AC:TARGET-IDN-002 a registration whose grant fails at any required write stays resumable with no seat, and neither a revoke nor another account turns it into one", async () => {
	const native = f.native("invitation_only");
	const s = await f.setup(),
		email = key() + "@example.test";
	s.recipient.email = email;
	const i = await f.invitation(s);
	await registerAt(native, "127.0.5.1", email, "invitation", { invitationProof: i.proof });
	const a = await identityOf(email);
	await verify(a.user);
	const cookie = await signedIn(native, email);
	const intent = { requestKey: key(), invitationProof: i.proof };
	const resume = async (jar = cookie, body: object = intent) => {
		const response = await native("resume-registration", body, jar);
		return [response.status, await response.json()] as const;
	};
	const status = async () => (await native("registration-status", undefined, cookie)).json();
	const RESUMABLE = { status: "pending_domain", accountId: a.id };
	const ungranted = async (at: string) => {
		assert.equal(await count(t.seat, eq(t.seat.account_id, a.id)), 0, at);
		assert.equal(await count(t.person, eq(t.person.linked_account_id, a.id)), 0, at);
		assert.equal(await count(t.audit_event, eq(t.audit_event.actor_id, a.id)), 0, at);
		assert.deepEqual(await status(), RESUMABLE, at);
	};
	for (const [table, when] of [
		["invitation", "UPDATE"],
		["seat", "INSERT"],
		["person", "INSERT"],
		["audit_event", "INSERT"],
		["mail", "INSERT"],
		["account", "UPDATE"],
	]) {
		const before = await effects();
		await f.admin.execute(
			sql.raw(
				`CREATE FUNCTION fail_required() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_required_failure'; END $$;
				 CREATE TRIGGER fail_required BEFORE ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_required()`,
			),
		);
		try {
			assert.equal((await resume())[0], 503, table);
		} finally {
			await f.admin.execute(sql.raw(`DROP TRIGGER fail_required ON ${table};DROP FUNCTION fail_required()`));
		}
		await ungranted(table!);
		assert.deepEqual(await effects(), before, table);
	}
	const unrelated = await registerAt(f.native(), "127.0.5.2", "unrelated-" + email, "discovery");
	assert.equal(unrelated.status, 200);
	const other = await identityOf("unrelated-" + email);
	await verify(other.user);
	const otherCookie = await signedIn(native, "unrelated-" + email);
	assert.deepEqual((await resume(otherCookie))[1].code, "invitation_unavailable");
	assert.equal(await liveSeats(other.id), 0);

	const { claim } = await f.admin.transaction(async (tx) => {
		const { pid } = (
			await tx
				.select({ pid: sql<number>`pg_backend_pid()` })
				.from(t.plant)
				.where(eq(t.plant.id, s.w.id))
				.for("update")
		)[0]!;
		const claim = resume();
		assert.equal(await waitingOnLock(f.admin, { blockedBy: pid }), true);
		await tx
			.update(t.invitation)
			.set({ state: "revoked", revision: "2" })
			.where(eq(t.invitation.id, i.result.invitation.invitationId));
		return { claim };
	});
	assert.equal((await claim)[1].code, "invitation_unavailable");
	for (let n = 0; n < 2; n++) assert.equal((await resume())[1].code, "invitation_unavailable");
	await ungranted("revoked");
	assert.deepEqual((await resume(cookie, { requestKey: key() }))[1], RESUMABLE);

	const again = await f.invitation(s);
	const retry = { requestKey: key(), invitationProof: again.proof };
	assert.equal((await resume(otherCookie, retry))[1].code, "invitation_unavailable");
	const lost = await resume(cookie, retry);
	assert.deepEqual(lost, [200, { status: "active", accountId: a.id }]);
	const committed = await effects();
	assert.deepEqual(await resume(cookie, retry), lost);
	assert.deepEqual(await effects(), committed);
	assert.equal(await liveSeats(a.id), 1);
	assert.equal(await count(t.person, eq(t.person.linked_account_id, a.id)), 1);
});

test("AC:TARGET-IDN-019 an Admin cannot remove the Owner: the seat, sessions, duties and events stay; the Owner's closed and waived work is never offered", async () => {
	const s = await f.setup(),
		[admin, second, member] = [await f.account(), await f.account(), await f.account()],
		foreign = await f.setup();
	const adminSeat = await f.seat(admin, s.w, "admin");
	await f.seat(second, s.w, "admin");
	const memberSeat = await f.seat(member, s.w, "member");
	const [open, waived] = [key(), key()];
	const task = {
		plant_id: s.w.id,
		category: "general",
		priority: "medium",
		created_at: new Date(),
		due_kind: "undated",
	} as const;
	await insertTasks(f.admin, [
		{ ...task, id: open, title: "Open duty", status: "not_started", assignee_id: s.sender.id },
	]);
	const [ownerSeat] = await f.admin
		.select()
		.from(t.seat)
		.where(and(eq(t.seat.account_id, s.sender.id), isNull(t.seat.ended_at)));
	const state = async () => ({
		...(await effects()),
		owner: await f.admin.select().from(t.seat).where(eq(t.seat.id, ownerSeat!.id)),
		sessions: await count(t.auth_session, eq(t.auth_session.user_id, s.sender.user)),
		holders: await assigneesOf(f.admin, open),
		tasks: await count(t.task, eq(t.task.plant_id, s.w.id)),
	});
	const removal = (seatId: string, expectedRole: string, revision = "1", handoffs: object[] = []) => ({
		requestKey: key(),
		expectedRevision: revision,
		input: { seatId, expectedRole, handoffs },
	});
	const before = await state();
	const actor = await f.actor(admin.session);
	for (const role of ["admin", "member"])
		for (const handoffs of [
			[],
			[{ kind: "assign", dutyId: open, expectedRevision: "1", recipientAccountId: admin.id }],
		])
			await denied(
				f.seats.remove(actor, s.w, removal(ownerSeat!.id, role, ownerSeat!.revision, handoffs), noReminders),
				"protected_owner",
			);
	await denied(
		f.seats.demote(actor, s.w, {
			requestKey: key(),
			expectedRevision: ownerSeat!.revision,
			input: { seatId: ownerSeat!.id, expectedRole: "admin", to: "member" },
		}),
		"protected_owner",
	);
	for (const [who, at] of [
		[member, s.w],
		[foreign.sender, s.w],
		[foreign.sender, foreign.w],
	] as const) {
		const other = await f.actor(who.session);
		await denied(f.seats.remove(other, at, removal(adminSeat, "admin"), noReminders));
		await denied(
			f.seats.appointAdmin(other, at, {
				requestKey: key(),
				expectedRevision: "1",
				input: { seatId: memberSeat, expectedRole: "member", to: "admin" },
			}),
		);
	}
	assert.deepEqual(await state(), before);

	const [meeting, duty] = [key(), key()];
	await f.admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision) VALUES(${meeting},${s.w.id},'vision_meeting','Vision night','2026-10-20','18:00','America/Chicago','2026-10-20T23:00:00Z','1','completed',1)`,
	);
	await f.admin.execute(
		sql`INSERT INTO obligation(id,plant_id,meeting_id,kind,origin_at,origin_date,timezone,formula_version,due_date) VALUES(${duty},${s.w.id},${meeting},'evaluation','2026-10-20T23:00:00Z','2026-10-20','America/Chicago','1','2026-10-30')`,
	);
	await insertTasks(f.admin, [
		{
			...task,
			id: waived,
			title: "Waived duty",
			status: "not_started",
			assignee_id: member.id,
			obligation_id: duty,
		},
	]);
	const waive = await withTaskWrite(f.db, await f.actor(admin.session), (tx, ctx) =>
		createTaskWriter({ reminders: async () => {} }).waive(tx, ctx, {
			requestKey: key(),
			expectedRevision: "1",
			input: { taskId: waived, reason: "Covered by the sending church" },
		}),
	);
	assert.equal(waive.status, "ok", JSON.stringify(waive));
	const waivedState = async () => ({
		task: await f.admin.select().from(t.task).where(eq(t.task.id, waived)),
		obligation: await f.admin.select().from(t.obligation).where(eq(t.obligation.id, duty)),
		holders: await assigneesOf(f.admin, waived),
	});
	const kept = await waivedState();
	assert.deepEqual(
		[kept.task[0]!.status, kept.obligation[0]!.waiver_reason, kept.holders],
		["no_longer_needed", "Covered by the sending church", [member.id]],
	);
	assert.ok(kept.obligation[0]!.waived_at);
	const review = await f.seats.readRemoval(admin.session, s.w, { seatId: memberSeat });
	assert.deepEqual(review.duties, []);
	const race = await Promise.allSettled(
		[admin, second].map(async (a) =>
			f.seats.remove(await f.actor(a.session), s.w, removal(memberSeat, "member"), noReminders),
		),
	);
	assert.deepEqual(race.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
	assert.equal(await liveSeats(member.id), 0);
	assert.deepEqual(await waivedState(), kept, "a removal leaves the waived duty as it was");
	assert.equal(await count(t.auth_session, eq(t.auth_session.user_id, member.user)), 0);
	assert.equal(
		await count(t.audit_event, and(eq(t.audit_event.subject_id, memberSeat), eq(t.audit_event.tenant_id, s.w.id))),
		1,
	);
	const contested = await f.account(),
		contestedSeat = await f.seat(contested, s.w, "member");
	const promotion = await Promise.allSettled([
		f.seats.remove(await f.actor(admin.session), s.w, removal(contestedSeat, "member"), noReminders),
		f.seats.appointAdmin(await f.actor(second.session), s.w, {
			requestKey: key(),
			expectedRevision: "1",
			input: { seatId: contestedSeat, expectedRole: "member", to: "admin" },
		}),
	]);
	assert.deepEqual(promotion.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
	assert.equal(await liveSeats(contested.id), promotion[0]!.status === "fulfilled" ? 0 : 1);
});

async function adminInvitation(s: Awaited<ReturnType<Fixture["setup"]>>) {
	const { invitation } = await f.invitations.invite(await f.actor(s.sender.session), {
		requestKey: key(),
		expectedRevision: "1",
		input: { workspace: s.w, role: "admin", recipientEmail: s.recipient.email },
	});
	const proof = await f.proof(invitation.invitationId);
	const claim = {
		requestKey: key(),
		expectedRevision: "1",
		input: { invitationId: invitation.invitationId, proof },
	};
	const revoke = async () =>
		f.invitations.revoke(await f.actor(s.sender.session), {
			requestKey: key(),
			expectedRevision: "1",
			input: { invitationId: invitation.invitationId },
		});
	return { id: invitation.invitationId, claim, revoke };
}
const openSeats = async (account: string) =>
	(
		await f.admin
			.select({ role: t.seat.role, plant: t.seat.plant_id })
			.from(t.seat)
			.where(and(eq(t.seat.account_id, account), isNull(t.seat.ended_at)))
	).map((x) => x);

test("AC:ROLE43-007 a separate operating lead becomes an Admin by accepting one ordinary addressed invitation, and a revoke or a retry leaves one seat or none", async () => {
	const s = await f.setup(),
		i = await adminInvitation(s),
		stranger = await f.account("pending_domain");
	await denied(f.invitations.accept(stranger.session, { ...i.claim, requestKey: key() }));
	await denied(
		f.invitations.accept(s.recipient.session, {
			...i.claim,
			requestKey: key(),
			input: { ...i.claim.input, proof: "wrong" },
		}),
	);
	assert.deepEqual(await openSeats(s.recipient.id), []);
	const accepted = await f.invitations.accept(s.recipient.session, i.claim);
	assert.equal(accepted.seat.role, "admin");
	assert.deepEqual(await f.invitations.accept(s.recipient.session, i.claim), accepted, "the same intent answers again");
	assert.deepEqual(await openSeats(s.recipient.id), [{ role: "admin", plant: s.w.id }]);
	assert.equal(
		await count(t.person, and(eq(t.person.plant_id, s.w.id), eq(t.person.linked_account_id, s.recipient.id))),
		1,
	);
	const audited = sql`SELECT action,count(*)::int AS n FROM audit_event WHERE actor_id=${s.recipient.id} AND subject_id=${accepted.seat.seatId} GROUP BY action`;
	assert.deepEqual((await f.admin.execute(audited)).rows, [{ action: "membership.created", n: 1 }]);
	const lead = await f.actor(s.recipient.session);
	assert.equal((await f.invitations.list(lead, { workspace: s.w })).items.length, 0);
	assert.equal(
		await count(t.team_tenure, eq(t.team_tenure.plant_id, s.w.id)),
		0,
		"no nomination or designation is needed or made",
	);
	const sent = await f.invitations.invite(lead, {
		requestKey: key(),
		expectedRevision: "1",
		input: { workspace: s.w, role: "member", recipientEmail: key() + "@example.test" },
	});
	assert.equal(sent.invitation.status, "pending", "Admin work is open at once");
	await denied(f.invitations.accept(s.recipient.session, { ...i.claim, requestKey: key() }));
	await denied(i.revoke());
	assert.equal((await openSeats(s.recipient.id)).length, 1);

	const r = await f.setup(),
		revoked = await adminInvitation(r);
	await revoked.revoke();
	await denied(f.invitations.accept(r.recipient.session, revoked.claim));
	assert.deepEqual(await openSeats(r.recipient.id), []);

	for (let n = 0; n < 3; n++) {
		const race = await f.setup(),
			offer = await adminInvitation(race);
		const [gone, taken] = await Promise.allSettled([
			offer.revoke(),
			f.invitations.accept(race.recipient.session, offer.claim),
		]);
		assert.equal([gone, taken].filter((x) => x.status === "fulfilled").length, 1);
		assert.deepEqual(
			await openSeats(race.recipient.id),
			taken.status === "fulfilled" ? [{ role: "admin", plant: race.w.id }] : [],
		);
	}
});

test("AC:ROLE43-009 an Admin removes an ordinary Admin or Member, never the Owner, a Member never promotes themselves and a changed seat refuses the stale removal", async () => {
	const s = await f.setup();
	const people = {
		actor: await f.account(),
		admin: await f.account(),
		member: await f.account(),
		self: await f.account(),
		raced: await f.account(),
		foreign: await f.account(),
	};
	const seats = {
		actor: await f.seat(people.actor, s.w, "admin"),
		admin: await f.seat(people.admin, s.w, "admin"),
		member: await f.seat(people.member, s.w, "member"),
		self: await f.seat(people.self, s.w, "member"),
		raced: await f.seat(people.raced, s.w, "member"),
		foreign: await f.seat(people.foreign, await f.workspace(), "admin"),
	};
	const [owner] = await f.admin
		.select({ id: t.seat.id })
		.from(t.seat)
		.where(and(eq(t.seat.account_id, s.sender.id), eq(t.seat.plant_id, s.w.id)));
	assert.ok(owner);
	const as = (who: { session: string }) => f.actor(who.session);
	const removal = (seatId: string, expectedRole: string, expectedRevision = "1") => ({
		requestKey: key(),
		expectedRevision,
		input: { seatId, expectedRole, handoffs: [] },
	});
	const state = async () =>
		JSON.stringify([
			await f.admin.select().from(t.seat).where(eq(t.seat.plant_id, s.w.id)).orderBy(t.seat.id),
			await count(t.audit_event, eq(t.audit_event.tenant_id, s.w.id)),
		]);
	const start = await state();
	const admin = await as(people.actor);
	const self = await as(people.self);
	for (const role of ["admin", "member"])
		await denied(f.seats.remove(admin, s.w, removal(owner.id, role), noReminders), "protected_owner");
	await denied(f.seats.readRemoval(people.actor.session, s.w, { seatId: owner.id }), "protected_owner");
	await denied(
		f.seats.demote(admin, s.w, {
			requestKey: key(),
			expectedRevision: "1",
			input: { seatId: owner.id, expectedRole: "admin", to: "member" },
		}),
		"protected_owner",
	);
	const promote = (seatId: string) => ({
		requestKey: key(),
		expectedRevision: "1",
		input: { seatId, expectedRole: "member", to: "admin" },
	});
	await denied(f.seats.appointAdmin(self, s.w, promote(seats.self)));
	await denied(f.seats.changeOrdinaryRole(self, s.w, promote(seats.self)));
	await assert.rejects(
		f.seats.changeOrdinaryRole(self, s.w, {
			...promote(seats.self),
			input: { ...promote(seats.self).input, to: "owner" },
		}),
	);
	await denied(f.seats.remove(self, s.w, removal(seats.member, "member"), noReminders));
	const foreign = await as(people.foreign);
	await denied(f.seats.remove(foreign, s.w, removal(seats.member, "member"), noReminders));
	await denied(f.seats.remove(admin, s.w, removal(seats.foreign, "admin"), noReminders));
	await denied(f.seats.remove(admin, s.w, removal(seats.member, "admin"), noReminders), "conflict");
	await denied(f.seats.remove(admin, s.w, removal(seats.member, "member", "2"), noReminders), "conflict");
	assert.equal(await state(), start, "every refusal leaves seats and history alone");

	for (const [seat, role, who] of [
		[seats.admin, "admin", people.admin],
		[seats.member, "member", people.member],
	] as const) {
		const q = removal(seat, role);
		const removed = await f.seats.remove(admin, s.w, q, noReminders);
		assert.deepEqual([removed.seatId, removed.outcome, removed.revision], [seat, "changed", "2"]);
		assert.deepEqual(await f.seats.remove(admin, s.w, q, noReminders), removed);
		assert.deepEqual(await openSeats(who.id), []);
		await denied(as(who));
		const events = await f.admin.execute(
			sql`SELECT action,actor_id FROM audit_event WHERE subject_id=${seat} AND action='membership.ended'`,
		);
		assert.deepEqual(events.rows, [{ action: "membership.ended", actor_id: people.actor.id }]);
	}
	const raced = await Promise.allSettled([
		f.seats.remove(admin, s.w, removal(seats.raced, "member"), noReminders),
		f.seats.appointAdmin(await as(s.sender), s.w, promote(seats.raced)),
	]);
	assert.equal(raced.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(raced));
	const lost = raced.find((x) => x.status === "rejected");
	assert.ok(lost?.status === "rejected");
	assert.ok(["conflict", "invitation_unavailable"].includes(String(codeOf(lost.reason))), String(lost.reason));
	assert.deepEqual(
		await openSeats(people.raced.id),
		raced[0]!.status === "fulfilled" ? [] : [{ role: "admin", plant: s.w.id }],
	);
	const roster = await f.seats.list(admin, { workspace: s.w });
	assert.deepEqual(roster.items.find((x) => x.seatId === owner.id)!.allowedActions, []);
	assert.equal(roster.items.find((x) => x.seatId === owner.id)!.role, "owner");
	assert.deepEqual(roster.items.find((x) => x.seatId === seats.self)!.role, "member");
});
