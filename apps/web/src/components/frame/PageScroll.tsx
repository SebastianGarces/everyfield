"use client";

import { prefersReducedMotion } from "@everyfield/ui/foundations";
import { addressHash, writeHash } from "@/components/location";
import { inOut } from "@/components/motion/curves";
import { READER_INPUT } from "./reader-input";

type Installed = { click: (e: MouseEvent) => void; input: () => void };

const INSTALLED = Symbol.for("everyfield.page-scroll");

let glide = 0;

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
	if (addressHash() === url.hash) target.scrollIntoView({ block: "start", behavior: "instant" });
	else writeHash(url.hash);
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

function install() {
	const host = window as unknown as Record<symbol, Installed | undefined>;
	const previous = host[INSTALLED];
	if (previous) {
		removeEventListener("click", previous.click, true);
		for (const t of READER_INPUT) removeEventListener(t, previous.input, true);
	}
	host[INSTALLED] = { click: glideToFragment, input: stopGlide };
	addEventListener("click", glideToFragment, true);
	for (const t of READER_INPUT) addEventListener(t, stopGlide, { capture: true, passive: true });
}

if (typeof window !== "undefined") install();

export function PageScroll() {
	return null;
}
