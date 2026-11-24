import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
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
	focus() {}
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
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = web("react-dom/client");
const { act, createElement, useTransition } = web("react");
const { PasswordForm } = await import("../../../apps/web/src/features/settings/flows/PasswordDialog.tsx");
const { SettingsProvider } = await import("../../../apps/web/src/features/settings/store.tsx");
const { createSettingsStore } = await import("../../../apps/web/src/features/settings/settings.store.ts");
const { createFixturePort } = await import("../../../apps/web/src/features/settings/preview/fixtures.ts");

type Props = Record<string, ((...args: unknown[]) => void) | unknown>;
const propsOf = (node: FakeNode) =>
	(node as unknown as Record<string, Props>)[Object.keys(node).find((k) => k.startsWith("__reactProps$"))!]!;
const settled = () => new Promise((resolve) => setImmediate(resolve));

const CURRENT = "  Old Secret PASSWORD  ";
const NEW = "  New Secret password 2  ";

test("a password change whose outcome is unknown is sent once, never again on re-render or reopen, and leaves no password behind", async () => {
	const { port } = createFixturePort("admin");
	const sent: unknown[] = [];
	const flows = {
		...port.flows,
		changePassword: async (request: unknown) => {
			sent.push(request);
			throw new TypeError("network down");
		},
	};
	const store = createSettingsStore({ port: { ...port, flows }, seed: null });
	const viewer = { context: "account", accountId: "11111111-1111-4111-8111-111111111111" } as const;
	function Host({ opened }: { opened: number }) {
		const [pending, startChange] = useTransition();
		return createElement(
			SettingsProvider,
			{ store, viewer },
			createElement(PasswordForm, { key: opened, pending, startChange, onCancel() {}, onChanged() {} }),
		);
	}
	const container = new FakeNode("DIV");
	const root = createRoot(container);
	const inputs = () => container.all().filter((n) => n.tagName === "INPUT");
	const values = () => inputs().map((n) => propsOf(n).value);
	const submit = () =>
		act(async () => {
			const form = container.all().find((n) => n.tagName === "FORM")!;
			(propsOf(form).onSubmit as (e: unknown) => void)({ preventDefault() {} });
			await settled();
		});
	const type = async (index: number, value: string) =>
		act(async () => (propsOf(inputs()[index]!).onChange as (e: unknown) => void)({ target: { value } }));
	const errored = console.error;
	console.error = () => {};
	try {
		await act(async () => root.render(createElement(Host, { opened: 1 })));
		await type(0, CURRENT);
		await type(1, NEW);
		await type(2, NEW);
		assert.deepEqual(values(), [CURRENT, NEW, NEW]);

		await submit();
		await act(settled);
		assert.deepEqual(sent, [{ currentPassword: CURRENT, newPassword: NEW, confirmPassword: NEW }]);
		assert.deepEqual(values(), ["", "", ""], "the form keeps no password after the unknown outcome");
		assert.match(container.textContent, /could not confirm whether your password changed/);
		const button = container.all().find((n) => n.tagName === "BUTTON" && propsOf(n).type === "submit")!;
		assert.equal(propsOf(button).disabled, true, "the form offers no second try");

		await submit();
		await act(async () => root.render(createElement(Host, { opened: 1 })));
		await act(settled);
		assert.equal(sent.length, 1, "a submit or a re-render after the unknown outcome sends nothing");

		await act(async () => root.render(createElement(Host, { opened: 2 })));
		await act(settled);
		assert.equal(sent.length, 1, "reopening sends nothing");
		assert.deepEqual(values(), ["", "", ""], "the reopened form starts empty");
		const kept = JSON.stringify(store.getState());
		assert.ok(!kept.includes(CURRENT.trim()) && !kept.includes(NEW.trim()), "the settings store keeps no password");
		await act(async () => root.unmount());
	} finally {
		console.error = errored;
	}
});
