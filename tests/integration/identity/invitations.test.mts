import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, key, noReminders } from "./invitations-support.mts";
import { and, eq, isNull, sql } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { assigneesOf, assignedCount, insertTasks } from "../task-assignees.mts";
let f;
before(async () => {
	f = await fixture();
});
after(async () => {
	await f?.close();
});
const denied = (promise, code = "invitation_unavailable") =>
	assert.rejects(promise, (e) => {
		assert.equal(e.value?.code, code);
		return true;
	});
const count = async (table, predicate) =>
	Number(
		(
			await f.admin
				.select({ n: sql`count(*)::int` })
				.from(table)
				.where(predicate)
		)[0].n,
	);

test("AC:TARGET-IDN-017 AC:TARGET-IDN-003 AC:ROLE43-006 ordinary invitation hides account resolution and persists hashed expiring proof", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		description = await f.invitations.describe({ proof: i.proof });
	assert.equal(description.status, "pending");
	assert.equal(description.subject.role, "member");
	assert.equal(description.workspaceName, "Synthetic plant");
	assert.equal("recipientEmail" in description, false);
	const [row] = await f.admin.select().from(t.invitation).where(eq(t.invitation.id, i.result.invitation.invitationId));
	assert.equal(row.token_hash, createHash("sha256").update(i.proof).digest("hex"));
	assert.equal(new Date(i.result.invitation.expiresAt).getTime() - row.created_at.getTime(), 30 * 86400000);
	assert.equal(JSON.stringify(i.result).includes("accountExists"), false);
	assert.equal(JSON.stringify(i.result).includes(i.proof), false);
	assert.deepEqual(await f.invitations.invite(await f.actor(s.sender.session), i.command), i.result);

	// INV-proof-fragment (D54): the mailed link carries the proof only after #, which no browser request sends.
	const sent = f.effects.findLast((e) => e.text.includes(i.proof) || e.text.includes(encodeURIComponent(i.proof)));
	assert.match(sent.text, /\/invitation#proof=\S+/);
	assert.doesNotMatch(sent.text, /[?&]proof=/);
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

	const [person] = await f.admin.select().from(t.person).where(eq(t.person.id, a.seat.personId));
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
	const [row] = await f.admin.select().from(t.invitation).where(eq(t.invitation.id, i.result.invitation.invitationId)),
		[account] = await f.admin.select().from(t.account).where(eq(t.account.id, s.recipient.id));
	assert.equal(row.state, "pending");
	assert.equal(account.registration_state, "pending_domain");
	assert.equal(await count(t.seat, eq(t.seat.account_id, s.recipient.id)), 0);
	assert.equal(await count(t.person, eq(t.person.linked_account_id, s.recipient.id)), 0);
	await f.admin.execute(sql`REVOKE INSERT ON ${sql.identifier(f.schema)}.audit_event FROM everyfield_runtime`);
	try {
		await assert.rejects(f.invitations.accept(s.recipient.session, i.claim), (error) => {
			assert.equal(error.cause?.code, "42501");
			return true;
		});
	} finally {
		await f.admin.execute(sql`GRANT INSERT ON ${sql.identifier(f.schema)}.audit_event TO everyfield_runtime`);
	}
	assert.equal(
		(await f.admin.select().from(t.invitation).where(eq(t.invitation.id, i.result.invitation.invitationId)))[0].state,
		"pending",
	);
	assert.equal(await count(t.audit_event, eq(t.audit_event.request_key, i.claim.requestKey)), 0);
	const accepted = await f.invitations.accept(s.recipient.session, i.claim);
	assert.equal(accepted.status, "accepted");
});
test("AC:TEN-005 AC:SEC-02 AC:AUTH-002 INV-claim: wrong mailbox unverified account and deletion witness cannot claim", async () => {
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
	// RT-6a: the workspace's deletion witness, read by the command's admission check after the root lock, also refuses.
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
// RT-6a verifier finding: the expiry check uses the database time after the wait for the workspace root lock.
test("INV-expiry: an accept or resume that waits on the workspace lock past expiry refuses", async () => {
	for (const via of ["accept", "resume"] as const) {
		const s = await f.setup(),
			i = await f.invitation(s),
			id = i.result.invitation.invitationId;
		// The invitation expires 2.5 seconds from now, by the database clock.
		await f.admin.execute(
			sql`UPDATE invitation SET created_at=clock_timestamp()-interval '720 hours'+interval '2.5 seconds' WHERE id=${id}`,
		);
		let claim;
		await f.admin.transaction(async (tx) => {
			const [{ pid }] = await tx
				.select({ pid: sql`pg_backend_pid()` })
				.from(t.plant)
				.where(eq(t.plant.id, s.w.id))
				.for("update");
			claim = (
				via === "accept"
					? f.invitations.accept(s.recipient.session, i.claim)
					: f.invitations.resume(s.recipient.session, i.proof, key())
			).then(
				(value) => ({ value }),
				(error) => ({ error }),
			);
			let blocked = false;
			for (let attempt = 0; attempt < 300 && !blocked; attempt++) {
				const result = await f.admin.execute(
					sql`SELECT count(*)::int AS n FROM pg_stat_activity a WHERE a.datname=current_database() AND ${pid}::int=ANY(pg_blocking_pids(a.pid))`,
				);
				blocked = Number(result.rows[0].n) > 0;
				if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(blocked, true, `${via} must wait for the workspace root lock`);
			await new Promise((resolve) => setTimeout(resolve, 3000));
		});
		const result = await claim;
		assert.equal(result.error?.value?.code, "invitation_unavailable", via + ": " + JSON.stringify(result.value ?? null));
		assert.equal(await count(t.seat, eq(t.seat.account_id, s.recipient.id)), 0);
		assert.equal((await f.admin.select().from(t.invitation).where(eq(t.invitation.id, id)))[0].state, "pending");
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
test("AC:ROLE43-007 INV-token: revoke claim resend and expiry serialize with one winner", async () => {
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
		.set({ resent_at: new Date(Date.now() - 61000), created_at: new Date(Date.now() - 120000) })
		.where(eq(t.invitation.id, i2.result.invitation.invitationId));
	const sent = await f.invitations.resend(await f.actor(s2.sender.session), {
		...change,
		requestKey: key(),
		input: { invitationId: i2.result.invitation.invitationId },
	});
	assert.equal(sent.invitation.revision, "2");
	assert.deepEqual(await f.invitations.describe({ proof: i2.proof }), { status: "unavailable" });
	await denied(f.invitations.accept(s2.recipient.session, i2.claim));
	const fresh = await f.proof(i2.result.invitation.invitationId);
	assert.notEqual(fresh, i2.proof);
	await f.admin
		.update(t.invitation)
		.set({ created_at: new Date(Date.now() - 30 * 86400000) })
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
	assert.equal(
		(
			await f.invitations.invite(await f.actor(other.sender.session), {
				requestKey: key(),
				expectedRevision: "1",
				input: { workspace: other.w, role: "admin", recipientEmail: s.recipient.email },
			})
		).invitation.subject.role,
		"admin",
	);
});
test("AC:ADR1-004 AC:WP008-MUL-004-ATOMIC resident accept is addressed, atomic, consent-specific and seatless", async () => {
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
		(await f.admin.select().from(t.account).where(eq(t.account.id, s.recipient.id)))[0].registration_state,
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
	assert.equal(list.items.find((x) => x.seatId === a.seat.seatId).joined.source, "accepted_invitation");
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
	const owner = list.items.find((x) => x.role === "owner");
	await denied(
		f.seats.remove(await f.actor(s.recipient.session), s.w, {
			requestKey: key(),
			expectedRevision: "1",
			input: { seatId: owner.seatId, expectedRole: "admin", handoffs: [] },
		}, noReminders),
		"protected_owner",
	);
	const demoted = await f.seats.demote(await f.actor(s.recipient.session), s.w, {
		requestKey: key(),
		expectedRevision: "2",
		input: { seatId: a.seat.seatId, expectedRole: "admin", to: "member" },
	});
	assert.equal(demoted.revision, "3");
	assert.equal((await f.seats.readCurrentMembership(s.recipient.session)).role, "member");
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
	const result = await f.seats.remove(await f.actor(s.sender.session), s.w, {
		...cmd,
		requestKey: key(),
		input: {
			...cmd.input,
			handoffs: [{ kind: "assign", dutyId: open, expectedRevision: "1", recipientAccountId: s.sender.id }],
		},
	}, noReminders);
	assert.deepEqual(result.duties, [{ status: "moved", dutyId: open, recipientAccountId: s.sender.id }]);
	assert.deepEqual(await assigneesOf(f.admin, open), [s.sender.id]);
	assert.equal((await f.admin.select().from(t.task).where(eq(t.task.id, closed)))[0].status, "complete");
	assert.equal(
		(await f.admin.select().from(t.person).where(eq(t.person.id, a.seat.personId)))[0].linked_account_id,
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
	// Only an Owner or Admin of the seat's own workspace reads it; a Member and another workspace's Owner do not.
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
	// The review is exactly what remove needs: handing off each listed duty succeeds at once.
	const result = await f.seats.remove(await f.actor(s.sender.session), s.w, {
		requestKey: key(),
		expectedRevision: review.expectedRevision,
		input: {
			seatId: review.seatId,
			expectedRole: review.expectedRole,
			handoffs: review.duties.map((d) => ({
				kind: "assign",
				dutyId: d.dutyId,
				expectedRevision: d.expectedRevision,
				recipientAccountId: review.recipients[0].accountId,
			})),
		},
	}, noReminders);
	assert.deepEqual(result.duties, [{ status: "moved", dutyId: open, recipientAccountId: s.sender.id }]);
	await denied(f.seats.readRemoval(s.sender.session, s.w, target));
});

test("AC:TARGET-IDN-019 INV-removal-linked: a task with a linked obligation is one duty, and a closed linked task keeps its outcome", async () => {
	const s = await f.setup(),
		i = await f.invitation(s),
		a = await f.invitations.accept(s.recipient.session, i.claim),
		[linked, settled] = [key(), key()],
		[open, closed] = [key(), key()];
	// Each evaluation comes from its own meeting.
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
	// The open task and its obligation are one reviewed duty; the completed task's obligation is not a duty.
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
	// The task carries the owner; the obligation keeps no second one.
	assert.deepEqual(await assigneesOf(f.admin, open), [s.sender.id]);
	const [kept] = await f.admin.select().from(t.task).where(eq(t.task.id, closed));
	assert.equal(kept.status, "complete");
	assert.deepEqual(await assigneesOf(f.admin, closed), [s.recipient.id]);
});

test("AC:TARGET-IDN-019 INV-removal-bound: 101 and 250 open duties are all reviewed, a stale one refuses, and one call hands them all over", async () => {
	for (const n of [101, 250]) {
		const s = await f.setup(),
			i = await f.invitation(s),
			a = await f.invitations.accept(s.recipient.session, i.claim),
			ids = Array.from({ length: n }, () => key());
		await insertTasks(f.admin, 
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
		const command = (review) => ({
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
			.where(eq(t.task.id, ids[n - 1]));
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
	const send = (body) => native("register", body, undefined, { "x-test-ip": "127.0.0.21" });
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
	// Existing addressed account takes the same public path; no cookie or grant is returned.
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
	const [user] = await f.admin.select().from(t.auth_user).where(eq(t.auth_user.email, newEmail)),
		[account] = await f.admin.select().from(t.account).where(eq(t.account.auth_user_id, user.id));
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
	assert.equal((await f.admin.select().from(t.seat).where(eq(t.seat.account_id, account.id)))[0].role, "member");

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

test("AC:ROLE43-006 INV-invitations: pending and Member actors cannot send or list administrative invitations", async () => {
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
	const [mail] = await f.admin.select().from(t.mail).where(eq(t.mail.tenant_id, s.w.id));
	assert.equal(mail.state, "cancelled");
});

test("AC:ADR1-004 INV-person-reference: retirement and invitation revocation beat a waiting resident claim without a deadlock", async () => {
	const s = await f.setup("sending_church"),
		person = await f.resident(s.w),
		i = await f.invitation(s, person);
	let claim;
	await f.admin.transaction(async (tx) => {
		await tx.select({ id: t.person.id }).from(t.person).where(eq(t.person.id, person)).for("update");
		const [{ pid }] = await tx
			.select({ pid: sql`pg_backend_pid()` })
			.from(t.person)
			.limit(1);
		claim = f.invitations
			.respondResident(s.recipient.session, {
				...i.claim,
				input: { ...i.claim.input, decision: "accept", choices: { shareFoundations: true, shareMilestones: false } },
			})
			.then(
				(value) => ({ value }),
				(error) => ({ error }),
			);
		let blocked = false;
		for (let attempt = 0; attempt < 30; attempt++) {
			const result = await f.admin.execute(
				sql`SELECT count(*)::int AS n FROM pg_stat_activity a WHERE a.datname=current_database() AND ${pid}::int=ANY(pg_blocking_pids(a.pid))`,
			);
			if (Number(result.rows[0].n) > 0) {
				blocked = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(blocked, true, "The claim must reach its competing Person lock");
		await tx
			.update(t.person)
			.set({ state: "retired", retired_at: new Date(), revision: "2" })
			.where(eq(t.person.id, person));
		await tx
			.update(t.invitation)
			.set({ state: "revoked", revision: "2" })
			.where(eq(t.invitation.id, i.result.invitation.invitationId));
	});
	const result = await claim;
	assert.equal(
		result.error?.value?.code,
		"invitation_unavailable",
		JSON.stringify({ databaseCode: result.error?.cause?.code }),
	);
	assert.equal(await count(t.residency_link, eq(t.residency_link.person_id, person)), 0);
	assert.equal(
		(await f.admin.select().from(t.invitation).where(eq(t.invitation.id, i.result.invitation.invitationId)))[0].state,
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
