"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactElement, type ReactNode } from "react";

// A saved follow-up outcome changes what Tasks shows: "What happened" in a task panel and the follow-up's state on
// /tasks/follow-ups. Next keeps each page this browser rendered and shows it again on browser back without asking the
// server. Only a refresh or a revalidating action drops those pages, and a revalidating action also renders the page the
// outcome was saved on again (T-234). So the follow-up screens count their saved outcomes here instead, and a Tasks page
// whose answer this browser first showed before the latest outcome shows its loading shape and reads the page again.

let outcomes = 0;
/** Each page answer this browser rendered, with the outcome count when it first showed. */
const shown = new WeakMap<object, number>();

/** A follow-up screen saved an outcome: every Tasks page rendered until now is out of date. */
export function outcomeSaved() {
	outcomes++;
}

/**
 * Wraps a Tasks page's screen. A page answer from the server is a new element each time, while browser back shows the
 * kept one again, so the element itself says when its page was read.
 */
export function Fresh({ loading, children }: { loading: ReactNode; children: ReactElement }) {
	const router = useRouter();
	const at = shown.get(children);
	const held = at !== undefined && at < outcomes;
	useEffect(() => {
		const first = shown.get(children);
		if (first === undefined) shown.set(children, outcomes);
		// The kept answer stays held, so the loading shape shows until the new answer replaces it.
		else if (first < outcomes) router.refresh();
	}, [children, router]);
	return held ? loading : children;
}
