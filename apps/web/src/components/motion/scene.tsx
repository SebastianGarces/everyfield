"use client";

import { cancelFrame, frame, m, useMotionValueEvent, useTransform, type MotionValue } from "motion/react";
import { createContext, useContext, useEffect, useEffectEvent, type CSSProperties, type ReactNode, type RefObject } from "react";
import { out, P, transformOf, type Frame } from "./curves";

/**
 * Advances a scene while `run` is true: Motion's frame loop calls `step(dt)` once per frame in its update phase, before
 * it writes styles. Steps only set MotionValues; they never read layout. Off screen, paused or reduced motion: no
 * callback is registered at all, so an idle page has no frame loop. dt is capped at 50 ms (a tab returning from the
 * background resumes where it left off).
 */
export function useTicker(run: boolean, step: (dt: number) => void) {
  const onStep = useEffectEvent(step);
  useEffect(() => {
    if (!run) return;
    let last = -1;
    const tick = ({ timestamp }: { timestamp: number }) => {
      onStep(last < 0 ? 0 : Math.min(timestamp - last, 50));
      last = timestamp;
    };
    frame.update(tick, true);
    return () => cancelFrame(tick);
  }, [run]);
}

/** Transform and opacity of an element as a function of a clock. */
export function useTo(t: MotionValue<number>, f: (t: number) => Frame) {
  const transform = useTransform(t, (v) => {
    const [x, y, s] = f(v);
    return transformOf(x, y, s);
  });
  const opacity = useTransform(t, (v) => +f(v)[3].toFixed(3));
  return { transform, opacity };
}

/** Text as a function of a clock (typing, counters). Rendered as the child of an m element, so React never re-renders. */
export function useText(t: MotionValue<number>, f: (t: number) => string) {
  return useTransform(t, f);
}
/** A counter: the rounded value as text. */
export function useCount(t: MotionValue<number>, f: (t: number) => number) {
  return useTransform(t, (v) => String(Math.round(f(v))));
}

/** Writes a data attribute from a clock in Motion's render step (EvryBot's mood). */
export function useDataAttr(ref: RefObject<HTMLElement | null>, name: string, value: MotionValue<string>) {
  const write = (v: string) => frame.render(() => ref.current?.setAttribute(name, v));
  useMotionValueEvent(value, "change", write);
  useEffect(() => { ref.current?.setAttribute(name, value.get()); }, [ref, name, value]);
}

/**
 * A panel's clocks, given by the chapter that shows it: t is the scene time (ms) and since the time since the panel
 * became the shown one (its children stagger in on it). stagger is when the first child starts (240 ms on the desktop
 * panel, after the card crossfade; 90 ms on a phone panel).
 */
export type PanelClock = { t: MotionValue<number>; since: MotionValue<number>; stagger: number };
const PanelContext = createContext<PanelClock | null>(null);
export function PanelClockProvider({ clock, children }: { clock: PanelClock; children: ReactNode }) {
  return <PanelContext value={clock}>{children}</PanelContext>;
}
export function usePanelClock() {
  const c = useContext(PanelContext);
  if (!c) throw new Error("a panel must render inside a chapter (PanelClockProvider)");
  return c;
}

/** A panel child that rises in with the card: the k-th one starts 75 ms after the one before. */
export function St({ i, as = "div", className, style, children }: { i: number; as?: "div" | "span"; className?: string; style?: CSSProperties; children?: ReactNode }) {
  const { since, stagger } = usePanelClock();
  const s = useTo(since, (v) => {
    const p = out(P(v, stagger + i * 75, 420));
    return [0, (1 - p) * 8, 1, p];
  });
  const C = as === "span" ? m.span : m.div;
  return (
    <C className={className} style={{ ...style, ...s }}>
      {children}
    </C>
  );
}
