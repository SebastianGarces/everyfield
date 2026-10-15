"use client";

import { m, motionValue, useTransform, type MotionValue } from "motion/react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/components/cn";
import { clamp } from "@/components/motion/curves";
import { useTicker, useReduced } from "@/components/motion/scene";
import { SCENES, type PanelKind } from "../scene-data";
import { Reveal } from "@/components/motion/Reveal";
import { DeskBg, DeskPanel, useStepReveal, sel } from "./ScrollChapter";

export type AutoStep = { kind: PanelKind; panel: ReactNode; tone: string; title: string; body: string };
type Props = {
  id: string;
  /** The section heading block (h2 with id `${id}-title`), rendered on the server. */
  head: ReactNode;
  /** Mirrored (Revision 19): the panel on the left, the heading in the list column. */
  mirror?: boolean;
  steps: AutoStep[];
  /** The section right after the phases rail rises in as one block (Revision 16). */
  revealUp?: boolean;
};

/* Revision 17: every step lasts the longest panel plus this hold. */
const HOLD = 1200;

/**
 * An auto-advancing list (Revision 10/17): the steps are ARIA tabs and the panel is their tab panel. When a step becomes
 * active its panel plays once to its end and holds; a line under the step fills over the step's time, then the next
 * step starts. Progress holds while the section is off screen or a tab has keyboard focus. Reduced motion: no advance
 * and no fill; the active line is full and the tabs still switch.
 */
export function AutoList({ id, head, mirror, steps, revealUp }: Props) {
  const n = steps.length;
  const reduced = useReduced();
  const root = useRef<HTMLElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const lis = useRef<(HTMLLIElement | null)[]>([]);
  const dur = Math.max(...steps.map((s) => SCENES[s.kind].end ?? 0)) + HOLD;
  const [c] = useState(() => ({ sw: motionValue(0), sel: motionValue(sel(0, -1)), prog: motionValue(0), t: steps.map(() => motionValue(0)), since: steps.map(() => motionValue(1e6)) }));
  const [active, setActive] = useState(0);
  const [on, setOn] = useState(false);
  const [kbd, setKbd] = useState(false);
  const s = useRef({ active: 0, seen: false });

  const still = useCallback((k: number) => SCENES[steps[k]!.kind].still, [steps]);
  /** Shows step k from its start (a click on the active step restarts its panel). */
  const goTo = useCallback((k: number) => {
    c.prog.set(0);
    if (k !== s.current.active) { c.sel.set(sel(k, s.current.active)); s.current.active = k; setActive(k); }
    if (reduced) { c.sw.set(1e6); c.since[k]!.set(1e6); c.t[k]!.set(still(k)); return; }
    c.sw.set(0); c.since[k]!.set(0); c.t[k]!.set(0);
  }, [c, reduced, still]);

  useEffect(() => {
    if (!reduced) return;
    c.sw.set(1e6); c.prog.set(0);
    steps.forEach((_, k) => { c.t[k]!.set(still(k)); c.since[k]!.set(1e6); });
  }, [reduced, c, steps, still]);

  // Revision 11: the list counts as on screen while any part of it shows.
  useEffect(() => {
    const r = root.current;
    if (!r) return;
    const io = new IntersectionObserver((es) => {
      const e = es[es.length - 1]!;
      if (e.isIntersecting && !s.current.seen && !reduced) {
        s.current.seen = true;
        const k = s.current.active;
        c.sw.set(0); c.since[k]!.set(0); c.t[k]!.set(0); c.prog.set(0);
      }
      setOn(e.isIntersecting);
    }, { threshold: 0 });
    io.observe(r);
    return () => io.disconnect();
  }, [c, reduced]);

  useTicker(on && !reduced, (dt) => {
    if (!kbd) {
      c.prog.set(c.prog.get() + dt);
      // The new step's panel advances in the same frame it starts (the prototype's order).
      if (c.prog.get() >= dur) goTo((s.current.active + 1) % n);
    }
    const k = s.current.active, S = SCENES[steps[k]!.kind];
    c.sw.set(c.sw.get() + dt);
    c.since[k]!.set(c.sw.get());
    c.t[k]!.set(Math.min(c.t[k]!.get() + dt, S.end ?? S.L));
  });

  useStepReveal(lis, reduced);

  const onKey = (e: KeyboardEvent, i: number) => {
    let k = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") k = (i + 1) % n;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") k = (i + n - 1) % n;
    else if (e.key === "Home") k = 0;
    else if (e.key === "End") k = n - 1;
    if (k < 0) return;
    e.preventDefault();
    goTo(k);
    tabs.current[k]?.focus();
    setKbd(true);
  };

  const list = (
    <ol role="tablist" aria-orientation="vertical" aria-labelledby={id + "-title"} className="grid">
      {steps.map((st, i) => (
        <li key={i} ref={(el) => { lis.current[i] = el; }} role="presentation" data-on={i === active} className="group/step">
          <button
            ref={(el) => { tabs.current[i] = el; }}
            type="button"
            role="tab"
            id={`${id}-tab-${i}`}
            aria-controls={id + "-panel"}
            aria-selected={i === active}
            tabIndex={i === active ? 0 : -1}
            onClick={() => goTo(i)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              "relative block w-full cursor-pointer rounded-none border-0 bg-transparent pt-[15px] pb-[17px] text-left text-inherit",
              mirror ? "mk-cx:pt-[14px] mk-cx:pb-4" : "mk-cx:pt-[31px] mk-cx:pb-[33px]",
            )}
          >
            <Bar prog={c.prog} dur={dur} active={i === active} reduced={reduced} />
            <span
              className={cn(
                "block [transition:opacity_.25s_cubic-bezier(.37,0,.63,1)] group-data-[on=false]/step:[:not(:hover)>&]:opacity-[.82] motion-reduce:[transition:none]",
                "group-data-[rv]/step:*:[transition:opacity_.42s_var(--ease-mk-out),transform_.42s_var(--ease-mk-out)]",
                "group-data-[rv=wait]/step:*:opacity-0 group-data-[rv=wait]/step:*:[transform:translateY(14px)] group-data-[rv=in]/step:[&>:nth-child(2)]:[transition-delay:75ms]",
              )}
            >
              <span className="block font-display text-[clamp(18px,1.4vw,21px)] leading-[1.15] font-medium tracking-[-0.02em] [font-stretch:100%] [text-wrap:balance]">{st.title}</span>
              <span className="mt-2 block max-w-[46ch] text-text-2">{st.body}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );

  return (
    <section
      ref={root}
      id={id}
      className="relative scroll-mt-[88px] py-section max-mk-sm:scroll-mt-[76px]"
      onFocus={(e) => setKbd(e.target instanceof Element && e.target.matches(":focus-visible"))}
      onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) setKbd(false); }}
    >
      <Wrap up={revealUp}>
        {mirror ? null : head}
        <div className="grid grid-cols-12 items-center gap-4">
          <div className={cn("col-span-5 min-w-0 max-mk-cx:col-span-12", mirror && "mk-cx:order-2 mk-cx:col-start-8 mk-cx:row-start-1")}>
            {mirror ? head : null}
            {list}
          </div>
          <div className={cn("col-span-6 min-w-0 self-stretch max-mk-cx:col-span-12", mirror ? "mk-cx:order-1 mk-cx:col-start-1 mk-cx:row-start-1" : "col-start-7 max-mk-cx:col-start-1")}>
            <div
              role="tabpanel"
              id={id + "-panel"}
              aria-labelledby={`${id}-tab-${active}`}
              data-idle={on && !reduced ? undefined : ""}
              className="ef-ui relative isolate grid h-[560px] place-items-center overflow-hidden rounded-frame shadow-[inset_0_0_0_1px_rgba(24,29,25,.06),0_30px_60px_-40px_rgba(24,29,25,.3)] max-mk-cx:h-auto max-mk-cx:grid-cols-[minmax(0,1fr)] max-mk-cx:rounded-card max-mk-cx:px-4 max-mk-cx:pt-11 max-mk-cx:pb-7"
            >
              {steps.map((st, i) => <DeskBg key={i} tone={st.tone} sw={c.sw} sel={c.sel} i={i} />)}
              {steps.map((st, i) => (
                <div key={i} aria-hidden="true" className="contents">
                  <DeskPanel sw={c.sw} sel={c.sel} i={i} t={c.t[i]!} since={c.since[i]!} place="auto">
                    {st.panel}
                  </DeskPanel>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Wrap>
    </section>
  );
}

function Wrap({ up, children }: { up?: boolean; children: ReactNode }) {
  return up ? <Reveal up className="mx-auto max-w-mk px-page">{children}</Reveal> : <div className="mx-auto max-w-mk px-page">{children}</div>;
}

/** The step line: a hairline, and the active step's fill growing left to right over the step's time. */
function Bar({ prog, dur, active, reduced }: { prog: MotionValue<number>; dur: number; active: boolean; reduced: boolean }) {
  const transform = useTransform(prog, (p) => "scaleX(" + (active ? (reduced ? 1 : clamp(p / dur)) : 0).toFixed(4) + ")");
  return (
    <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-mk-line before:content-['']">
      <m.i className="absolute inset-0 origin-left rounded-[2px] bg-ink will-change-transform" style={{ transform }} />
    </span>
  );
}
