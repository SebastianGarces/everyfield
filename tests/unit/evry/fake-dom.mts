import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));

export class FakeNode extends EventTarget {
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
		return this.insertBefore(child, null);
	}
	insertBefore(child: FakeNode, before: FakeNode | null) {
		child.parentNode?.removeChild(child);
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
	contains(other: FakeNode | null) {
		return other === this || this.all().some((n) => n === other);
	}
	focus() {}
	closest() {
		return null;
	}
	querySelector() {
		return null;
	}
	all(): FakeNode[] {
		return this.childNodes.flatMap((c) => [c, ...c.all()]);
	}
}

const fakeDocument = Object.assign(new EventTarget(), {
	nodeType: 9,
	activeElement: null,
	querySelector: () => null,
	createElement: (tag: string) => new FakeNode(tag.toUpperCase()),
	createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
	createTextNode: (text: string) => Object.assign(new FakeNode("#text", 3), { nodeValue: text }),
	head: new FakeNode("HEAD"),
});

Object.assign(globalThis, {
	window: globalThis,
	self: globalThis,
	document: fakeDocument,
	IntersectionObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
	HTMLIFrameElement: class {},
	HTMLFormElement: class {},
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	addEventListener() {},
	removeEventListener() {},
	location: new URL("https://app.example.test/settings/account"),
	history: { state: null, pushState() {}, replaceState() {} },
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = web("react-dom/client");
const { act, createElement } = web("react");
const { AppRouterContext } = web("next/dist/shared/lib/app-router-context.shared-runtime");
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };

type Props = Record<string, unknown> & Partial<Record<`on${string}`, (event: unknown) => unknown>>;
const SPOKEN = ["aria-label", "aria-description", "alt", "title", "placeholder"];

export function propsOf(node: FakeNode): Props {
	const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
	return key ? (Reflect.get(node, key) as Props) : {};
}

export function linesOf(node: FakeNode): string[] {
	const spoken = SPOKEN.flatMap((name) => {
		const value = node.getAttribute(name);
		return value ? [value] : [];
	});
	return [
		...(node.nodeType === 3 && node.nodeValue ? [node.nodeValue] : []),
		...spoken,
		...node.childNodes.flatMap(linesOf),
	];
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

export async function mount(type: unknown, props: Record<string, unknown>) {
	const container = new FakeNode("DIV");
	const root = createRoot(container);
	const run = (step: () => unknown) =>
		act(async () => {
			await step();
			for (let turn = 0; turn < 5; turn++) await settle();
		});
	await run(() => root.render(createElement(AppRouterContext.Provider, { value: router }, createElement(type, props))));
	const byTag = (tag: string) => container.all().filter((n) => n.tagName === tag);
	const button = (label: string) => {
		const found = byTag("BUTTON").find((n) => n.textContent.trim() === label);
		if (!found) throw Error(`no ${label} button in: ${container.textContent}`);
		return found;
	};
	return {
		byTag,
		run,
		text: () => container.textContent,
		lines: () => linesOf(container),
		click: (label: string) =>
			run(() => propsOf(button(label)).onClick?.({ preventDefault() {}, defaultPrevented: false })),
		disabled: (label: string) => propsOf(button(label)).disabled === true,
		submit: (fields: Record<string, string>) =>
			run(() => {
				const form = byTag("FORM")[0];
				if (!form) throw Error(`no form in: ${container.textContent}`);
				return propsOf(form).onSubmit?.({ preventDefault() {}, currentTarget: { fields } });
			}),
		unmount: () => act(async () => root.unmount()),
	};
}
