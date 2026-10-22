"use client";

import type { FocusEvent, PointerEvent } from "react";
import type { Outcome } from "../../../components/save/model.ts";
import { loadRecords, unmergePreview } from "./actions.ts";

// Intent prefetch for the dialog reads (patterns.md, Interface behavior): a pointer over the button, a touch on it or
// keyboard focus on it starts the read the dialog needs, and the dialog takes that same request when it opens. A read
// is taken once and kept for a short time only, so a later opening, a retry or a reload after a save reads afresh.

const FRESH_MS = 15_000;
type Entry = { at: number; read: Promise<Outcome<unknown>> };
const started = new Map<string, Entry>();

function start<T>(key: string, read: () => Promise<Outcome<T>>): void {
	const held = started.get(key);
	if (held && Date.now() - held.at < FRESH_MS) return;
	started.set(key, { at: Date.now(), read: read().catch(() => ({ status: "lost" }) as const) });
}
/** The read started on intent, if it is still fresh; otherwise a new one. Either way the entry is used up. */
function take<T>(key: string, read: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const held = started.get(key);
	started.delete(key);
	if (held && Date.now() - held.at < FRESH_MS) return held.read as Promise<Outcome<T>>;
	return read().catch(() => ({ status: "lost" }) as const);
}

const unmergeKey = (mergeId: string) => `unmerge:${mergeId}`;
const recordsKey = (personId: string) => `records:${personId}`;
export const takeUnmergePreview = (mergeId: string) => take(unmergeKey(mergeId), () => unmergePreview(mergeId));
export const takeRecords = (personId: string) => take(recordsKey(personId), () => loadRecords(personId));

/**
 * Handlers that start a read on intent: a mouse over the control, a touch, or keyboard focus (not focus that code
 * restores). They use pointer-move and focus-capture, so a shared control's own enter and focus handlers stay intact.
 */
function intent(begin: () => void) {
	return {
		onPointerMove: (e: PointerEvent<HTMLElement>) => {
			if (e.pointerType === "mouse") begin();
		},
		onTouchStart: () => begin(),
		onFocusCapture: (e: FocusEvent<HTMLElement>) => {
			if (e.currentTarget.matches(":focus-visible")) begin();
		},
	};
}
export const unmergeIntent = (mergeId: string) =>
	intent(() => start(unmergeKey(mergeId), () => unmergePreview(mergeId)));
export const recordsIntent = (personId: string) =>
	intent(() => start(recordsKey(personId), () => loadRecords(personId)));
