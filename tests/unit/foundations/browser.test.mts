import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const ui = await import("../../../packages/ui/src/foundations/index.ts");

test("INV-hydration: every browser hook renders its neutral server value, so hydration never mismatches", () => {
	function Probe() {
		return createElement(
			"output",
			null,
			JSON.stringify({
				wide: ui.useMediaQuery("(min-width: 900px)"),
				wideOnServer: ui.useMediaQuery("(min-width: 900px)", true),
				reduced: ui.useReducedMotion(),
				hidden: ui.useDocumentHidden(),
				hydrated: ui.useHydrated(),
				zone: ui.useBrowserZone(),
				now: ui.useMinuteClock(),
			}),
		);
	}
	const html = renderToStaticMarkup(createElement(Probe));
	const values = JSON.parse(html.replace(/^<output>|<\/output>$/g, "").replaceAll("&quot;", '"'));
	assert.deepEqual(values, {
		wide: false,
		wideOnServer: true,
		reduced: false,
		hidden: false,
		hydrated: false,
		zone: null,
		now: null,
	});
});

test("INV-debounce: only the last call runs, once; cancel, flush and detaching its node settle what is pending", (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());
	const ran: string[] = [];
	const debouncer = ui.createDebouncer(300);

	debouncer.run(() => ran.push("a"));
	mock.timers.tick(200);
	debouncer.run(() => ran.push("b"));
	mock.timers.tick(299);
	assert.deepEqual(ran, []);
	mock.timers.tick(1);
	assert.deepEqual(ran, ["b"]);
	mock.timers.tick(1000);
	assert.deepEqual(ran, ["b"]);

	debouncer.run(() => ran.push("c"));
	debouncer.flush();
	debouncer.flush();
	mock.timers.tick(1000);
	assert.deepEqual(ran, ["b", "c"]);

	debouncer.run(() => ran.push("d"));
	debouncer.cancel();
	const detach = debouncer.cancelOnDetach(null);
	debouncer.run(() => ran.push("e"));
	detach();
	mock.timers.tick(1000);
	assert.deepEqual(ran, ["b", "c"]);
});

type FakeNode = {
	ownerDocument: FakeDocument;
	focus: (options?: FocusOptions) => void;
	id?: string;
	top?: number;
	addEventListener?: (type: string, fn: () => void) => void;
	removeEventListener?: (type: string, fn: () => void) => void;
	getBoundingClientRect?: () => { top: number };
};
type FakeDocument = {
	activeElement: FakeNode | null;
	body: FakeNode;
	getElementById?: (id: string) => FakeNode | null;
};

function fakeDocument(): FakeDocument {
	const doc = { activeElement: null } as unknown as FakeDocument;
	doc.body = fakeNode(doc);
	doc.activeElement = doc.body;
	return doc;
}
function fakeNode(doc: FakeDocument, extra: Partial<FakeNode> = {}): FakeNode {
	const node: FakeNode = {
		ownerDocument: doc,
		focus: () => {
			doc.activeElement = node;
		},
		...extra,
	};
	return node;
}
const asElement = (node: FakeNode) => node as unknown as HTMLElement;

test("INV-focus: a focus request is served once, on the commit that brings it; a later attach never takes focus again", () => {
	const doc = fakeDocument();
	const requests = ui.createFocusRequests();
	const field = fakeNode(doc);

	requests.ref(0)(asElement(field));
	assert.equal(doc.activeElement, doc.body, "no request: nothing is focused at mount");

	const first = requests.ref(1);
	assert.equal(requests.ref(1), first, "the same request keeps one ref, so a re-render does not re-run it");
	first(asElement(field));
	assert.equal(doc.activeElement, field, "request 1 focuses its node");

	doc.activeElement = doc.body;
	first(null);
	const remounted = fakeNode(doc);
	requests.ref(1)(asElement(remounted));
	assert.equal(doc.activeElement, doc.body, "a remount under the spent request does not steal focus");

	const other = fakeNode(doc);
	requests.ref(2, () => asElement(other))(asElement(remounted));
	assert.equal(doc.activeElement, other, "request 2 focuses what the pick returns");

	const busy = fakeNode(doc);
	busy.focus();
	requests.ref(3, ui.focusIfLost)(asElement(field));
	assert.equal(doc.activeElement, busy, "focusIfLost leaves focus where the reader put it");
	doc.activeElement = doc.body;
	requests.ref(4, ui.focusIfLost)(asElement(field));
	assert.equal(doc.activeElement, field, "focusIfLost takes focus that fell to the body");

	let received: FocusOptions | undefined;
	const row = fakeNode(doc, { focus: (options?: FocusOptions) => (received = options) });
	requests.ref(5, undefined, { preventScroll: true })(asElement(row));
	assert.deepEqual(
		received,
		{ preventScroll: true },
		"focus options reach the focused node, so a pick never focuses by itself",
	);
	requests.ref(6, undefined, { focusVisible: true })(asElement(row));
	assert.deepEqual(received, { focusVisible: true }, "every focus option is passed on, none is dropped");
	const shown = requests.ref(7, undefined, { focusVisible: true });
	assert.notEqual(requests.ref(7, undefined, { focusVisible: false }), shown, "a different option is a different ref");
});

test("INV-observers: every node observer stops on detach, and a late fonts.ready no longer measures", async () => {
	const live = new Set<string>();
	const listeners = new Map<string, () => void>();
	let fontsReady!: () => void;
	const fonts = new Promise<void>((resolve) => (fontsReady = resolve));
	class Observer {
		constructor(readonly kind: string) {
			live.add(kind);
		}
		observe() {}
		disconnect() {
			live.delete(this.kind);
		}
	}
	const globals = globalThis as Record<string, unknown>;
	const saved = ["ResizeObserver", "IntersectionObserver", "window", "document"].map((k) => [k, globals[k]] as const);
	globals.ResizeObserver = class extends Observer {
		constructor() {
			super("resize");
		}
	};
	globals.IntersectionObserver = class extends Observer {
		constructor() {
			super("intersection");
		}
	};
	const target = {
		addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
		removeEventListener: (type: string, fn: () => void) => listeners.get(type) === fn && listeners.delete(type),
	};
	globals.window = target;
	globals.document = { fonts: { ready: fonts } };
	try {
		let measured = 0;
		const node = {} as Element;
		const detachSize = ui.observeSize(() => measured++, { fonts: true, viewport: true })(node)!;
		assert.equal(measured, 1, "measures on attach");
		assert.ok(live.has("resize") && listeners.has("resize"));
		detachSize();
		assert.ok(!live.has("resize") && !listeners.has("resize"), "ResizeObserver and window listener released");
		fontsReady();
		await fonts;
		assert.equal(measured, 1, "fonts.ready after detach does not measure");

		const detachLater = ui.observeSize(() => measured++, { measureOnAttach: false })(node)!;
		assert.equal(measured, 1, "measureOnAttach: false leaves the first measure to the size observer");
		detachLater();

		const detachSeen = ui.observeIntersection(() => {})(node)!;
		assert.ok(live.has("intersection"));
		detachSeen();
		assert.ok(!live.has("intersection"), "IntersectionObserver released");

		const doc = { defaultView: target, getElementById: () => ({ getBoundingClientRect: () => ({ top: 0 }) }) };
		const detachHeadings = ui.observeHeadings(["a"], () => {})({ ownerDocument: doc } as unknown as HTMLElement)!;
		assert.ok(listeners.has("scroll"));
		detachHeadings();
		assert.ok(!listeners.has("scroll"), "scroll listener released");

		const seen: number[] = [];
		Object.assign(target, { innerHeight: 700 });
		const article = { scrollHeight: 1000, getBoundingClientRect: () => ({ top: 200 }) } as unknown as HTMLElement;
		const detachProgress = ui.observeScrollProgress((fraction) => seen.push(fraction))(article)!;
		assert.deepEqual(seen, [], "the first report waits for layout (the size observer's first callback)");
		assert.ok(live.has("resize") && listeners.has("scroll") && listeners.has("resize"));
		listeners.get("scroll")!();
		assert.deepEqual(seen, [0.5], "the part above the viewport's bottom edge, as a fraction of the node");
		detachProgress();
		assert.ok(!live.has("resize") && !listeners.has("scroll") && !listeners.has("resize"), "progress released");
	} finally {
		for (const [key, value] of saved) globals[key] = value;
	}
});

test("INV-minute-clock: one shared interval while anyone listens, none after, and a stale minute is refreshed", async (t) => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	t.after(() => mock.timers.reset());
	const clock = await import("../../../packages/ui/src/foundations/minute-clock.ts");
	const ticks: string[] = [];
	const stopA = clock.subscribeMinute(() => ticks.push("a"));
	const stopB = clock.subscribeMinute(() => ticks.push("b"));
	mock.timers.tick(60_000);
	assert.deepEqual(ticks, ["a", "b"], "one tick reaches both subscribers");
	assert.equal(clock.minuteSnapshot(), 60_000);
	stopA();
	stopB();
	mock.timers.tick(180_000);
	assert.deepEqual(ticks, ["a", "b"], "no interval runs once nobody listens");

	assert.equal(clock.minuteSnapshot(), 240_000, "a read with no subscriber takes the time now");
	mock.timers.tick(300_000);
	const stop = clock.subscribeMinute(() => {});
	assert.equal(clock.minuteSnapshot(), 540_000, "subscribing refreshes a minute cached long ago");
	stop();
});
