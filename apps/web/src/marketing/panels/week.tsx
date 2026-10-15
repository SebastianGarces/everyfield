"use client";

import { m, useTransform } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Av, StageChip, type Tone } from "@/components/kit/kit";
import { EvryBot } from "@/components/kit/EvryBot";
import { back, bump, clamp, inOut, out, P, pop, press, reset, rise, sine, swapIn, swapOut, transformOf } from "@/components/motion/curves";
import { St } from "@/components/motion/scene";
import { PanelCard, useGeo, useTarget } from "../chapters/panel-frame";
import { ICONS } from "../icons";
import { CX_DRAFT, CX_PEOPLE, CX_SIGNS, CX_TEAMS, CX_TYPES } from "../scene-data";
import { CHIP, Count, Done, Fade, Field, Head, Lab, Move, Num, PIcon, Swap, Tf, Typed, useT } from "./parts";

// The home week chapter: reach, gather, follow up, commit. Each panel is a pure function of its clock t (ms); the prototype's
// timings are kept 1:1 (design/everyfield-marketing.html, cxScene).

const TONE: Record<string, Tone> = { "tone-ink": "ink", "tone-blue": "blue", "tone-amber": "amber", "tone-violet": "violet", "tone-green": "green", "tone-teal": "teal" };
const tone = (k: string) => TONE[k] ?? "ink";
const meterBar = (v: number, of: number) => "translate3d(" + (-100 + (v / of) * 100).toFixed(2) + "%,0,0)";

/** A thin meter (8 px in the chapters) whose fill slides in. */
function Meter({ f, color }: { f: (t: number) => string; color: string }) {
  return (
    <div className="relative mt-[5px] h-2 overflow-hidden rounded-full bg-surface-2">
      <Tf f={f} className="absolute inset-0 rounded-full">
        <span className="absolute inset-0 rounded-full" style={{ background: color }} />
      </Tf>
    </div>
  );
}

/* ---------- 1. People: counts rise, a list is imported, the new people land in Prospect ---------- */
const R_PEOPLE = (t: number) => reset(t, 5800);
const peopleRow = (t: number, k: number) => {
  const r = CX_PEOPLE[k]!, p = out(P(t, 300 + k * 90, 900)), imp = inOut(P(t, 2350, 800));
  return (r[3] * p + (k === 0 ? (r[2] - r[3]) * imp : 0)) * R_PEOPLE(t);
};
const peopleTotal = (t: number) => CX_PEOPLE.reduce((a, _, k) => a + peopleRow(t, k), 0) + 20 * out(P(t, 300, 900)) * R_PEOPLE(t);
const PEOPLE_MAX = CX_PEOPLE.reduce((a, r) => a + r[2], 0) + 20;

export function PeoplePanel() {
  return (
    <PanelCard kind="people">
      <Head
        lead={<PIcon tone="ink" icon={ICONS.users} />}
        title="Where people are"
        sub={<>Harvest Point · <Count value={peopleTotal} max={PEOPLE_MAX} unit=" people" /></>}
        right={<Done target="t0" at={2000} label="Import list" done="Added" R={R_PEOPLE} />}
      />
      <St i={1} className="mt-0.5 mb-3 h-[30px]">
        <Move as="span" f={(t) => pop(t, 2250, R_PEOPLE(t))} className="inline-flex h-[30px] items-center gap-[7px] rounded-full bg-green-50 pr-3 pl-2 text-[12.5px] font-semibold whitespace-nowrap text-green-700 opacity-0 shadow-[inset_0_0_0_1px_rgba(28,227,98,.35)]">
          <Icon icon={ICONS.check} size={15} />
          24 people added from the sign-up form
        </Move>
      </St>
      <div className="grid gap-2.5">
        {CX_PEOPLE.map((r, k) => (
          <St key={r[1]} i={k + 2}>
            <div className="flex min-h-[26px] items-center gap-2">
              <StageChip tone={tone(r[0])}>{r[1]}</StageChip>
              <Num className="ml-auto text-[17px]"><Count value={(t) => peopleRow(t, k)} max={r[2]} /></Num>
            </div>
            <Meter f={(t) => meterBar(peopleRow(t, k), 82)} color={r[4]} />
          </St>
        ))}
      </div>
      <St i={7}>
        <Move f={(t) => rise(t, 3300, R_PEOPLE(t))} className="mt-3.5 rounded-[14px] bg-white px-4 py-3.5 text-[13px] font-semibold opacity-0 shadow-[0_1px_2px_rgba(24,29,25,.04)]">
          14 interviewed people have not committed yet.
        </Move>
      </St>
    </PanelCard>
  );
}

/* ---------- 2. Meet: a gathering is created, guests check in ---------- */
const R_MEET = (t: number) => reset(t, 6500);
const flashR = (t: number, a: number, b: number) => out(P(t, a, 250)) * (1 - sine(P(t, b, 300))) * R_MEET(t);
const GUESTS = [["KW", "Kim Wu"], ["JO", "James Okafor"]] as const;

export function MeetPanel() {
  const t0 = useTarget("t0");
  return (
    <PanelCard kind="meet">
      <Head lead={<PIcon tone="blue" icon={ICONS.calendar} />} title="New gathering" sub="Harvest Point" right={<Done target="t1" at={3300} label="Create" done="Created" R={R_MEET} />} />
      <St i={1}>
        <Lab>Type</Lab>
        <TypePicker innerRef={t0} />
      </St>
      <St i={2} className="mt-3 grid grid-cols-2 gap-2.5">
        <div className="min-w-0">
          <Lab>When</Lab>
          <Field fr={(t) => flashR(t, 2450, 2950)}>
            <Faded><Typed text="Sun Oct 12, 5 pm" p={(t) => P(t, 2500, 450)} className="min-w-0 flex-1" /></Faded>
          </Field>
        </div>
        <div className="min-w-0">
          <Lab>Where</Lab>
          <Field fr={(t) => flashR(t, 2950, 3400)}>
            <Faded><Typed text="Reyes home" p={(t) => P(t, 3000, 350)} className="min-w-0 flex-1" /></Faded>
          </Field>
        </div>
      </St>
      <St i={3} className="mt-3.5 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Lab flush>Checked in</Lab>
            <Move as="span" f={(t) => pop(t, 4500, R_MEET(t))} className="grid opacity-0">
              <BadgeSm>3 new guests</BadgeSm>
            </Move>
          </span>
          <Tf f={(t) => "scale(" + (1 + 0.06 * bump(t, 4950, 260)).toFixed(4) + ")"} className="grid origin-bottom-right font-display text-[22px] leading-none font-medium">
            <Count value={(t) => 12 * out(P(t, 3850, 1100)) * R_MEET(t)} max={12} />
          </Tf>
        </div>
        <div className="mt-2.5 flex h-[30px] flex-nowrap gap-1.5 overflow-hidden">
          {GUESTS.map((g, j) => (
            <Drop key={g[1]} j={j}><Av small>{g[0]}</Av>{g[1]}</Drop>
          ))}
          <Drop j={2} more>10 more</Drop>
        </div>
      </St>
    </PanelCard>
  );
}
/** The typed text fades with the loop reset. */
function Faded({ children }: { children: ReactNode }) {
  return <Fade f={R_MEET} className="min-w-0 flex-1">{children}</Fade>;
}
function BadgeSm({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-white px-2 text-[11.5px] font-semibold whitespace-nowrap text-text shadow-mk-badge before:size-[7px] before:rounded-full before:bg-blue-500 before:content-['']">
      {children}
    </span>
  );
}
/** The type picker steps through each kind of gathering, then lands on Vision meeting. */
function TypePicker({ innerRef }: { innerRef: (el: HTMLElement | null) => void }) {
  const t = useT();
  const pressT = useTransform(t, (v) => press(v, 1100, 0.03));
  const roll = useTransform(t, (v) => {
    let k = 0;
    for (let i = 0; i < 4; i++) k += inOut(P(v, 1350 + i * 280, 200));
    return "translate3d(0," + (-k * 20 * R_MEET(v)).toFixed(3) + "%,0)";
  });
  return (
    <m.div ref={innerRef} className="will-change-transform" style={{ transform: pressT }}>
      <Field fr={(v) => flashR(v, 1150, 2450)}>
        <span className="inline-block h-[1.3em] overflow-hidden align-bottom leading-[1.3em] tabular-nums">
          <m.span className="block will-change-transform" style={{ transform: roll }}>
            {CX_TYPES.map((x, i) => <i key={i} className="block not-italic">{x}</i>)}
          </m.span>
        </span>
        <Icon icon={ICONS.arrow} size={15} className="ml-auto rotate-90 text-text-3" />
      </Field>
    </m.div>
  );
}
/** A guest chip drops in from above. */
function Drop({ j, more, children }: { j: number; more?: boolean; children: ReactNode }) {
  return (
    <Move
      as="span"
      f={(t) => { const p = P(t, 3800 + j * 160, 420); return [0, -16 * (1 - back(p)), 1, clamp(p * 2.5) * R_MEET(t)]; }}
      className={cn(CHIP, "h-7 flex-none gap-[7px] pr-2.5 text-[12px] opacity-0", more ? "pl-2.5" : "pl-1")}
    >
      {children}
    </Move>
  );
}

/* ---------- 3. Follow: Evry turns new guests into follow-ups, drafts one, you approve ---------- */
const R_FOLLOW = (t: number) => reset(t, 7900);
const openE = (t: number) => out(P(t, 2900, 450)) * R_FOLLOW(t);
const FGUESTS = [["KW", "Kim Wu", "TO", "Tom"], ["JO", "James Okafor", "TO", "Tom"], ["SN", "Sara Nunez", "AN", "Ana"]] as const;

export function FollowPanel() {
  const t = useT();
  const mood = useTransform<number, string>(t, (v) => (v >= 600 && v < 4300 ? "talking" : v >= 5100 && v < 6600 ? "happy" : "idle"));
  const draft = useTarget("draft");
  const { boxes, measured } = useGeo();
  const dh = () => (boxes.current.draft?.h ?? 0) + 8;
  const dn = useTransform([t, measured], ([v]: number[]) => transformOf(0, -dh() * (1 - openE(v!)), 1));
  return (
    <PanelCard kind="follow" variant={{ kind: "clip" }}>
      <Shell />
      <Head lead={<EvryBot size="lg" mood={mood} />} title="Evry" sub="3 new guests from Sunday's vision meeting" />
      <St i={1}><FollowRow g={FGUESTS[0]} k={0} /></St>
      <Move innerRef={draft} f={(v) => { const e = openE(v); return [0, 0, 0.96 + 0.04 * e, e]; }} className="mb-2 ml-8 origin-top rounded-[12px] bg-surface px-3 py-2.5 text-[12.5px] leading-[1.45] text-ink-2 opacity-0 shadow-[inset_0_0_0_1px_var(--color-line)]">
        <span className="mb-1 flex items-center gap-[5px] text-[11.5px] font-semibold text-text-3"><Icon icon={ICONS.sparkle} size={13} />Drafted for Tom</span>
        <Typed text={CX_DRAFT} p={(v) => P(v, 3150, 1200)} />
      </Move>
      <m.div className="will-change-transform" style={{ transform: dn }}>
        <St i={2}><FollowRow g={FGUESTS[1]} k={1} /></St>
        <St i={3}><FollowRow g={FGUESTS[2]} k={2} /></St>
        <St i={4} className="mt-3.5 flex items-center justify-between gap-2.5">
          <Swap p={(v) => out(P(v, 5150, 380)) * R_FOLLOW(v)} className="text-[12.5px]" a={<span className="text-text-3">Nothing is saved until you approve.</span>} b={<span className="text-text-3">Assigned to Tom and Ana</span>} />
          <Done target="t0" at={4900} label="Approve" done="Approved" R={R_FOLLOW} />
        </St>
      </m.div>
    </PanelCard>
  );
}
function FollowRow({ g, k }: { g: (typeof FGUESTS)[number]; k: number }) {
  const at = 1300 + k * 500;
  return (
    <div className="flex h-[50px] items-center gap-2.5">
      <span className="inline-grid flex-none">
        <Move as="span" f={(v) => swapOut(out(P(v, 5150 + k * 120, 380)) * R_FOLLOW(v))} className="col-start-1 row-start-1"><Av>{g[0]}</Av></Move>
        <Move as="span" f={(v) => swapIn(out(P(v, 5150 + k * 120, 380)) * R_FOLLOW(v))} className="col-start-1 row-start-1 grid size-[22px] place-items-center rounded-full bg-green-500 text-ink opacity-0">
          <Icon icon={ICONS.check} size={13} className="[&_path]:[stroke-width:2.6]" />
        </Move>
      </span>
      <span className="min-w-0 flex-1">
        <Swap
          p={(v) => out(P(v, at, 380)) * R_FOLLOW(v)}
          block
          a={<><L1>{g[1]}</L1><L2>New guest</L2></>}
          b={<><L1>Follow up with {g[1]}</L1><L2>Due Oct 10</L2></>}
        />
      </span>
      <Move as="span" f={(v) => pop(v, at + 150, R_FOLLOW(v))} className={cn(CHIP, "h-[26px] gap-[7px] pr-[9px] pl-[3px] text-[12px] opacity-0")}>
        <Av who>{g[2]}</Av>
        {g[3]}
      </Move>
    </div>
  );
}
function L1({ children }: { children: ReactNode }) {
  return <span className="block overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap">{children}</span>;
}
function L2({ children }: { children: ReactNode }) {
  return <span className="mt-px block text-[11.5px] font-medium text-text-3">{children}</span>;
}
/**
 * The card's white shell follows the draft as it opens, so the closed card has no empty space. Compositor only: a static
 * top piece, a middle piece that scales in height, and a bottom piece that moves up by the closed amount. The white
 * ring runs around all three without overlapping. The shadow piece scales as one.
 */
function Shell() {
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
      <m.span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-1 origin-top rounded-[22px] shadow-[0_0_0_1px_rgba(24,29,25,.05),0_1px_2px_rgba(24,29,25,.05),0_26px_50px_-26px_rgba(24,29,25,.4)] will-change-transform" style={{ transform: shade }} />
      <m.span aria-hidden="true" className={cn(piece, "inset-0 rounded-[22px] shadow-[var(--ui-ring)]")} style={{ clipPath: top }} />
      <m.span aria-hidden="true" className={cn(piece, "inset-x-0 origin-top shadow-[-6px_0_0_0_rgba(255,255,255,.25),6px_0_0_0_rgba(255,255,255,.25)] will-change-transform")} style={{ top: midTop, height: midH, transform: mid }} />
      <m.span aria-hidden="true" className={cn(piece, "inset-0 rounded-[22px] shadow-[var(--ui-ring)] will-change-transform")} style={{ clipPath: botClip, transform: bottom }} />
    </>
  );
}

/* ---------- 4. Teams: commitments are recorded, each person moves into a team ---------- */
const R_TEAMS = (t: number) => reset(t, 7000);
const base = (t: number) => out(P(t, 300, 900));
const teamAt = (k: number) => (k ? 3300 : 1700);

export function TeamsPanel() {
  return (
    <PanelCard kind="teams">
      <Head lead={<PIcon tone="violet" icon={ICONS.users} />} title="Your teams" sub="Harvest Point · committed adults" />
      {CX_TEAMS.map((r, k) => <Team key={r[1]} k={k} />)}
      <St i={3} className="mt-[18px] border-t border-line pt-3 text-[12px] font-semibold text-text-2">To record</St>
      {CX_SIGNS.map((r, k) => <Sign key={r[1]} k={k} />)}
      {CX_SIGNS.map((r, k) => <Fly key={r[1]} k={k} />)}
    </PanelCard>
  );
}
function Team({ k }: { k: number }) {
  const r = CX_TEAMS[k]!, land = teamAt(k) + 950;
  const dst = useTarget("dst" + k);
  return (
    <St i={k + 1} className="mt-3">
      <div ref={dst}>
        <div className="flex min-h-[28px] items-center justify-between gap-2">
          <StageChip tone={tone(r[0])}>{r[1]}</StageChip>
          <Tf f={(t) => "scale(" + (1 + 0.08 * bump(t, land, 280)).toFixed(4) + ")"} className="grid origin-bottom-right font-display text-[22px] leading-none font-medium">
            <Count value={(t) => Math.round((Math.round(r[3] * base(t)) + (t >= land ? 1 : 0)) * R_TEAMS(t))} max={r[3] + 1} />
          </Tf>
        </div>
        <Meter f={(t) => meterBar((r[3] * base(t) + out(P(t, land, 400))) * R_TEAMS(t), 40)} color={r[2]} />
      </div>
    </St>
  );
}
function Sign({ k }: { k: number }) {
  const r = CX_SIGNS[k]!;
  const src = useTarget("src" + k);
  return (
    <St i={k + 4} className={cn("relative isolate flex items-center gap-3", k ? "border-t border-line py-3" : "pt-2 pb-3")}>
      <span ref={src} className="grid size-[30px] flex-none place-items-center rounded-full bg-green-100 text-[10.5px] font-bold tracking-[.02em] text-green-700">{r[0]}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">{r[1]}</div>
        <div className="mt-0.5 text-[12.5px] text-text-3">{r[2]}</div>
      </div>
      <Done target={k ? "t1" : "t0"} at={teamAt(k)} label="Record" done="Recorded" R={R_TEAMS} />
    </St>
  );
}
/** The person chip leaves the row and moves into its team. */
function Fly({ k }: { k: number }) {
  const r = CX_SIGNS[k]!, at = teamAt(k), land = at + 950;
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
      <Av>{r[0]}</Av>
      {r[1]}
    </m.span>
  );
}
