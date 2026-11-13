"use client";

import { useTransform } from "motion/react";
import { createContext, useContext, type ReactNode } from "react";
import { cn } from "../cn";
import { EvryBot } from "../kit/EvryBot";
import type { Frame } from "./curves";
import { m } from "./m";
import { MText, usePanelClock, useTo } from "./scene";

/**
 * Animated leaves for server-rendered product visuals. A panel's markup, copy and icons render on the server; only these
 * leaves run in the browser. A Server Component cannot pass a function to the browser, so a leaf names its frame
 * function by id (fx) and an optional number (n, the row index), and a client registry (FxProvider) maps the id to the
 * scene's timing code. Each panel family has one registry module, so a page ships only the timing of its own panels.
 * A missing id throws while the page prerenders, so `next build` fails instead of shipping a still element.
 */
export type Registry = Readonly<Record<string, (t: number, n: number) => unknown>>;
const FxContext = createContext<Registry>({});
export function FxProvider({ fx, children }: { fx: Registry; children: ReactNode }) {
	return <FxContext value={fx}>{children}</FxContext>;
}
/** The frame function named id in the surrounding registry, bound to n (for a family's own leaves). */
function useFx<R>(id: string, n = 0): (t: number) => R {
	const f = useContext(FxContext)[id];
	if (!f) throw new Error(`no frame function "${id}" in this panel's registry`);
	return (t) => f(t, n) as R;
}
/** The clock of the surrounding panel or scene. */
export const useT = () => usePanelClock().t;

/* Named geometry targets (cursor points, slots, chip sources). The chapter or hero that measures them provides this. */
type Register = (name: string) => (el: HTMLElement | null) => void;
const TargetContext = createContext<Register | null>(null);
export const TargetProvider = TargetContext;
/** A ref callback that registers an element as a named target of the surrounding card's geometry. */
function useTarget(name: string | undefined) {
	const register = useContext(TargetContext);
	if (!name) return undefined;
	if (!register) throw new Error("useTarget needs a TargetProvider");
	return register(name);
}

type Leaf = { fx: string; n?: number; className?: string; children?: ReactNode };

/** An element moved by a frame function of the clock (rise, pop, slide). */
export function Move({
	fx,
	n,
	as = "div",
	className,
	children,
	target,
}: Leaf & { as?: "div" | "span"; target?: string }) {
	const s = useTo(useT(), useFx<Frame>(fx, n));
	const C = as === "span" ? m.span : m.div;
	return (
		<C ref={useTarget(target)} className={cn("will-change-[transform,opacity]", className)} style={s}>
			{children}
		</C>
	);
}

/** An element whose transform is a function of the clock (a press, a bar). layer: own compositor layer (will-change), as
 *  the prototype gave buttons and chips but not form fields. */
export function Tf({
	fx,
	n,
	as = "span",
	className,
	children,
	target,
	layer = true,
}: Leaf & { as?: "div" | "span" | "i"; target?: string; layer?: boolean }) {
	const transform = useTransform(useT(), useFx<string>(fx, n));
	const C = as === "div" ? m.div : as === "i" ? m.i : m.span;
	return (
		<C ref={useTarget(target)} className={cn(layer && "will-change-transform", className)} style={{ transform }}>
			{children}
		</C>
	);
}

/** An element whose opacity is a function of the clock. */
export function Fade({ fx, n, as = "span", className, children }: Leaf & { as?: "div" | "span" }) {
	const f = useFx<number>(fx, n);
	const opacity = useTransform(useT(), (v) => +f(v).toFixed(3));
	const C = as === "div" ? m.div : m.span;
	return (
		<C className={className} style={{ opacity }}>
			{children}
		</C>
	);
}

/** An element that only registers itself as a geometry target. */
export function Target({
	name,
	as = "span",
	className,
	children,
}: {
	name: string;
	as?: "div" | "span";
	className?: string;
	children?: ReactNode;
}) {
	const C = as;
	return (
		<C ref={useTarget(name)} aria-hidden={children ? undefined : true} className={className}>
			{children}
		</C>
	);
}

/**
 * A counter that never changes size or moves anything (measured: zero layout-shift entries in Chromium). Digits are
 * tabular; an invisible copy of the widest value holds the group's width, so line breaks never change. The live number
 * and its unit are one text node anchored at the group's start, so the unit keeps normal spacing and nothing starts at a
 * new position while the number grows. Spare room, if any, sits after the unit.
 */
export function Count({
	fx,
	n,
	max,
	unit = "",
	className,
}: {
	fx: string;
	n?: number;
	max: number;
	unit?: string;
	className?: string;
}) {
	const value = useFx<number>(fx, n);
	const text = useTransform(useT(), (v) => String(Math.round(value(v))) + unit);
	return (
		<span className={cn("inline-grid whitespace-nowrap tabular-nums", className)}>
			<span aria-hidden="true" className="invisible col-start-1 row-start-1">
				{"0".repeat(String(max).length) + unit}
			</span>
			<MText value={text} data-n="" className="col-start-1 row-start-1" />
		</span>
	);
}

/** Evry, whose mood (idle, talking, happy) follows the scene clock. */
export function MoodBot({ fx, size = "lg", follow }: { fx: string; size?: "sm" | "lg"; follow?: boolean }) {
	const f = useFx<string>(fx);
	const mood = useTransform<number, string>(useT(), f);
	return <EvryBot size={size} mood={mood} follow={follow} />;
}
