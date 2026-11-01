// Evry streams an answer as it is written (WP-051). The running turn hands each model delta to this process's observers
// at once (runtime/live.ts) and saves it to the database off the model read loop.
//   INV-stream-progressive: a short answer of at least 6 deltas reaches an observer as 3 or more updates, in order, whose
//     concatenation is the model text; each delta is delivered within 150 ms of the model emitting it. The live path
//     skips the database, so the numbers do not include its latency (D81).
//   INV-stream-durable: a reconnect from a mid-stream cursor has the rest with no gap and no duplicate; a second
//     observer and a reload show the same final text; a lost run is closed once.
//   INV-stream-access: an observer whose seat ends mid-stream gets no more text within 1 s.
//   INV-stream-end: Stop keeps the partial text; a provider error mid-stream keeps it, shows the projected error and
//     leaks no raw provider message.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { APICallError } from "../../../packages/evry/node_modules/ai/dist/index.js";
import type { LanguageModelV4 } from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import {
	cancelTurn,
	createConversation,
	observeRun,
	readConversation,
	submitTurn,
	type ConversationEvent,
	type EvryActor,
	type Observed,
} from "../../../packages/evry/src/index.ts";
import { scriptedModel } from "../../../packages/evry/src/runtime/scripted.ts";
import { actor, admin, db, people, setup, sql, teardown, work } from "./support.mts";

before(setup);
after(teardown);

const qualified = (model: LanguageModelV4) => ({ status: "qualified" as const, id: "test", model });
const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SENTENCES = ["There are 19 prospects in this church. ", "The list is complete and up to date."];
const DELTAS = [
	"There ",
	"are ",
	"19 ",
	"prospects ",
	"in this ",
	"church. ",
	"The list is ",
	"complete and ",
	"up to date.",
];
const TEXT = DELTAS.join("");

/** A model that writes `deltas` 30 to 60 ms apart, recording when each left the model; optionally ends in an error. */
function writer(deltas: string[], emitted: number[] = [], opts: { error?: Error; gap?: () => number } = {}) {
	const base = scriptedModel();
	const gap = opts.gap ?? (() => 30 + Math.random() * 30);
	const model: LanguageModelV4 = {
		...base,
		async doStream(options) {
			if (options.responseFormat?.type === "json") return base.doStream(options);
			return {
				stream: new ReadableStream({
					async start(c) {
						c.enqueue({ type: "text-start", id: "t" });
						for (const delta of deltas) {
							if (options.abortSignal?.aborted) return c.error(options.abortSignal.reason);
							c.enqueue({ type: "text-delta", id: "t", delta });
							emitted.push(Date.now());
							await sleep(gap());
						}
						if (opts.error) return (c.enqueue({ type: "error", error: opts.error }), c.close());
						c.enqueue({ type: "text-end", id: "t" });
						c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage });
						c.close();
					},
				}),
			};
		},
	};
	return qualified(model);
}

async function ask(who: EvryActor, text = "Write a short overview of the people list.") {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text, references: [] });
	return c.id;
}
type Seen = { at: number; item: Observed };
/** Follows a conversation like the stream route does, stamping each item. */
async function follow(who: EvryActor, id: string, after = 0, ms = 15_000, seen: Seen[] = []) {
	for await (const item of observeRun(db, who, id, after, AbortSignal.timeout(ms))) seen.push({ at: Date.now(), item });
	return seen;
}
const lives = (seen: Seen[]) =>
	seen.filter((s) => "live" in s.item).map((s) => ({ at: s.at, ...(s.item as any).live }));
const saved = (seen: Seen[]) =>
	seen.filter((s) => "event" in s.item).map((s) => (s.item as any).event as ConversationEvent);
const savedText = (events: ConversationEvent[]) =>
	events
		.filter((e) => e.kind === "assistant_text")
		.map((e) => e.body.text)
		.join("");
async function readAll(who: EvryActor, id: string) {
	return (await readConversation(db, who, id)).events;
}

test("INV-stream-progressive: a short answer arrives as 3+ ordered updates, each within 150 ms of the model", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	const emitted: number[] = [];
	const seen: Seen[] = [];
	const watching = follow(owner, id, 0, 15_000, seen);
	// The observer has passed its first access check once it delivered the question.
	for (let n = 0; n < 100 && !seen.length; n++) await sleep(20);
	assert.equal(await work(writer(DELTAS, emitted)), "succeeded");
	await watching;

	const pieces = lives(seen);
	assert.ok(pieces.length >= 3, `${pieces.length} live updates`);
	assert.ok(pieces.length >= DELTAS.length / 2);
	let offset = 0;
	for (const p of pieces) {
		assert.equal(p.offset, offset, "in order, no gap, no repeat");
		offset += p.text.length;
	}
	assert.equal(pieces.map((p) => p.text).join(""), TEXT);

	// Delivery latency per delta: the first update that covers the delta's end, against when the model emitted it.
	let end = 0;
	const worst = DELTAS.map((delta, n) => {
		end += delta.length;
		const covering = pieces.find((p) => p.offset + p.text.length >= end)!;
		return covering.at - emitted[n]!;
	});
	console.log("latency to observer per delta (ms):", worst.join(" "), "updates:", pieces.length);
	assert.ok(Math.max(...worst) <= 150, `slowest delta ${Math.max(...worst)} ms`);
	assert.ok(pieces[0]!.at - emitted[0]! <= 150, "first text within 150 ms of the first delta");

	// The database holds the same text.
	assert.equal(savedText(await readAll(owner, id)), TEXT);
});

test("INV-stream-durable: reconnect mid-stream, a second tab and a reload agree; no gap, no duplicate", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	const first: Seen[] = [];
	const tab: Seen[] = [];
	const a = follow(owner, id, 0, 15_000, first);
	const b = follow(owner, id, 0, 15_000, tab);
	for (let n = 0; n < 100 && (!first.length || !tab.length); n++) await sleep(20);
	const running = work(writer(DELTAS, [], { gap: () => 60 }));
	// Wait for the first saved text, then reconnect from that cursor.
	let cursor = 0;
	for (let n = 0; n < 200 && !cursor; n++) {
		cursor = saved(first).find((e) => e.kind === "assistant_text")?.sequence ?? 0;
		await sleep(20);
	}
	assert.ok(cursor > 0);
	const again = await follow(owner, id, cursor);
	await running;
	await Promise.all([a, b]);

	const before = saved(first).filter((e) => e.sequence <= cursor);
	const after = saved(again);
	const sequences = [...before, ...after].map((e) => e.sequence);
	assert.deepEqual(
		sequences,
		[...new Set(sequences)].sort((x, y) => x - y),
		"no duplicate, in order",
	);
	const everything = await readAll(owner, id);
	assert.deepEqual(
		sequences,
		everything.map((e) => e.sequence),
		"no gap",
	);
	assert.equal(savedText([...before, ...after]), TEXT);
	assert.equal(savedText(saved(tab)), TEXT, "a second observer sees the same text");
	assert.equal(savedText(everything), TEXT, "a reload after the end shows the same text");
	assert.equal(everything.filter((e) => e.kind === "status").length, 1);
	// A reconnect while the run lived got its live text from the start of the turn, addressed by offset.
	for (const p of lives(again)) assert.equal(TEXT.slice(p.offset, p.offset + p.text.length), p.text);
});

test("INV-stream-durable: a lost run's interrupted end is saved exactly once", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	const seen: Seen[] = [];
	const watching = follow(owner, id, 0, 15_000, seen);
	for (let n = 0; n < 100 && !seen.length; n++) await sleep(20);
	const running = work(writer(DELTAS, [], { gap: () => 80 }));
	for (let n = 0; n < 100 && !lives(seen).length; n++) await sleep(20);
	await admin.execute(
		sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE kind='assistant_turn' AND subject_record_id=${id}`,
	);
	assert.equal(await running, "lost");
	await watching;
	const statuses = (await readAll(owner, id)).filter((e) => e.kind === "status");
	assert.equal(statuses.length, 1);
	assert.equal((statuses[0]!.body.error as { code: string }).code, "interrupted");
	assert.equal(saved(seen).filter((e) => e.kind === "status").length, 1);
});

test("INV-stream-access: an observer whose seat ends mid-stream gets no more text within 1 s", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	const seen: Seen[] = [];
	const watching = follow(owner, id, 0, 15_000, seen);
	for (let n = 0; n < 100 && !seen.length; n++) await sleep(20);
	const running = work(
		writer(
			Array.from({ length: 40 }, (_, n) => `w${n} `),
			[],
			{ gap: () => 50 },
		),
	);
	for (let n = 0; n < 100 && lives(seen).length < 2; n++) await sleep(20);
	const endedAt = Date.now();
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${owner.accountId}`);
	try {
		await assert.rejects(watching, (e: { code?: string }) => e.code === "not_found");
		const after = lives(seen).filter((p) => p.at > endedAt + 1_000);
		assert.equal(after.length, 0, "no text more than 1 s after the seat ended");
		assert.ok(Date.now() - endedAt < 3_000);
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${owner.accountId}`);
		await cancelTurn(db, owner, id);
		await running;
	}
});

test("INV-stream-end: Stop keeps the partial text and ends the stream promptly", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	const seen: Seen[] = [];
	const watching = follow(owner, id, 0, 15_000, seen);
	for (let n = 0; n < 100 && !seen.length; n++) await sleep(20);
	const running = work(
		writer(
			Array.from({ length: 60 }, (_, n) => `w${n} `),
			[],
			{ gap: () => 50 },
		),
	);
	for (let n = 0; n < 100 && lives(seen).length < 3; n++) await sleep(20);
	const stoppedAt = Date.now();
	assert.equal((await cancelTurn(db, owner, id)).cancelled, true);
	assert.equal(await running, "lost");
	await watching;
	assert.ok(Date.now() - stoppedAt < 1_500, "the stream ended promptly");
	const events = await readAll(owner, id);
	assert.equal(events.at(-1)!.body.reason, "cancelled");
	assert.equal(events.filter((e) => e.kind === "status").length, 1);
	const text = savedText(events);
	assert.ok(text.length > 0 && text.startsWith("w0 w1 "), "the saved partial text stays");
});

test("INV-stream-end: a provider error mid-stream keeps the text, projects the error and leaks nothing", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	const error = new APICallError({
		message: "RAW-PROVIDER-DETAIL sk-secret",
		url: "https://api.provider.example/v1",
		requestBodyValues: {},
		statusCode: 500,
	});
	assert.equal(await work(writer(DELTAS.slice(0, 4), [], { error, gap: () => 30 })), "failed");
	const events = await readAll(owner, id);
	const status = events.findLast((e) => e.kind === "status")!;
	assert.equal(status.body.state, "failed");
	assert.equal((status.body.error as { code: string }).code, "model_unavailable");
	assert.equal(savedText(events), DELTAS.slice(0, 4).join(""), "the partial text stays");
	assert.ok(!JSON.stringify(events).includes("RAW-PROVIDER-DETAIL"));
	assert.equal(events.filter((e) => e.kind === "status").length, 1);
});

test("INV-stream-withheld: a source removed mid-turn withholds the turn's live text from a new observer", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	// The first call reads Casey; the second streams slowly.
	const slow = writer(
		Array.from({ length: 40 }, (_, n) => `secret${n} `),
		[],
		{ gap: () => 50 },
	);
	const streaming = slow.model.doStream.bind(slow.model);
	const model = qualified({
		...slow.model,
		async doStream(options) {
			const last = options.prompt.at(-1);
			if (options.responseFormat?.type !== "json" && last?.role !== "tool")
				return {
					stream: new ReadableStream({
						start(c) {
							c.enqueue({
								type: "tool-call",
								toolCallId: randomUUID(),
								toolName: "people_read",
								input: JSON.stringify({ operation: "people.getPerson", input: { personId: people.casey } }),
							});
							c.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage });
							c.close();
						},
					}),
				};
			return streaming(options);
		},
	});
	const running = work(model);
	try {
		let some = false;
		for (let n = 0; n < 150 && !some; n++) {
			await sleep(20);
			some = (await readAll(owner, id)).some((e) => e.kind === "assistant_text");
		}
		assert.ok(some, "the turn saved some text");
		await admin.execute(sql`UPDATE person SET state='retired',retired_at=clock_timestamp() WHERE id=${people.casey}`);
		const seen: Seen[] = [];
		const watching = follow(owner, id, 0, 2_500, seen);
		await sleep(1_200);
		const texts = saved(seen).filter((e) => e.kind === "assistant_text");
		assert.ok(texts.length > 0 && texts.every((e) => e.body.withheld === true && e.body.text === ""));
		assert.equal(lives(seen).length, 0, "no live text of a withheld turn");
		assert.ok(!JSON.stringify(seen).includes("secret"), "no withheld word reaches the observer");
		await cancelTurn(db, owner, id);
		await watching;
	} finally {
		await admin.execute(sql`UPDATE person SET state='live',retired_at=NULL WHERE id=${people.casey}`);
		await cancelTurn(db, owner, id);
		await running;
	}
});
