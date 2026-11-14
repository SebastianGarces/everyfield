// Evry's honest limits and the facts it keeps (WP-054, WP-085), through the real runtime on the scripted model: DST gaps
// and folds are asked about, never guessed; a Member is told who can make a change; a bulk request confirms its scope
// first and no turn fills with review cards; a long history comes in dated pages without private care; and past the
// message window the conversation's reviews keep their exact outcomes, so an applied change is never prepared again.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
} from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import {
	approveProposal,
	createConversation,
	executeProposal,
	readConversation,
	readReview,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { LIMITS } from "../../../packages/evry/src/context/limits.ts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../apps/web/src/server/jobs/queue.ts";
import { accounts, actor, admin, db, people, plant, setup, sql, teardown, work } from "./support.mts";

before(async () => {
	await setup();
	// 57 people in Prospect: the three named prospects and 54 more.
	await admin.execute(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		SELECT ${plant}::uuid,${plant}::uuid,'Prospect '||lpad(n::text,2,'0'),'other',clock_timestamp(),'prospect','unknown','unknown',300+n,'live' FROM generate_series(1,54) n`);
});
after(teardown);

async function conversation(who: EvryActor) {
	return (await createConversation(db, who, { requestKey: randomUUID() })).id;
}
/** One turn: the reply, the tool calls with their inputs and the review cards in the conversation. */
async function say(
	who: EvryActor,
	id: string,
	text: string,
	model?: Parameters<typeof work>[0],
	references: { kind: "person"; id: string }[] = [],
) {
	await submitTurn(db, who, id, { requestKey: randomUUID(), text, references });
	assert.equal(await work(model), "succeeded");
	const events = [];
	for (let page = await readConversation(db, who, id); ; page = await readConversation(db, who, id, events.at(-1)!.sequence)) {
		events.push(...page.events);
		if (!page.more) break;
	}
	const turn = events.findLast((e) => e.kind === "user_message")!.turnId;
	const mine = events.filter((e) => e.turnId === turn);
	return {
		text: mine
			.filter((e) => e.kind === "assistant_text")
			.map((e) => e.body.text)
			.join(""),
		calls: mine.filter((e) => e.kind === "tool_result").map((e) => (e.body as { operation: string }).operation),
	};
}
const proposals = async (id: string) =>
	(await admin.execute(sql`SELECT operation,state FROM proposal WHERE conversation_id=${id}::uuid ORDER BY created_at`))
		.rows as { operation: string; state: string }[];

test("AC:GAP-EVR-425 INV-dst: in America/New_York a 1:30 AM that happens twice is asked about, a 2:30 AM the clocks skip is refused, and a date Evry can't pin down is asked for", async () => {
	await admin.execute(sql`UPDATE plant SET timezone='America/New_York' WHERE id=${plant}::uuid`);
	try {
		const owner = await actor("owner");
		const id = await conversation(owner);
		const fold = await say(owner, id, "Schedule the volunteer email for Nov 1, 2026 at 1:30am");
		assert.deepEqual(fold.calls, ["calendar.resolve"]);
		assert.equal(
			fold.text,
			"That time happens twice that day as the clocks fall back. Do you mean Sun, Nov 1, 2026, 1:30 AM EDT (the first) or Sun, Nov 1, 2026, 1:30 AM EST (the second)?",
		);
		const gap = await say(owner, id, "Then make it March 14, 2027 at 2:30am");
		assert.deepEqual(gap.calls, ["calendar.resolve"]);
		assert.equal(
			gap.text,
			"That time doesn't exist that day in America/New_York: the clocks skip it. What time would you like instead?",
		);
		const vague = await say(owner, id, "Actually send it the 5th");
		assert.match(vague.text, /^Which date do you mean\?/);
		assert.deepEqual(await proposals(id), []);
	} finally {
		await admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${plant}::uuid`);
	}
});

test("AC:SAF-02 a Member asking to change someone is told an Owner or Admin has to make it, and no review card is prepared", async () => {
	const member = await actor("member");
	const id = await conversation(member);
	const reply = await say(member, id, "move Casey to leader");
	assert.equal(reply.text, "An Owner or Admin of this church has to make that change. I can't prepare it for you.");
	assert.deepEqual(reply.calls, []);
	assert.deepEqual(await proposals(id), []);
});

/** A model that, on its first step, asks to delete every person id in the system prompt's verified references. */
function bulkDeleter(): LanguageModelV4 {
	let step = 0;
	return {
		specificationVersion: "v4",
		provider: "test",
		modelId: "bulk",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text: JSON.stringify({ kind: "application" }) }],
			finishReason: { unified: "stop", raw: undefined },
			usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
			warnings: [],
		}),
		async doStream(options: LanguageModelV4CallOptions) {
			const system = options.prompt.find((m) => m.role === "system")?.content as string;
			const ids = [...system.matchAll(/"id":"([0-9a-f-]{36})"/g)].map((m) => m[1]!);
			const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
			const parts: LanguageModelV4StreamPart[] =
				step++ === 0
					? [
							...ids.map(
								(personId) =>
									({
										type: "tool-call",
										toolCallId: randomUUID(),
										toolName: "propose_change",
										input: JSON.stringify({ operation: "people.deletePerson", input: { personId, reason: "Cleanup" } }),
									}) as LanguageModelV4StreamPart,
							),
							{ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
						]
					: [
							{ type: "text-start", id: "t" },
							{ type: "text-delta", id: "t", delta: "Done preparing." },
							{ type: "text-end", id: "t" },
							{ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
						];
			return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
		},
	};
}

test("AC:SAF-16 INV-review-cards: deleting everyone in Prospect confirms the scope and the count of 57 before preparing anything, and no turn ever holds more than ten review cards", async () => {
	const owner = await actor("owner");
	const id = await conversation(owner);
	const reply = await say(owner, id, "delete everyone in prospect");
	assert.deepEqual(reply.calls, ["people.listPeople"]);
	assert.match(reply.text, /^That would remove all 57 people in prospect\. Do you want me to prepare those removals\?/);
	assert.deepEqual(await proposals(id), []);

	// Even a model that asks for twelve removals in one step gets ten review cards; the rest are refused.
	const twelve = (
		await admin.execute(
			sql`SELECT id FROM person WHERE plant_id=${plant}::uuid AND display_name LIKE 'Prospect %' ORDER BY display_name LIMIT 12`,
		)
	).rows.map((r) => ({ kind: "person" as const, id: r.id as string }));
	const bulk = await conversation(owner);
	await say(owner, bulk, "remove these people", { status: "qualified", id: "bulk", model: bulkDeleter() }, twelve);
	const prepared = await proposals(bulk);
	assert.equal(prepared.length, LIMITS.reviewCards);
	assert.ok(prepared.every((p) => p.operation === "people.deletePerson" && p.state === "pending"));
});

test("AC:EVR-031 two years of a person's history come in dated pages that continue; private care never appears and a Member sees no record details", async () => {
	// A note a month for two years, each recorded a week after it happened, and a private care follow-up.
	await admin.execute(sql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		SELECT ${plant}::uuid,${plant}::uuid,${people.casey}::uuid,${accounts.owner.id}::uuid,'Private note text '||n,
			timestamptz '2024-10-15 15:00Z'+make_interval(months=>n),timestamptz '2024-10-22 15:00Z'+make_interval(months=>n)
		FROM generate_series(0,23) n`);
	await admin.execute(sql`INSERT INTO contact_outcome(plant_id,person_id,outcome,occurred_at,recorded_at,notes)
		VALUES(${plant}::uuid,${people.casey}::uuid,'contacted',timestamptz '2026-10-01 15:00Z',timestamptz '2026-10-01 15:00Z','Care: hospital visit')`);
	for (const who of ["owner", "member"] as const) {
		const me = await actor(who);
		const id = await conversation(me);
		const first = await say(me, id, "show me everything that's happened with Casey Reed");
		assert.deepEqual(first.calls, ["people.listPeople", "people.getActivities"]);
		const lines = first.text.split("\n");
		assert.equal(lines[0], "Casey Reed's history, page 1:");
		// Newest first, each on the date it happened (not the date it was recorded).
		assert.deepEqual(lines.slice(1, 4), ["- 2026-09-15: Note", "- 2026-08-15: Note", "- 2026-07-15: Note"]);
		assert.equal(lines.at(-1), "There is more. Ask for page 2 of Casey Reed's history.");
		const later = await say(me, id, "show me page 3 of the history of Casey Reed");
		assert.deepEqual(later.text.split("\n").slice(0, 2), ["Casey Reed's history, page 3:", "- 2025-02-15: Note"]);
		for (const text of [first.text, later.text]) {
			assert.doesNotMatch(text, /Care|hospital|contacted|Private note text/);
			assert.doesNotMatch(text, /follow_up/);
		}
	}
});

/** Runs the next approved effect as the app worker does. */
async function effect() {
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		async () => undefined,
	);
	if (outcome !== "lost") await transaction(db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	return outcome;
}

test("AC:EVRY-CONTEXT-BOUNDS AC:GAP-EVR-429 past 24 messages and 64 references the conversation keeps its reviews' outcomes: an applied change is never prepared again, and 'did you send it?' tells waiting from sent", async () => {
	const owner = await actor("owner");
	const id = await conversation(owner);
	await say(owner, id, "change Casey's city to Austin");
	const [card] = (await admin.execute(sql`SELECT id FROM proposal WHERE conversation_id=${id}::uuid`)).rows as { id: string }[];
	const review = await readReview(db, owner, card!.id);
	await approveProposal(db, owner, card!.id, { revision: review.revision, digest: review.digest }, null);
	assert.equal(await effect(), "completed");
	assert.equal((await readReview(db, owner, card!.id)).outcome, "completed");

	// Two emails reviewed in this conversation: one still waiting, one approved and accepted by the email service with
	// delivery not reported yet. Their rows are placed as the review and the effect leave them.
	const waiting = randomUUID();
	const sent = randomUUID();
	for (const [message, subject] of [
		[waiting, "Sunday invite"],
		[sent, "Volunteer thanks"],
	] as const)
		await admin.execute(sql`INSERT INTO communication(id,plant_id,author_id,revision,state,subject,body_html,body_text,audience,scheduled_at,created_at)
			VALUES(${message}::uuid,${plant}::uuid,${accounts.owner.id}::uuid,1,'scheduled',${subject},'<p>Hi</p>','Hi','{"groups":["all"],"teamIds":[],"personIds":[]}'::jsonb,
				clock_timestamp()+interval '7 days',clock_timestamp())`);
	const target = (message: string, label: string) =>
		JSON.stringify({ target: { kind: "message", id: message, label }, changes: [] });
	await admin.execute(sql`INSERT INTO proposal(tenant_id,account_id,conversation_id,operation,input,review,digest,state,expires_at)
		VALUES(${plant}::uuid,${accounts.owner.id}::uuid,${id}::uuid,'communication.scheduleReviewed','{}'::jsonb,${target(waiting, "Sunday invite")}::jsonb,
			${"0".repeat(64)},'pending',clock_timestamp()+interval '15 minutes')`);
	const report = { kind: "schedule", confirmation: "confirmed", scheduledAt: "2026-11-20T15:00:00.000Z", accepted: 1, refused: 0, unknown: 0 };
	await admin.execute(sql`INSERT INTO proposal(tenant_id,account_id,conversation_id,operation,input,review,digest,state,expires_at,approved_at,outcome,receipt)
		VALUES(${plant}::uuid,${accounts.owner.id}::uuid,${id}::uuid,'communication.scheduleReviewed','{}'::jsonb,${target(sent, "Volunteer thanks")}::jsonb,
			${"1".repeat(64)},'approved',clock_timestamp()+interval '15 minutes',clock_timestamp(),'completed',
			${JSON.stringify({ receiptId: sent, revision: "2", report })}::jsonb)`);

	// Thirteen more turns: 26 more messages, past the 24 a model call holds, two of them with 64 page references each.
	const many = (
		await admin.execute(sql`SELECT id FROM person WHERE plant_id=${plant}::uuid ORDER BY display_name LIMIT 128`)
	).rows.map((r) => ({ kind: "person" as const, id: r.id as string }));
	for (let n = 0; n < 13; n++)
		await say(owner, id, `hello ${n}`, undefined, n === 5 ? many.slice(0, 64) : n === 6 ? many.slice(64) : []);

	const again = await say(owner, id, "change Casey's city to Austin");
	assert.equal(again.text, "That change was already applied in this conversation, so I didn't prepare it again.");
	assert.deepEqual(
		(await proposals(id)).map((p) => p.operation),
		["people.updatePerson", "communication.scheduleReviewed", "communication.scheduleReviewed"],
	);
	const [updates] = (
		await admin.execute(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${people.casey}::uuid AND action='people.updated'`,
		)
	).rows as { n: number }[];
	assert.equal(updates!.n, 1, "one effect for one approval");

	const status = await say(owner, id, "did you send it?");
	assert.equal(
		status.text,
		['- "Sunday invite": not sent, waiting for your review', '- "Volunteer thanks": sent, delivery not confirmed yet'].join("\n"),
	);
});
