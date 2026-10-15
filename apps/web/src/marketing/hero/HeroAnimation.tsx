"use client";

import { PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { m, useInView, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@/components/cn";
import { Icon } from "@/components/Icon";
import { Av, CardIcon, NUM, StageChip } from "@/components/kit/kit";
import { EvryBot } from "@/components/kit/EvryBot";
import { back, bump, clamp, inOut, out, P, sine, transformOf } from "@/components/motion/curves";
import { MText, useText, useTicker, useTo, useReduced } from "@/components/motion/scene";
import { DoneButton } from "@/components/motion/DoneButton";
import { ICONS } from "../icons";
import { HA_DRAFT, HA_NAME } from "../scene-data";

/* ---------- Timing (Revision 8 table: the one place to tune the hero loop; ms) ----------
   Five cards share one grid cell and crossfade. Maria's chip glides from a hidden slot in each card to the next.
   Every style is a pure function of the loop time t. Reduced motion renders the final frame (STILL) once. */
const TM = { act: 1.5, hold: [1700, 1800, 1800, 1800, 3000], lead: [700, 450, 250, 500, 150], span: [1870, 380, 2800, 1130, 1220], cardIn: 380, cardOut: 250, gap: 150, moveAt: 50, move: 650, seam: 250, chipFade: 230 };
const SC: [number, number][] = [], A: number[] = [], MOVES: [number, number, number, number][] = [];
let LOOP = 0;
{
  let a = -TM.seam;
  for (let i = 0; i < 5; i++) {
    const s = a + TM.lead[i]!, b = s + TM.span[i]! * TM.act + TM.hold[i]!;
    SC.push([a, b]); A.push(s);
    if (i < 4) MOVES.push([b + TM.moveAt, b + TM.moveAt + TM.move, i, i + 1]);
    a = b + TM.gap;
  }
  LOOP = SC[4]![1] + TM.seam;
}
const STILL = A[4]! + 1400 * TM.act; /* final frame: Maria in the core group, highlight on */
const at = (i: number, ms: number) => A[i]! + ms * TM.act;
const d = (ms: number) => ms * TM.act;

type Pos = { x: number; y: number };
const LABEL = "Example: Maria Lopez is added, comes to a vision meeting, gets a follow-up that Evry drafted and you approved, commits, and joins the core group.";

/**
 * The home hero: one person, from first contact to the core group. The loop runs only while the stage is on screen
 * and not paused; reduced motion shows the last scene and no pause button.
 */
export function HeroAnimation() {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const slots = useRef<(HTMLSpanElement | null)[]>([]);
  const t = useMotionValue(0);
  // Slot positions live in a ref; measured bumps a counter so the chip transform recomputes even while paused.
  const pos = useRef<Pos[]>([]);
  const measured = useMotionValue(0);
  const [paused, setPaused] = useState(false);
  const reduced = useReduced();
  const seen = useInView(stage);
  const run = seen && !paused && reduced === false;

  useEffect(() => { if (reduced) t.set(STILL); }, [reduced, t]);
  useTicker(run, (dt) => t.set((t.get() + dt) % LOOP));

  // Slot positions inside the stage, measured when the stage resizes and when the fonts arrive (never per frame).
  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    const measure = () => { pos.current = slots.current.map((s) => offsetIn(s, st)); measured.set(measured.get() + 1); };
    const ro = new ResizeObserver(measure);
    ro.observe(st);
    void document.fonts.ready.then(measure);
    return () => ro.disconnect();
  }, [measured]);

  const slot = (i: number) => (
    <span ref={(el) => { slots.current[i] = el; }} className="invisible inline-flex">
      <Maria />
    </span>
  );

  return (
    <div ref={root} className="relative mx-auto max-w-[1180px]" data-idle={run ? undefined : ""}>
      <div
        ref={stage}
        role="img"
        aria-label={LABEL}
        className="ef-ui relative isolate grid items-start justify-items-center overflow-hidden rounded-frame pt-6 pb-16 max-mk-sm:rounded-card max-mk-sm:pb-14"
      >
        <div aria-hidden="true" className="contents">
          <div className="col-start-1 row-start-1 w-[min(440px,calc(100%-32px))] self-stretch rounded-[22px] shadow-mk-hero-card max-mk-sm:w-[calc(100%-24px)]" />
          <div className="col-start-1 row-start-1 w-[min(440px,calc(100%-32px))] self-stretch rounded-[22px] bg-white max-mk-sm:w-[calc(100%-24px)]" />
          <Card t={t} i={0}>
            <Head t={t} i={0} lead={<CardIcon tone="green" icon={ICONS.users} size={36} glyph={17} />} title="Add person" sub="People" />
            <St t={t} i={0} k={1} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Lab>Name</Lab>
                <div className="flex h-10 items-center overflow-hidden rounded-[12px] bg-white px-3 text-[14px] whitespace-nowrap text-ink shadow-[inset_0_0_0_1.5px_var(--color-green-500),0_0_0_3px_rgba(28,227,98,.16)]">
                  <Typed t={t} />
                </div>
              </div>
              <AddButton t={t} />
            </St>
            <St t={t} i={0} k={2} className="mt-4">
              <Lab>Recently added</Lab>
              <Li first>{slot(0)}</Li>
              <Li><span className="skeleton block size-6 flex-none rounded-full" /><span className="skeleton block h-2" style={{ width: "46%" }} /></Li>
            </St>
          </Card>
          <Card t={t} i={1}>
            <Head t={t} i={1} lead={<CardIcon tone="blue" icon={ICONS.calendar} size={36} glyph={17} />} title="Vision meeting #12" sub="Sun, Oct 12 · 6:00 PM" />
            <Kv t={t} k={1} label="Type">Vision meeting</Kv>
            <Kv t={t} k={2} label="Host home"><Icon icon={ICONS.pin} className="text-text-3" />Hyde Park</Kv>
            <Kv t={t} k={3} label="Guests"><Roll t={t} a={8} b={9} p={(v) => inOut(P(v, at(1, 0), d(380)))} /></Kv>
            <St t={t} i={1} k={4} className="mt-2.5 flex flex-nowrap gap-2 overflow-hidden">
              <span className="skeleton inline-block h-[30px] w-16 flex-none" />
              <span className="skeleton inline-block h-[30px] w-16 flex-none" />
              {slot(1)}
            </St>
          </Card>
          <Card t={t} i={2}>
            <Head t={t} i={2} lead={<Bot t={t} />} title="Evry drafted a follow-up" sub="Due today. You approve it." />
            <St t={t} i={2} k={1} className="flex items-center gap-2.5 text-[12.5px] text-text-3"><span>To</span>{slot(2)}</St>
            <St t={t} i={2} k={2} className="relative mt-3 h-[88px] overflow-hidden rounded-[14px] bg-surface px-[13px] py-[11px] text-[13.5px] leading-[1.5] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <Caret t={t} show={(v) => v > at(2, 200) && v < at(2, 1850)} h={15}>
                <MText value={useText(t, (v) => HA_DRAFT.slice(0, Math.floor(P(v, at(2, 350), d(1350)) * HA_DRAFT.length)))} />
              </Caret>
            </St>
            <St t={t} i={2} k={3} className="mt-3.5 flex items-center justify-between gap-2.5">
              <span className="skeleton block h-2" style={{ width: "28%" }} />
              <DoneButton t={t} at={at(2, 1820)} scale={TM.act} press={330} label="Approve and send" done="Sent" />
            </St>
          </Card>
          <Card t={t} i={3}>
            <St t={t} i={3} k={0} className="mb-3.5 flex items-center justify-between gap-2.5">
              {slot(3)}
              <Flip t={t} />
            </St>
            {[["Vision meeting #12", "Attended"], ["Follow-up from Evry", "Sent"], ["Commitment card", "Signed"]].map((r, k) => (
              <St key={r[0]} t={t} i={3} k={k + 1} className="flex h-11 items-center gap-2.5 border-t border-line">
                <Check t={t} k={k} />
                <span className="min-w-0 flex-1 text-[13px] font-semibold">{r[0]}</span>
                <span className="text-[12.5px] text-text-3">{r[1]}</span>
              </St>
            ))}
            <St t={t} i={3} k={4}>
              <Li first><span className="skeleton block size-6 flex-none rounded-full" /><span className="skeleton block h-2" style={{ width: "52%" }} /></Li>
            </St>
          </Card>
          <Card t={t} i={4}>
            <Head t={t} i={4} lead={<CardIcon tone="ink" icon={ICONS.users} size={36} glyph={17} />} title="Where people are" sub="Harvest Point · this week" />
            <div className="grid gap-3">
              <Row t={t} k={0} chip={<StageChip tone="blue" className="flex-none">Attendee</StageChip>} num="41" />
              <Row t={t} k={1} chip={<StageChip tone="amber" className="flex-none">Following up</StageChip>} num={<Roll t={t} a={23} b={22} p={join} />} />
              <Row t={t} k={2} chip={<StageChip tone="green" className="flex-none">Core group</StageChip>} slot={slot(4)} num={<Roll t={t} a={34} b={35} p={join} />} hl />
            </div>
          </Card>
          <Live t={t} pos={pos} measured={measured} />
        </div>
      </div>
      <button
        type="button"
        aria-label={paused ? "Play animation" : "Pause animation"}
        onClick={() => setPaused((p) => !p)}
        className="absolute bottom-3.5 left-1/2 z-7 -ml-[17px] grid size-[34px] cursor-pointer place-items-center rounded-full border-0 bg-transparent text-ink hover:bg-white/35 motion-reduce:hidden"
      >
        <Icon icon={paused ? PlayIcon : PauseIcon} size={14} />
      </button>
    </div>
  );
}

/** Position of el inside stop, from the offset chain (layout is clean in a ResizeObserver callback). */
function offsetIn(el: HTMLElement | null, stop: HTMLElement): Pos {
  let x = 0, y = 0;
  while (el && el !== stop) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent as HTMLElement | null; }
  return { x, y };
}

const join = (v: number) => inOut(P(v, at(4, 500), d(520)));

type T = { t: MotionValue<number> };

/** One scene card: in 380 ms ease-out with an 8 px lift, out 250 ms sine (6 px up). Card 0 also covers the loop seam. */
function Card({ t, i, children }: T & { i: number; children: ReactNode }) {
  const s = useTo(t, (v) => {
    const u = i === 0 && v >= LOOP - 300 ? v - LOOP : v;
    const [a, b] = SC[i]!;
    const pin = out(P(u, a, TM.cardIn)), pout = sine(P(u, b, TM.cardOut));
    return [0, (1 - pin) * 8 - pout * 6, 1, pin * (1 - pout)];
  });
  return (
    <m.div className="relative col-start-1 row-start-1 will-change-[transform,opacity] w-[min(440px,calc(100%-32px))] rounded-[22px] px-5 pt-[18px] pb-5 opacity-0 max-mk-sm:w-[calc(100%-24px)] max-mk-sm:px-4 max-mk-sm:pt-4 max-mk-sm:pb-[18px]" style={s}>
      {children}
    </m.div>
  );
}

/** A card child that staggers in: 90 ms after the card, then 75 ms apart. */
function St({ t, i, k, className, children }: T & { i: number; k: number; className?: string; children: ReactNode }) {
  const s = useTo(t, (v) => {
    const u = i === 0 && v >= LOOP - 300 ? v - LOOP : v;
    const p = out(P(u, SC[i]![0] + 90 + k * 75, 420));
    return [0, (1 - p) * 8, 1, p];
  });
  return <m.div className={cn("will-change-[transform,opacity]", className)} style={s}>{children}</m.div>;
}

function Head({ t, i, lead, title, sub }: T & { i: number; lead: ReactNode; title: string; sub: string }) {
  return (
    <St t={t} i={i} k={0} className="mb-4 flex items-center gap-3">
      {lead}
      <div className="min-w-0 flex-1">
        <div className="font-display text-[17px] leading-[1.2] font-medium tracking-[-0.02em]">{title}</div>
        <div className="mt-0.5 text-[12.5px] text-text-3">{sub}</div>
      </div>
    </St>
  );
}

function Lab({ children }: { children: ReactNode }) {
  return <span className="mb-1.5 block text-[12px] font-semibold text-text-2">{children}</span>;
}
/** A list line; the first one of its group has no rule above it. */
function Li({ first, children }: { first?: boolean; children: ReactNode }) {
  return <div className={cn("flex h-11 items-center gap-2.5", !first && "border-t border-line")}>{children}</div>;
}
function Kv({ t, k, label, children }: T & { k: number; label: string; children: ReactNode }) {
  return (
    <St t={t} i={1} k={k} className="flex h-[38px] items-center justify-between gap-2.5 border-t border-line text-[13px] text-text-2">
      <span>{label}</span>
      <span className="inline-flex items-center gap-1.5 font-semibold text-ink">{children}</span>
    </St>
  );
}

function Maria({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-[30px] items-center gap-[7px] rounded-full bg-white pr-3 pl-1 text-[13px] font-semibold whitespace-nowrap text-ink shadow-mk-chip", className)}>
      <Av>ML</Av>
      {HA_NAME}
    </span>
  );
}

/** Scene 1: the name is typed, then fades as the chip pops out of the field. */
function Typed({ t }: T) {
  const text = useText(t, (v) => HA_NAME.slice(0, Math.floor(P(v, at(0, 0), d(1050)) * HA_NAME.length)));
  const opacity = useTransform(t, (v) => +(1 - P(v, at(0, 1550), d(220))).toFixed(3));
  return (
    <m.span style={{ opacity }}>
      <Caret t={t} show={(v) => v < at(0, 1500)} h={18}><MText value={text} /></Caret>
    </m.span>
  );
}
/**
 * Typed text with its caret: a 1.5 px stripe drawn as a background at the end of the text (1 px after it). The text box
 * only grows from a fixed start, so typing moves nothing (an inline caret element moved with every letter: a layout
 * shift each time). The stripe blinks with a CSS animation; show() hides it.
 */
function Caret({ t, show, h, children }: T & { show: (t: number) => boolean; h: number; children: ReactNode }) {
  const size = useTransform<number, string>(t, (v) => (show(v) ? `1.5px ${h}px` : "0px 0px"));
  return (
    <m.span
      className="[box-decoration-break:slice] bg-[linear-gradient(var(--color-ink),var(--color-ink))] bg-right bg-no-repeat pr-[2.5px] whitespace-pre-wrap animate-mk-caret motion-reduce:animate-none"
      style={{ backgroundSize: size }}
    >
      {children}
    </m.span>
  );
}
function AddButton({ t }: T) {
  const transform = useTransform(t, (v) => "scale(" + (1 - 0.05 * bump(v, at(0, 1250), d(200))).toFixed(4) + ")");
  return (
    <m.span className="relative inline-grid h-10 flex-none will-change-transform place-items-center overflow-hidden rounded-[12px] bg-ink px-4 text-[13px] font-semibold whitespace-nowrap text-white shadow-pill" style={{ transform }}>
      <span className="col-start-1 row-start-1 inline-flex items-center gap-1.5">Add</span>
    </m.span>
  );
}

/** A two-number roll (the count changes by one): the column moves up half its height. */
function Roll({ t, a, b, p }: T & { a: number; b: number; p: (t: number) => number }) {
  const transform = useTransform(t, (v) => "translate3d(0," + (-50 * p(v)).toFixed(3) + "%,0)");
  return (
    <span className="inline-block h-[1.2em] overflow-hidden align-bottom leading-[1.2em] tabular-nums">
      <m.span className="block will-change-transform" style={{ transform }}>
        <i className="block not-italic">{a}</i>
        <i className="block not-italic">{b}</i>
      </m.span>
    </span>
  );
}

function Bot({ t }: T) {
  const mood = useTransform<number, string>(t, (v) => (v >= at(2, 0) && v < at(2, 1800) ? "talking" : v >= at(2, 2150) && v < SC[2]![1] + 200 ? "happy" : "idle"));
  return <EvryBot size="lg" mood={mood} />;
}

/** Scene 4: the stage flips from Following up to Committed. */
function Flip({ t }: T) {
  const f = (v: number) => P(v, at(3, 750), d(380));
  const a = useTo(t, (v) => { const e = out(f(v)); return [0, -7 * e, 1, 1 - e]; });
  const b = useTo(t, (v) => { const p = f(v), e = out(p); return [0, 7 * (1 - e), 0.85 + 0.15 * back(p), e]; });
  return (
    <span className="inline-grid">
      <m.span className="col-start-1 row-start-1 justify-self-end will-change-[transform,opacity]" style={a}><StageChip tone="amber">Following up</StageChip></m.span>
      <m.span className="col-start-1 row-start-1 justify-self-end will-change-[transform,opacity]" style={b}><StageChip tone="green">Committed</StageChip></m.span>
    </span>
  );
}
function Check({ t, k }: T & { k: number }) {
  const s = useTo(t, (v) => { const p = P(v, at(3, k * 260), d(340)); return [0, 0, 0.4 + 0.6 * back(p), clamp(p * 2.5)]; });
  return (
    <m.span className="grid size-[22px] flex-none place-items-center rounded-full bg-green-500 text-ink will-change-[transform,opacity]" style={s}>
      <Icon icon={ICONS.check} className="[&_path]:[stroke-width:2.6]" />
    </m.span>
  );
}

/** Scene 5: the bars fill, Maria joins the core group (one out of Following up, one into Core group), a short highlight. */
const ROWS = [41, 23, 34] as const;
const METER = ["bg-blue-500", "bg-amber-500", "bg-green-500"] as const;
function Row({ t, k, chip, slot, num, hl }: T & { k: 0 | 1 | 2; chip: ReactNode; slot?: ReactNode; num: ReactNode; hl?: boolean }) {
  const transform = useTransform(t, (v) => {
    const p = out(P(v, at(4, k * 90), d(650))), j = join(v);
    const val = (ROWS[k] / 50) * p + (k === 2 ? j : k === 1 ? -j : 0) / 50;
    return "translate3d(" + (-100 + 100 * val).toFixed(2) + "%,0,0)";
  });
  const hlOpacity = useTransform(t, (v) => +(out(P(v, at(4, 400), d(300))) * (1 - sine(P(v, SC[4]![1] - 1500, d(600))))).toFixed(3));
  return (
    <St t={t} i={4} k={k + 1} className="relative">
      {hl ? <m.span className="absolute -inset-x-2.5 -inset-y-1.5 -z-1 rounded-[14px] bg-green-50 opacity-0 shadow-[inset_0_0_0_1px_rgba(28,227,98,.35)]" style={{ opacity: hlOpacity }} /> : null}
      <div className="flex min-h-[30px] items-center gap-2">
        {chip}
        {slot}
        <span className={cn(NUM, "ml-auto text-[18px]")}>{num}</span>
      </div>
      <div className="relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-surface-2">
        <m.span className={cn("absolute inset-0 rounded-full will-change-transform", METER[k])} style={{ transform }} />
      </div>
    </St>
  );
}

/** Maria's chip: pops in, then glides between the slots with a small lift, and fades at the loop seam. */
function Live({ t, pos, measured }: T & { pos: RefObject<Pos[]>; measured: MotionValue<number> }) {
  const frameOf = (v: number, P5: Pos[]) => {
    if (P5.length !== 5) return null;
    let x = P5[0]!.x, y = P5[0]!.y, s = 1, o = 0;
    const pp = P(v, at(0, 1450), d(420));
    if (v >= at(0, 1450)) { o = clamp(pp * 2); s = 0.6 + 0.4 * back(pp); }
    for (const mv of MOVES) {
      if (v < mv[0]) continue;
      const p = inOut(P(v, mv[0], mv[1] - mv[0])), from = P5[mv[2]]!, to = P5[mv[3]]!;
      x = from.x + (to.x - from.x) * p; y = from.y + (to.y - from.y) * p;
      s = 1 + 0.06 * Math.sin(Math.PI * p);
    }
    const fade = sine(P(v, SC[4]![1], TM.chipFade));
    return { x, y, s: s - 0.04 * fade, o: o * (1 - fade) };
  };
  const transform = useTransform([t, measured], ([v]: number[]) => { const f = frameOf(v!, pos.current); return f ? transformOf(f.x, f.y, f.s) : "none"; });
  const opacity = useTransform([t, measured], ([v]: number[]) => { const f = frameOf(v!, pos.current); return f ? +f.o.toFixed(3) : 0; });
  const ring = useTo(t, (v) => { const r = P(v, at(4, 420), d(800)); return [0, 0, 1 + 0.3 * out(r), r > 0 && r < 1 ? 0.8 * (1 - r) : 0]; });
  return (
    <m.span
      className="pointer-events-none absolute top-0 left-0 z-6 inline-flex h-[30px] origin-center items-center gap-[7px] rounded-full bg-white pr-3 pl-1 text-[13px] font-semibold whitespace-nowrap text-ink opacity-0 shadow-mk-chip will-change-[transform,opacity]"
      style={{ transform, opacity }}
    >
      <m.span className="absolute -inset-px rounded-full opacity-0 shadow-[0_0_0_2px_var(--color-green-500)]" style={ring} />
      <Av>ML</Av>
      {HA_NAME}
    </m.span>
  );
}

