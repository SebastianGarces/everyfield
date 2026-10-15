"use client";

import { useTransform } from "motion/react";
import { m } from "@/components/motion/m";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Av, Badge, UiButton } from "@/components/kit/kit";
import { EvryBot } from "@/components/kit/EvryBot";
import { back, out, P, pop, press, reset, rise } from "@/components/motion/curves";
import { St } from "@/components/motion/scene";
import { PanelCard, useTarget } from "../chapters/panel-frame";
import { ICONS } from "../icons";
import { CX_A, CX_Q } from "../scene-data";
import { CHIP, Count, Done, Hl, INSIGHT_FOOTER, INSIGHT_TEXT, INSIGHT_TITLE, InsightMetric, InsightTop, Move, Num, PIcon, Swap, Tf, Typed, useT } from "./parts";

// The home Plant Intelligence auto list: one focus, the facts, ask Evry, sharing. Timings are the prototype's.

/** A pictured button that the cursor presses (a cursor target). */
function PressBtn({ target, at, d = 0.05, variant, children }: { target: "t0" | "t1"; at: number; d?: number; variant: "light" | "glass"; children: ReactNode }) {
  const ref = useTarget(target);
  return (
    <Tf innerRef={ref} f={(t) => press(t, at, d)} className="inline-flex" layer={false}>
      <UiButton variant={variant}>{children}</UiButton>
    </Tf>
  );
}

/* ---------- Focus this week ---------- */
const R_FOCUS = (t: number) => reset(t, 6200);
const days = (t: number) => 16 * out(P(t, 300, 1200)) * R_FOCUS(t);
const FACTS = [["Last vision meeting", "#11, 16 days ago"], ["New guests at #11", "9"], ["Next", "#12, Sun Oct 12"]] as const;

export function FocusPanel() {
  const t = useT();
  // The fill shows the days elapsed; it slides out of a rounded window (transform only, no clip-path animation).
  const fill = useTransform(t, (v) => "translate3d(" + (-(1 - days(v) / 16) * 100).toFixed(2) + "%,0,0)");
  const s = (v: number) => out(P(v, 2550, 380)) * R_FOCUS(v);
  return (
    <PanelCard kind="focus" variant={{ kind: "insight", tone: "dawn" }}>
      <InsightTop i={0} icon={ICONS.compass} label="Focus this week" count="Plant Intelligence" />
      <InsightMetric i={1} num={<Count value={days} max={16} unit=" d" />} unit="since the last vision meeting" />
      <St i={2}>
        <div className="relative mt-4 h-2 rounded-full bg-[rgba(24,29,25,.12)]">
          <span className="absolute inset-y-0 left-0 w-[84.2%] overflow-hidden rounded-full">
            <m.span className="absolute inset-0 rounded-full bg-ink will-change-transform" style={{ transform: fill }} />
          </span>
          <span className="absolute -top-[5px] right-0 -bottom-[5px] w-0.5 rounded-[2px] bg-ink" />
        </div>
        <div className="relative mt-2 h-4 text-[12px] text-[var(--on-3)]">
          <span className="absolute right-0 whitespace-nowrap">Next: #12, Sun Oct 12</span>
        </div>
      </St>
      <St i={3} className={INSIGHT_TITLE}>Hold your next vision meeting this week</St>
      <St i={4} className="mt-2.5 grid">
        <Move f={(v) => [0, -6 * s(v), 1, 1 - s(v)]} className={cn(INSIGHT_TEXT, "col-start-1 row-start-1")}>
          Vision meeting #12 is set for Sun Oct 12. Invite the 9 guests from #11.
        </Move>
        <div className="col-start-1 row-start-1">
          {FACTS.map((f, k) => (
            <Move key={f[0]} f={(v) => rise(v, 2640 + k * 75, R_FOCUS(v))} className={cn("flex justify-between gap-2.5 py-1.5 text-[13px] text-[var(--on-2)] opacity-0", k > 0 && "border-t border-[rgba(24,29,25,.1)]")}>
              <span>{f[0]}</span>
              <b className="font-semibold text-[var(--on)]">{f[1]}</b>
            </Move>
          ))}
        </div>
      </St>
      <St i={5} className={INSIGHT_FOOTER}>
        <PressBtn target="t0" at={2400} variant="light">See the facts <Icon icon={ICONS.arrow} /></PressBtn>
        <UiButton variant="glass">Why this?</UiButton>
      </St>
    </PanelCard>
  );
}

/* ---------- The facts behind the finding ---------- */
const R_FACTS = (t: number) => reset(t, 6000);
const KV = [["New guests, last 2 vision meetings", 24], ["Contacted within 48 hours", 17], ["No contact yet", 7]] as const;
const NAMES = [["JO", "James Okafor"], ["KW", "Kim Wu"], ["SN", "Sara Nunez"]] as const;

export function FactsPanel() {
  const t = useT();
  const p = (v: number) => out(P(v, 300, 1100)) * R_FACTS(v);
  // The ring keeps stroke-dashoffset: a paint-only change on a 64 px SVG (no layout), and the round line caps stay right.
  const dash = useTransform(t, (v) => (169.65 * (1 - 0.71 * p(v))).toFixed(2));
  const t0 = useTarget("t0");
  return (
    <PanelCard kind="facts">
      <PanelHead tone="amber" icon={ICONS.alert} title="Follow-up is slipping" sub="The facts this finding used" />
      <St i={1} className="flex items-center gap-3.5 pt-1 pb-2.5">
        <svg viewBox="0 0 64 64" aria-hidden="true" className="size-16 flex-none -rotate-90">
          <circle cx="32" cy="32" r="27" className="fill-none stroke-surface-2 stroke-7" />
          <m.circle cx="32" cy="32" r="27" className="fill-none stroke-amber-500 stroke-7 [stroke-dasharray:169.65] [stroke-linecap:round]" style={{ strokeDashoffset: dash }} />
        </svg>
        <div>
          <Num className="block text-[30px] leading-none"><Count value={(v) => 71 * p(v)} max={71} unit="%" /></Num>
          <div className="text-[13px] text-text-3">of new guests contacted within 48 hours</div>
        </div>
      </St>
      {KV.map((r, k) => (
        <St key={r[0]} i={k + 2} className="relative isolate flex items-center justify-between gap-3 border-t border-line py-[11px]">
          {k === 2 ? <Hl a={1650} b={5800} R={R_FACTS} /> : null}
          {k === 2 ? <span ref={t0} aria-hidden="true" className="absolute inset-0" /> : null}
          <span className="text-[13px] text-text-2">{r[0]}</span>
          <span className="flex items-center gap-2">
            {k === 2 ? <Badge status="risk" size="sm">Open</Badge> : null}
            <span className="font-display text-[18px] font-medium tracking-[-0.02em] whitespace-nowrap"><Count value={(v) => r[1] * out(P(v, 300 + k * 90, 900)) * R_FACTS(v)} max={r[1]} /></span>
          </span>
        </St>
      ))}
      <St i={5} className="mt-2.5 flex h-[30px] flex-nowrap gap-1.5 overflow-hidden">
        {NAMES.map((n, k) => (
          <Move key={n[1]} as="span" f={(v) => pop(v, 2500 + k * 120, R_FACTS(v))} className={cn(CHIP, "h-7 flex-none gap-[7px] pr-2.5 pl-1 text-[12px] opacity-0")}>
            <Av small>{n[0]}</Av>
            {n[1]}
          </Move>
        ))}
        <Move as="span" f={(v) => pop(v, 2500 + 3 * 120, R_FACTS(v))} className={cn(CHIP, "h-7 flex-none pr-2.5 pl-2.5 text-[12px] opacity-0")}>4 more</Move>
      </St>
    </PanelCard>
  );
}

/** The common panel header with a tinted icon. */
export function PanelHead({ tone, icon, title, sub, right }: { tone: Parameters<typeof PIcon>[0]["tone"]; icon: Parameters<typeof PIcon>[0]["icon"]; title: string; sub: string; right?: ReactNode }) {
  return (
    <St i={0} className="mb-3.5 flex items-center gap-3">
      <PIcon tone={tone} icon={icon} />
      <div className="min-w-0 flex-1">
        <div className="font-display text-[17px] leading-[1.2] font-medium tracking-[-0.02em]">{title}</div>
        <div className="mt-0.5 text-[12.5px] text-text-3">{sub}</div>
      </div>
      {right}
    </St>
  );
}

/* ---------- Ask Evry why ---------- */
const R_EVRY = (t: number) => reset(t, 7800);

export function EvryPanel() {
  const t = useT();
  const mood = useTransform<number, string>(t, (v) => (v >= 2050 && v < 3700 ? "talking" : v >= 5300 && v < 6400 ? "happy" : "idle"));
  return (
    <PanelCard kind="evry" variant={{ kind: "evry" }}>
      <St i={0} className="flex items-center gap-2.5 border-b border-line pb-3">
        <EvryBot size="lg" mood={mood} follow />
        <div className="min-w-0 flex-1">
          <div className="font-display text-[18px] font-medium">Evry</div>
          <div className="text-[12px] text-text-3">Reads and drafts. You approve every change.</div>
        </div>
      </St>
      <St i={1} className="max-w-[86%] self-end rounded-2xl rounded-br-xs bg-ink px-3.5 py-[11px] text-[13px] leading-[1.45] text-on-ink">
        <Typed text={CX_Q} p={(v) => P(v, 450, 1300)} />
      </St>
      <Move f={(v) => rise(v, 1950, R_EVRY(v))} className="max-w-[86%] self-start rounded-2xl rounded-bl-xs bg-surface-2 px-3.5 py-[11px] text-[13px] leading-[1.45] opacity-0">
        <Typed text={CX_A} p={(v) => P(v, 2150, 1500)} />
      </Move>
      <Move f={(v) => rise(v, 3750, R_EVRY(v))} className="overflow-hidden rounded-[18px] bg-white opacity-0 shadow-[inset_0_0_0_1px_var(--color-line),var(--shadow-raised)]">
        <div className="flex items-center gap-2.5 border-b border-[rgba(255,165,82,.18)] bg-amber-50 px-4 py-3 text-[13px] font-semibold text-amber-600">
          <Icon icon={ICONS.edit} />
          Review 7 changes
          <span className="min-w-0 flex-1" />
          <span className="font-medium">Assign follow-up tasks</span>
        </div>
        <div className="flex flex-col gap-[9px] px-4 py-3">
          <div className="flex items-start gap-2.5 text-[12.5px]">
            <Icon icon={ICONS.task} size={16} className="mt-px text-text-3" />
            <span>Assign <b>Follow up with James Okafor</b> to <b>Tom</b>, due <b>Oct 10</b></span>
          </div>
          <div className="flex items-start gap-2.5 text-[12.5px] text-text-3">
            <Icon icon={ICONS.more} size={16} className="mt-px text-text-3" />
            <span>6 more follow-ups in this change</span>
          </div>
        </div>
        <div className="flex gap-2 border-t border-line px-4 py-2.5">
          <Done target="t0" at={5100} label="Approve" done="Approved" R={R_EVRY} />
          <UiButton variant="ghost">Edit</UiButton>
        </div>
      </Move>
    </PanelCard>
  );
}

/* ---------- You see it first: sharing ---------- */
const R_SHARE = (t: number) => reset(t, 6000);
const SHARE = [["Phase and launch date", 1, 0], ["Plant Intelligence findings", 0, 0], ["People and contact details", 0, 1], ["Private weekly check-in", 0, 1]] as const;

export function SharePanel() {
  return (
    <PanelCard kind="share">
      <PanelHead tone="violet" icon={ICONS.eye} title="Sharing with Grace Church" sub="You choose what leaves your plant" />
      {SHARE.map((r, i) => (
        <St key={r[0]} i={i + 1} className="relative isolate flex items-center justify-between gap-2.5 border-t border-line py-2.5 text-[13px]">
          {i === 1 ? <Hl a={1550} b={3000} /> : null}
          <span>
            {r[0]}
            {r[2] ? <> <span className="text-[12px] text-text-3">Never shared</span></> : null}
          </span>
          {i === 1 ? <AnimatedSwitch /> : <Switch on={!!r[1]} lock={!!r[2]} />}
        </St>
      ))}
      <St i={5} className="mt-3 rounded-[14px] bg-surface-2 px-3.5 py-3">
        <div className="text-[12px] text-text-3">What Grace Church sees</div>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[13px] font-semibold">
          <span>Harvest Point · Phase 1</span>
          <Swap p={(v) => out(P(v, 2600, 380)) * R_SHARE(v)} className="justify-items-end" a={<Badge status="unknown" size="sm">Findings not shared</Badge>} b={<Badge status="positive" size="sm">On track</Badge>} />
        </div>
      </St>
    </PanelCard>
  );
}
const SWITCH = "relative h-[22px] w-9 flex-none overflow-hidden rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]";
const KNOB = "absolute top-[3px] left-[3px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.2)] will-change-transform";
function Switch({ on, lock }: { on: boolean; lock: boolean }) {
  return (
    <span className={cn(SWITCH, lock && "opacity-60")}>
      <b className={cn("absolute inset-0 rounded-full bg-green-500", on ? "opacity-100" : "opacity-0")} />
      <i className={cn(KNOB, on && "[transform:translateX(14px)]")} />
    </span>
  );
}
/** The findings switch the cursor turns on. */
function AnimatedSwitch() {
  const t = useT();
  const ref = useTarget("t0");
  const on = (v: number) => P(v, 2300, 380) * R_SHARE(v);
  const pressT = useTransform(t, (v) => press(v, 2200, 0.08));
  const fill = useTransform(t, (v) => +out(on(v)).toFixed(3));
  const knob = useTransform(t, (v) => "translate3d(" + (14 * back(on(v))).toFixed(2) + "px,0,0)");
  return (
    <m.span ref={ref} className={cn(SWITCH, "will-change-transform")} style={{ transform: pressT }}>
      <m.b className="absolute inset-0 rounded-full bg-green-500 opacity-0" style={{ opacity: fill }} />
      <m.i className={KNOB} style={{ transform: knob }} />
    </m.span>
  );
}
