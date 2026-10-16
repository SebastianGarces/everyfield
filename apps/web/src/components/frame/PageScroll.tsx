"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { READER_INPUT } from "./reader-input";

/** The page this document shows and when the reader arrived at it: 0 for the first page (the document's load), the
 *  effect time for a page opened from a link (the click that opened it came before). Module state, so React's
 *  development double effect does not count as a navigation. */
let shown: string | null = null;
let shownAt = 0;

/**
 * Page-level scrolling, one leaf in the root layout.
 *
 * A page opened at a #fragment (a direct load or a link from another page): until the reader scrolls, the target stays
 * where the jump put it while the page above it changes height (web fonts swapping in, the pinned sections measuring
 * themselves after hydration). Browsers do this only in part: WebKit has no scroll anchoring, and Firefox and Chromium
 * anchor on the element at the viewport top, which can be inside the part that grows. The check runs in a
 * ResizeObserver callback, after layout and before paint, so no frame shows the target out of place. Reader input
 * ends the hold, and input since the reader arrived (recorded before hydration by READER_INPUT_SCRIPT) means it never
 * starts.
 *
 * Smooth in-page anchor scrolling turns on two frames after the load event (data-scroll-behavior, see marketing.css),
 * so the browser's own jump on load is instant. Next reads the same attribute and opens a new page at its top without
 * a smooth scroll.
 */
export function PageScroll() {
  const path = usePathname();

  useEffect(() => {
    let raf = 0;
    const on = () => {
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => { document.documentElement.dataset.scrollBehavior = "smooth"; });
      });
    };
    if (document.readyState === "complete") on();
    else addEventListener("load", on, { once: true });
    return () => { removeEventListener("load", on); cancelAnimationFrame(raf); };
  }, []);

  useEffect(() => {
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
