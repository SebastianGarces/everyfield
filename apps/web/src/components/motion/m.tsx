"use client";

import { frame, isMotionValue } from "motion/react";
import {
	useCallback,
	useState,
	type ComponentPropsWithRef,
	type CSSProperties,
	type ElementType,
	type JSX,
} from "react";

type Value = string | number | undefined;
type Live = { get(): Value; on(event: "change", callback: () => void): () => void };
type MStyle = { [K in keyof CSSProperties]?: CSSProperties[K] | Live } & { [k: `--${string}`]: Value | Live };
type Props<T extends keyof JSX.IntrinsicElements> = Omit<ComponentPropsWithRef<T>, "style"> & { style?: MStyle };

const UNITLESS = new Set(["opacity", "zIndex", "flexGrow", "flexShrink", "order", "lineHeight", "fontWeight", "scale"]);
const css = (k: string, v: Value) =>
	typeof v === "number" && !UNITLESS.has(k) && !k.startsWith("--") && k !== "strokeDashoffset"
		? v + "px"
		: v === undefined
			? ""
			: String(v);
const kebab = (k: string) => (k.startsWith("--") ? k : k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()));

type Node = HTMLElement | SVGElement;

type Binding = { live: (readonly [string, Live])[]; first: Map<string, Value> };

const liveEntries = (style: MStyle | undefined) =>
	Object.entries(style ?? {}).flatMap(([k, v]) => (isMotionValue(v) ? [[k, v as Live] as const] : []));

const bindingOf = (style: MStyle | undefined): Binding => {
	const live = liveEntries(style);
	return { live, first: new Map(live.map(([k, mv]) => [k, mv.get()])) };
};

const sameLive = (a: Binding["live"], b: Binding["live"]) =>
	a.length === b.length &&
	a.every(([k, mv], i) => {
		const other = b[i];
		return other !== undefined && other[0] === k && other[1] === mv;
	});

function useBinding(style: MStyle | undefined) {
	const [binding, setBinding] = useState(() => bindingOf(style));
	if (sameLive(binding.live, liveEntries(style))) return binding;
	const next = bindingOf(style);
	setBinding(next);
	return next;
}

function resolved(style: MStyle | undefined, first: Binding["first"]) {
	if (!style) return undefined;
	const out: Record<string, Value> = {};
	for (const [k, v] of Object.entries(style)) out[k] = first.has(k) ? first.get(k) : (v as Value);
	return out as CSSProperties;
}

function forward(ref: unknown, node: Node | null) {
	if (typeof ref === "function") ref(node);
	else if (ref) (ref as { current: unknown }).current = node;
}

function make<T extends keyof JSX.IntrinsicElements>(tag: T) {
	function M({ style, ref, ...rest }: Props<T>) {
		const { live, first } = useBinding(style);
		const bind = useCallback(
			(node: Node | null) => {
				forward(ref, node);
				if (!node) return;
				const offs = live.map(([k, mv]) => {
					const name = kebab(k);
					const write = () => node.style.setProperty(name, css(k, mv.get()));
					write();
					return mv.on("change", () => frame.render(write));
				});
				return () => {
					for (const off of offs) off();
					forward(ref, null);
				};
			},
			[ref, live],
		);
		const Tag = tag as ElementType;
		return <Tag {...rest} ref={bind} style={resolved(style, first)} />;
	}
	M.displayName = "m." + tag;
	return M;
}

export const m = { div: make("div"), span: make("span"), i: make("i"), b: make("b"), circle: make("circle") };
