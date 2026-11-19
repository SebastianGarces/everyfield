import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));

class FakeNode extends EventTarget {
	childNodes: FakeNode[] = [];
	parentNode: FakeNode | null = null;
	attributes = new Map<string, string>();
	props = new Map<string, string>();
	style = {
		setProperty: (name: string, value: string) => this.props.set(name, value),
		removeProperty: (name: string) => this.props.delete(name),
	};
	namespaceURI = "http://www.w3.org/1999/xhtml";
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
	get firstChild() {
		return this.childNodes[0] ?? null;
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
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
}

const fakeDocument = Object.assign(new EventTarget(), {
	nodeType: 9,
	createElement: (tag: string) => new FakeNode(tag.toUpperCase()),
	createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
	createTextNode: (text: string) => Object.assign(new FakeNode("#text", 3), { nodeValue: text }),
	documentElement: null,
});

Object.assign(globalThis, {
	window: globalThis,
	document: fakeDocument,
	HTMLIFrameElement: class {},
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (paint: (at: number) => void) => setImmediate(() => paint(performance.now())),
});

const { createRoot } = web("react-dom/client");
const { act, createElement } = web("react");
const { motionValue, frame } = web("motion/react");
const { m } = await import("../../../apps/web/src/components/motion/m.tsx");

const painted = () => new Promise((resolve) => frame.postRender(() => resolve(undefined)));

test("INV-motion: m.* follows the MotionValue it is given now, not only the one it first rendered with", async () => {
	const container = new FakeNode("DIV");
	const root = createRoot(container);
	const first = motionValue(0.25);
	const second = motionValue(0.75);
	await act(async () => root.render(createElement(m.div, { style: { opacity: first } })));
	const node = container.childNodes[0]!;
	assert.equal(node.props.get("opacity"), "0.25");

	await act(async () => root.render(createElement(m.div, { style: { opacity: second } })));
	assert.equal(node.props.get("opacity"), "0.75", "the new value is written when it replaces the first one");

	second.set(0.5);
	await painted();
	assert.equal(node.props.get("opacity"), "0.5", "changes of the new value reach the element");
	first.set(0.1);
	await painted();
	assert.equal(node.props.get("opacity"), "0.5", "the replaced value no longer writes to the element");
	await act(async () => root.unmount());
});
