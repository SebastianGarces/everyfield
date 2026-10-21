"use client";

import { useSyncExternalStore } from "react";

// Meetings deleted in this tab whose delete may still be running. The meeting page navigates to the list at once and
// hides the meeting there; a failed delete shows it again. The list is another route, so this lives outside both.

let hidden: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const set = (next: Set<string>) => {
	hidden = next;
	for (const l of listeners) l();
};

export const deletions = {
	hide: (id: string) => set(new Set(hidden).add(id)),
	show: (id: string) => {
		const next = new Set(hidden);
		next.delete(id);
		set(next);
	},
};

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};
const empty: ReadonlySet<string> = new Set();
/** The meeting IDs to leave out of the list. The server render has none. */
export const useDeleted = () =>
	useSyncExternalStore(
		subscribe,
		() => hidden,
		() => empty,
	);
