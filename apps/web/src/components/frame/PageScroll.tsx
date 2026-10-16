"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { inOut } from "@/components/motion/curves";
import { READER_INPUT } from "./reader-input";

/** The page this document shows and when the reader arrived at it: 0 for the first page (the document's load), the
 *  effect time for a page opened from a link (the click that opened it came before). Module state, so React's
 *  development double effect does not count as a navigation. */
let shown: string | null = null;
let shownAt = 0;

/** The running in-page glide (an animation frame id), and how to stop it. */
let glide = 0;
const stopGlide = () => { cancelAnimationFrame(glide); glide = 0; };

/**
 * Page-level scrolling, one leaf in the root layout. The site has no CSS smooth scrolling, so every browser and Next
 * scroll (a #fragment on load, a new page opening at its top) is instant.
 *
 * In-page anchor links glide: a click on a link to a #fragment of this page lets the browser make its own instant
 * fragment jump (history entry, :target, focus start; Next's Link stands aside for a prevented click), then animates
 * from where the reader was to there. The glide is a frame loop, so it stops at once on reader input, a new link
 * click or a route change; WebKit could not stop the native smooth scroll it replaces. Reduced motion: the jump only.
 *
 * A page opened at a #fragment (a direct load or a link from another page): until the reader scrolls, the target stays
 * where the jump put it while the page above it changes height (web fonts swapping in, the pinned sections measuring
 * themselves after hydration). Browsers do this only in part: WebKit has no scroll anchoring, and Firefox and Chromium
 * anchor on the element at the viewport top, which can be inside the part that grows. The check runs in a
 * ResizeObserver callback, after layout and before paint, so no frame shows the target out of place. Reader input
 * ends the hold, and input since the reader arrived (recorded before hydration by READER_INPUT_SCRIPT) means it never
 * starts.
 */
export function PageScroll() {
  const path = usePathname();

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href);
      const page = location.pathname + location.search;
      if (url.origin !== location.origin || url.pathname + url.search !== page || !url.hash) return;
      const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
      if (!target || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      e.preventDefault();
      stopGlide();
      const from = window.scrollY;
      if (location.hash === url.hash) target.scrollIntoView({ block: "start", behavior: "instant" });
      else location.hash = url.hash;
      const to = window.scrollY;
      if (to === from) return;
      // Back to where the reader was before this frame paints, then the glide: ease in-out, 600–800 ms by distance
      // (the browsers' smooth scroll took 650–780 ms over these distances).
      window.scrollTo({ top: from, behavior: "instant" });
      const ms = 600 + Math.min(200, Math.abs(to - from) / 20), t0 = performance.now();
      const step = (now: number) => {
        if (location.pathname + location.search !== page) return stopGlide();
        const p = Math.min(1, (now - t0) / ms);
        window.scrollTo({ top: from + (to - from) * inOut(p), behavior: "instant" });
        glide = p < 1 ? requestAnimationFrame(step) : 0;
      };
      glide = requestAnimationFrame(step);
    };
    addEventListener("click", onClick, true);
    for (const t of READER_INPUT) addEventListener(t, stopGlide, { capture: true, passive: true });
    return () => {
      stopGlide();
      removeEventListener("click", onClick, true);
      for (const t of READER_INPUT) removeEventListener(t, stopGlide, true);
    };
  }, []);

  useEffect(() => {
    stopGlide();
    if (path !== shown) {
      if (shown !== null) shownAt = performance.now();
      shown = path;
    }
    if ((window.__readerInputAt ?? -1) >= shownAt) return;
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    if (!target) return;
    const root = document.documentElement;
    let held = -1, height = 0;
    const hold = () => {
      target.scrollIntoView({ block: "start", behavior: "instant" });
      held = window.scrollY;
      height = root.scrollHeight;
    };
    const ro = new ResizeObserver(hold);
    // A scroll this hold did not make: with a new page height it is the browser's own scroll anchoring, so the target
    // is set again; with the same height it is the reader (a scrollbar drag has no input event).
    const onScroll = () => {
      if (held < 0 || Math.abs(window.scrollY - held) <= 1) return;
      if (root.scrollHeight !== height) hold();
      else release();
    };
    const release = () => {
      ro.disconnect();
      removeEventListener("scroll", onScroll);
      for (const t of READER_INPUT) removeEventListener(t, release, true);
    };
    ro.observe(document.body);
    addEventListener("scroll", onScroll, { passive: true });
    for (const t of READER_INPUT) addEventListener(t, release, { capture: true, passive: true });
    return release;
  }, [path]);

  return null;
}
