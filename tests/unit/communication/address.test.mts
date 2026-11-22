import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
	resolve: (specifier, context, next) =>
		specifier === "./actions.ts" && context.parentURL?.endsWith("/communication/Address.tsx")
			? {
					url: "data:text/javascript,export const restoreOwnSuppression = async () => ({ status: 'lost' });",
					shortCircuit: true,
				}
			: next(specifier, context),
});

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

const { createRoot } = web("react-dom/client");
const { act, createElement } = web("react");
const { Address } = await import("../../../apps/web/src/features/communication/Address.tsx");

const REPORT = { address: "pastor@grace.example", active: false, restores: [] };
const press = (node: FakeNode) => {
	const props = Object.entries(node).find(([k]) => k.startsWith("__reactProps"))?.[1] as { onClick(): void };
	props.onClick();
};
const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));

test("when the Your address read cannot reach the server, the section offers Try again and loads once the network is back", async () => {
	let online = false;
	const fetched = mock.method(globalThis, "fetch", async () => {
		if (!online) throw new TypeError("Failed to fetch");
		return new Response(JSON.stringify({ status: "ok", value: REPORT }), { status: 200 });
	});
	const errored = mock.method(console, "error", () => {});
	const container = new FakeNode("DIV");
	const root = createRoot(container);
	try {
		await act(async () => root.render(createElement(Address)));
		await settle();
		const alert = container.all().find((n) => n.getAttribute("role") === "alert");
		assert.match(alert?.textContent ?? "", /Unable to reach the church records/);
		const retry = container.all().find((n) => n.nodeName === "BUTTON" && n.textContent === "Try again");
		assert.ok(retry, "the failed read offers Try again");

		online = true;
		await act(async () => press(retry));
		await settle();
		assert.equal(fetched.mock.callCount(), 2);
		assert.match(container.textContent, /pastor@grace\.example/);
		assert.match(container.textContent, /This address is not suppressed/);
		assert.equal(
			container.all().some((n) => n.getAttribute("role") === "alert"),
			false,
		);
		await act(async () => root.unmount());
	} finally {
		fetched.mock.restore();
		errored.mock.restore();
	}
});
