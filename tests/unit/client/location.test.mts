import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));

let at = new URL("https://everyfield.test/people");
let addressReads = 0;
const stored = new Map<string, string>();
const history = {
	state: null as unknown,
	length: 1,
	pushState(state: unknown, _unused: string, href: string) {
		at = new URL(href, at);
		this.state = state;
		this.length += 1;
	},
	replaceState(state: unknown, _unused: string, href: string) {
		at = new URL(href, at);
		this.state = state;
	},
};
const location = {
	get pathname() {
		addressReads += 1;
		return at.pathname;
	},
	get search() {
		return at.search;
	},
	get hash() {
		return at.hash;
	},
	set hash(value: string) {
		history.pushState(null, "", new URL(`#${value.replace(/^#/, "")}`, at).href);
	},
	get origin() {
		return at.origin;
	},
	get href() {
		return at.href;
	},
};
Object.assign(globalThis, {
	window: Object.assign(new EventTarget(), {
		HTMLIFrameElement: class {},
		location,
		history,
		sessionStorage: {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => void stored.set(key, value),
			removeItem: (key: string) => void stored.delete(key),
		},
	}),
	document: Object.assign(new EventTarget(), { activeElement: null }),
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = web("react-dom/client");
const { renderToStaticMarkup } = web("react-dom/server");
const { act, createElement } = web("react");

const store = await import("../../../apps/web/src/components/location.ts");
const readsWhileLoading = addressReads;

test("INV-location: loading the store reads nothing from the address, so it may load before or after the one-time link script", () => {
	assert.equal(readsWhileLoading, 0);
});

test("INV-location: every navigation Next's router starts is reported once, Back and Forward always, and a push or replace to the address it starts from is not", () => {
	const seen: string[] = [];
	const stop = store.onNavigation((to, type) => seen.push(`${type} ${to}`));
	const navigate = (href: string, type: "push" | "replace") => {
		store.routerTransitionStarted(href, type);
		if (type === "push") history.pushState(null, "", href);
		else history.replaceState(null, "", href);
	};
	navigate("/people/duplicates/dismissed", "push");
	navigate("https://everyfield.test/people?view=list", "replace");
	navigate("/people?view=list#top", "push");
	history.replaceState(null, "", "/people/duplicates/dismissed");
	navigate("/people?view=list", "push");
	at = new URL("https://everyfield.test/people?view=list");
	window.dispatchEvent(new Event("popstate"));
	store.routerTransitionStarted("https://everyfield.test/people?view=list", "traverse");
	store.writeAddress("/people?view=cards");
	navigate("/people?view=cards", "push");
	assert.deepEqual(seen, [
		"push /people/duplicates/dismissed",
		"replace /people?view=list",
		"push /people?view=list",
		"traverse /people?view=list",
	]);
	stop();
	store.routerTransitionStarted("/tasks", "push");
	assert.equal(seen.length, 4, "a released listener hears nothing more");
});

test("INV-link: a one-time link value brought in by a same-document navigation leaves the address and is handed to its page until it is forgotten", () => {
	at = new URL("https://everyfield.test/invitation?from=mail#proof=second");
	const before = history.length;
	window.dispatchEvent(new Event("popstate"));
	assert.equal(at.pathname + at.search + at.hash, "/invitation?from=mail");
	assert.equal(history.length, before);
	assert.equal(stored.get("ef-invitation-proof"), "second");
	store.forgetOneTimeLinkValue("invitation");
	assert.equal(stored.has("ef-invitation-proof"), false);
});

test("INV-location: the address hash reader shows the fragment after an in-page link, a store write, Back and Forward, and nothing on the server", async () => {
	let shown: string | undefined;
	function Reader() {
		shown = store.useAddressHash();
		return null;
	}
	assert.equal(renderToStaticMarkup(createElement(Reader)), "");
	assert.equal(shown, "", "the server renders no fragment");

	at = new URL("https://everyfield.test/oversight");
	const root = createRoot(
		Object.assign(new EventTarget(), { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: document }),
	);
	await act(async () => root.render(createElement(Reader)));
	assert.equal(shown, "");

	history.pushState(null, "", "/oversight#pricing");
	await act(async () => void window.dispatchEvent(new Event("hashchange")));
	assert.equal(shown, "#pricing", "an in-page link's fragment");

	const before = history.length;
	await act(async () => store.writeHash("#faq-seats"));
	assert.equal(shown, "#faq-seats", "a store write shows in the same event");
	assert.equal(history.length, before + 1, "a hash write adds one entry, as a fragment link does");

	at = new URL("https://everyfield.test/oversight#pricing");
	await act(async () => void window.dispatchEvent(new Event("popstate")));
	assert.equal(shown, "#pricing", "Back");
	at = new URL("https://everyfield.test/oversight#faq-seats");
	await act(async () => void window.dispatchEvent(new Event("popstate")));
	assert.equal(shown, "#faq-seats", "Forward");
	await act(async () => root.unmount());
});
