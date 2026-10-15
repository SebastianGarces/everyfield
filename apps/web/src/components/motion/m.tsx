"use client";

import { frame, isMotionValue } from "motion/react";
import { useCallback, useEffect, useState, type ComponentPropsWithRef, type CSSProperties, type ElementType, type JSX } from "react";

/**
 * Elements whose style may hold MotionValues. Every animated value on the site is a MotionValue (a scene clock through
 * useTransform), so an element only has to show the current value on render and write each change to its style in
 * Motion's render step. That is all Motion's own m components did here; they also carried Motion's animation,
 * gesture and layout-projection engine, which the site never uses (about 40 KB of client JS).
 */
type Value = string | number | undefined;
/** A MotionValue of any value type, read-only from here (MotionValue's type parameter is invariant). */
type Live = { get(): Value; on(event: "change", callback: () => void): () => void };
type MStyle = { [K in keyof CSSProperties]?: CSSProperties[K] | Live } & { [k: `--${string}`]: Value | Live };
type Props<T extends keyof JSX.IntrinsicElements> = Omit<ComponentPropsWithRef<T>, "style"> & { style?: MStyle };

const UNITLESS = new Set(["opacity", "zIndex", "flexGrow", "flexShrink", "order", "lineHeight", "fontWeight", "scale"]);
const css = (k: string, v: Value) => (typeof v === "number" && !UNITLESS.has(k) && !k.startsWith("--") && k !== "strokeDashoffset" ? v + "px" : v === undefined ? "" : String(v));
const kebab = (k: string) => (k.startsWith("--") ? k : k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()));

/**
 * The style React renders. A MotionValue property always renders its first value: React then never writes it again,
 * and only the binder below updates it. (If React rendered the current value, a commit could land after a newer
 * frame and put back an older value.)
 */
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

function useBind(el: HTMLElement | SVGElement | null, style: MStyle | undefined) {
  useEffect(() => {
    if (!el || !style) return;
    const offs: (() => void)[] = [];
    for (const [k, v] of Object.entries(style)) {
      if (!isMotionValue(v)) continue;
      const name = kebab(k), mv = v as Live;
      const write = () => el.style.setProperty(name, css(k, mv.get()));
      // A value can change between render and this effect: write once, then on every change in the render step.
      write();
      offs.push(mv.on("change", () => frame.render(write)));
    }
    return () => offs.forEach((off) => off());
  }, [el, style]);
}

function make<T extends keyof JSX.IntrinsicElements>(tag: T) {
  function M({ style, ref, ...rest }: Props<T>) {
    const [el, setEl] = useState<HTMLElement | SVGElement | null>(null);
    useBind(el, style);
    const setRef = useCallback((node: HTMLElement | SVGElement | null) => {
      setEl(node);
      if (typeof ref === "function") ref(node as never);
      else if (ref) (ref as { current: unknown }).current = node;
    }, [ref]);
    const Tag = tag as ElementType;
    const resolved = useResolved(style);
    return <Tag {...rest} ref={setRef} style={resolved} />;
  }
  M.displayName = "m." + tag;
  return M;
}

export const m = { div: make("div"), span: make("span"), i: make("i"), b: make("b"), circle: make("circle") };
