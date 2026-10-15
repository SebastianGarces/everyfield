"use client";

import type { IconSvgElement } from "@hugeicons/react";
import { useTransform } from "motion/react";
import { m } from "@/components/motion/m";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { CardIcon, NUM, type Tone } from "@/components/kit/kit";
import { Icon } from "@/components/Icon";
import { flash, swapIn, swapOut, type Frame } from "@/components/motion/curves";
import { DoneButton } from "@/components/motion/DoneButton";
import { MText, St, usePanelClock, useText, useTo } from "@/components/motion/scene";
import { useTarget } from "../chapters/panel-frame";

/** The panel's clock (ms on the scene). */
export function useT() {
  return usePanelClock().t;
}

/** Panel header: icon (or Evry), title, subtitle, and an optional control on the right. */
export function Head({ i = 0, lead, title, sub, right, className }: { i?: number; lead: ReactNode; title: string; sub: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <St i={i} className={cn("mb-3.5 flex items-center gap-3", className)}>
      {lead}
      <div className="min-w-0 flex-1">
        <div className="font-display text-[17px] leading-[1.2] font-medium tracking-[-0.02em]">{title}</div>
        <div className="mt-0.5 text-[12.5px] text-text-3">{sub}</div>
      </div>
      {right}
    </St>
  );
}
export function PIcon({ tone, icon }: { tone: Tone; icon: IconSvgElement }) {
  return <CardIcon tone={tone} icon={icon} size={36} glyph={17} />;
}
export function Lab({ children, flush }: { children: ReactNode; flush?: boolean }) {
  return <span className={cn("block text-[12px] font-semibold text-text-2", !flush && "mb-1.5")}>{children}</span>;
}

/** An element moved by a frame function of the clock (rise, pop, slide). */
export function Move({ f, as = "div", className, children, innerRef }: { f: (t: number) => Frame; as?: "div" | "span"; className?: string; children?: ReactNode; innerRef?: (el: HTMLElement | null) => void }) {
  const s = useTo(useT(), f);
  const C = as === "span" ? m.span : m.div;
  return (
    <C ref={innerRef} className={cn("will-change-[transform,opacity]", className)} style={s}>
      {children}
    </C>
  );
}
/** An element whose transform is a function of the clock (a press, a bar). */
/** layer: own compositor layer (will-change), as the prototype gave buttons and chips but not form fields. */
export function Tf({ f, as = "span", className, children, innerRef, layer = true }: { f: (t: number) => string; as?: "div" | "span" | "i"; className?: string; children?: ReactNode; innerRef?: (el: HTMLElement | null) => void; layer?: boolean }) {
  const transform = useTransform(useT(), f);
  const C = as === "div" ? m.div : as === "i" ? m.i : m.span;
  return (
    <C ref={innerRef} className={cn(layer && "will-change-transform", className)} style={{ transform }}>
      {children}
    </C>
  );
}
/** An element whose opacity is a function of the clock. */
export function Fade({ f, as = "span", className, children }: { f: (t: number) => number; as?: "div" | "span"; className?: string; children?: ReactNode }) {
  const opacity = useTransform(useT(), (v) => +f(v).toFixed(3));
  const C = as === "div" ? m.div : m.span;
  return <C className={className} style={{ opacity }}>{children}</C>;
}

/** Two stacked states in one grid cell: the first slides up and out as p goes 0 → 1, the second slides up and in.
 *  Each state is a grid box, so a badge inside sits without a line box around it (as when the badge itself moved). */
export function Swap({ p, a, b, block, className, itemClassName }: { p: (t: number) => number; a: ReactNode; b: ReactNode; block?: boolean; className?: string; itemClassName?: string }) {
  return (
    <span className={cn(block ? "grid" : "inline-grid", "min-w-0", className)}>
      <Move as="span" f={(v) => swapOut(p(v))} className={cn("col-start-1 row-start-1 grid min-w-0", itemClassName)}>{a}</Move>
      <Move as="span" f={(v) => swapIn(p(v))} className={cn("col-start-1 row-start-1 grid min-w-0 opacity-0", itemClassName)}>{b}</Move>
    </span>
  );
}

/** Typing: the full text sits invisible and holds the space, the typed part draws over it. */
export function Typed({ text, p, className, typedClassName }: { text: string; p: (t: number) => number; className?: string; typedClassName?: string }) {
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
export function Count({ value, max, unit = "", className }: { value: (t: number) => number; max: number; unit?: string; className?: string }) {
  const text = useTransform(useT(), (v) => String(Math.round(value(v))) + unit);
  return (
    <span className={cn("inline-grid whitespace-nowrap tabular-nums", className)}>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">{"0".repeat(String(max).length) + unit}</span>
      <MText value={text} data-n="" className="col-start-1 row-start-1" />
    </span>
  );
}

/** A short highlight behind a row (fades in at a, out at b). */
export function Hl({ a, b, R, box = "inset-x-[-10px] inset-y-0.5 bg-surface-2" }: { a: number; b: number; R?: (t: number) => number; box?: string }) {
  return <Fade f={(v) => flash(v, a, b, R ? R(v) : 1)} className={cn("absolute -z-1 rounded-[14px] opacity-0", box)} />;
}

/** A confirm button that is also a cursor target. */
export function Done({ target, at, label, done, R }: { target: "t0" | "t1"; at: number; label: string; done: string; R?: (t: number) => number }) {
  const ref = useTarget(target);
  return <DoneButton ref={ref} t={useT()} at={at} label={label} done={done} R={R} size="sm" />;
}

/** A form field picture: rounded input with a focus ring that fades in. */
export function Field({ fr, children, className, innerRef }: { fr: (t: number) => number; children: ReactNode; className?: string; innerRef?: (el: HTMLElement | null) => void }) {
  return (
    <div ref={innerRef} className={cn("relative flex h-[38px] items-center gap-2 overflow-hidden rounded-[11px] bg-surface px-3 text-[13.5px] font-medium whitespace-nowrap text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)]", className)}>
      <Fade f={fr} className="pointer-events-none absolute inset-0 rounded-[11px] opacity-0 shadow-[inset_0_0_0_1.5px_var(--color-blue-500),0_0_0_3px_rgba(80,150,255,.16)]" />
      {children}
    </div>
  );
}

/** A dashboard number (display face). */
export function Num({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn(NUM, className)}>{children}</span>;
}

/** A person chip that pops or drops in (meeting guests, the facts names). */
export const CHIP = "inline-flex items-center rounded-full bg-white font-semibold whitespace-nowrap text-ink shadow-mk-chip";

/* ---------- InsightCard parts (focus, top finding, where help could matter) ---------- */
/** The pill never wraps or shrinks (owner finding 00:52: "Where help could matter" broke onto two lines); when the row
 *  runs out of room, the count moves under it. */
export function InsightTop({ i, icon, label, count }: { i: number; icon: IconSvgElement; label: string; count: string }) {
  return (
    <St i={i} className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5">
      <span className="inline-flex h-[30px] flex-none items-center gap-[7px] rounded-full bg-[var(--pill-bg)] px-3 text-[13px] font-semibold whitespace-nowrap shadow-[inset_0_0_0_1px_var(--pill-edge)]">
        <Icon icon={icon} />
        {label}
      </span>
      <span className="text-[12.5px] text-[var(--on-3)]">{count}</span>
    </St>
  );
}
export function InsightMetric({ i, num, unit, numClassName, unitMax = 180 }: { i: number; num: ReactNode; unit: string; numClassName?: string; unitMax?: number }) {
  return (
    <St i={i} className="mt-5 flex items-end gap-3">
      <span className={cn(NUM, "text-[52px] leading-[.95]", numClassName)}>{num}</span>
      <span className="pb-[3px] text-[13.5px] leading-[1.3] text-[var(--on-2)]" style={{ maxWidth: unitMax }}>{unit}</span>
    </St>
  );
}
export const INSIGHT_TITLE = "mt-3.5 font-display text-[23px] leading-[1.18] font-medium tracking-[-0.02em]";
export const INSIGHT_TEXT = "text-[14px] text-[var(--on-2)]";
export const INSIGHT_FOOTER = "mt-auto flex flex-wrap gap-2 pt-5";
