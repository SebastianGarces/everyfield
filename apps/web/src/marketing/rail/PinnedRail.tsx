"use client";

import { useReduced } from "@/components/motion/scene";
import { m, useScroll, useTransform } from "motion/react";
import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/components/cn";
import { clamp } from "@/components/motion/curves";

type Props = { id: string; headingId: string; head: ReactNode; children: ReactNode };

/** Rail geometry for the pinned mode: start offset a, travel, sticky top, side inset, viewport width, pin top in the document. */
type Geo = { a: number; travel: number; stick: number; inset: number; vw: number; fh: number; pinTop: number };
const WIDE = "(min-width: 901px)";
/* Revision 16: where the first card's left edge sits when the section pins (share of the viewport width), moved left by
   one card step so one more full card shows at pin start. */
const START = 0.55, LEAD = 1;

const cardsOf = (list: HTMLOListElement | null) => [...(list?.children ?? [])] as HTMLElement[];
/** Distance between two cards (card width plus gap). */
function stepOf(list: HTMLOListElement | null, rail: HTMLDivElement | null) {
  const c = cardsOf(list);
  return c.length > 1 ? c[1]!.offsetLeft - c[0]!.offsetLeft : rail?.clientWidth ?? 0;
}

/**
 * The phases rail (Marketing v15). Desktop (above 900 px, no reduced motion): the section pins and vertical scroll moves
 * the rail left 1:1. The offset is a pure function of scrollY and geometry measured on resize (never a layout read per
 * scroll frame). Narrow screens and reduced motion: a native horizontal rail with scroll snap, mouse drag, touch swipe
 * and arrow keys.
 */
export function PinnedRail({ id, headingId, head, children }: Props) {
  const reduced = useReduced();
  const root = useRef<HTMLElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [wide, setWide] = useState(false);
  const [geo, setGeo] = useState<Geo | null>(null);
  const pinned = wide && !reduced;

  useEffect(() => {
    const mq = matchMedia(WIDE);
    const set = () => setWide(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  const cards = () => cardsOf(list.current);
  const step = () => stepOf(list.current, rail.current);

  /* Read once per resize: in a ResizeObserver callback the layout is already clean. */
  const measure = useCallback(() => {
    const R = root.current, F = frame.current, Ra = rail.current, L = list.current, Pr = probe.current;
    if (!R || !F || !Ra || !L || !Pr || !pinned) { setGeo(null); return; }
    const vw = R.clientWidth, vh = window.innerHeight;
    const inset = parseFloat(getComputedStyle(Ra).paddingLeft) || 0;
    // The sticky line --phc-top (a clamp) resolved to px by a probe element.
    const top = parseFloat(getComputedStyle(Pr).top) || 0;
    const fh = F.offsetHeight, stick = Math.min(top, vh - fh - 16);
    const a = Math.max(0, START * vw - inset - LEAD * stepOf(L, Ra)), z = Math.min(vw - 2 * inset - L.scrollWidth, a);
    const pinTop = R.getBoundingClientRect().top + window.scrollY;
    const next = { a, travel: Math.max(0, a - z), stick, inset, vw, fh, pinTop };
    setGeo((g) => (g && JSON.stringify(g) === JSON.stringify(next) ? g : next));
  }, [pinned]);

  useEffect(() => {
    const R = root.current;
    if (!R) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(R);
    ro.observe(document.body);
    void document.fonts.ready.then(measure);
    const onResize = () => { if (matchMedia(WIDE).matches) measure(); };
    window.addEventListener("resize", onResize, { passive: true });
    return () => { ro.disconnect(); window.removeEventListener("resize", onResize); };
  }, [measure]);

  const { scrollY } = useScroll();
  const progress = useCallback((y: number) => (geo && geo.travel ? clamp((y - geo.pinTop + geo.stick) / geo.travel) : 0), [geo]);
  const x = useTransform(scrollY, (y) => (geo ? "translate3d(" + (geo.a - geo.travel * progress(y)).toFixed(2) + "px,0,0)" : "none"));

  /* Pinned: keyboard focus on a card scrolls the page so the card is inside the rail window. */
  const onFocus = (e: FocusEvent) => {
    const c = (e.target as Element).closest<HTMLElement>("[data-card]");
    if (!c || !geo || !root.current) return;
    const cur = geo.a - geo.travel * progress(window.scrollY), l = geo.inset + cur + c.offsetLeft, r = l + c.offsetWidth;
    let nx = cur;
    if (l < geo.inset) nx = cur + (geo.inset - l); else if (r > geo.vw - geo.inset) nx = cur - (r - (geo.vw - geo.inset));
    const pt = root.current.getBoundingClientRect().top;
    if (nx === cur && pt <= geo.stick + 1 && pt >= geo.stick - geo.travel - 1) return;
    const p = geo.travel ? clamp((geo.a - nx) / geo.travel) : 0;
    window.scrollTo({ top: Math.round(window.scrollY + pt - geo.stick + p * geo.travel), behavior: "instant" });
  };
  const onKey = (e: KeyboardEvent) => {
    const all = cards(), k = all.indexOf(e.target as HTMLElement), n = all.length;
    if (k < 0) return;
    let dest = -1;
    if (e.key === "ArrowRight") dest = Math.min(n - 1, k + 1); else if (e.key === "ArrowLeft") dest = Math.max(0, k - 1); else if (e.key === "Home") dest = 0; else if (e.key === "End") dest = n - 1;
    if (dest < 0) return;
    e.preventDefault();
    all[dest]!.focus({ preventScroll: true });
    if (!geo && rail.current) rail.current.scrollTo({ left: Math.max(0, Math.min(rail.current.scrollWidth - rail.current.clientWidth, dest * step())), behavior: reduced ? "auto" : "smooth" });
  };

  /* Native mode: mouse drag (touch and trackpads scroll natively). */
  const drag = useRef<{ x: number; s: number; moved: boolean; id: number } | null>(null);
  const dragged = useRef(false);
  const [dragging, setDragging] = useState(false);
  const onDown = (e: PointerEvent) => {
    if (geo || e.pointerType !== "mouse" || e.button !== 0 || !rail.current) return;
    drag.current = { x: e.clientX, s: rail.current.scrollLeft, moved: false, id: e.pointerId };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current, Ra = rail.current;
    if (!d || !Ra) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > 5) { d.moved = true; setDragging(true); try { Ra.setPointerCapture(d.id); } catch { /* pointer already released */ } }
    if (d.moved) Ra.scrollLeft = d.s - dx;
  };
  const onUp = () => {
    const d = drag.current, Ra = rail.current;
    drag.current = null;
    if (!d?.moved || !Ra) return;
    const at = Ra.scrollLeft, s = step();
    setDragging(false);
    Ra.scrollLeft = at;
    Ra.scrollTo({ left: Math.max(0, Math.min(Ra.scrollWidth - Ra.clientWidth, Math.round(at / s) * s)), behavior: reduced ? "auto" : "smooth" });
    dragged.current = true;
    setTimeout(() => { dragged.current = false; }, 0);
  };

  return (
    <section ref={root} id={id} className="relative scroll-mt-[88px] py-section max-mk-sm:scroll-mt-[76px] [--phc-top:clamp(148px,2.5vw+126px,162px)]">
      <span ref={probe} aria-hidden="true" className="pointer-events-none invisible absolute top-(--phc-top) size-0" />
      <div style={geo ? { height: geo.fh + geo.travel } : undefined}>
        <div ref={frame} className={cn(pinned && "sticky")} style={geo ? { top: geo.stick } : undefined}>
          {head}
          <div
            ref={rail}
            role="region"
            aria-roledescription="carousel"
            aria-labelledby={headingId}
            onKeyDown={onKey}
            onFocus={onFocus}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onClickCapture={(e) => { if (dragged.current) { e.preventDefault(); e.stopPropagation(); } }}
            className={cn(
              "[--phc-in:max(var(--spacing-page),calc((100%-var(--container-mk))/2+var(--spacing-page)))] px-(--phc-in) pt-1.5 pb-[22px]",
              pinned
                ? "overflow-clip"
                : cn("cursor-grab snap-x snap-mandatory scroll-px-(--phc-in) overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", dragging && "cursor-grabbing snap-none select-none"),
            )}
          >
            <m.ol ref={list} className={cn("flex w-max gap-4", pinned && "will-change-transform")} style={geo ? { transform: x } : undefined}>
              {children}
            </m.ol>
          </div>
        </div>
      </div>
    </section>
  );
}
