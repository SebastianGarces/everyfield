import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement, useState } = web("react");
const { createRead, useRead } = await import("../../../apps/web/src/components/read.tsx");

test("INV-read: the read cache holds nothing on the server, so one account's seeded value never reaches the next render", async () => {
	let loads = 0;
	const unread = createRead(async (account: string) => ({ status: "ok" as const, count: ++loads, account }), {
		failed: () => ({ status: "lost" as const }),
		fresh: 60_000,
	});
	const seen: unknown[] = [];
	function Bell({ count }: { count: number }) {
		useState(() => unread.seed({ status: "ok", count, account: "account" }, "account"));
		seen.push(unread.peek("account"));
		return createElement("output", null, String(useRead(unread, "account").status));
	}
	assert.equal(renderToStaticMarkup(createElement(Bell, { count: 7 })), "<output>idle</output>");
	assert.equal(renderToStaticMarkup(createElement(Bell, { count: 2 })), "<output>idle</output>");
	assert.deepEqual(seen, [null, null]);
	unread.prefetch("account");
	await unread.get("account");
	unread.patch((value) => value, "account");
	assert.equal(unread.peek("account"), null, "a load or a patch on the server stores nothing either");
});
