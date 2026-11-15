import { prefersReducedMotion, type NodeRef } from "@everyfield/ui/foundations";
import { cancelFrame, frame } from "motion/react";

type Listener = () => void;

const pageListeners = new Set<Listener>();
const pageChanged = () => {
	for (const listener of pageListeners) listener();
};

export function onPageStateChange(listener: Listener): () => void {
	pageListeners.add(listener);
	return () => pageListeners.delete(listener);
}

type Installed = { changed: Listener; media: MediaQueryList };
const INSTALLED = Symbol.for("everyfield.marketing.page-state");

function install() {
	const host = window as unknown as Record<symbol, Installed | undefined>;
	const previous = host[INSTALLED];
	if (previous) {
		document.removeEventListener("visibilitychange", previous.changed);
		previous.media.removeEventListener("change", previous.changed);
	}
	const media = matchMedia("(prefers-reduced-motion: reduce)");
	host[INSTALLED] = { changed: pageChanged, media };
	document.addEventListener("visibilitychange", pageChanged);
	media.addEventListener("change", pageChanged);
}

if (typeof window !== "undefined") install();

export function runFrames(step: (dt: number) => void): () => void {
	let last = performance.now();
	const tick = ({ timestamp }: { timestamp: number }) => {
		step(Math.max(0, Math.min(timestamp - last, 50)));
		last = timestamp;
	};
	frame.update(tick, true);
	return () => cancelFrame(tick);
}

export function joinRefs<T extends Element>(...refs: NodeRef<T>[]): NodeRef<T> {
	return (node) => {
		const cleanups = refs.map((ref) => ref(node));
		return () => {
			for (const cleanup of cleanups) cleanup?.();
		};
	};
}

export type Autoplay = {
	hold(reason: string, on: boolean): void;
	restart(): void;
	observe<T extends Element>(advance: () => void, threshold: number): NodeRef<T>;
};

export function createAutoplay(ms: number): Autoplay {
	const holds = new Set(["unseen"]);
	let advance: () => void = () => {};
	let running = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		clearTimeout(timer);
		timer = undefined;
	};
	const start = () => {
		stop();
		timer = setTimeout(() => {
			timer = undefined;
			advance();
		}, ms);
	};
	const sync = () => {
		const next = holds.size === 0 && !document.hidden && !prefersReducedMotion();
		if (next === running) return;
		running = next;
		if (running) start();
		else stop();
	};
	const hold = (reason: string, on: boolean) => {
		if (on) holds.add(reason);
		else holds.delete(reason);
		sync();
	};
	return {
		hold,
		restart() {
			if (running) start();
		},
		observe(next, threshold) {
			return (node) => {
				if (!node) return;
				advance = next;
				let release: (() => void) | undefined;
				const observer = new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							if (entry.isIntersecting) release ??= onPageStateChange(sync);
							else {
								release?.();
								release = undefined;
							}
							hold("unseen", !entry.isIntersecting);
						}
					},
					{ threshold },
				);
				observer.observe(node);
				return () => {
					observer.disconnect();
					release?.();
					release = undefined;
					holds.add("unseen");
					running = false;
					stop();
				};
			};
		},
	};
}
