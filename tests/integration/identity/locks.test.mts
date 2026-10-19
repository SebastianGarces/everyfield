import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fixture, key } from "./invitations-support.mts";
import { eq, sql, and } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { peopleReader } from "../../../packages/domain/src/people/index.ts";
let f;
before(async () => {
	f = await fixture({ lockTimeout: "1s" });
});
after(async () => {
	await f?.close();
});
const outcome = (p) =>
	p.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
async function waitingOn(pid) {
	for (let n = 0; n < 100; n++) {
		const r = await f.admin.execute(
			sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))`,
		);
		if (r.rows[0].n > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("Competing operation did not reach the held lock");
}

test("BUG-124: People membership read takes no account write lock", async () => {
	const s = await f.setup();
	await f.admin.transaction(async (tx) => {
		await tx.select().from(t.account).where(eq(t.account.id, s.sender.id)).for("share");
		const member = await f.seats.readCurrentMembership(s.sender.session);
		assert.equal(member.status, "active");
		const page = await f.db.transaction((tx) =>
			peopleReader.listPeople(
				tx,
				{
					session: s.sender.session,
					selected: member.workspace,
					purpose: "native",
				},
				{ search: "No matching person" },
			),
		);
		assert.equal(page.status, "ok");
		assert.equal(page.value.total, 0);
	});
});

test("BUG-124: a held account write returns a retryable refusal and the read resumes", async () => {
	const s = await f.setup();
	await f.admin.transaction(async (tx) => {
		await tx.update(t.account).set({ revision: "2" }).where(eq(t.account.id, s.sender.id));
		await assert.rejects(f.seats.readCurrentMembership(s.sender.session), (error) => {
			assert.equal(error.value?.code, "temporary");
			assert.equal(error.value.retry, "same_request");
			return true;
		});
	});
	assert.equal((await f.seats.readCurrentMembership(s.sender.session)).status, "active");
});

test("BUG-127: resend during a 250-duty removal refuses contention safely then resumes", async () => {
	const s = await f.setup(),
		invitation = await f.invitation(s);
	const accepted = await f.invitations.accept(s.recipient.session, invitation.claim);
	const pending = await f.invitations.invite(s.sender.session, {
		requestKey: key(),
		expectedRevision: "1",
		input: { workspace: s.w, role: "member", recipientEmail: key() + "@example.test" },
	});
	await f.admin
		.update(t.invitation)
		.set({ created_at: new Date(Date.now() - 120000) })
		.where(eq(t.invitation.id, pending.invitation.invitationId));
	const ids = Array.from({ length: 250 }, () => key());
	await f.admin
		.insert(t.task)
		.values(
			ids.map((id) => ({
				id,
				plant_id: s.w.id,
				title: "Open duty",
				category: "general",
				priority: "medium",
				status: "not_started",
				created_at: new Date(),
				assignee_id: s.recipient.id,
				due_kind: "undated",
			})),
		);
	const command = {
		requestKey: key(),
		expectedRevision: "1",
		input: {
			seatId: accepted.seat.seatId,
			expectedRole: "member",
			handoffs: ids.map((dutyId) => ({
				kind: "assign",
				dutyId,
				expectedRevision: "1",
				recipientAccountId: s.sender.id,
			})),
		},
	};
	const resend = { requestKey: key(), expectedRevision: "1", input: { invitationId: pending.invitation.invitationId } };
	let removal, concurrent;
	try {
		await f.admin.transaction(async (tx) => {
			await tx.select().from(t.task).where(eq(t.task.id, ids[0])).for("update");
			const r = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
			removal = outcome(f.seats.remove(s.sender.session, s.w, command));
			await waitingOn(r.rows[0].pid);
			concurrent = outcome(f.invitations.resend(s.sender.session, resend));
		});
	} finally {
		if (removal) await removal;
		if (concurrent) await concurrent;
	}
	const removed = await removal,
		sent = await concurrent;
	assert.equal(removed.error, undefined, "Removal must complete atomically");
	assert.equal(removed.value.duties.length, 250);
	if (sent.error) {
		assert.equal(sent.error.value?.code, "temporary");
		assert.equal(sent.error.value.retry, "same_request");
	}
	const result = sent.value ?? (await f.invitations.resend(s.sender.session, resend));
	assert.equal(result.invitation.revision, "2");
	assert.deepEqual(await f.seats.remove(s.sender.session, s.w, command), removed.value);
	const [{ n }] = await f.admin
		.select({ n: sql`count(*)::int` })
		.from(t.task)
		.where(and(eq(t.task.plant_id, s.w.id), eq(t.task.assignee_id, s.sender.id), eq(t.task.revision, "2")));
	assert.equal(n, 250);
	assert.equal(removed.value.receipt.eventIds.length, 251);
});
