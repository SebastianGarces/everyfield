import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4StreamPart,
} from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import {
	approveProposal,
	cancelProposal,
	createConversation,
	LIMITS,
	observeConversation,
	readConversation,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { readNotes, updateNotes } from "../../../packages/evry/src/conversations/notes.ts";
import { readReviews } from "../../../packages/evry/src/conversations/store.ts";
import { scriptedModel } from "../../../packages/evry-scripted/src/scripted.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { accounts, actor, admin, db, freshActor, people, setup, sql, teardown, usage, work } from "./support.mts";

before(setup);
after(teardown);

type Reply = Record<string, unknown>;
type Step = { tool: string; input: unknown }[] | string;
function stepping(steps: Step[]) {
	const base = scriptedModel();
	const replies: Reply[][] = [];
	let at = 0;
	const model: LanguageModelV4 = {
		...base,
		async doGenerate(options) {
			return options.responseFormat?.type === "json"
				? { ...(await base.doGenerate(options)), content: [{ type: "text", text: '{"kind":"application"}' }] }
				: base.doGenerate(options);
		},
		async doStream({ prompt }: LanguageModelV4CallOptions) {
			const last = prompt.at(-1);
			if (last?.role === "tool")
				replies.push(
					last.content.flatMap((p) =>
						p.type === "tool-result" && p.output.type === "json" ? [p.output.value as Reply] : [],
					),
				);
			const step = steps[at++] ?? "Done.";
			const content: LanguageModelV4Content[] =
				typeof step === "string"
					? [{ type: "text", text: step }]
					: step.map((s) => ({
							type: "tool-call",
							toolCallId: randomUUID(),
							toolName: s.tool,
							input: JSON.stringify(s.input),
						}));
			const parts: LanguageModelV4StreamPart[] = content.flatMap((c): LanguageModelV4StreamPart[] =>
				c.type === "text"
					? [
							{ type: "text-start", id: "t" },
							{ type: "text-delta", id: "t", delta: c.text },
							{ type: "text-end", id: "t" },
						]
					: c.type === "tool-call"
						? [c]
						: [],
			);
			parts.push({
				type: "finish",
				finishReason: { unified: typeof step === "string" ? "stop" : "tool-calls", raw: undefined },
				usage,
			});
			return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
		},
	};
	return { model: { status: "qualified" as const, id: "test", model }, replies };
}
async function open(who: EvryActor) {
	return (await createConversation(db, who, { requestKey: randomUUID() })).id;
}
async function turn(
	who: EvryActor,
	id: string,
	steps: Step[],
	outcome = "succeeded",
	deps: Parameters<typeof work>[1] = {},
) {
	await submitTurn(db, who, id, { requestKey: randomUUID(), text: "Help me plan the week." });
	const s = stepping(steps);
	assert.equal(await work(s.model, deps), outcome);
	return s.replies.flat();
}
async function held(who: EvryActor, id: string) {
	await submitTurn(db, who, id, { requestKey: randomUUID(), text: "hold" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	return {
		lease: {
			turnId: claim!.id,
			tenantId: claim!.tenant_id,
			leaseOwner: claim!.lease_owner,
			generation: claim!.claim_generation,
		},
		end: async () => {
			await admin.execute(sql`UPDATE conversation SET active_turn_id=NULL,active_session_id=NULL WHERE id=${id}`);
			await transaction(db, (tx) => finishClaim(tx, claim!, { state: "succeeded" }));
		},
	};
}
const note = (notes: string, expectedRevision: number) => ({
	tool: "update_planning_notes",
	input: { notes, expectedRevision },
});
const recall = { tool: "read_planning_notes", input: {} };
const person = (personId: string) => ({
	tool: "people_read",
	input: { operation: "people.getPerson", input: { personId } },
});

test("AC:EVRY-FAMILY-RUNTIME-CONVERSATION INV-evry-notes: planning notes last to a later turn and a reload, refuse a stale or long edit, and stay the owner's in one conversation", async () => {
	const owner = await actor("owner");
	const member = await actor("member");
	const id = await open(owner);
	const other = await open(owner);
	const audits = async () =>
		(
			await admin.execute(
				sql`SELECT (SELECT count(*)::int FROM proposal) proposals,(SELECT jsonb_agg(p.revision ORDER BY p.id) FROM person p) people`,
			)
		).rows[0];
	const was = await audits();
	assert.deepEqual(
		await turn(owner, id, [[recall], [note("Invite list done.", 0)], [note("Lost edit.", 0)], "Saved."]),
		[{ notes: "", revision: 0 }, { revision: 1 }, { error: "stale_notes", revision: 1 }],
	);
	assert.deepEqual(await turn(owner, id, [[recall], [note("Invite list done. Venue booked.", 1)]]), [
		{ notes: "Invite list done.", revision: 1 },
		{ revision: 2 },
	]);
	const reloaded = await actor("owner");
	const notes = await readNotes(db, reloaded, id);
	assert.deepEqual([notes?.notes, notes?.revision], ["Invite list done. Venue booked.", 2]);
	assert.deepEqual(await turn(owner, id, [[note("x".repeat(LIMITS.notesChars + 1), 2)]]), [
		{ error: "notes_too_long", limit: LIMITS.notesChars },
	]);
	assert.equal((await readNotes(db, owner, other))?.notes, "", "another conversation has its own");
	assert.equal(await readNotes(db, member, id), null, "another account reads nothing");
	const run = await held(owner, id);
	assert.deepEqual(await updateNotes(db, member, run.lease, id, { notes: "Not mine", expectedRevision: 2 }), {
		status: "lost",
	});
	const both = await Promise.all(
		["One", "Two"].map((notes) => updateNotes(db, owner, run.lease, id, { notes, expectedRevision: 2 })),
	);
	assert.deepEqual(both.map((b) => b.status).sort(), ["saved", "stale"], "two edits at once keep one");
	await run.end();
	const page = await readConversation(db, owner, id);
	assert.ok(!JSON.stringify(page).includes("Invite list done"), "never in the chat as a message or an outcome");
	const stop = new AbortController();
	let seen = 0;
	for await (const event of observeConversation(db, owner, id, 0, stop.signal)) {
		assert.ok(!JSON.stringify(event).includes("Invite list done"), "nor in the live stream");
		if (++seen === page.events.length) stop.abort();
	}
	assert.deepEqual(await audits(), was, "notes change no record and prepare no review");
	await admin.execute(sql`DELETE FROM conversation_event WHERE conversation_id=${id}`);
	await admin.execute(sql`DELETE FROM conversation WHERE id=${id}`);
	assert.equal(await readNotes(db, owner, id), null, "deleting the conversation deletes its notes");
});

test("INV-evry-notes: notes from a source that is gone are withheld, like the answers that used it, and new notes start clean", async () => {
	const owner = await actor("owner");
	const id = await open(owner);
	assert.deepEqual((await turn(owner, id, [[person(people.casey)], [note("Call Casey about Sunday.", 0)]])).at(-1), {
		revision: 1,
	});
	assert.deepEqual((await turn(owner, id, [[recall], [note("Call Casey about Sunday. Then book.", 1)]])).at(-1), {
		revision: 2,
	});
	await admin.execute(sql`UPDATE person SET state='retired',retired_at=clock_timestamp() WHERE id=${people.casey}`);
	assert.deepEqual(await turn(owner, id, [[recall], [note("Book the hall.", 2)], [recall]]), [
		{ notes: "", revision: 2, withheld: true },
		{ revision: 3 },
		{ notes: "Book the hall.", revision: 3 },
	]);
	await admin.execute(sql`UPDATE person SET state='live',retired_at=NULL WHERE id=${people.casey}`);
});

test("AC:EVRY-FAMILY-RUNTIME-REVIEW-EXECUTION INV-evry-review: the read says waiting, approved with its outcome, declined or expired for the actor's own cards here, under current access", async () => {
	const owner = await actor("owner");
	const id = await open(owner);
	const change = (city: string) => ({
		tool: "propose_change",
		input: {
			operation: "people.updatePerson",
			input: { personId: people.alexRivera, patch: { city, summaryNotes: `Private words ${city}` } },
		},
	});
	const cards = (await turn(owner, id, [
		[change("Waiting")],
		[change("Approved")],
		[change("Declined")],
		[change("Expired")],
	])) as {
		proposalId: string;
	}[];
	const [, approved, declined, expired] = cards.map((c) => c.proposalId);
	const { reviews } = await readConversation(db, owner, id);
	const card = reviews[approved!]!;
	await approveProposal(db, owner, card.id, { revision: card.revision, digest: card.digest }, null);
	await admin.execute(
		sql`UPDATE proposal SET outcome='completed',receipt='{"revision":"2"}'::jsonb WHERE id=${card.id}`,
	);
	await cancelProposal(db, owner, declined!);
	await admin.execute(sql`UPDATE proposal SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=${expired!}`);
	const [all, one, gone] = (await turn(owner, id, [
		[{ tool: "read_review", input: {} }],
		[{ tool: "read_review", input: { proposalId: declined } }],
		[{ tool: "read_review", input: { proposalId: randomUUID() } }],
	])) as { status: string; total: number; rows: { label: string; fields: Record<string, unknown> }[] }[];
	assert.deepEqual(
		all!.rows.map((r) => [r.label, r.fields.status, r.fields.outcome]),
		[
			["Alex Rivera", "waiting", "waiting for the user's review: nothing changed yet"],
			["Alex Rivera", "approved", "approved and applied"],
			["Alex Rivera", "declined", "cancelled: nothing changed"],
			["Alex Rivera", "expired", "the review expired before approval: nothing changed"],
		],
	);
	assert.deepEqual([one!.total, one!.rows[0]!.fields.proposalId], [1, declined]);
	assert.deepEqual([gone!.status, gone!.total], ["not_found", 0]);
	assert.ok(!JSON.stringify([all, one]).includes("Private words"), "it repeats nothing the change said");
	assert.deepEqual((await readReviews(db, owner, await open(owner), approved!))?.reviews, [], "another conversation");
	assert.equal(await readReviews(db, await actor("member"), id, null), null, "another account");
	await admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${accounts.owner.id}`);
	try {
		const demoted = await actor("owner");
		assert.deepEqual(await readReviews(db, demoted, id, null), { total: 0, reviews: [] }, "a withdrawn role sees none");
	} finally {
		await admin.execute(sql`UPDATE seat SET role='owner' WHERE account_id=${accounts.owner.id}`);
	}
	await admin.execute(
		sql`UPDATE person SET state='retired',retired_at=clock_timestamp() WHERE id=${people.alexRivera}`,
	);
	const withheld = await readReviews(db, owner, id, approved!);
	assert.equal(withheld?.reviews[0]?.review.target, null, "a person no longer current is not named");
	await admin.execute(sql`UPDATE person SET state='live',retired_at=NULL WHERE id=${people.alexRivera}`);
});

const compose = (reads: { operation: string; input: unknown }[]) => ({ tool: "compose_reads", input: { reads } });
const read = (personId: string) => ({ operation: "people.getPerson", input: { personId } });

test("AC:EVRY-FAMILY-RUNTIME-CONVERSATION INV-evry-compose: at most eight declared reads overlap in one composition, and each keeps its own result, access check and budget", async () => {
	const owner = await actor("owner");
	let checking = 0;
	let most = 0;
	const counted = async (session: string) => {
		most = Math.max(most, ++checking);
		try {
			return await freshActor(session);
		} finally {
			checking--;
		}
	};
	const id = await open(owner);
	const [good] = (await turn(
		owner,
		id,
		[
			[
				compose([
					read(people.alexRivera),
					read(people.alexChen),
					{ operation: "people.listPeople", input: { limit: 2 } },
					{ operation: "people.getPerson", input: { personId: "not-an-id" } },
					read(people.foreign),
				]),
			],
		],
		"succeeded",
		{ freshActor: counted },
	)) as { results: Record<string, unknown>[] }[];
	assert.equal(most, 4, `every valid read started before any finished its access check: ${most} at once`);
	assert.deepEqual(
		good!.results.map((r) => [
			r.operation,
			r.error ?? r.status,
			(r.rows as { label: string }[] | undefined)?.[0]?.label ?? null,
		]),
		[
			["people.getPerson", "available", "Alex Rivera"],
			["people.getPerson", "available", "Alex Chen"],
			["people.listPeople", "available", "Alex Rivera"],
			["people.getPerson", "invalid_input", null],
			["people.getPerson", "not_found", null],
		],
	);
	const ids = good!.results.flatMap((r) => (typeof r.resultId === "number" ? [r.resultId] : []));
	assert.equal(new Set(ids).size, 4, "each result has its own resultId");
	const picked = (await turn(owner, await open(owner), [
		[compose([read(people.alexRivera)])],
		[{ tool: "people_read", input: read(people.alexChen) }],
	])) as { results?: { resultId: number }[] }[];
	assert.equal(typeof picked[0]!.results![0]!.resultId, "number");

	const refusedIn = await open(owner);
	assert.deepEqual(
		await turn(owner, refusedIn, [
			[compose(Array.from({ length: LIMITS.composedReads + 1 }, () => read(people.alexRivera)))],
			[compose([read(people.alexRivera), { operation: "people.updatePerson", input: {} }])],
			[compose([{ operation: "evry.approveProposal", input: {} }])],
		]),
		[
			{ error: "too_many_reads", limit: 8 },
			{ error: "not_a_read", operations: ["people.updatePerson"] },
			{ error: "not_a_read", operations: ["evry.approveProposal"] },
		],
	);
	const { events } = await readConversation(db, owner, refusedIn);
	assert.equal(events.filter((e) => e.kind === "tool_result").length, 0, "nothing ran before the refusal");
	assert.equal((events.findLast((e) => e.kind === "status")!.body.usage as { toolCalls: number }).toolCalls, 0);

	const eight = compose(Array.from({ length: 8 }, () => read(people.alexRivera)));
	const spent = await open(owner);
	await turn(owner, spent, [[eight], [eight], "Enough."]);
	const after = await readConversation(db, owner, spent);
	assert.equal((after.events.findLast((e) => e.kind === "status")!.body.usage as { toolCalls: number }).toolCalls, 16);
	const over = await open(owner);
	const replies = (await turn(owner, over, [
		[eight],
		[eight],
		[{ tool: "people_read", input: read(people.alexChen) }],
		[eight],
	])) as {
		results?: { error?: string }[];
	}[];
	const end = (await readConversation(db, owner, over)).events;
	assert.equal(end.filter((e) => e.kind === "tool_result").length, LIMITS.toolCalls, "24 reads ran, never more");
	assert.equal(end.findLast((e) => e.kind === "status")!.body.reason, "tool_budget");
	assert.equal(replies.length, 3, "the turn stops when the budget is spent");
});

test("INV-evry-compose: a person deleted during the turn leaves a composed result before the model is called again", async () => {
	const owner = await actor("owner");
	const id = await open(owner);
	await submitTurn(db, owner, id, { requestKey: randomUUID(), text: "Help me plan the week." });
	const s = stepping([[compose([read(people.alexRivera), read(people.alexChen)])], [recall]]);
	const seen: string[] = [];
	const stream = s.model.model.doStream.bind(s.model.model);
	s.model.model = {
		...s.model.model,
		async doStream(options: LanguageModelV4CallOptions) {
			seen.push(JSON.stringify(options.prompt));
			if (seen.length === 2)
				await admin.execute(
					sql`UPDATE person SET state='retired',retired_at=clock_timestamp() WHERE id=${people.alexChen}`,
				);
			return stream(options);
		},
	};
	assert.equal(await work(s.model), "succeeded");
	await admin.execute(sql`UPDATE person SET state='live',retired_at=NULL WHERE id=${people.alexChen}`);
	assert.ok(seen[1]!.includes("Alex Chen"));
	assert.ok(seen[2]!.includes("Alex Rivera") && !seen[2]!.includes("Alex Chen"), "the deleted person is withheld");
	assert.ok(seen[2]!.includes("withheldRows"));
});
