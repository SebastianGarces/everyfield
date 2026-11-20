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
	namespaceURI = "http://www.w3.org/1999/xhtml";
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
	hasAttribute(name: string) {
		return this.attributes.has(name);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	closest() {
		return null;
	}
	getRootNode() {
		return fakeDocument;
	}
	focus() {}
	all(): FakeNode[] {
		return this.childNodes.flatMap((c) => [c, ...c.all()]);
	}
}

const fakeDocument = Object.assign(new EventTarget(), {
	nodeType: 9,
	activeElement: null,
	createElement: (tag: string) => new FakeNode(tag.toUpperCase()),
	createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
	createTextNode: (text: string) => Object.assign(new FakeNode("#text", 3), { nodeValue: text }),
	documentElement: null,
	head: new FakeNode("HEAD"),
	getElementsByTagName: () => [],
});

Object.assign(globalThis, {
	window: globalThis,
	document: fakeDocument,
	HTMLIFrameElement: class {},
	HTMLInputElement: class {},
	HTMLFormElement: class {},
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = web("react-dom/client");
const { act, createElement } = web("react");
const { PersonPicker } = await import("../../../apps/web/src/features/meetings/dialogs.tsx");

const ANA = { id: "11111111-1111-4111-8111-111111111111", name: "Ana Lee" };

async function pickInTurn(none: string | undefined, picks: ({ id: string; name: string } | null)[]) {
	const container = new FakeNode("DIV");
	const root = createRoot(container);
	const render = (value: { id: string; name: string } | null) =>
		act(async () => root.render(createElement(PersonPicker, { label: "Host", value, onChange() {}, none })));
	const warned = mock.method(console, "warn", () => {});
	const errored = mock.method(console, "error", () => {});
	const checked: string[][] = [];
	try {
		for (const value of picks) {
			await render(value);
			checked.push(
				container
					.all()
					.filter((n) => n.getAttribute("role") === "radio" && n.getAttribute("aria-checked") === "true")
					.map((n) => n.parentNode?.textContent ?? ""),
			);
		}
		await act(async () => root.unmount());
		return {
			checked,
			messages: [...warned.mock.calls, ...errored.mock.calls].map((c) => String(c.arguments[0])),
		};
	} finally {
		warned.mock.restore();
		errored.mock.restore();
	}
}

test("a person picker with no none option stays controlled from first render through a pick, with no React warning", async () => {
	const { checked, messages } = await pickInTurn(undefined, [null, ANA, ANA]);
	assert.deepEqual(checked, [[], ["Ana Lee"], ["Ana Lee"]]);
	assert.deepEqual(messages, []);
});

test("a person picker with a none option starts on none, moves to the pick and back to none, with no React warning", async () => {
	const { checked, messages } = await pickInTurn("No host", [null, ANA, null]);
	assert.deepEqual(checked, [["No host"], ["Ana Lee"], ["No host"]]);
	assert.deepEqual(messages, []);
});
