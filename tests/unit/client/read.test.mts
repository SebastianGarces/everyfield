import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
Object.assign(globalThis, {
	window: globalThis,
	document: { activeElement: null },
	HTMLIFrameElement: class {},
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = web("react-dom/client");
const { act, createElement } = web("react");
const { createRead, useReadWith } = await import("../../../apps/web/src/components/read.tsx");

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

test("INV-read: a read started by an event is the one the reader shows, with no second request, while it is in flight or within its fresh window", async () => {
	const { read, calls } = counted();
	read.prefetch("a");
	const stop = read.connect(() => {}, "a");
	assert.equal(calls(), 1, "the click's request is still in flight when the dialog mounts");
	await settled();
	assert.deepEqual(read.snapshot(read.key("a"))?.value, { status: "ok", value: "a-1" });
	stop();

	let kept = 0;
	const warm = createRead(async (id: string) => ({ status: "ok" as const, value: `${id}-${++kept}` }), {
		failed: () => ({ status: "lost" as const }),
		fresh: 15_000,
	});
	warm.prefetch("b");
	await settled();
	const stopWarm = warm.connect(() => {}, "b");
	assert.equal(kept, 1, "a settled prefetch inside its fresh window is served as it is");
	stopWarm();
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

test("INV-read: a prefetched or seeded entry older than its fresh window is not served as current; the first reader revalidates while it shows the old value", async (t) => {
	mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	t.after(() => mock.timers.reset());
	let calls = 0;
	const read = createRead(async (id: string) => ({ status: "ok" as const, value: `${id}-${++calls}` }), {
		failed: () => ({ status: "lost" as const }),
		fresh: 15_000,
	});
	read.prefetch("a");
	await settled();
	read.seed({ status: "ok", value: "seeded" }, "b");
	mock.timers.tick(10 * 60_000);
	const stopA = read.connect(() => {}, "a");
	const stopB = read.connect(() => {}, "b");
	assert.equal(calls, 3, "both stale entries are read again on first read");
	assert.deepEqual(
		read.snapshot(read.key("a"))?.value,
		{ status: "ok", value: "a-1" },
		"the reader keeps the old value meanwhile",
	);
	assert.equal(read.snapshot(read.key("a"))?.status, "loading");
	stopA();
	stopB();
});

test("INV-read: a subscriber that knows a newer server read reloads an older entry once by the server's own times, whatever the client clock says, and keeps a newer one", async (t) => {
	let served = 1_000;
	let calls = 0;
	const count = createRead(
		async (account: string) => ({ status: "ok" as const, value: `${account}-${++calls}`, servedAt: served }),
		{
			failed: () => ({ status: "lost" as const }),
			fresh: 60_000,
			servedAt: (v) => ("servedAt" in v ? v.servedAt : undefined),
		},
	);
	t.mock.method(Date, "now", () => 1_000 + 120_000);
	count.prefetch("a");
	await settled();
	const bell = count.connect(() => {}, "a");
	assert.equal(calls, 1);
	const key = count.key("a");
	for (let i = 0; i < 3; i++) count.snapshot(key);
	assert.equal(calls, 1, "rendering with a bound starts nothing");
	served = 2_000;
	const page = count.connectWith(() => {}, ["a"], { newerThan: 1_500 });
	const again = count.connectWith(() => {}, ["a"], { newerThan: 1_500 });
	assert.equal(
		calls,
		2,
		"one reload for the entry the server read before the page, with the client clock 2 minutes ahead",
	);
	assert.equal(
		(count.snapshot(key)?.value as { value: string }).value,
		"a-1",
		"every reader keeps its value meanwhile",
	);
	await settled();
	assert.equal((count.snapshot(key)?.value as { value: string }).value, "a-2");
	const later = count.connectWith(() => {}, ["a"], { newerThan: 1_500 });
	assert.equal(calls, 2, "an entry the server read after the page is kept");
	for (const stop of [bell, page, again, later]) stop();
});

test("INV-read: a patch made while the entry loads is applied exactly once to the value that arrives", async () => {
	let release: (value: string[]) => void = () => {};
	const list = createRead(() => new Promise<string[]>((resolve) => (release = resolve)), { failed: () => [] });
	const stop = list.connect(() => {}, "team");
	let applied = 0;
	list.patch((rows) => (applied++, [...rows, "added"]), "team");
	release(["first"]);
	await settled();
	assert.deepEqual(list.snapshot(list.key("team"))?.value, ["first", "added"]);
	assert.equal(applied, 1);
	stop();
});

test("INV-read: a patch in a transition re-renders every reader of the key through its own update instead of an immediate notification", async () => {
	const rows = createRead(async (team: string) => [team], { failed: () => [], fresh: Infinity });
	rows.prefetch("t");
	await settled();
	const heard: string[] = [];
	const asked = rows.connectWith(
		() => heard.push("asked notified"),
		["t"],
		{},
		() => heard.push("asked rerender"),
	);
	const list = rows.connectWith(
		() => heard.push("list notified"),
		["t"],
		{},
		() => heard.push("list rerender"),
	);
	const elsewhere = rows.connect(() => heard.push("plain notified"), "t");
	rows.patchInTransition((value) => [...value, "b"], "t");
	assert.deepEqual(heard.sort(), ["asked rerender", "list rerender", "plain notified"]);
	assert.deepEqual(rows.snapshot(rows.key("t"))?.value, ["t", "b"]);
	for (const stop of [asked, list, elsewhere]) stop();
});

test("INV-read: a read keeps at most its limit of entries, dropping the oldest one no reader shows", async () => {
	const pages = createRead(async (n: number) => n, { failed: () => -1, fresh: Infinity, limit: 2 });
	const shown = pages.connect(() => {}, 1);
	pages.prefetch(2);
	pages.prefetch(3);
	pages.prefetch(4);
	await settled();
	assert.notEqual(pages.peek(1), null, "a shown entry is never dropped");
	assert.equal(pages.peek(2), null);
	assert.equal(pages.peek(3), null);
	assert.notEqual(pages.peek(4), null);
	shown();
});

test("INV-read: a search that keeps the previous list shows the last answer while the next one loads, even when it starts keeping only after that answer, and shows nothing kept after the search was cleared", async () => {
	const answers = new Map<string, (rows: string[]) => void>();
	const searches = createRead((text: string) => new Promise<string[]>((resolve) => answers.set(text, resolve)), {
		failed: () => [],
	});
	let shown: string[] | undefined;
	function Search({ text, showPrevious }: { text: string; showPrevious: boolean }) {
		shown = useReadWith(text ? searches : null, [text], { showPrevious }).value;
		return null;
	}
	const root = createRoot(
		Object.assign(new EventTarget(), {
			nodeType: 1,
			nodeName: "DIV",
			tagName: "DIV",
			ownerDocument: new EventTarget(),
		}),
	);
	const type = (text: string, showPrevious = true) =>
		act(async () => root.render(createElement(Search, { text, showPrevious })));
	const answer = (text: string, rows: string[]) => act(async () => answers.get(text)?.(rows));

	await type("a", false);
	await answer("a", ["Ana Lee", "Andre Moss"]);
	await type("an");
	assert.deepEqual(shown, ["Ana Lee", "Andre Moss"], 'the answer to "a" stays while "an" loads');
	await answer("an", ["Ana Lee"]);
	assert.deepEqual(shown, ["Ana Lee"]);

	await type("");
	assert.equal(shown, undefined);
	await type("b");
	assert.equal(shown, undefined, "the first search after a clear shows nothing from before the clear");
	await answer("b", ["Ben Ruiz"]);
	assert.deepEqual(shown, ["Ben Ruiz"]);
	await act(async () => root.unmount());
});
