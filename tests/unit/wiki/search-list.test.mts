import "../runs-in/render-development.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));

type Listener = { fn: EventListenerOrEventListenerObject; capture: boolean };

class FakeNode {
	childNodes: FakeNode[] = [];
	parentNode: FakeNode | null = null;
	attributes = new Map<string, string>();
	style = { setProperty() {}, removeProperty() {} };
	nodeValue: string | null = null;
	listeners = new Map<string, Listener[]>();
	constructor(
		public nodeName: string,
		public nodeType = 1,
	) {}
	get tagName() {
		return this.nodeName;
	}
	get ownerDocument() {
		return fakeDocument;
	}
	get parentElement(): FakeNode | null {
		return this.parentNode;
	}
	get options(): FakeNode[] {
		return this.all().filter((n) => n.nodeName === "OPTION");
	}
	get firstChild(): FakeNode | null {
		return this.childNodes[0] ?? null;
	}
	get textContent(): string {
		return this.nodeType === 3 ? (this.nodeValue ?? "") : this.childNodes.map((c) => c.textContent).join("");
	}
	set textContent(text: string) {
		this.childNodes = [Object.assign(new FakeNode("#text", 3), { nodeValue: text, parentNode: this })];
	}
	appendChild(child: FakeNode) {
		child.parentNode?.removeChild(child);
		child.parentNode = this;
		this.childNodes.push(child);
		return child;
	}
	insertBefore(child: FakeNode, before: FakeNode | null) {
		if (!before) return this.appendChild(child);
		child.parentNode?.removeChild(child);
		child.parentNode = this;
		this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
		return child;
	}
	removeChild(child: FakeNode) {
		this.childNodes = this.childNodes.filter((c) => c !== child);
		child.parentNode = null;
		return child;
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, String(value));
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	hasAttribute(name: string) {
		return this.attributes.has(name);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	closest() {
		return null;
	}
	contains(node: FakeNode | null): boolean {
		return node === this || this.childNodes.some((c) => c.contains(node));
	}
	focus() {
		fakeDocument.activeElement = this;
	}
	blur() {}
	scrollIntoView() {}
	all(): FakeNode[] {
		return this.childNodes.flatMap((c) => [c, ...c.all()]);
	}
	querySelectorAll(selector: string) {
		return this.all().filter((n) => n.nodeType === 1 && matches(n, selector));
	}
	querySelector(selector: string) {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	addEventListener(type: string, fn: EventListenerOrEventListenerObject, options?: boolean | { capture?: boolean }) {
		const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), { fn, capture }]);
	}
	removeEventListener(type: string, fn: EventListenerOrEventListenerObject, options?: boolean | { capture?: boolean }) {
		const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter((l) => l.fn !== fn || l.capture !== capture),
		);
	}
	dispatchEvent(event: Event) {
		const path: FakeNode[] = [this];
		while (path.at(-1)?.parentNode) path.push(path.at(-1)?.parentNode as FakeNode);
		let stopped = false;
		const stop = event.stopPropagation.bind(event);
		Object.defineProperty(event, "stopPropagation", { value: () => ((stopped = true), stop()) });
		Object.defineProperty(event, "target", { value: this, configurable: true });
		const run = (node: FakeNode, capture: boolean) => {
			Object.defineProperty(event, "currentTarget", { value: node, configurable: true });
			for (const l of node.listeners.get(event.type) ?? []) {
				if (l.capture !== capture) continue;
				if (typeof l.fn === "function") l.fn.call(node, event);
				else l.fn.handleEvent(event);
			}
		};
		for (const node of [...path].reverse()) if (!stopped) run(node, true);
		for (const node of event.bubbles ? path : [this]) if (!stopped) run(node, false);
		return !event.defaultPrevented;
	}
}

function matches(node: FakeNode, selector: string): boolean {
	const negated = [...selector.matchAll(/:not\((\[[^\]]+\])\)/g)].map((m) => m[1] ?? "");
	const plain = selector.replace(/:not\((\[[^\]]+\])\)/g, "");
	const test = (part: string) => {
		const [, name = "", value] = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) ?? [];
		return value === undefined ? node.hasAttribute(name) : node.getAttribute(name) === value;
	};
	const parts = plain.match(/\[[^\]]+\]/g) ?? [];
	return parts.every(test) && !negated.some(test);
}

const body = new FakeNode("BODY");
const fakeDocument = {
	nodeType: 9,
	oninput: null,
	body,
	head: new FakeNode("HEAD"),
	activeElement: body as FakeNode,
	createElement: (tag: string) => new FakeNode(tag.toUpperCase()),
	createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
	createTextNode: (text: string) => Object.assign(new FakeNode("#text", 3), { nodeValue: text }),
	getElementById: (id: string) => body.all().find((n) => n.getAttribute("id") === id) ?? null,
	querySelector: () => null,
	addEventListener() {},
	removeEventListener() {},
};

Object.assign(globalThis, {
	window: globalThis,
	self: globalThis,
	document: fakeDocument,
	DocumentFragment: class extends FakeNode {
		constructor() {
			super("#document-fragment", 11);
		}
	},
	HTMLSelectElement: class {
		set value(_value: string) {}
	},
	HTMLIFrameElement: class {},
	HTMLFormElement: class {},
	ResizeObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: () => 0,
	cancelAnimationFrame() {},
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = web("react-dom/client");
const { act, createElement, createRef } = web("react");
const { AppRouterContext } = web("next/dist/shared/lib/app-router-context.shared-runtime");
const { SearchParamsContext } = web("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { WikiSearch } = await import("../../../apps/web/src/features/wiki/overlays.tsx");

const hit = (n: number, title: string, slug: string, excerpt: string | null) => ({
	articleId: `00000000-0000-4000-8000-00000000000${n}`,
	title,
	slug,
	excerpt,
	observedFraction: "0",
	completed: false,
});

const FIRST_PAGE = [
	hit(1, "Grace and truth", "guides/grace & truth", "Lead with [[grace]] in every visit."),
	hit(2, "Prayer list", "care/prayer-list", null),
	hit(3, "Hosting a meal", "care/meals", "Plan the meal for [[grace]] night."),
];
const SECOND_PAGE = [hit(4, "Welcome table", "launch/welcome", null), hit(5, "Baptism", "phases/baptism", null)];

const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));

async function mountSearch() {
	const asked: { query: string; page: number }[] = [];
	const fetched = mock.method(globalThis, "fetch", async (url: string) => {
		const input = JSON.parse(new URL(String(url), "http://wiki.test").searchParams.get("in") ?? "{}");
		asked.push({ query: input.query, page: input.page });
		const value =
			input.page === 1
				? { status: "results", hits: FIRST_PAGE, nextPage: "2" }
				: { status: "results", hits: SECOND_PAGE, nextPage: null };
		return new Response(JSON.stringify(value), { status: 200 });
	});
	const pushed: string[] = [];
	const router = {
		push: (href: string) => pushed.push(href),
		replace() {},
		refresh() {},
		prefetch() {},
		back() {},
		forward() {},
	};
	let opened = 0;
	const field = createRef();
	const container = new FakeNode("DIV");
	body.appendChild(container);
	const root = createRoot(container);
	await act(async () =>
		root.render(
			createElement(
				AppRouterContext.Provider,
				{ value: router },
				createElement(
					SearchParamsContext.Provider,
					{ value: new URLSearchParams() },
					createElement(WikiSearch, { field, onOpened: () => (opened += 1) }),
				),
			),
		),
	);
	const input = field.current as FakeNode & { value: string };
	input.focus();
	const fire = async (node: FakeNode, type: string, extra: Record<string, unknown> = {}) => {
		await act(async () => {
			node.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), extra));
		});
		await settle();
	};
	const options = () => container.querySelectorAll('[role="option"]');
	return {
		asked,
		pushed,
		opened: () => opened,
		input,
		type: async (text: string) => {
			input.value = text;
			await fire(input, "input");
		},
		press: (key: string) => fire(input, "keydown", { key }),
		click: (node: FakeNode) => fire(node, "click", { button: 0 }),
		titles: () => options().map((n) => n.childNodes[0]?.textContent ?? ""),
		highlighted: () => options().findIndex((n) => n.getAttribute("aria-selected") === "true"),
		announced: () => input.getAttribute("aria-activedescendant"),
		optionIds: () => options().map((n) => n.getAttribute("id")),
		focused: () => fakeDocument.activeElement === input,
		nextPage: () => container.all().find((n) => n.nodeName === "BUTTON" && n.textContent.includes("Next page")),
		close: async () => {
			await act(async () => root.unmount());
			body.removeChild(container);
			fetched.mock.restore();
		},
	};
}

test("Enter searches at once, every server hit is listed in order, and Down then Enter opens the first hit", async () => {
	const search = await mountSearch();
	try {
		await search.type("grace");
		await search.press("Enter");
		assert.deepEqual(search.asked, [{ query: "grace", page: 1 }], "Enter runs the search without the typing pause");
		assert.deepEqual(search.titles(), ["Grace and truth", "Prayer list", "Hosting a meal"]);
		assert.equal(search.highlighted(), -1, "nothing is highlighted before an arrow key");
		assert.equal(search.input.getAttribute("role"), "combobox");
		assert.equal(search.input.getAttribute("aria-activedescendant"), null);

		await search.press("ArrowDown");
		assert.equal(search.highlighted(), 0);
		assert.equal(search.announced(), search.optionIds()[0], "the field announces the highlighted hit");
		assert.ok(search.focused(), "focus stays in the field");

		await search.press("Enter");
		assert.deepEqual(search.pushed, ["/wiki/guides/grace%20%26%20truth"]);
		assert.equal(search.opened(), 1, "opening a hit closes the search");
	} finally {
		await search.close();
	}
});

test("Up and Down keep the highlight at either end, and Next page swaps in the second page's hits", async () => {
	const search = await mountSearch();
	try {
		await search.type("grace");
		await search.press("Enter");
		for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown"]) await search.press(key);
		assert.equal(search.highlighted(), 2, "Down past the last hit keeps the last hit");
		for (const key of ["ArrowUp", "ArrowUp", "ArrowUp"]) await search.press(key);
		assert.equal(search.highlighted(), 0, "Up past the first hit keeps the first hit");

		const next = search.nextPage();
		assert.ok(next, "the server has more hits, so Next page shows");
		await search.click(next);
		assert.deepEqual(search.asked.at(-1), { query: "grace", page: 2 });
		assert.deepEqual(search.titles(), ["Welcome table", "Baptism"]);
		assert.ok(!search.nextPage(), "the last page has no Next page");
		assert.equal(search.highlighted(), -1);
		assert.ok(search.focused(), "Next page returns focus to the field");

		await search.press("ArrowDown");
		await search.press("ArrowDown");
		await search.press("Enter");
		assert.deepEqual(search.pushed, ["/wiki/phases/baptism"]);
	} finally {
		await search.close();
	}
});

test("Enter with hits but no highlight searches again and opens nothing", async () => {
	const search = await mountSearch();
	try {
		await search.type("grace");
		await search.press("Enter");
		await search.press("Enter");
		assert.equal(search.asked.length, 2);
		assert.deepEqual(search.pushed, []);
		assert.equal(search.opened(), 0);
	} finally {
		await search.close();
	}
});
