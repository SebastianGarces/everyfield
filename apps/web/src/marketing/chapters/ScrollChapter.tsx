"use client";

import { motionValue, useTransform, type MotionValue } from "motion/react";
import { m } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { cn } from "@/components/cn";
import { inOut, out, P, sine } from "@/components/motion/curves";
import { useTicker, useReduced } from "@/components/motion/scene";
import { SCENES, type PanelKind } from "../scene-data";
import { PanelSlotProvider, type PanelSlot } from "./panel-frame";

export type ChapterStep = {
  /** The panel kind (timing) and its element, rendered on the server. */
  kind: PanelKind;
  panel: ReactNode;
  /** The gradient tone utility of the panel background (g-field ...). */
  tone: string;
  /** The step text, rendered on the server. It holds [data-txt] (the fading block) and [data-tl] (the title row). */
  text: ReactNode;
};
type Props = {
  id: string;
  /** The heading, split into plain text and the step phrases (index of the step it belongs to). */
  title: (string | { w: number; text: string })[];
  steps: ChapterStep[];
};

/* Revision 13 timings and geometry. */
const DWELL = 800;
const SHARE = 0.72;
const DESK = "(min-width: 901px)";

/** Lock lines, scroll room and thresholds of the stacked steps, computed from one set of reads. */
type Geo = {
  stack: boolean;
  fold: boolean;
  st: number[]; mt: number[]; pb: number[];
  tail: number; olMb: number; rightMb: number; gridPb: number;
  /** Each step's natural top inside the list (where it would sit if it were not sticky) and the viewport line it
   *  becomes active at. A step is active once its natural top has passed its line. */
  nat: number[];
  lines: number[];
  /** The viewport height the lines were measured against (the sentinels' root band ends at the line). */
  vh: number;
};

/**
 * The home week chapter. Desktop (above 900 px): the heading and the panel are sticky; each step rises and locks under
 * the heading (stacked), and the panel crossfades to the active step. The active step follows the scroll position
 * through IntersectionObserver sentinels placed from geometry measured on resize, and moves one step at a time with an
 * 800 ms dwell.
 * Phones and tablets: each step has its own panel above it, which plays while it is on screen.
 */
export function ScrollChapter({ id, title, steps }: Props) {
  const n = steps.length;
  const reduced = useReduced();
  const root = useRef<HTMLElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const ol = useRef<HTMLOListElement>(null);
  const vis = useRef<HTMLDivElement>(null);
  const lis = useRef<(HTMLLIElement | null)[]>([]);
  const mobs = useRef<(HTMLDivElement | null)[]>([]);

  // Clocks: one scene time and one stagger clock per desktop panel and per phone panel, and the switch clock (time
  // since the active step changed) that drives the crossfade.
  const [clocks] = useState(() => {
    const mt = steps.map(() => motionValue(0)), msince = steps.map(() => motionValue(1e6));
    return {
      sw: motionValue(0),
      sel: motionValue(sel(0, -1)),
      t: steps.map(() => motionValue(0)),
      since: steps.map(() => motionValue(1e6)),
      mt,
      msince,
      // Stable slot objects: a new object per render would re-render every animated element of every panel.
      mob: steps.map((_, i): PanelSlot => ({ t: mt[i]!, since: msince[i]!, stagger: 90, place: "mob" })),
    };
  });
  const [active, setActiveState] = useState(0);
  const [desk, setDesk] = useState(false);
  const [on, setOn] = useState(false);
  const [mobOn, setMobOn] = useState<boolean[]>(() => steps.map(() => false));
  const [geo, setGeo] = useState<Geo | null>(null);

  const st = useRef({ active: 0, target: 0, at: 0, tm: 0 as ReturnType<typeof setTimeout> | 0, on: false, seen: false });

  const still = useCallback((k: number) => SCENES[steps[k]!.kind].still, [steps]);
  const setActive = useCallback((k: number) => {
    const s = st.current;
    if (k === s.active) return;
    clocks.sel.set(sel(k, s.active));
    s.active = k;
    setActiveState(k);
    if (reduced) { clocks.sw.set(1e6); clocks.since[k]!.set(1e6); clocks.t[k]!.set(still(k)); return; }
    clocks.sw.set(0); clocks.since[k]!.set(0); clocks.t[k]!.set(0);
  }, [clocks, reduced, still]);

  /* The shown step moves toward the target one step at a time and holds each step at least DWELL ms. */
  const go = useCallback(() => {
    const s = st.current;
    const step = () => {
      clearTimeout(s.tm); s.tm = 0;
      if (s.target === s.active) return;
      const now = performance.now();
      if (!s.on || reduced) { setActive(s.target); s.at = now; return; }
      let wait = s.at + DWELL - now;
      if (wait <= 0) { setActive(s.active + (s.target > s.active ? 1 : -1)); s.at = now; wait = DWELL; }
      if (s.target !== s.active) s.tm = setTimeout(step, wait + 1);
    };
    step();
  }, [reduced, setActive]);
  useEffect(() => () => clearTimeout(st.current.tm), []);

  // Reduced motion: every panel shows its still frame and nothing ticks.
  useEffect(() => {
    if (!reduced) return;
    clocks.sw.set(1e6);
    steps.forEach((_, k) => { clocks.t[k]!.set(still(k)); clocks.since[k]!.set(1e6); clocks.mt[k]!.set(still(k)); clocks.msince[k]!.set(1e6); });
  }, [reduced, clocks, steps, still]);

  // Layout mode from a media query, not from the DOM (the old engine read offsetParent every frame here).
  useEffect(() => {
    const mq = matchMedia(DESK);
    const set = () => setDesk(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  /* Geometry: read once per resize (ResizeObserver, fonts, desktop window height), never per frame. */
  const measure = useCallback(() => {
    const H = head.current, O = ol.current, V = vis.current;
    if (!H || !O || !V || !matchMedia(DESK).matches) { setGeo(null); return; }
    const vh = window.innerHeight, y0 = window.scrollY;
    const headTop = parseFloat(getComputedStyle(H).top) || 0, headH = H.offsetHeight;
    const olTop = O.getBoundingClientRect().top + y0; // document position, only to express the steps relative to the list
    const items = lis.current.map((li) => {
      const txt = li!.querySelector<HTMLElement>("[data-txt]")!, tl = li!.querySelector<HTMLElement>("[data-tl]")!;
      return { txt: txt.offsetHeight, tl: tl.offsetHeight, off: tl.getBoundingClientRect().top - li!.getBoundingClientRect().top };
    });
    const visH = V.offsetHeight;
    const h = items.map((it, i) => it.txt + 70 + (i ? 1 : 0));
    const x = Math.max(0, visH - headH);
    const stack = !reduced;
    let next: Geo;
    if (stack) {
      const base = headTop + headH, S = Math.round(vh * SHARE);
      const full = h.reduce((a, b) => a + b, 0), fits = base + full <= vh - 24;
      const c = items.map((it, i) => (fits ? h[i]! : it.tl + 70 + (i ? 1 : 0)));
      let lead = 0, top = 0;
      for (let i = 0; i < n; i++) lead = Math.max(lead, h[i]! - c[i]!);
      lead = Math.max(60, lead + 8);
      const lock: number[] = [];
      for (let i = 0; i < n; i++) { lock[i] = base + top; if (i < n - 1) top += c[i]!; }
      const listH = top + h[n - 1]!;
      const pb = h.map((hi, i) => Math.max(0, listH - (lock[i]! - base) - hi));
      const mt = h.map((_, i) => (i ? S + c[i - 1]! - h[i - 1]! - pb[i - 1]! + (i === 1 ? lead : 0) : 0));
      // Where each step would sit if it were not sticky: it locks once that point reaches its lock line.
      const nat: number[] = [];
      let acc = olTop;
      for (let i = 0; i < n; i++) { acc += mt[i]!; nat[i] = acc; acc += h[i]! + pb[i]!; }
      next = {
        stack, fold: !fits, st: lock, mt, pb, tail: S - lead, olMb: -listH, rightMb: -x, gridPb: Math.max(x, listH - 36),
        nat: nat.map((v) => v - olTop), lines: lock.map((l) => l + lead), vh,
      };
    } else {
      // Reduced motion: a plain list under the sticky heading; a step is active once its top passes the previous
      // step's title (the old cxScroll rule), computed from the same stored geometry.
      const nat: number[] = [];
      let acc = olTop;
      for (let i = 0; i < n; i++) { nat[i] = acc; acc += h[i]!; }
      // Once the heading has stuck, its bottom is headTop + headH, so each line is fixed (before that no step can pass).
      const cap = vh * 0.6;
      next = {
        stack, fold: false, st: [], mt: [], pb: [], tail: 0, olMb: -h[n - 1]!, rightMb: -x, gridPb: x,
        nat: nat.map((v) => v - olTop), lines: h.map((_, i) => (i ? Math.min(headTop + headH + h[i - 1]! - items[i - 1]!.off + 28, cap) : 0)), vh,
      };
    }
    setGeo((g) => (g && sameGeo(g, next) ? g : next));
  }, [n, reduced]);

  useEffect(() => {
    const r = root.current;
    if (!r) return;
    const ro = new ResizeObserver(measure);
    ro.observe(r);
    ro.observe(document.body);
    void document.fonts.ready.then(measure);
    // The stack share depends on the window height (desktop only; phones never listen, so the address bar costs nothing).
    const mq = matchMedia(DESK);
    const onResize = () => { if (mq.matches) measure(); };
    window.addEventListener("resize", onResize, { passive: true });
    return () => { ro.disconnect(); window.removeEventListener("resize", onResize); };
  }, [measure]);

  /* The target step from IntersectionObserver sentinels, so no scroll handler or frame callback reads layout (the
     prototype read getBoundingClientRect on every scroll frame). Each sentinel runs from its step's natural top to the
     end of the list, and its root is the band of the viewport above the step's line. A step has passed its line when
     its sentinel meets that band or lies wholly above it. A jump of any size changes the intersection state, so the
     observer always reports it (a 1 px sentinel could jump over a thin band without a report). */
  const sentinels = useRef<(HTMLSpanElement | null)[]>([]);
  const jumped = useRef(false);
  useEffect(() => {
    if (!geo) return;
    const passed = steps.map(() => false);
    let seen = 0;
    const ios = geo.lines.map((line, i) => {
      const el = sentinels.current[i];
      if (!i || !el) return null;
      const io = new IntersectionObserver(([e]) => {
        if (!e) return;
        passed[i] = e.isIntersecting || e.boundingClientRect.top < line;
        seen++;
        const s = st.current;
        s.target = passed.lastIndexOf(true) < 0 ? 0 : passed.lastIndexOf(true);
        // The first report of every sentinel sets the step at once (a page opened mid-chapter).
        if (!jumped.current && seen >= n - 1) { jumped.current = true; clearTimeout(s.tm); setActive(s.target); s.at = performance.now(); return; }
        if (jumped.current) go();
      }, { rootMargin: `0px 0px ${-Math.max(0, Math.round(geo.vh - line))}px 0px`, threshold: 0 });
      io.observe(el);
      return io;
    });
    return () => ios.forEach((io) => io?.disconnect());
  }, [geo, n, steps, go, setActive]);

  /* On screen: the desktop panel (12 % visible) and each phone panel. */
  useEffect(() => {
    const V = vis.current;
    if (!V) return;
    const io = new IntersectionObserver((es) => {
      const e = es[es.length - 1]!, s = st.current;
      if (e.isIntersecting && !s.seen && !reduced) {
        s.seen = true;
        clocks.sw.set(0); clocks.since[s.active]!.set(0); clocks.t[s.active]!.set(0);
      }
      if (e.isIntersecting && !s.on) s.at = performance.now();
      s.on = e.isIntersecting;
      setOn(e.isIntersecting);
      go();
    }, { threshold: 0.12 });
    io.observe(V);
    const mio = new IntersectionObserver((es) => {
      setMobOn((cur) => {
        const next = [...cur];
        for (const e of es) {
          const k = mobs.current.indexOf(e.target as HTMLDivElement);
          if (k < 0) continue;
          if (e.isIntersecting && !cur[k] && !reduced) { clocks.mt[k]!.set(0); clocks.msince[k]!.set(0); }
          next[k] = e.isIntersecting;
        }
        return next;
      });
    }, { threshold: 0.12 });
    mobs.current.forEach((el) => el && mio.observe(el));
    return () => { io.disconnect(); mio.disconnect(); };
  }, [clocks, go, reduced]);

  /* One frame step for everything that is on screen. */
  const anyMob = mobOn.some(Boolean);
  useTicker(!reduced && (desk ? on : anyMob), (dt) => {
    if (desk) {
      const k = st.current.active, S = SCENES[steps[k]!.kind];
      clocks.sw.set(clocks.sw.get() + dt);
      clocks.since[k]!.set(clocks.sw.get());
      const t = clocks.t[k]!;
      t.set(S.once ? Math.min(t.get() + dt, S.end ?? S.L) : (t.get() + dt) % S.L);
      return;
    }
    mobOn.forEach((o, k) => {
      if (!o) return;
      const S = SCENES[steps[k]!.kind], t = clocks.mt[k]!;
      clocks.msince[k]!.set(clocks.msince[k]!.get() + dt);
      t.set(S.once ? Math.min(t.get() + dt, S.end ?? S.L) : (t.get() + dt) % S.L);
    });
  });

  useStepReveal(lis, reduced);

  const stack = !!geo?.stack && desk;
  return (
    <section ref={root} id={id} data-fold={stack && geo?.fold ? "" : undefined} className="group/chap relative scroll-mt-[88px] py-section max-mk-sm:scroll-mt-[76px] [--cx-top:clamp(148px,2.5vw+126px,162px)]">
      <div className="mx-auto max-w-mk px-page">
        <div className="grid grid-cols-12 items-start gap-4" style={desk && geo ? { paddingBottom: geo.gridPb } : undefined}>
          <div className="col-span-5 min-w-0 max-mk-cx:col-span-12">
            <div
              ref={head}
              className={cn(
                "sticky top-(--cx-top) z-3 border-b border-mk-line bg-mk-canvas pb-[26px]",
                "before:absolute before:inset-x-0 before:bottom-full before:h-(--cx-top) before:bg-mk-canvas before:content-['']",
                "after:pointer-events-none after:absolute after:inset-x-0 after:top-[calc(100%+1px)] after:h-5 after:bg-[linear-gradient(var(--color-mk-canvas),rgba(252,251,248,0))] after:content-['']",
                "max-mk-cx:static max-mk-cx:border-b-0 max-mk-cx:pb-2 max-mk-cx:before:hidden max-mk-cx:after:hidden",
              )}
            >
              <h2 className="mk-display text-mk-h2 mk-cx:motion-safe:text-[color-mix(in_srgb,var(--color-ink)_52%,var(--color-mk-canvas))]">
                {title.map((p, i) =>
                  typeof p === "string" ? (
                    p
                  ) : (
                    <span key={i} className={cn("mk-cx:motion-safe:[transition:color_.3s_var(--ease-mk)]", active === p.w && "mk-cx:motion-safe:text-ink")}>
                      {p.text}
                    </span>
                  ),
                )}
              </h2>
            </div>
            <div className="relative">
            {desk && geo
              ? geo.nat.map((top, i) => (i ? <span key={i} ref={(el) => { sentinels.current[i] = el; }} aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 w-px" style={{ top }} /> : null))
              : null}
            <ol
              ref={ol}
              className={cn(stack && "flex flex-col after:h-(--cx-tail) after:flex-none after:content-['']")}
              style={desk && geo ? ({ marginBottom: geo.olMb, "--cx-tail": geo.tail + "px" } as CSSProperties) : undefined}
            >
              {steps.map((s, i) => (
                <li
                  key={i}
                  ref={(el) => { lis.current[i] = el; }}
                  data-on={i === active}
                  data-past={i < active ? "" : undefined}
                  className={cn(
                    "group/step border-t border-mk-line pt-[34px] first:border-t-0 max-mk-cx:border-t-0 max-mk-cx:pt-[22px] max-mk-cx:pb-[18px]",
                    stack ? "sticky top-(--cx-st) mt-(--cx-mt) bg-mk-canvas pb-[calc(36px+var(--cx-pb))]" : "pb-9",
                  )}
                  style={stack && geo ? ({ "--cx-st": geo.st[i] + "px", "--cx-mt": geo.mt[i] + "px", "--cx-pb": geo.pb[i] + "px" } as CSSProperties) : undefined}
                >
                  <div
                    ref={(el) => { mobs.current[i] = el; }}
                    aria-hidden="true"
                    className="ef-ui relative isolate mb-[22px] hidden place-items-center overflow-hidden rounded-card px-4 pt-11 pb-7 shadow-[inset_0_0_0_1px_rgba(24,29,25,.06)] max-mk-cx:grid"
                    data-idle={mobOn[i] && !reduced ? undefined : ""}
                  >
                    <span className={cn("mk-gsurf absolute inset-0 z-0 will-change-[opacity] [--grain:.3]", s.tone)} />
                    <PanelSlotProvider slot={clocks.mob[i]!}>{s.panel}</PanelSlotProvider>
                  </div>
                  {s.text}
                </li>
              ))}
            </ol>
            </div>
          </div>
          <div className="col-span-6 col-start-7 min-w-0 self-stretch max-mk-cx:hidden" style={desk && geo ? { marginBottom: geo.rightMb } : undefined}>
            <div
              ref={vis}
              aria-hidden="true"
              data-idle={on && !reduced ? undefined : ""}
              className="ef-ui sticky top-(--cx-top) isolate grid h-[min(560px,calc(100vh-var(--cx-top)-28px))] min-h-[500px] place-items-center overflow-hidden rounded-frame shadow-[inset_0_0_0_1px_rgba(24,29,25,.06),0_30px_60px_-40px_rgba(24,29,25,.3)]"
            >
              {steps.map((s, i) => <DeskBg key={i} tone={s.tone} sw={clocks.sw} sel={clocks.sel} i={i} />)}
              {steps.map((s, i) => (
                <DeskPanel key={i} sw={clocks.sw} sel={clocks.sel} i={i} t={clocks.t[i]!} since={clocks.since[i]!} place="vis">
                  {s.panel}
                </DeskPanel>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function sameGeo(a: Geo, b: Geo) {
  return a.stack === b.stack && a.fold === b.fold && a.tail === b.tail && a.olMb === b.olMb && a.rightMb === b.rightMb && a.gridPb === b.gridPb &&
    a.st.join() === b.st.join() && a.mt.join() === b.mt.join() && a.pb.join() === b.pb.join() &&
    a.nat.join() === b.nat.join() && a.lines.join() === b.lines.join() && a.vh === b.vh;
}

export type Role = "active" | "prev" | "idle";
/** The shown step and the one fading out, packed in one number (active * 16 + prev + 1) so it can feed a multi-input
 *  transform. Set in the same call that restarts the switch clock, so a panel's style never waits for a React render
 *  to learn its new role. */
export const sel = (a: number, p: number) => a * 16 + p + 1;
const roleOf = (i: number, r: number): Role => (i === r >> 4 ? "active" : i === (r & 15) - 1 ? "prev" : "idle");
/** Panel crossfade (the hero's curves): the old card out 250 ms sine, 6 px up; the new card in after 150 ms, 380 ms ease-out, 8 px lift. */
export function cardFrame(role: Role, s: number) {
  if (role === "active") { const pin = out(P(s, 150, 380)); return { o: pin, y: (1 - pin) * 8 }; }
  if (role === "prev") { const po = sine(P(s, 0, 250)); return { o: 1 - po, y: -6 * po }; }
  return { o: 0, y: 0 };
}
export function DeskPanel({ sw, sel, i, t, since, place, children }: { sw: MotionValue<number>; sel: MotionValue<number>; i: number; t: MotionValue<number>; since: MotionValue<number>; place: "vis" | "auto"; children: ReactNode }) {
  const f = ([s, r]: number[]) => cardFrame(roleOf(i, r!), s!);
  const transform = useTransform([sw, sel], (v: number[]) => "translate3d(0px," + f(v).y.toFixed(2) + "px,0)");
  const opacity = useTransform([sw, sel], (v: number[]) => +f(v).o.toFixed(3));
  const visibility = useTransform([sw, sel], (v: number[]): string => (f(v).o > 0 ? "visible" : "hidden"));
  const slot = useMemo((): PanelSlot => ({ t, since, stagger: 240, place, card: { transform, opacity, visibility } }), [t, since, place, transform, opacity, visibility]);
  return <PanelSlotProvider slot={slot}>{children}</PanelSlotProvider>;
}
/** The active step's gradient fades in over the previous one (500 ms in-out). Layers use z 0 to 2 (not negative):
 *  axe sorted a negative z-index gradient above the white card and reported false contrast failures. */
export function DeskBg({ tone, sw, sel, i }: { tone: string; sw: MotionValue<number>; sel: MotionValue<number>; i: number }) {
  const opacity = useTransform([sw, sel], ([s, r]: number[]) => { const k = roleOf(i, r!); return +(k === "active" ? inOut(P(s!, 0, 500)) : k === "prev" ? 1 : 0).toFixed(3); });
  const zIndex = useTransform(sel, (r) => (r >> 4 === i ? 1 : 0));
  return <m.span aria-hidden="true" className={cn("mk-gsurf absolute inset-0 opacity-0 will-change-[opacity] [--grain:.3]", tone)} style={{ opacity, zIndex }} />;
}

/**
 * Steps below the fold rise in once (hero stagger, 75 ms apart). A step is marked data-rv="wait" only after the first
 * IntersectionObserver report says it is below 90 % of the viewport, and "in" when it enters; CSS does the rest.
 */
export function useStepReveal(lis: RefObject<(HTMLElement | null)[]>, reduced: boolean) {
  useEffect(() => {
    if (reduced) return;
    const ios: IntersectionObserver[] = [];
    lis.current.forEach((li) => {
      if (!li) return;
      let first = true;
      const io = new IntersectionObserver(([e]) => {
        if (!e) return;
        if (first) {
          first = false;
          const vh = e.rootBounds ? e.rootBounds.bottom / 0.9 : 0;
          if (e.boundingClientRect.top < vh * 0.9) { io.disconnect(); return; }
          li.dataset.rv = "wait";
          return;
        }
        if (e.isIntersecting) { li.dataset.rv = "in"; io.disconnect(); }
      }, { rootMargin: "0px 0px -10% 0px", threshold: 0.05 });
      io.observe(li);
      ios.push(io);
    });
    return () => ios.forEach((io) => io.disconnect());
  }, [lis, reduced]);
}
