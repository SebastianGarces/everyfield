import assert from "node:assert/strict";
import { test } from "node:test";

const { createRead } = await import("../../../apps/web/src/components/read.tsx");

const settled = () => new Promise((resolve) => setImmediate(resolve));

function counted() {
	let calls = 0;
	const read = createRead(async (id: string) => ({ status: "ok" as const, value: `${id}-${++calls}` }), {
		failed: () => ({ status: "lost" as const }),
	});
	return { read, calls: () => calls };
}

test("INV-read: what a reader calls while rendering never starts a load; the first subscription does", async () => {
	const { read, calls } = counted();
	const key = read.key("a");
	for (let i = 0; i < 3; i++) assert.equal(read.snapshot(key), null);
	assert.equal(calls(), 0, "rendering a reader starts nothing");
	const stop = read.connect(() => {}, "a");
	assert.equal(calls(), 1);
	assert.equal(read.snapshot(key)?.status, "loading");
	await settled();
	assert.deepEqual(read.snapshot(key)?.value, { status: "ok", value: "a-1" });
	stop();
});

test("INV-read: StrictMode's subscribe, unsubscribe, subscribe sends one request for one key", async () => {
	const { read, calls } = counted();
	read.connect(() => {}, "a")();
	const stop = read.connect(() => {}, "a");
	const also = read.connect(() => {}, "a");
	assert.equal(calls(), 1);
	await settled();
	stop();
	also();
});

test("INV-read: a read started by an event is the one the reader shows, with no second request", async () => {
	const { read, calls } = counted();
	read.prefetch("a");
	await settled();
	assert.deepEqual(read.snapshot(read.key("a"))?.value, { status: "ok", value: "a-1" });
	const stop = read.connect(() => {}, "a");
	assert.equal(calls(), 1);
	stop();
});

test("INV-read: a reader that mounts later revalidates in the background and never blanks a reader already showing the key", async () => {
	const { read } = counted();
	const key = read.key("a");
	const first = read.connect(() => {}, "a");
	await settled();
	const second = read.connect(() => {}, "a");
	const during = read.snapshot(key);
	assert.equal(during?.status, "loading");
	assert.deepEqual(
		during?.value,
		{ status: "ok", value: "a-1" },
		"the first reader keeps its data while the second loads",
	);
	await settled();
	assert.deepEqual(read.snapshot(key)?.value, { status: "ok", value: "a-2" });
	first();
	second();
	assert.equal(read.snapshot(key), null, "with no reader left and fresh 0, a new reader starts from its fallback");
});
