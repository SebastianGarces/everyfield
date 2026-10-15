"use client";

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { useTransform, type MotionValue } from "motion/react";
import { m } from "@/components/motion/m";
import type { Ref } from "react";
import { cn } from "../cn";
import { Icon } from "../Icon";
import { back, bump, inOut, out, P } from "./curves";
import { useTo } from "./scene";

type Props = {
  t: MotionValue<number>;
  /** When the press starts (ms on the clock). */
  at: number;
  label: string;
  done: string;
  /** Time scale of the confirm steps (the hero plays them 1.5 times slower). */
  scale?: number;
  /** Length of the press (ms). */
  press?: number;
  /** The scene's loop reset (1 while it plays). */
  R?: (t: number) => number;
  size?: "md" | "sm";
  className?: string;
  ref?: Ref<HTMLSpanElement>;
};

/**
 * A pictured button that is pressed and confirms: it presses, a green fill rises, the label swaps to a check and the
 * done label, and a shine sweeps across. The hero's "Approve and send" and every panel's confirm button.
 * The check is 18 px, as in the prototype (its product-visual icon size wins over the button's 15 px rule).
 */
export function DoneButton({ t, at, label, done, scale = 1, press = 200, R = one, size = "md", className, ref }: Props) {
  const k = scale;
  const ok = (v: number) => out(P(v, at + 160 * k, 320 * k)) * R(v);
  const transform = useTransform(t, (v) => "scale(" + (1 - 0.05 * bump(v, at, press)).toFixed(4) + ")");
  const fill = useTransform(t, (v) => +ok(v).toFixed(3));
  const l1 = useTo(t, (v) => { const o = ok(v); return [0, -8 * o, 1, 1 - o]; });
  const l2 = useTo(t, (v) => {
    const o = ok(v), r = R(v);
    return [0, 8 * (1 - o), 0.9 + 0.1 * back(P(v, at + 160 * k, 380 * k)) * r + (1 - r) * 0.1, o];
  });
  const shine = useTransform(t, (v) => "translate3d(" + (-120 + 400 * inOut(P(v, at + 330 * k, 650 * k))).toFixed(1) + "%,0,0)");
  return (
    <m.span
      ref={ref}
      className={cn(
        "relative inline-grid flex-none place-items-center overflow-hidden bg-ink font-semibold whitespace-nowrap text-white shadow-pill will-change-transform",
        size === "md" ? "h-10 rounded-[12px] px-4 text-[13px]" : "h-[34px] rounded-[11px] px-[13px] text-[12.5px]",
        className,
      )}
      style={{ transform }}
    >
      <m.span className="absolute inset-0 bg-[linear-gradient(180deg,var(--color-mk-done-top),var(--ef-grad-field-g3))] opacity-0" style={{ opacity: fill }} />
      <m.span className="absolute inset-y-0 left-0 w-[40%] bg-[linear-gradient(100deg,transparent,var(--color-mk-white-55),transparent)]" style={{ transform: shine }} />
      <m.span className="col-start-1 row-start-1 inline-flex items-center gap-1.5" style={l1}>{label}</m.span>
      <m.span className="col-start-1 row-start-1 inline-flex items-center gap-1.5 text-mk-done-ink opacity-0" style={l2}>
        <Icon icon={Tick02Icon} size={18} />
        {done}
      </m.span>
    </m.span>
  );
}

const one = () => 1;
