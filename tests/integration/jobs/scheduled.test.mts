import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	readConversation,
	readReview,
	retryUnresolvedEffects,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { claimDue, finishJob } from "../../../apps/web/src/server/jobs/queue.ts";
import { actor, admin, db, people, queries, setup, sql, teardown, work } from "../../evry/runtime/support.mts";

// The scheduled runner as Vercel cron calls it: GET with the CRON_SECRET bearer, on a suite schema of the shared
// development database. The turns use the scripted model.
process.env.EVRY_SCRIPTED_MODEL = "1";
const secret = "cron-" + randomUUID();
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
let tick: (request: Request) => Promise<Response>;
const call = (authorization?: string) =>
	tick(new Request("http://localhost/api/cron/jobs", authorization ? { headers: { authorization } } : {}));
const run = async () => {
	const response = await call(`Bearer ${secret}`);
	assert.equal(response.status, 200);
	return (await response.json()) as { closed: { jobs: number; runs: number }; effects: number; turns: number };
};

before(async () => {
	await setup();
	tick = scheduledJobs({ secret, db, storage: null, reminders: noReminders });
});
after(teardown);

async function ask(who: EvryActor, text: string) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text });
	return c.id;
}
async function approved(who: EvryActor, text: string) {
	const c = await ask(who, text);
	assert.equal(await work(), "succeeded");
	const card = (await readConversation(db, who, c)).events.find(
		(e) => e.kind === "tool_result" && e.body.operation === "evry.prepareProposal",
	)!;
	const p = await readReview(db, who, (card.body.result as { proposalId: string }).proposalId);
	await approveProposal(db, who, p.id, { revision: p.revision, digest: p.digest }, null);
	return p.id;
}
const job = (where: ReturnType<typeof sql>) => admin.execute(sql`UPDATE job SET ${where}`);
const turnOf = (conversation: string) => sql`kind='assistant_turn' AND subject_record_id=${conversation}`;
const effectOf = (proposal: string) => sql`kind='evry_effect' AND producer_key LIKE ${proposal + ":%"}`;
const city = async (id: string) =>
	(await admin.execute(sql`SELECT city FROM person WHERE id=${id}`)).rows[0]!.city as string;

test("INV-executor: the runner refuses a call without the exact bearer and runs nothing", async () => {
	const owner = await actor("owner");
	const waiting = await ask(owner, "Find Casey");
	for (const authorization of [undefined, "Bearer wrong", `Bearer ${secret}x`, secret])
		assert.equal((await call(authorization)).status, 401, String(authorization));
	const unset = scheduledJobs({ secret: undefined, db, storage: null, reminders: noReminders });
	assert.equal((await unset(new Request("http://localhost/api/cron/jobs"))).status, 503);
	assert.equal((await readConversation(db, owner, waiting)).run?.state, "running");
	assert.equal(await work(), "succeeded");
});

test("INV-run-recovery: with no page open, the scheduled run closes a turn and an effect whose worker stopped or that no worker took within 60 s, runs due work once, and the effect can be tried again", async () => {
	const owner = await actor("owner");
	// Effects: one whose worker stopped, one no worker took in 60 s.
	const stalled = await approved(owner, "Change Casey's city to Austin");
	await job(
		sql`state='claimed',lease_owner='gone',lease_until=clock_timestamp()-interval '1 second',claim_generation=1,attempt_count=1 WHERE ${effectOf(stalled)}`,
	);
	const late = await approved(owner, "Change Rivera's city to Naperville");
	await job(sql`eligible_at=clock_timestamp()-interval '61 seconds' WHERE ${effectOf(late)}`);
	// Turns: one whose worker stopped (lease ended), one no worker took in 60 s.
	const stopped = await ask(owner, "Find Casey");
	await job(
		sql`state='claimed',lease_owner='gone',lease_until=clock_timestamp()-interval '1 second',claim_generation=1,attempt_count=1 WHERE ${turnOf(stopped)}`,
	);
	const unclaimed = await ask(owner, "Find Casey");
	await job(sql`eligible_at=clock_timestamp()-interval '61 seconds' WHERE ${turnOf(unclaimed)}`);
	// Due work no request drained: a fresh turn.
	const fresh = await ask(owner, "Find Casey");

	const first = await run();
	assert.deepEqual([first.closed, first.effects, first.turns], [{ jobs: 4, runs: 2 }, 0, 1]);
	for (const id of [stopped, unclaimed]) {
		const page = await readConversation(db, owner, id);
		const end = page.events.at(-1)!;
		assert.deepEqual(
			[page.run, end.kind, end.body.state, (end.body.error as { code: string }).code],
			[null, "status", "failed", "interrupted"],
		);
	}
	assert.equal((await readConversation(db, owner, fresh)).run, null);
	for (const id of [stalled, late]) assert.equal((await readReview(db, owner, id)).outcome, "unknown");
	assert.deepEqual([await city(people.casey), await city(people.alexRivera)], [null, "Chicago"]);

	// A second run finds nothing to close or run: no turn ends twice and no closed job runs later.
	const second = await run();
	assert.deepEqual([second.closed, second.effects, second.turns], [{ jobs: 0, runs: 0 }, 0, 0]);
	assert.equal((await readConversation(db, owner, stopped)).events.filter((e) => e.kind === "status").length, 1);

	// Try again queues a new effect; two overlapping runs execute it exactly once.
	for (const id of [stalled, late]) assert.equal((await retryUnresolvedEffects(db, owner, id)).retried, true);
	const [a, b] = await Promise.all([run(), run()]);
	assert.equal(a.effects + b.effects, 2);
	assert.deepEqual([await city(people.casey), await city(people.alexRivera)], ["Austin", "Naperville"]);
	for (const id of [stalled, late]) {
		assert.equal((await readReview(db, owner, id)).outcome, "completed");
		const audits = await admin.execute(
			sql`SELECT count(*)::int n FROM audit_event WHERE request_key LIKE ${"evry:" + id + ":%"}`,
		);
		assert.equal(audits.rows[0]!.n, 1);
	}
});

test("INV-budget: an idle scheduled run sends a fixed number of statements, and finishing a job is one round trip", async () => {
	await run();
	const start = queries.length;
	await run();
	const sent = queries.slice(start).filter((q) => !/^(BEGIN|COMMIT)/i.test(q.trim()));
	// closeLostJobs 2 (timeout, close); imports: recoverLease 2, claim 1; effects claim 1; turns claim 1.
	assert.equal(sent.length, 7, sent.join("\n---\n"));
	// A job the runner finishes costs one round trip: the statement bound and the fenced finish in one message.
	await ask(await actor("owner"), "Find Casey");
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	const before = queries.length;
	assert.equal(await finishJob(db, claim!, { state: "cancelled" }), true);
	assert.equal(queries.length - before, 1);
});
