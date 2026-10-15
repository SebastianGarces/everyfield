"use client";

import { useTransform } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { FxProvider, useT, useTarget } from "@/components/motion/fx";
import { m } from "@/components/motion/m";
import { back, bump, clamp, inOut, out, P, pop, press, reset, rise, sine, swapIn, swapOut, transformOf } from "@/components/motion/curves";
import { useGeo } from "../chapters/panel-frame";
import { CX_PEOPLE, CX_TEAMS } from "../demo-data";
import { CHIP } from "./classes";

// Timing of the home week chapter panels: reach, gather, follow up, commit (week.tsx renders their markup on the server).
// Each panel is a pure function of its clock t (ms); the prototype's timings are kept 1:1 (cxScene).

const meterBar = (v: number, of: number) => "translate3d(" + (-100 + (v / of) * 100).toFixed(2) + "%,0,0)";

/* 1. People */
const R_PEOPLE = (t: number) => reset(t, 5800);
const peopleRow = (t: number, k: number) => {
  const r = CX_PEOPLE[k]!, p = out(P(t, 300 + k * 90, 900)), imp = inOut(P(t, 2350, 800));
  return (r[3] * p + (k === 0 ? (r[2] - r[3]) * imp : 0)) * R_PEOPLE(t);
};
const peopleTotal = (t: number) => CX_PEOPLE.reduce((a, _, k) => a + peopleRow(t, k), 0) + 20 * out(P(t, 300, 900)) * R_PEOPLE(t);

/* 2. Meet */
const R_MEET = (t: number) => reset(t, 6500);
const flashR = (t: number, a: number, b: number) => out(P(t, a, 250)) * (1 - sine(P(t, b, 300))) * R_MEET(t);

/* 3. Follow */
const R_FOLLOW = (t: number) => reset(t, 7900);
const openE = (t: number) => out(P(t, 2900, 450)) * R_FOLLOW(t);
const rowAt = (k: number) => 1300 + k * 500;
const checked = (t: number, k: number) => out(P(t, 5150 + k * 120, 380)) * R_FOLLOW(t);

/* 4. Teams */
const R_TEAMS = (t: number) => reset(t, 7000);
const base = (t: number) => out(P(t, 300, 900));
const teamAt = (k: number) => (k ? 3300 : 1700);

const FX = {
  "people.R": R_PEOPLE,
  "people.total": peopleTotal,
  "people.added": (t: number) => pop(t, 2250, R_PEOPLE(t)),
  "people.row": peopleRow,
  "people.meter": (t: number, k: number) => meterBar(peopleRow(t, k), 82),
  "people.note": (t: number) => rise(t, 3300, R_PEOPLE(t)),
  "meet.R": R_MEET,
  "meet.pickPress": (t: number) => press(t, 1100, 0.03),
  "meet.pickFocus": (t: number) => flashR(t, 1150, 2450),
  "meet.roll": (t: number) => {
    let k = 0;
    for (let i = 0; i < 4; i++) k += inOut(P(t, 1350 + i * 280, 200));
    return "translate3d(0," + (-k * 20 * R_MEET(t)).toFixed(3) + "%,0)";
  },
  "meet.whenFocus": (t: number) => flashR(t, 2450, 2950),
  "meet.whenType": (t: number) => P(t, 2500, 450),
  "meet.whereFocus": (t: number) => flashR(t, 2950, 3400),
  "meet.whereType": (t: number) => P(t, 3000, 350),
  "meet.badge": (t: number) => pop(t, 4500, R_MEET(t)),
  "meet.bump": (t: number) => "scale(" + (1 + 0.06 * bump(t, 4950, 260)).toFixed(4) + ")",
  "meet.count": (t: number) => 12 * out(P(t, 3850, 1100)) * R_MEET(t),
  "meet.drop": (t: number, j: number) => { const p = P(t, 3800 + j * 160, 420); return [0, -16 * (1 - back(p)), 1, clamp(p * 2.5) * R_MEET(t)]; },
  "follow.R": R_FOLLOW,
  "follow.mood": (t: number) => (t >= 600 && t < 4300 ? "talking" : t >= 5100 && t < 6600 ? "happy" : "idle"),
  "follow.draft": (t: number) => { const e = openE(t); return [0, 0, 0.96 + 0.04 * e, e]; },
  "follow.type": (t: number) => P(t, 3150, 1200),
  "follow.swap": (t: number) => out(P(t, 5150, 380)) * R_FOLLOW(t),
  "follow.avOut": (t: number, k: number) => swapOut(checked(t, k)),
  "follow.avIn": (t: number, k: number) => swapIn(checked(t, k)),
  "follow.task": (t: number, k: number) => out(P(t, rowAt(k), 380)) * R_FOLLOW(t),
  "follow.who": (t: number, k: number) => pop(t, rowAt(k) + 150, R_FOLLOW(t)),
  "teams.R": R_TEAMS,
  "teams.bump": (t: number, k: number) => "scale(" + (1 + 0.08 * bump(t, teamAt(k) + 950, 280)).toFixed(4) + ")",
  "teams.count": (t: number, k: number) => Math.round((Math.round(CX_TEAMS[k]![3] * base(t)) + (t >= teamAt(k) + 950 ? 1 : 0)) * R_TEAMS(t)),
  "teams.meter": (t: number, k: number) => meterBar((CX_TEAMS[k]![3] * base(t) + out(P(t, teamAt(k) + 950, 400))) * R_TEAMS(t), 40),
};

export function WeekFx({ children }: { children: ReactNode }) {
  return <FxProvider fx={FX}>{children}</FxProvider>;
}

/** The rows under the draft move up by the closed draft's height, so the closed card has no gap. */
export function FollowRest({ children }: { children: ReactNode }) {
  const t = useT();
  const { boxes, measured } = useGeo();
  const dh = () => (boxes.current.draft?.h ?? 0) + 8;
  const dn = useTransform([t, measured], ([v]: number[]) => transformOf(0, -dh() * (1 - openE(v!)), 1));
  return <m.div className="will-change-transform" style={{ transform: dn }}>{children}</m.div>;
}

/**
 * The card's white shell follows the draft as it opens, so the closed card has no empty space. Compositor only: a static
 * top piece, a middle piece that scales in height, and a bottom piece that moves up by the closed amount. The white
 * ring runs around all three without overlapping. The shadow piece scales as one.
 */
export function Shell() {
  const t = useT();
  const { boxes, measured } = useGeo();
  const g = () => {
    const H = boxes.current.card?.h ?? 0, dh = (boxes.current.draft?.h ?? 0) + 8;
    return { H, dh, S: Math.max(0, Math.round(H - dh - 30)) };
  };
  const cut = (v: number) => g().dh * (1 - openE(v));
  const shade = useTransform([t, measured], ([v]: number[]) => { const { H } = g(); return H ? "scaleY(" + ((H - cut(v!)) / H).toFixed(4) + ")" : "none"; });
  const mid = useTransform([t, measured], ([v]: number[]) => { const { dh } = g(); return dh > 8 ? "scaleY(" + ((dh - cut(v!)) / dh).toFixed(4) + ")" : "none"; });
  const bottom = useTransform([t, measured], ([v]: number[]) => transformOf(0, -cut(v!), 1));
  const top = useTransform(measured, () => `inset(-8px -8px ${g().H - g().S}px -8px)`);
  const midTop = useTransform(measured, () => g().S + "px");
  const midH = useTransform(measured, () => g().dh + "px");
  const botClip = useTransform(measured, () => `inset(${g().S + g().dh}px -8px -8px -8px)`);
  const piece = "pointer-events-none absolute -z-1 bg-white";
  return (
    <>
      <m.span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-1 origin-top rounded-[22px] shadow-mk-panel-body will-change-transform" style={{ transform: shade }} />
      <m.span aria-hidden="true" className={cn(piece, "inset-0 rounded-[22px] shadow-[var(--ui-ring)]")} style={{ clipPath: top }} />
      <m.span aria-hidden="true" className={cn(piece, "inset-x-0 origin-top shadow-mk-ring-sides will-change-transform")} style={{ top: midTop, height: midH, transform: mid }} />
      <m.span aria-hidden="true" className={cn(piece, "inset-0 rounded-[22px] shadow-[var(--ui-ring)] will-change-transform")} style={{ clipPath: botClip, transform: bottom }} />
    </>
  );
}

/** The person chip leaves the row and moves into its team. */
export function Fly({ k, children }: { k: number; children: ReactNode }) {
  const at = teamAt(k), land = at + 950;
  const t = useT();
  const fly = useTarget("fly" + k);
  const { boxes, measured } = useGeo();
  const f = (v: number) => {
    const b = boxes.current, a = b["src" + k], d = b["dst" + k], c = b["fly" + k];
    if (!a || !d || !c) return null;
    const mm = inOut(P(v, at + 250, 700));
    const x0 = a.x - 4, y0 = a.y + (a.h - 30) / 2, x1 = d.x + d.w - c.w - 44, y1 = d.y - 1;
    return { x: x0 + (x1 - x0) * mm, y: y0 + (y1 - y0) * mm - 18 * Math.sin(Math.PI * mm), s: 1 + 0.06 * Math.sin(Math.PI * mm), o: out(P(v, at + 200, 200)) * (1 - sine(P(v, land - 50, 250))) };
  };
  const transform = useTransform([t, measured], ([v]: number[]) => { const x = f(v!); return x ? transformOf(x.x, x.y, x.s) : "none"; });
  const opacity = useTransform([t, measured], ([v]: number[]) => { const x = f(v!); return x ? +x.o.toFixed(3) : 0; });
  return (
    <m.span ref={fly} className={cn(CHIP, "pointer-events-none absolute top-0 left-0 z-7 h-[30px] gap-[7px] pr-3 pl-1 text-[13px] opacity-0 will-change-[transform,opacity]")} style={{ transform, opacity }}>
      {children}
    </m.span>
  );
}
