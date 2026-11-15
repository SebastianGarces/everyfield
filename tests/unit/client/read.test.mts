import assert from "node:assert/strict";
import { test } from "node:test";

const { createRead } = await import("../../../apps/web/src/components/read.tsx");

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("INV-read: a reader that mounts later revalidates in the background and never blanks a reader already showing the key", async () => {
	let calls = 0;
	const read = createRead(async (id: string) => ({ status: "ok" as const, value: `${id}-${++calls}` }), {
		failed: () => ({ status: "lost" as const }),
	});
	const stop = read.subscribe(() => {}, read.key("a"));
	read.get("a");
	await settled();
	assert.deepEqual(read.peek("a")?.value, { status: "ok", value: "a-1" });

	read.get("a");
	const during = read.peek("a");
	assert.equal(during?.status, "loading");
	assert.deepEqual(
		during?.value,
		{ status: "ok", value: "a-1" },
		"the first reader keeps its data while the second loads",
	);
	await settled();
	assert.deepEqual(read.peek("a")?.value, { status: "ok", value: "a-2" });
	stop();

	read.get("a");
	assert.equal(read.peek("a")?.value, undefined, "with no reader left, a new reader starts from its fallback");
});
