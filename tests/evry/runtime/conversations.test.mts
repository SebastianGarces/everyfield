import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	cancelTurn,
	createConversation,
	latestConversation,
	listConversations,
	observeConversation,
	readConversation,
	retryTurn,
	submitTurn,
} from "../../../packages/evry/src/index.ts";
import { actor, admin, counts, db, queries, setup, sql, teardown, work } from "./support.mts";

before(setup);
after(teardown);

const refused = async (body: () => Promise<unknown>, code: string) =>
	assert.rejects(body, (e: { code?: string }) => {
		assert.equal(e.code, code);
		return true;
	});
const statements = async <T,>(body: () => Promise<T>) => {
	const start = queries.length;
	const value = await body();
	return { value, count: queries.slice(start).filter((q) => !/^(BEGIN|COMMIT|SET LOCAL)/i.test(q.trim())).length };
};

test("AC:UI45-001 AC:UI45-002 AC:INH-REGRESSION-SESSION-NAVIGATION AC:EVRY-RETRY-CANCEL AC:INH-CROSS-08 one private conversation, one turn per request key, one active run, cancel and explicit retry", async () => {
	const owner = await actor("owner");
	const key = randomUUID();
	const created = await statements(() => createConversation(db, owner, { requestKey: key }));
	assert.equal(created.count, 1, "create is one statement");
	assert.deepEqual(
		await createConversation(db, owner, { requestKey: key }),
		created.value,
		"same key, same conversation",
	);
	const c = created.value;
	assert.equal(c.context, "plant");
	// Opening Evry again from the launcher or the panel returns the same conversation, not a new thread.
	assert.equal((await latestConversation(db, owner))?.id, c.id);

	const first = { requestKey: randomUUID(), text: "Show my people.", references: [] };
	const submitted = await statements(() => submitTurn(db, owner, c.id, first));
	assert.equal(submitted.count, 1, "submit is one statement");
	const before = await counts();
	assert.deepEqual(await submitTurn(db, owner, c.id, first), { ...submitted.value, replayed: true });
	assert.deepEqual(await counts(), before, "a repeated submit writes nothing");
	await refused(() => submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "Another" }), "run_active");

	// Observing replays saved events and never starts the run.
	const seen = [];
	for await (const e of observeConversation(db, owner, c.id, 0, AbortSignal.timeout(400), 50)) seen.push(e);
	assert.deepEqual(
		seen.map((e) => [e.sequence, e.kind, e.body.text]),
		[[1, "user_message", "Show my people."]],
	);
	const run = await admin.execute(sql`SELECT state FROM job WHERE id=${submitted.value.turnId}`);
	assert.equal(run.rows[0]!.state, "ready", "GET never starts the executor");

	const cancelled = await statements(() => cancelTurn(db, owner, c.id));
	assert.equal(cancelled.count, 1, "cancel is one statement");
	assert.deepEqual(cancelled.value, { cancelled: true, turnId: submitted.value.turnId });
	assert.deepEqual(await cancelTurn(db, owner, c.id), { cancelled: false, turnId: null }, "cancel again is a no-op");
	assert.equal(await work(), null, "a cancelled run is never claimed");
	const read = await readConversation(db, owner, c.id);
	assert.equal(read.run, null);
	assert.deepEqual(
		read.events.map((e) => [e.kind, e.body.text ?? e.body.reason]),
		[
			["user_message", "Show my people."],
			["status", "cancelled"],
		],
		"the user's message stays; nothing is called undone",
	);
	assert.equal(read.conversation.title, "Show my people.");

	const retryKey = randomUUID();
	const retry = await statements(() => retryTurn(db, owner, c.id, { requestKey: retryKey }));
	assert.equal(retry.count, 2, "retry is one lookup and one submit statement");
	const retried = retry.value;
	assert.equal(retried.replayed, false);
	assert.equal(await work(), "succeeded");
	assert.deepEqual(await retryTurn(db, owner, c.id, { requestKey: retryKey }), { ...retried, replayed: true });
	await refused(() => retryTurn(db, owner, c.id, { requestKey: randomUUID() }), "invalid_input");
	const after = await readConversation(db, owner, c.id, 2);
	assert.deepEqual(after.events[0]!.body, { text: "Show my people.", references: [], retryOf: 1 });
	assert.equal(after.events.at(-1)!.body.state, "completed");
	const audits = await admin.execute(
		sql`SELECT action FROM audit_event WHERE subject_id=${c.id} ORDER BY recorded_at,action`,
	);
	assert.deepEqual(
		audits.rows.map((r) => r.action),
		["evry.conversation_created", "evry.turn_submitted", "evry.turn_cancelled", "evry.turn_retried"],
	);
	const bodies = await admin.execute(
		sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${c.id} AND (before_value IS NOT NULL OR after_value IS NOT NULL OR metadata::text LIKE '%people%')`,
	);
	assert.equal(bodies.rows[0]!.n, 0, "audit never holds message text");

	// A follow-up turn in the same conversation is accepted; the conversation is not duplicated.
	await submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "What about tomorrow?" });
	assert.equal((await listConversations(db, owner, {})).total, 1);
	assert.equal((await listConversations(db, owner, { search: "tomorrow" })).items[0]?.id, c.id);
	assert.equal((await listConversations(db, owner, { search: "nothing like this" })).total, 0);
	await cancelTurn(db, owner, c.id);
});

test("AC:INH-REGRESSION-FOREIGN-SESSION AC:TEN-002 AC:SEC-02 AC:UI45-006 INV-tenancy: another account or context cannot read, stream, append, cancel or continue a conversation", async () => {
	const owner = await actor("owner");
	const c = await createConversation(db, owner, { requestKey: randomUUID() });
	await submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "Private planning note" });
	const before = await counts();
	for (const who of ["member", "foreign", "orgOwner", "seatless"] as const) {
		const other = await actor(who);
		await refused(() => readConversation(db, other, c.id), "not_found");
		await refused(async () => {
			for await (const _ of observeConversation(db, other, c.id, 0, AbortSignal.timeout(200))) void _;
		}, "not_found");
		await refused(() => submitTurn(db, other, c.id, { requestKey: randomUUID(), text: "append" }), "not_found");
		await refused(() => cancelTurn(db, other, c.id), "not_found");
		await refused(() => retryTurn(db, other, c.id, { requestKey: randomUUID() }), "not_found");
		assert.deepEqual((await listConversations(db, other, { search: "Private" })).items, []);
		assert.equal(await latestConversation(db, other), null);
	}
	assert.deepEqual(await counts(), before, "no refused call wrote anything");
	// An ended seat loses the conversation's context at once: no new turn, no cancel.
	await cancelTurn(db, owner, c.id);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${owner.accountId}`);
	await refused(
		() => submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "after removal" }),
		"access_denied",
	);
	await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${owner.accountId}`);
});

test("INV-budget: conversation reads use one statement regardless of size", async () => {
	const owner = await actor("owner");
	for (const after of [0, 1]) {
		const c = (await listConversations(db, owner, {})).items[0]!;
		const read = await statements(() => readConversation(db, owner, c.id, after));
		assert.equal(read.count, 1);
	}
	const list = await statements(() => listConversations(db, owner, { search: "a", page: 3 }));
	assert.equal(list.count, 1);
	assert.deepEqual(list.value.items, [], "a page past the end is empty, not an error");
});
