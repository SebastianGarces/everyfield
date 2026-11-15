import assert from "node:assert/strict";
import { test } from "node:test";

let at = new URL("https://everyfield.test/people");
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
		return at.pathname;
	},
	get search() {
		return at.search;
	},
	get hash() {
		return at.hash;
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
		location,
		history,
		sessionStorage: {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => void stored.set(key, value),
			removeItem: (key: string) => void stored.delete(key),
		},
	}),
	document: new EventTarget(),
});

const store = await import("../../../apps/web/src/components/location.ts");

test("INV-location: every navigation Next's router starts is reported once, and one that stays on the shown address is not", () => {
	const seen: string[] = [];
	const stop = store.onNavigation((to, type) => seen.push(`${type} ${to}`));
	store.routerTransitionStarted("/people/duplicates/dismissed", "push");
	store.routerTransitionStarted("https://everyfield.test/people?view=list", "replace");
	store.routerTransitionStarted("/people?view=list#top", "push");
	store.routerTransitionStarted("https://everyfield.test/people", "traverse");
	store.writeAddress("/people?view=cards");
	store.routerTransitionStarted("/people?view=cards", "push");
	assert.deepEqual(seen, ["push /people/duplicates/dismissed", "replace /people?view=list", "traverse /people"]);
	stop();
	store.routerTransitionStarted("/tasks", "push");
	assert.equal(seen.length, 3, "a released listener hears nothing more");
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
