import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { accountId, sessionId } from "../../../../packages/contracts/src/common/index.ts";
import { and, eq, isNull, sql } from "../../../../packages/db/src/query.ts";
import * as t from "../../../../packages/db/src/schema/tables.ts";
import { deletionOperations } from "../../../../packages/domain/src/settings/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { codeOf, fixture, key, noReminders, type Fixture } from "../../identity/invitations-support.mts";

type Case = { id: string; expected: { result: Record<string, unknown>; event: null } };
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);

let f: Fixture;
before(async () => {
	f = await fixture();
});
after(async () => {
	await f?.close();
});

const failure = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		return codeOf(error) ?? (error instanceof Error ? codeOf(error.cause) : undefined) ?? String(error);
	}
	return "accepted";
};
const liveSeats = (account: string) =>
	f.admin.$count(t.seat, and(eq(t.seat.account_id, account), isNull(t.seat.ended_at)));
const insertSeat = (account: string, plant: string, role = "member") =>
	failure(
		f.admin.execute(
			sql`INSERT INTO seat(id,account_id,plant_id,role,accepted_at) VALUES(${randomUUID()},${account},${plant},${role},clock_timestamp())`,
		),
	);
const freshSession = async (user: string) => {
	const id = sessionId.parse(randomUUID());
	await f.admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${id},${user},${randomBytes(32).toString("hex")},clock_timestamp()+interval '1 day')`);
	return id;
};

test("AC:SCHEMA-002 one account accepts into P and Q at once and keeps one live seat; the last Owner cannot be demoted, removed or purged; a Member's end allows a new invitation", async () => {
	const c = caseOf("SCHEMA-002");
	const P = await f.setup(),
		Q = await f.setup();
	Q.recipient = P.recipient;
	const intoP = await f.invitation(P),
		intoQ = await f.invitation(Q);
	const outcomes = await Promise.all([
		failure(f.invitations.accept(P.recipient.session, intoP.claim)),
		failure(f.invitations.accept(P.recipient.session, intoQ.claim)),
	]);
	assert.deepEqual(
		[...outcomes].sort(),
		["accepted", "invitation_unavailable"],
		"one accept wins and the other is refused",
	);
	const [seat] = await f.admin
		.select()
		.from(t.seat)
		.where(and(eq(t.seat.account_id, P.recipient.id), isNull(t.seat.ended_at)));
	assert.ok(seat);
	const won = seat.plant_id === P.w.id ? P : Q,
		lost = won === P ? Q : P;
	assert.equal(await insertSeat(P.recipient.id, lost.w.id), "23505", "seat_uq_0 refuses a second live seat");
	assert.equal(await insertSeat(P.recipient.id, won.w.id, "admin"), "23505");
	assert.equal(await insertSeat(won.sender.id, won.w.id, "owner"), "23505", "seat_uq_1 refuses a second Owner");

	const owner = (await f.seats.list(await f.actor(won.sender.session), { workspace: won.w })).items.find(
		(x) => x.role === "owner",
	)!;
	const appointed = await f.seats.appointAdmin(await f.actor(won.sender.session), won.w, {
		requestKey: key(),
		expectedRevision: "1",
		input: { seatId: seat.id, expectedRole: "member", to: "admin" },
	});
	assert.equal(appointed.revision, "2");
	const admin = await f.actor(P.recipient.session);
	const ownerAttempts = [
		await failure(
			f.seats.demote(admin, won.w, {
				requestKey: key(),
				expectedRevision: "1",
				input: { seatId: owner.seatId, expectedRole: "admin", to: "member" },
			}),
		),
		await failure(
			f.seats.remove(
				admin,
				won.w,
				{
					requestKey: key(),
					expectedRevision: "1",
					input: { seatId: owner.seatId, expectedRole: "admin", handoffs: [] },
				},
				noReminders,
			),
		),
		await failure(f.seats.readRemoval(P.recipient.session, won.w, { seatId: owner.seatId })),
	];
	const deletion = deletionOperations({
		queue: () => assert.fail("a refused deletion queues nothing"),
		workspaceNotice: async () => assert.fail("an account deletion sends no workspace notice"),
	});
	const purge = await gatedTransaction(f.db, (tx) =>
		deletion.requestAccountDeletion(
			tx,
			{ session: won.sender.session, selected: { kind: "account", id: accountId.parse(won.sender.id) } },
			{ requestKey: key(), expectedRevision: "1", input: { confirmed: true } },
		),
	);
	assert.equal(purge.status, "refused");
	assert.ok(purge.status === "refused");
	ownerAttempts.push(purge.error.code);
	assert.deepEqual(ownerAttempts, [
		"protected_owner",
		"protected_owner",
		"protected_owner",
		"manual_owner_exception_required",
	]);
	const owners = await f.admin
		.select()
		.from(t.seat)
		.where(and(eq(t.seat.plant_id, won.w.id), eq(t.seat.role, "owner"), isNull(t.seat.ended_at)));
	assert.deepEqual(
		owners.map((s) => s.account_id),
		[won.sender.id],
	);
	assert.equal(await f.admin.$count(t.lifecycle_witness, eq(t.lifecycle_witness.opaque_subject_id, won.sender.id)), 0);

	assert.deepEqual(
		{ active_seats: await liveSeats(P.recipient.id), last_Owner_removal_allowed: owners.length !== 1 },
		c.expected.result,
	);
	assert.equal(c.expected.event, null);

	await f.seats.demote(admin, won.w, {
		requestKey: key(),
		expectedRevision: "2",
		input: { seatId: seat.id, expectedRole: "admin", to: "member" },
	});
	const ended = await f.seats.remove(
		await f.actor(won.sender.session),
		won.w,
		{ requestKey: key(), expectedRevision: "3", input: { seatId: seat.id, expectedRole: "member", handoffs: [] } },
		noReminders,
	);
	assert.deepEqual(ended.duties, []);
	assert.equal(await liveSeats(P.recipient.id), 0);
	P.recipient.session = await freshSession(P.recipient.user);
	const again = await f.invitation(won);
	const rejoined = await f.invitations.accept(P.recipient.session, again.claim);
	assert.equal(rejoined.seat.role, "member");
	assert.equal(await liveSeats(P.recipient.id), 1);
	const [current] = await f.admin
		.select()
		.from(t.seat)
		.where(and(eq(t.seat.account_id, P.recipient.id), isNull(t.seat.ended_at)));
	assert.equal(current!.plant_id, won.w.id);
	assert.notEqual(current!.id, seat.id);
});
