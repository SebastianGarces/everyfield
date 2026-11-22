import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));

class FakeNode extends EventTarget {
	childNodes: FakeNode[] = [];
	parentNode: FakeNode | null = null;
	attributes = new Map<string, string>();
	style: Record<string, string> = {};
	nodeValue: string | null = null;
	constructor(
		public nodeName: string,
		public nodeType = 1,
	) {
		super();
	}
	get tagName() {
		return this.nodeName;
	}
	get ownerDocument() {
		return fakeDocument;
	}
	get textContent(): string {
		return this.nodeType === 3 ? (this.nodeValue ?? "") : this.childNodes.map((c) => c.textContent).join("");
	}
	set textContent(text: string) {
		this.childNodes = text ? [Object.assign(new FakeNode("#text", 3), { nodeValue: text, parentNode: this })] : [];
	}
	appendChild(child: FakeNode) {
		child.parentNode = this;
		this.childNodes.push(child);
		return child;
	}
	insertBefore(child: FakeNode, before: FakeNode | null) {
		child.parentNode = this;
		const at = before ? this.childNodes.indexOf(before) : -1;
		if (at < 0) this.childNodes.push(child);
		else this.childNodes.splice(at, 0, child);
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
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	closest() {
		return null;
	}
	all(): FakeNode[] {
		return this.childNodes.flatMap((c) => [c, ...c.all()]);
	}
}

const fakeDocument = Object.assign(new EventTarget(), {
	nodeType: 9,
	createElement: (tag: string) => new FakeNode(tag.toUpperCase()),
	createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
	createTextNode: (text: string) => Object.assign(new FakeNode("#text", 3), { nodeValue: text }),
	head: new FakeNode("HEAD"),
});

Object.assign(globalThis, {
	window: globalThis,
	document: fakeDocument,
	HTMLIFrameElement: class {},
	HTMLFormElement: class {},
	IS_REACT_ACT_ENVIRONMENT: true,
});

mock.module(new URL("../../../apps/web/src/features/communication/actions.ts", import.meta.url).href, {
	namedExports: { restoreOwnSuppression: async () => ({ status: "lost" }) },
});

const { createRoot } = web("react-dom/client");
const { act, createElement } = web("react");
const { Address } = await import("../../../apps/web/src/features/communication/Address.tsx");
const { outcomeText, unread } = await import("../../../apps/web/src/features/communication/model.ts");

const settled = () => new Promise((resolve) => setImmediate(resolve));
const LINE = "We couldn't load your church's address.";

test("a failed address read shows Maya's line and a Try again button that reloads in place, again after a second failure", async () => {
	const report = { address: "owner@church.test", active: false, restores: [] };
	let answer = () => {};
	const answered = new Promise<void>((resolve) => (answer = resolve));
	const replies: (() => Promise<Response>)[] = [
		async () => new Response("", { status: 500 }),
		async () => {
			throw new TypeError("network down");
		},
		async () => {
			await answered;
			return Response.json({ status: "ok", value: report });
		},
	];
	const asked: string[] = [];
	const fetched = mock.method(globalThis, "fetch", (url: string) => {
		asked.push(url);
		const reply = replies.shift();
		assert.ok(reply, "no more reads expected");
		return reply();
	});
	const errored = mock.method(console, "error", () => {});
	const container = new FakeNode("DIV");
	const root = createRoot(container);
	const text = () => container.textContent;
	const tryAgain = () => container.all().find((n) => n.tagName === "BUTTON" && n.textContent === "Try again");
	const press = async (button: FakeNode) => {
		const props = (button as unknown as Record<string, { onClick?: () => void }>)[
			Object.keys(button).find((k) => k.startsWith("__reactProps$"))!
		];
		await act(async () => props.onClick?.());
	};
	const showsFailure = (when: string) => {
		const button = tryAgain();
		assert.ok(button, `${when}: Try again is shown`);
		assert.equal(button.getAttribute("disabled"), null, `${when}: Try again is enabled`);
		assert.equal(button.getAttribute("aria-disabled"), null, `${when}: Try again is enabled`);
		assert.ok(text().includes(LINE), `${when}: Maya's line is shown`);
		assert.equal(text().match(/try again/gi)?.length, 1, `${when}: no other try-again text`);
		assert.doesNotMatch(text(), /failed|lost|500|error/i, `${when}: no error code`);
		return button;
	};
	try {
		await act(async () => root.render(createElement(Address)));
		await act(settled);
		assert.equal(asked.length, 1);
		const first = showsFailure("after a 500");

		await press(first);
		await act(settled);
		assert.equal(asked.length, 2, "Try again starts another read");
		const second = showsFailure("after a lost read");

		await press(second);
		await act(settled);
		assert.ok(text().includes("Checking this address."), "the loading line shows while the reload runs");
		assert.ok(!text().includes(LINE), "the failure line goes while the reload runs");
		await act(async () => {
			answer();
			await settled();
		});
		assert.equal(asked.length, 3, "Try again starts another read after a second failure");
		assert.ok(text().includes("owner@church.test"), "the address is shown");
		assert.ok(text().includes("This address is not suppressed. It can receive church email."));
		assert.equal(tryAgain(), undefined, "Try again goes once the address loads");
		assert.ok(!text().includes(LINE));
		await act(async () => root.unmount());
	} finally {
		fetched.mock.restore();
		errored.mock.restore();
	}
});

test("a refused address read is not offered a retry and keeps its own line", () => {
	const denied = { status: "refused", code: "access_denied" } as const;
	assert.equal(unread(denied), false);
	assert.equal(outcomeText(denied), "An Owner or Admin seat is required to change messages.");
});
