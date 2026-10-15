"use client";

import { useTransform } from "motion/react";
import { createContext, useContext, type ReactNode } from "react";
import { cn } from "../cn";
import { EvryBot } from "../kit/EvryBot";
import { flash, swapIn, swapOut, type Frame } from "./curves";
import { DoneButton } from "./DoneButton";
import { m } from "./m";
import { MText, usePanelClock, useText, useTo } from "./scene";

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
export function useFx<R>(id: string, n = 0): (t: number) => R {
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
export function useTarget(name: string | undefined) {
  const register = useContext(TargetContext);
  if (!name) return undefined;
  if (!register) throw new Error("useTarget needs a TargetProvider");
  return register(name);
}

type Leaf = { fx: string; n?: number; className?: string; children?: ReactNode };

/** An element moved by a frame function of the clock (rise, pop, slide). */
export function Move({ fx, n, as = "div", className, children, target }: Leaf & { as?: "div" | "span"; target?: string }) {
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
export function Tf({ fx, n, as = "span", className, children, target, layer = true }: Leaf & { as?: "div" | "span" | "i"; target?: string; layer?: boolean }) {
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
  return <C className={className} style={{ opacity }}>{children}</C>;
}

/** An element that only registers itself as a geometry target. */
export function Target({ name, as = "span", className, children }: { name: string; as?: "div" | "span"; className?: string; children?: ReactNode }) {
  const C = as;
  return <C ref={useTarget(name)} aria-hidden={children ? undefined : true} className={className}>{children}</C>;
}

/** Two stacked states in one grid cell: the first slides up and out as p goes 0 → 1, the second slides up and in.
 *  Each state is a grid box, so a badge inside sits without a line box around it (as when the badge itself moved). */
export function Swap({ fx, n, a, b, block, className, itemClassName }: { fx: string; n?: number; a: ReactNode; b: ReactNode; block?: boolean; className?: string; itemClassName?: string }) {
  const p = useFx<number>(fx, n), t = useT();
  const sa = useTo(t, (v) => swapOut(p(v)));
  const sb = useTo(t, (v) => swapIn(p(v)));
  return (
    <span className={cn(block ? "grid" : "inline-grid", "min-w-0", className)}>
      <m.span className={cn("will-change-[transform,opacity]", "col-start-1 row-start-1 grid min-w-0", itemClassName)} style={sa}>{a}</m.span>
      <m.span className={cn("will-change-[transform,opacity]", "col-start-1 row-start-1 grid min-w-0 opacity-0", itemClassName)} style={sb}>{b}</m.span>
    </span>
  );
}

/** Typing: the full text sits invisible and holds the space, the typed part draws over it. fx gives the progress 0..1. */
export function Typed({ text, fx, n, className, typedClassName }: { text: string; fx: string; n?: number; className?: string; typedClassName?: string }) {
  const p = useFx<number>(fx, n);
  const typed = useText(useT(), (v) => text.slice(0, Math.floor(p(v) * text.length)));
  return (
    <span className={cn("relative block", className)}>
      <span className="invisible">{text}</span>
      <MText value={typed} className={cn("absolute inset-0", typedClassName)} />
    </span>
  );
}

/**
 * A counter that never changes size or moves anything (measured: zero layout-shift entries in Chromium). Digits are
 * tabular; an invisible copy of the widest value holds the group's width, so line breaks never change. The live number
 * and its unit are one text node anchored at the group's start, so the unit keeps normal spacing and nothing starts at a
 * new position while the number grows. Spare room, if any, sits after the unit.
 */
export function Count({ fx, n, max, unit = "", className }: { fx: string; n?: number; max: number; unit?: string; className?: string }) {
  const value = useFx<number>(fx, n);
  const text = useTransform(useT(), (v) => String(Math.round(value(v))) + unit);
  return (
    <span className={cn("inline-grid whitespace-nowrap tabular-nums", className)}>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">{"0".repeat(String(max).length) + unit}</span>
      <MText value={text} data-n="" className="col-start-1 row-start-1" />
    </span>
  );
}

const ONE = () => 1;
/** A short highlight behind a row (fades in at a, out at b). R names the scene's loop reset, if it has one. */
export function Hl({ a, b, R, box = "inset-x-[-10px] inset-y-0.5 bg-surface-2" }: { a: number; b: number; R?: string; box?: string }) {
  const reg = useContext(FxContext);
  const r = (R ? reg[R] : ONE) as ((t: number, n: number) => number) | undefined;
  if (!r) throw new Error(`no frame function "${R}" in this panel's registry`);
  const opacity = useTransform(useT(), (v) => +flash(v, a, b, r(v, 0)).toFixed(3));
  return <m.span className={cn("absolute -z-1 rounded-[14px] opacity-0", box)} style={{ opacity }} />;
}

/** A confirm button that is also a cursor target. R names the scene's loop reset, if it has one. */
export function Done({ target, at, label, done, R }: { target: "t0" | "t1"; at: number; label: string; done: string; R?: string }) {
  const reg = useContext(FxContext);
  const r = R ? (reg[R] as ((t: number) => number) | undefined) : undefined;
  if (R && !r) throw new Error(`no frame function "${R}" in this panel's registry`);
  return <DoneButton ref={useTarget(target)} t={useT()} at={at} label={label} done={done} R={r} size="sm" />;
}

/** A form field picture: rounded input with a focus ring that fades in (fx gives the ring's opacity). */
export function Field({ fx, n, children, className }: Leaf) {
  const f = useFx<number>(fx, n);
  const opacity = useTransform(useT(), (v) => +f(v).toFixed(3));
  return (
    <div className={cn("relative flex h-[38px] items-center gap-2 overflow-hidden rounded-[11px] bg-surface px-3 text-[13.5px] font-medium whitespace-nowrap text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)]", className)}>
      <m.span className="pointer-events-none absolute inset-0 rounded-[11px] opacity-0 shadow-mk-field-focus" style={{ opacity }} />
      {children}
    </div>
  );
}

/** Evry, whose mood (idle, talking, happy) follows the scene clock. */
export function MoodBot({ fx, size = "lg", follow }: { fx: string; size?: "sm" | "lg"; follow?: boolean }) {
  const f = useFx<string>(fx);
  const mood = useTransform<number, string>(useT(), f);
  return <EvryBot size={size} mood={mood} follow={follow} />;
}
