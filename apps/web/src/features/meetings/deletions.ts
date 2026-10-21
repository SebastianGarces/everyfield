"use client";

import { useSyncExternalStore } from "react";

// Meetings deleted in this tab whose delete may still be running. The meeting page hides the meeting and opens the
// list at once; the list starts the delete once it is on screen (Next.js holds a navigation while a server action
// runs, so starting it earlier would hold the list back). A failed delete shows the meeting again. The list is another
// route, so this lives outside both.

let hidden: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const set = (next: Set<string>) => {
	hidden = next;
	for (const l of listeners) l();
};

let queued: (() => void)[] = [];
export const deletions = {
	/** Hide the meeting now and keep `run` (the delete) until the list is on screen. */
	queue: (id: string, run: () => void) => {
		queued.push(run);
		set(new Set(hidden).add(id));
	},
	/** The list is on screen: start the queued deletes. */
	flush: () => {
		const runs = queued;
		queued = [];
		for (const run of runs) run();
	},
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
