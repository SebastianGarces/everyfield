import assert from "node:assert/strict";
import { test } from "node:test";

class FakeElement {
	constructor(readonly attributes: Record<string, string> = {}) {}
	closest(selector: string) {
		return selector === "a[href]" && this instanceof FakeAnchor && "href" in this.attributes ? this : null;
	}
	hasAttribute(name: string) {
		return name in this.attributes;
	}
}
class FakeAnchor extends FakeElement {
	get target() {
		return this.attributes.target ?? "";
	}
	get origin() {
		return new URL(this.attributes.href ?? "", "https://everyfield.test").origin;
	}
}

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
	Element: FakeElement,
	HTMLAnchorElement: FakeAnchor,
});

const store = await import("../../../apps/web/src/components/location.ts");

function click(
	target: FakeElement,
	keys: Partial<Record<"button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey", unknown>> = {},
) {
	const event = Object.assign(
		new Event("click"),
		{ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
		keys,
	);
	Object.defineProperty(event, "target", { value: target });
	document.dispatchEvent(event);
}

test("INV-location: a navigation is reported for an in-app link, Back or Forward and the app's own write, and not for a click that opens elsewhere", () => {
	const seen: string[] = [];
	const stop = store.onNavigation(() => seen.push(at.pathname + at.search));
	click(new FakeAnchor({ href: "/people/duplicates/dismissed" }));
	click(new FakeAnchor({ href: "/people", target: "_blank" }));
	click(new FakeAnchor({ href: "/people" }), { metaKey: true });
	click(new FakeAnchor({ href: "/people" }), { button: 1 });
	click(new FakeAnchor({ href: "/report.pdf", download: "" }));
	click(new FakeAnchor({ href: "https://elsewhere.test/" }));
	click(new FakeElement());
	assert.deepEqual(seen, ["/people"], "only the plain in-app link counts, reported before the router moves");
	store.writeAddress("/people?view=list");
	window.dispatchEvent(new Event("popstate"));
	assert.deepEqual(seen, ["/people", "/people?view=list", "/people?view=list"]);
	stop();
	click(new FakeAnchor({ href: "/tasks" }));
	assert.equal(seen.length, 3, "a released listener hears nothing more");
});

test("INV-link: a one-time link value brought in by a same-document navigation leaves the address and is read from the tab until it is forgotten", () => {
	at = new URL("https://everyfield.test/invitation?from=mail#proof=second");
	const before = history.length;
	window.dispatchEvent(new Event("popstate"));
	assert.equal(at.pathname + at.search + at.hash, "/invitation?from=mail");
	assert.equal(history.length, before);
	assert.equal(stored.get("ef-invitation-proof"), "second");
	store.forgetOneTimeLinkValue("invitation");
	assert.equal(stored.has("ef-invitation-proof"), false);
});
