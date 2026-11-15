"use client";

import { prefersReducedMotion } from "@everyfield/ui/foundations";
import { inOut } from "@/components/motion/curves";
import { READER_INPUT } from "./reader-input";

type Hold = { target: HTMLElement; held: number; height: number; sizes: ResizeObserver };
type Installed = {
	click: (e: MouseEvent) => void;
	input: () => void;
	scroll: () => void;
	pages: MutationObserver;
};

const INSTALLED = Symbol.for("everyfield.page-scroll");

let shown: string | null = null;
let shownAt = 0;
let glide = 0;
let hold: Hold | null = null;

const stopGlide = () => {
	cancelAnimationFrame(glide);
	glide = 0;
};

function glideToFragment(e: MouseEvent) {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
	if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
	if (a.dataset.scroll === "instant") return;
	const url = new URL(a.href);
	const page = location.pathname + location.search;
	if (url.origin !== location.origin || url.pathname + url.search !== page || !url.hash) return;
	const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
	if (!target || prefersReducedMotion()) return;
	e.preventDefault();
	stopGlide();
	const from = window.scrollY;
	if (location.hash === url.hash) target.scrollIntoView({ block: "start", behavior: "instant" });
	else location.hash = url.hash;
	const to = window.scrollY;
	if (to === from) return;
	window.scrollTo({ top: from, behavior: "instant" });
	const ms = 600 + Math.min(200, Math.abs(to - from) / 20),
		t0 = performance.now();
	const step = (now: number) => {
		if (location.pathname + location.search !== page) return stopGlide();
		const p = Math.min(1, (now - t0) / ms);
		window.scrollTo({ top: from + (to - from) * inOut(p), behavior: "instant" });
		glide = p < 1 ? requestAnimationFrame(step) : 0;
	};
	glide = requestAnimationFrame(step);
}

function keepTargetInPlace() {
	if (!hold) return;
	hold.target.scrollIntoView({ block: "start", behavior: "instant" });
	hold.held = window.scrollY;
	hold.height = document.documentElement.scrollHeight;
}

function releaseHold() {
	hold?.sizes.disconnect();
	hold = null;
}

function onReaderInput() {
	stopGlide();
	releaseHold();
}

function onScroll() {
	if (!hold || hold.held < 0 || Math.abs(window.scrollY - hold.held) <= 1) return;
	if (document.documentElement.scrollHeight !== hold.height) keepTargetInPlace();
	else releaseHold();
}

function pageShown() {
	const path = location.pathname;
	if (path === shown) return;
	stopGlide();
	releaseHold();
	if (shown !== null) shownAt = performance.now();
	shown = path;
	if ((window.__readerInputAt ?? -1) >= shownAt) return;
	const id = decodeURIComponent(location.hash.slice(1));
	const target = id ? document.getElementById(id) : null;
	if (!target) return;
	hold = { target, held: -1, height: 0, sizes: new ResizeObserver(keepTargetInPlace) };
	hold.sizes.observe(document.body);
}

function install() {
	const host = window as unknown as Record<symbol, Installed | undefined>;
	const previous = host[INSTALLED];
	if (previous) {
		removeEventListener("click", previous.click, true);
		for (const t of READER_INPUT) removeEventListener(t, previous.input, true);
		removeEventListener("scroll", previous.scroll);
		previous.pages.disconnect();
	}
	const pages = new MutationObserver(pageShown);
	host[INSTALLED] = { click: glideToFragment, input: onReaderInput, scroll: onScroll, pages };
	addEventListener("click", glideToFragment, true);
	for (const t of READER_INPUT) addEventListener(t, onReaderInput, { capture: true, passive: true });
	addEventListener("scroll", onScroll, { passive: true });
	pages.observe(document.body, { childList: true, subtree: true });
	pageShown();
}

if (typeof window !== "undefined") install();

export function PageScroll() {
	return null;
}
