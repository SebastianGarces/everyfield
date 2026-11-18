"use client";

import { useCallback, useSyncExternalStore } from "react";
import { minuteSnapshot, subscribeMinute } from "./minute-clock";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const noSubscribe = () => () => {};

export function useMediaQuery(query: string, serverValue = false): boolean {
	const subscribe = useCallback(
		(changed: () => void) => {
			const list = matchMedia(query);
			list.addEventListener("change", changed);
			return () => list.removeEventListener("change", changed);
		},
		[query],
	);
	return useSyncExternalStore(
		subscribe,
		() => matchMedia(query).matches,
		() => serverValue,
	);
}

export function useReducedMotion(): boolean {
	return useMediaQuery(REDUCED_MOTION);
}

export function prefersReducedMotion(): boolean {
	return matchMedia(REDUCED_MOTION).matches;
}

const subscribeVisibility = (changed: () => void) => {
	document.addEventListener("visibilitychange", changed);
	return () => document.removeEventListener("visibilitychange", changed);
};

export function useDocumentHidden(): boolean {
	return useSyncExternalStore(
		subscribeVisibility,
		() => document.hidden,
		() => false,
	);
}

export function useHydrated(): boolean {
	return useSyncExternalStore(
		noSubscribe,
		() => true,
		() => false,
	);
}

export function useBrowserZone(): string | null {
	return useSyncExternalStore(
		noSubscribe,
		() => Intl.DateTimeFormat().resolvedOptions().timeZone,
		() => null,
	);
}

export function useMinuteClock(): number | null {
	return useSyncExternalStore(subscribeMinute, minuteSnapshot, () => null);
}
