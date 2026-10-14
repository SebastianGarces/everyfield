"use client";

import { frame, useInView, useReducedMotion, type MotionValue } from "motion/react";
import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { cn } from "../cn";
import { useDataAttr } from "../motion/scene";

// Evry's animated avatar (design/everyfield-ui.html). The body morphs, the eyes blink and glance, and a "follow" bot looks
// toward the pointer. Mood (idle, talking, happy) comes from the scene clock as a data attribute. All of it runs only
// while the bot is on screen; reduced motion stops every animation (foundations.md: Evry animations are off).

const SIZE = { sm: 24, lg: 40 } as const;
const EYE =
  "absolute top-[36%] h-[calc(var(--s)*.23)] w-[calc(var(--s)*.13)] origin-center rounded-full bg-ink animate-eb-blink " +
  "group-data-[blink]/eb:animate-eb-blink-now motion-reduce:animate-none " +
  // Highlight in the eye (large bots only, not when happy).
  "after:absolute after:top-[18%] after:left-[22%] after:h-[22%] after:w-[34%] after:rounded-full after:bg-white/85 after:content-[''] " +
  "group-data-[size=sm]/eb:after:hidden group-data-[mood=happy]/eb:after:hidden " +
  // Happy: the eyes become arcs.
  "group-data-[mood=happy]/eb:top-[40%] group-data-[mood=happy]/eb:h-[calc(var(--s)*.1)] group-data-[mood=happy]/eb:w-[calc(var(--s)*.17)] " +
  "group-data-[mood=happy]/eb:rounded-b-none group-data-[mood=happy]/eb:border-[length:calc(var(--s)*.055)] group-data-[mood=happy]/eb:border-b-0 " +
  "group-data-[mood=happy]/eb:border-ink group-data-[mood=happy]/eb:bg-transparent group-data-[mood=happy]/eb:animate-none";

type Props = { size: keyof typeof SIZE; mood?: MotionValue<string>; follow?: boolean; className?: string };

export function EvryBot({ size, mood, follow, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref);
  const reduced = useReducedMotion();
  const live = seen && !reduced;

  // Each bot blinks on its own rhythm. Random values are set after mount, so server and client markup match.
  useEffect(() => {
    const b = ref.current;
    if (!b) return;
    b.style.setProperty("--blink", (3.8 + Math.random() * 3).toFixed(2) + "s");
    b.style.setProperty("--blink-delay", (-Math.random() * 4).toFixed(2) + "s");
  }, []);

  // Now and then an extra blink or a short glance (idle only).
  useEffect(() => {
    const b = ref.current;
    if (!b || !live) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (f: () => void, ms: number) => { const id = setTimeout(() => { timers.delete(id); f(); }, ms); timers.add(id); };
    const look = (x: number, y: number) => { b.style.setProperty("--lx", x + "px"); b.style.setProperty("--ly", y + "px"); };
    const life = () => {
      if (Math.random() < 0.35) { b.setAttribute("data-blink", ""); later(() => b.removeAttribute("data-blink"), 200); }
      if (Math.random() < 0.25 && b.dataset.mood === "idle" && !b.hasAttribute("data-following")) {
        const r = () => (Math.random() * 2 - 1) * SIZE[size] * 0.07;
        look(r(), r() * 0.7);
        later(() => look(0, 0), 900 + Math.random() * 900);
      }
      later(life, 1400 + Math.random() * 1600);
    };
    later(life, 1400 + Math.random() * 1600);
    return () => timers.forEach(clearTimeout);
  }, [live, size]);

  // A follow bot looks toward the pointer. Its box is read in Motion's read step, before any style write of that frame.
  useEffect(() => {
    const b = ref.current;
    if (!b || !follow || !live) return;
    let rest: ReturnType<typeof setTimeout> | undefined;
    const onMove = (e: PointerEvent) => {
      if (b.dataset.mood !== "idle") return;
      frame.read(() => {
        const r = b.getBoundingClientRect();
        if (!r.width) return;
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy) || 1, k = (Math.min(1, d / 300) * r.width * 0.09) / d;
        frame.render(() => {
          b.setAttribute("data-following", "");
          b.style.setProperty("--lx", dx * k + "px");
          b.style.setProperty("--ly", dy * k + "px");
        });
      });
      clearTimeout(rest);
      rest = setTimeout(() => { b.removeAttribute("data-following"); b.style.setProperty("--lx", "0px"); b.style.setProperty("--ly", "0px"); }, 1600);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => { document.removeEventListener("pointermove", onMove); clearTimeout(rest); };
  }, [follow, live]);

  return (
    <span
      ref={ref}
      data-size={size}
      data-mood="idle"
      data-idle={live ? undefined : ""}
      aria-hidden="true"
      className={cn("group/eb relative inline-block flex-none align-middle [--lx:0px] [--ly:0px]", className)}
      style={{ "--s": SIZE[size] + "px", width: SIZE[size], height: SIZE[size] } as CSSProperties}
    >
      {mood ? <Mood target={ref} mood={mood} /> : null}
      <span
        className={
          "absolute inset-0 rounded-[46%_54%_52%_48%/50%_46%_54%_50%] animate-eb-morph motion-reduce:animate-none " +
          "bg-[radial-gradient(circle_at_30%_26%,rgba(255,255,255,.55),rgba(255,255,255,0)_42%),#1CE362] " +
          "shadow-[inset_0_calc(var(--s)*-.08)_0_rgba(10,60,30,.18),0_calc(var(--s)*.06)_calc(var(--s)*.16)_-0.05em_rgba(10,60,30,.35)] " +
          "group-data-[mood=happy]/eb:animate-eb-bounce motion-reduce:group-data-[mood=happy]/eb:animate-none"
        }
      />
      <span className="absolute inset-0 [transform:translate(var(--lx),var(--ly))] [transition:transform_.35s_cubic-bezier(.3,1.4,.5,1)] motion-reduce:[transition:none]">
        <span className={cn(EYE, "left-[31%] group-data-[mood=happy]/eb:left-[27%]")} />
        <span className={cn(EYE, "left-[56%]")} />
        <span
          className={
            "absolute top-[66%] left-1/2 -ml-[calc(var(--s)*.08)] h-[calc(var(--s)*.05)] w-[calc(var(--s)*.16)] rounded-full bg-ink opacity-0 " +
            "group-data-[mood=talking]/eb:animate-eb-talk group-data-[mood=talking]/eb:opacity-100 motion-reduce:animate-none"
          }
        />
      </span>
    </span>
  );
}

function Mood({ target, mood }: { target: RefObject<HTMLSpanElement | null>; mood: MotionValue<string> }) {
  useDataAttr(target, "data-mood", mood);
  return null;
}
