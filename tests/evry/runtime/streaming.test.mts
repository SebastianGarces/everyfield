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
import type { ObserveOptions } from "../../../packages/evry/src/runtime/observe.ts";
import { liveRoom } from "../../../packages/evry/src/runtime/live.ts";
import { actor, admin, db, gatedWriter, people, setup, sql, teardown, usage, work } from "./support.mts";

before(setup);
after(teardown);

const qualified = (model: LanguageModelV4) => ({ status: "qualified" as const, id: "test", model });
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
const words = (n: number, word = "w") => Array.from({ length: n }, (_, i) => `${word}${i} `);

async function ask(who: EvryActor, text = "Write a short overview of the people list.") {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text, references: [] });
	return c.id;
}
type Seen = { at: number; item: Observed };
type WatchOptions = { after?: number; ms?: number } & Pick<ObserveOptions, "pause" | "now">;
function watch(who: EvryActor, id: string, { after = 0, ms = 15_000, ...options }: WatchOptions = {}) {
	const seen: Seen[] = [];
	const stopped = new AbortController();
	let changed = Promise.withResolvers<void>();
	let ended = false;
	const done = (async () => {
		try {
			const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(ms)]);
			for await (const item of observeRun(db, who, id, after, signal, options)) {
				seen.push({ at: Date.now(), item });
				changed.resolve();
				changed = Promise.withResolvers();
			}
		} finally {
			ended = true;
			changed.resolve();
		}
	})();
	done.catch(() => {});
	const until = async (ok: (seen: Seen[]) => boolean, what: string) => {
		while (!ok(seen)) {
			assert.ok(!ended, "the stream ended before " + what);
			await changed.promise;
		}
	};
	return { seen, done, until, stop: () => stopped.abort() };
}
function heldPolls() {
	const held = new Set<() => void>();
	let pausedAgain = Promise.withResolvers<void>();
	const polls = {
		count: 0,
		pause: (_ms: number, signal: AbortSignal) =>
			new Promise<void>((resolve) => {
				polls.count++;
				held.add(resolve);
				signal.addEventListener("abort", () => resolve(), { once: true });
				pausedAgain.resolve();
				pausedAgain = Promise.withResolvers();
			}),
		async once(stream: Promise<unknown>) {
			const next = pausedAgain.promise;
			for (const resolve of [...held]) resolve();
			held.clear();
			await Promise.race([next, stream.catch(() => {})]);
		},
	};
	return polls;
}
async function roomHas(id: string, text: string) {
	const room = liveRoom(id);
	while (!room.text.includes(text)) await room.next(AbortSignal.timeout(5_000));
}
const lives = (seen: Seen[]) => seen.flatMap((s) => ("live" in s.item ? [{ at: s.at, ...s.item.live }] : []));
const liveText = (seen: Seen[]) =>
	lives(seen)
		.map((p) => p.text)
		.join("");
const saved = (seen: Seen[]) => seen.flatMap((s) => ("event" in s.item ? [s.item.event] : []));
const savedText = (events: ConversationEvent[]) =>
	events
		.filter((e) => e.kind === "assistant_text")
		.map((e) => e.body.text)
		.join("");
async function readAll(who: EvryActor, id: string) {
	return (await readConversation(db, who, id)).events;
}

test("INV-stream-paint INV-stream-progressive: a short answer arrives as 3+ ordered updates, each within 150 ms of the model", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	const emitted: number[] = [];
	const watching = watch(owner, id);
	await watching.until((seen) => seen.length > 0, "the first page");
	const writer = gatedWriter(DELTAS, { emitted });
	const running = work(writer.model);
	let end = 0;
	for (const delta of DELTAS) {
		end += delta.length;
		writer.release();
		await watching.until((seen) => liveText(seen).length >= end, "the live text of " + JSON.stringify(delta));
	}
	assert.equal(await running, "succeeded");
	await watching.done;

	const pieces = lives(watching.seen);
	assert.ok(pieces.length >= 3, `${pieces.length} live updates`);
	assert.ok(pieces.length >= DELTAS.length / 2);
	let offset = 0;
	for (const p of pieces) {
		assert.equal(p.offset, offset, "in order, no gap, no repeat");
		offset += p.text.length;
	}
	assert.equal(pieces.map((p) => p.text).join(""), TEXT);

	end = 0;
	const worst = DELTAS.map((delta, n) => {
		end += delta.length;
		const covering = pieces.find((p) => p.offset + p.text.length >= end)!;
		return covering.at - emitted[n]!;
	});
	console.log("latency to observer per delta (ms):", worst.join(" "), "updates:", pieces.length);
	assert.ok(Math.max(...worst) <= 150, `slowest delta ${Math.max(...worst)} ms`);
	assert.ok(pieces[0]!.at - emitted[0]! <= 150, "first text within 150 ms of the first delta");

	assert.equal(savedText(await readAll(owner, id)), TEXT);
});

test("INV-stream-durable: reconnect mid-stream, a second tab and a reload agree; no gap, no duplicate", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	const first = watch(owner, id);
	const tab = watch(owner, id);
	await first.until((seen) => seen.length > 0, "the first page");
	await tab.until((seen) => seen.length > 0, "the first page");
	const writer = gatedWriter(DELTAS);
	const running = work(writer.model);
	writer.release();
	const firstSaved = (seen: Seen[]) => saved(seen).find((e) => e.kind === "assistant_text")?.sequence ?? 0;
	await first.until((seen) => firstSaved(seen) > 0, "the first saved text");
	const cursor = firstSaved(first.seen);
	const again = watch(owner, id, { after: cursor });
	writer.release(Infinity);
	assert.equal(await running, "succeeded");
	await Promise.all([first.done, tab.done, again.done]);

	const before = saved(first.seen).filter((e) => e.sequence <= cursor);
	const after = saved(again.seen);
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
	assert.equal(savedText(saved(tab.seen)), TEXT, "a second observer sees the same text");
	assert.equal(savedText(everything), TEXT, "a reload after the end shows the same text");
	assert.equal(everything.filter((e) => e.kind === "status").length, 1);
	for (const p of lives(again.seen)) assert.equal(TEXT.slice(p.offset, p.offset + p.text.length), p.text);
});

test("INV-statements: the stream route's access check is its first page, so an idle conversation streams with no second read", async () => {
	const owner = await actor("owner");
	const c = await createConversation(db, owner, { requestKey: randomUUID() });
	const first = await readConversation(db, owner, c.id);
	let statements = 0;
	const counted = {
		execute: (...args: unknown[]) => (statements++, (db.execute as (...args: unknown[]) => unknown)(...args)),
	} as typeof db;
	const seen: Observed[] = [];
	for await (const item of observeRun(counted, owner, c.id, 0, AbortSignal.timeout(5_000), { first })) seen.push(item);
	assert.deepEqual(
		seen,
		first.events.map((event) => ({ event })),
	);
	assert.equal(statements, 0);
});

test("INV-stream-durable: a lost run's interrupted end is saved exactly once", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	const watching = watch(owner, id);
	await watching.until((seen) => seen.length > 0, "the first page");
	const writer = gatedWriter(DELTAS);
	const running = work(writer.model);
	writer.release();
	await watching.until((seen) => lives(seen).length > 0, "the first live text");
	await admin.execute(
		sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE kind='assistant_turn' AND subject_record_id=${id}`,
	);
	writer.release(Infinity);
	assert.equal(await running, "lost");
	await watching.done;
	const statuses = (await readAll(owner, id)).filter((e) => e.kind === "status");
	assert.equal(statuses.length, 1);
	assert.equal((statuses[0]!.body.error as { code: string }).code, "interrupted");
	assert.equal(saved(watching.seen).filter((e) => e.kind === "status").length, 1);
});

test("INV-stream-access: an observer whose seat ends mid-stream gets no more text within 1 s", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	let clock = 1_000_000;
	const polls = heldPolls();
	const watching = watch(owner, id, { pause: polls.pause, now: () => clock });
	await watching.until((seen) => seen.length > 0, "the first page");
	const writer = gatedWriter(words(40));
	const running = work(writer.model);
	writer.release(2);
	await watching.until((seen) => liveText(seen) === "w0 w1 ", "two live words");
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${owner.accountId}`);
	try {
		writer.release();
		await watching.until((seen) => liveText(seen) === "w0 w1 w2 ", "a word within the checked second");
		clock += 1_001;
		writer.release(3);
		await roomHas(id, "w5 ");
		await polls.once(watching.done);
		await assert.rejects(watching.done, (e: { code?: string }) => e.code === "not_found");
		assert.equal(liveText(watching.seen), "w0 w1 w2 ", "no text once the last access check is over 1 s old");
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${owner.accountId}`);
		await cancelTurn(db, owner, id);
		writer.release(Infinity);
		await running;
	}
});

test("INV-stream-stop INV-stream-end: Stop keeps the partial text and ends the stream promptly", async () => {
	const owner = await actor("owner");
	const id = await ask(owner);
	const polls = heldPolls();
	const watching = watch(owner, id, { pause: polls.pause });
	await watching.until((seen) => seen.length > 0, "the first page");
	const writer = gatedWriter(words(60));
	const running = work(writer.model);
	writer.release(2);
	for (let n = 0; n < 100 && !savedText(saved(watching.seen)).startsWith("w0 w1 "); n++)
		await polls.once(watching.done);
	assert.ok(savedText(saved(watching.seen)).startsWith("w0 w1 "), "the partial text was saved before Stop");
	assert.equal((await cancelTurn(db, owner, id)).cancelled, true);
	writer.release(Infinity);
	assert.equal(await running, "lost");
	const pausedBeforeStop = polls.count;
	await polls.once(watching.done);
	await watching.done;
	assert.equal(polls.count, pausedBeforeStop, "the stream ended at the first poll after Stop");
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
	const writer = gatedWriter(DELTAS.slice(0, 4), { error });
	writer.release(Infinity);
	assert.equal(await work(writer.model), "failed");
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
	const slow = gatedWriter(words(40, "secret"));
	const streaming = slow.model.model.doStream.bind(slow.model.model);
	const model = qualified({
		...slow.model.model,
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
		const earlier = watch(owner, id);
		slow.release();
		await earlier.until((seen) => saved(seen).some((e) => e.kind === "assistant_text"), "the first saved text");
		earlier.stop();
		await earlier.done;
		await admin.execute(sql`UPDATE person SET state='retired',retired_at=clock_timestamp() WHERE id=${people.casey}`);
		const watching = watch(owner, id);
		await watching.until((seen) => saved(seen).some((e) => e.kind === "assistant_text"), "the withheld text");
		slow.release(5);
		await roomHas(id, "secret5 ");
		await cancelTurn(db, owner, id);
		slow.release(Infinity);
		await watching.done;
		const texts = saved(watching.seen).filter((e) => e.kind === "assistant_text");
		assert.ok(texts.length > 0 && texts.every((e) => e.body.withheld === true && e.body.text === ""));
		assert.equal(lives(watching.seen).length, 0, "no live text of a withheld turn");
		assert.ok(!JSON.stringify(watching.seen).includes("secret"), "no withheld word reaches the observer");
	} finally {
		await admin.execute(sql`UPDATE person SET state='live',retired_at=NULL WHERE id=${people.casey}`);
		await cancelTurn(db, owner, id);
		slow.release(Infinity);
		await running;
	}
});
