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
		this.childNodes = [Object.assign(new FakeNode("#text", 3), { nodeValue: text, parentNode: this })];
	}
	appendChild(child: FakeNode) {
		child.parentNode = this;
		this.childNodes.push(child);
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
}

const fakeDocument = Object.assign(new EventTarget(), {
	nodeType: 9,
	createElement: (tag: string) => new FakeNode(tag.toUpperCase()),
	createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
	createTextNode: (text: string) => Object.assign(new FakeNode("#text", 3), { nodeValue: text }),
	head: new FakeNode("HEAD"),
	querySelector: () => null,
});

Object.assign(globalThis, {
	window: globalThis,
	document: fakeDocument,
	HTMLIFrameElement: class {},
	HTMLFormElement: class {},
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = web("react-dom/client");
const { act, createElement } = web("react");
const { AssigneePicker, reloadAssignees } = await import("../../../apps/web/src/features/tasks/AssigneePicker.tsx");

const ANA = { accountId: "11111111-1111-4111-8111-111111111111", displayName: "Ana Lee" };
const BEN = { accountId: "22222222-2222-4222-8222-222222222222", displayName: "Ben Cho" };
const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));

test("after an owner change is refused, a mounted owner picker reads the owners again once, at once", async () => {
	const answers = [[ANA, BEN], [ANA]];
	const fetched = mock.method(globalThis, "fetch", async (url: string) => {
		assert.match(String(url), /what=seats/);
		const items = answers.shift() ?? [ANA];
		return new Response(JSON.stringify({ status: "ok", value: { items } }), { status: 200 });
	});
	const container = new FakeNode("DIV");
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				createElement(AssigneePicker, {
					value: [BEN.accountId],
					purpose: "committed_follow_up",
					held: [{ accountId: BEN.accountId, displayName: BEN.displayName }],
					onChange() {},
				}),
			),
		);
		await settle();
		assert.equal(fetched.mock.callCount(), 1);

		reloadAssignees();
		await settle();
		assert.equal(fetched.mock.callCount(), 2, "the refusal reads the owners again without waiting for a pointer");
		await settle();
		assert.equal(fetched.mock.callCount(), 2, "and only once");
		await act(async () => root.unmount());
	} finally {
		fetched.mock.restore();
	}
});
