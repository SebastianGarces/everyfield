import assert from "node:assert/strict";
import { test } from "node:test";

const matchesOne = (element: FakeElement, selector: string) => {
	if (selector === ":disabled") return "disabled" in element.attributes;
	if (selector === "a[href]") return element instanceof FakeAnchor && "href" in element.attributes;
	if (/^[a-z]+$/.test(selector)) return element.tag === selector;
	const wanted = [...selector.matchAll(/\[([\w-]+)(?:=([\w-]+))?\]/g)];
	return (
		wanted.length > 0 &&
		wanted.every(
			([, name, value]) =>
				element.attributes[name!] === (value ?? element.attributes[name!]) && name! in element.attributes,
		)
	);
};

class FakeElement {
	isConnected = true;
	clicks = 0;
	submits = 0;
	constructor(
		readonly tag: string,
		readonly attributes: Record<string, string> = {},
	) {}
	matches(selector: string) {
		return selector.split(",").some((part) => matchesOne(this, part.trim()));
	}
	closest(selector: string) {
		return this.matches(selector) ? this : null;
	}
	hasAttribute(name: string) {
		return name in this.attributes;
	}
	getAttribute(name: string) {
		return this.attributes[name] ?? null;
	}
	click() {
		this.clicks += 1;
	}
}
class FakeAnchor extends FakeElement {
	get href() {
		return new URL(this.attributes.href ?? "", "https://everyfield.test").href;
	}
	get target() {
		return this.attributes.target ?? "";
	}
	get origin() {
		return new URL(this.href).origin;
	}
	click() {
		super.click();
		click(this);
	}
}
class FakeForm extends FakeElement {
	requestSubmit() {
		this.submits += 1;
	}
}

let page: FakeElement[] = [];
const at = new URL("https://everyfield.test/documents/written/1");
const sent: { url: string; init: RequestInit }[] = [];
const document = Object.assign(new EventTarget(), {
	querySelector: (selector: string) => page.find((e) => e.matches(selector)) ?? null,
	querySelectorAll: (selector: string) => page.filter((e) => e.matches(selector)),
});
Object.assign(globalThis, {
	window: Object.assign(new EventTarget(), {
		location: {
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
		},
		history: { state: null, pushState() {}, replaceState() {}, back() {} },
	}),
	document,
	Element: FakeElement,
	HTMLElement: FakeElement,
	HTMLAnchorElement: FakeAnchor,
	HTMLFormElement: FakeForm,
	fetch: async (url: string, init: RequestInit) => (sent.push({ url, init }), new Response()),
});

const leave = await import("../../../apps/web/src/components/save/leave.ts");

function dispatch(type: string, target: FakeElement | null, props: Record<string, unknown>) {
	const event = Object.assign(new Event(type, { cancelable: true }), props);
	Object.defineProperty(event, "target", { value: target });
	window.dispatchEvent(event);
	return event;
}
const press = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
	dispatch("keydown", null, { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
function click(target: FakeElement) {
	return dispatch("click", target, { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false });
}

test("INV-shortcut: a punctuation shortcut matches whether or not the layout needs Shift for it, a Shift combo needs Shift, and a claimed disabled control still stops the browser's own action", () => {
	const search = new FakeElement("button", leave.shortcutMark("/"));
	const help = new FakeElement("button", leave.shortcutMark("Shift+?"));
	const evry = new FakeElement("button", { ...leave.shortcutMark("Meta+J Control+J", { claim: true }), disabled: "" });
	const save = new FakeElement("button", { ...leave.shortcutMark("Meta+S"), disabled: "" });
	page = [search, help, evry, save];
	assert.equal(press("/").defaultPrevented, true);
	assert.equal(press("/", { shiftKey: true }).defaultPrevented, true);
	assert.equal(search.clicks, 2);
	assert.equal(press("?").defaultPrevented, false);
	assert.equal(press("?", { shiftKey: true }).defaultPrevented, true);
	assert.equal(help.clicks, 1);
	assert.equal(press("j", { metaKey: true }).defaultPrevented, true, "the claimed key never reaches the browser");
	assert.equal(evry.clicks, 0, "a disabled control is not clicked");
	assert.equal(
		press("s", { metaKey: true }).defaultPrevented,
		false,
		"an unclaimed disabled control passes the key on",
	);
	assert.equal(press("j", { metaKey: true, shiftKey: true }).defaultPrevented, false);
});

test("INV-leave: an in-app link or a sign-out from a page holding unsaved work waits for the person's answer, and Leave goes on", () => {
	const editor = new FakeForm("form", leave.leaveHoldMark(true));
	const link = new FakeAnchor("a", { href: "/documents" });
	page = [editor, link];
	assert.equal(click(link).defaultPrevented, true);
	let followed = 0;
	window.addEventListener("click", (event) => void (event.defaultPrevented || followed++));
	const request = leave.leaveRequestNow();
	assert.ok(request, "the page is asked");
	request.leave();
	assert.equal(link.clicks, 1, "Leave follows the same link");
	assert.equal(followed, 1, "and that click is not held again");
	assert.equal(leave.leaveRequestNow(), null);

	let signedOut = 0;
	leave.leavePage(() => signedOut++);
	assert.equal(signedOut, 0);
	leave.leaveRequestNow()?.stay();
	assert.equal(signedOut, 0, "Stay keeps the page");
	leave.leavePage(() => signedOut++);
	leave.leaveRequestNow()?.leave();
	assert.equal(signedOut, 1);
	const unload = dispatch("beforeunload", null, {});
	assert.equal(unload.defaultPrevented, false, "after Leave the browser does not ask a second time");

	page = [link];
	assert.equal(click(link).defaultPrevented, false, "nothing unsaved: the link is not held");
});

test("INV-leave: when the page is hidden, each marked beacon goes out once with keepalive", async () => {
	page = [
		new FakeElement("article", leave.leaveBeaconMark({ url: "/api/wiki/progress", body: { fraction: "0.62" } })),
		new FakeElement("article", leave.leaveBeaconMark(null)),
	];
	window.dispatchEvent(new Event("pagehide"));
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.url, "/api/wiki/progress");
	assert.equal(sent[0]?.init.keepalive, true);
	assert.equal(sent[0]?.init.body, JSON.stringify({ fraction: "0.62" }));
});
