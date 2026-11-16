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

function useResolved(style: MStyle | undefined) {
	const [first] = useState(() => new Map<string, Value>());
	if (!style) return undefined;
	const out: Record<string, Value> = {};
	for (const [k, v] of Object.entries(style)) {
		if (isMotionValue(v)) {
			if (!first.has(k)) first.set(k, (v as Live).get());
			out[k] = first.get(k);
		} else out[k] = v as Value;
	}
	return out as CSSProperties;
}

type Node = HTMLElement | SVGElement;

const liveEntries = (style: MStyle | undefined) =>
	Object.entries(style ?? {}).flatMap(([k, v]) => (isMotionValue(v) ? [[k, v as Live] as const] : []));

function forward(ref: unknown, node: Node | null) {
	if (typeof ref === "function") ref(node);
	else if (ref) (ref as { current: unknown }).current = node;
}

function make<T extends keyof JSX.IntrinsicElements>(tag: T) {
	function M({ style, ref, ...rest }: Props<T>) {
		const [live] = useState(() => liveEntries(style));
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
		const resolved = useResolved(style);
		return <Tag {...rest} ref={bind} style={resolved} />;
	}
	M.displayName = "m." + tag;
	return M;
}

export const m = { div: make("div"), span: make("span"), i: make("i"), b: make("b"), circle: make("circle") };
