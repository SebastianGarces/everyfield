"use client";

import type { ToastInput } from "@everyfield/ui/controls";
import { useSyncExternalStore } from "react";
import { deleteMeeting, reloadMeeting } from "./actions.ts";
import { sendTwice } from "../../components/save/model.ts";
import { problemText } from "./model.ts";

// Meetings deleted in this tab whose delete may still be running. The meeting page hides the meeting and opens the
// list at once; the list starts the delete once it is on screen (Next.js holds a navigation while a server action
// runs, so starting it earlier would hold the list back). The list is another route, so this lives outside both.

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

const lost = () => ({ status: "lost" }) as const;

/**
 * Delete a meeting from its page: hide it, and once the list is on screen send the delete. The outcome is known before
 * anything is said:
 * - deleted: a confirmation;
 * - refused by the server: the meeting shows again with the reason;
 * - answer lost: the same request key is sent once more (components/save sendTwice), so the server replays a delete
 *   that did commit. If that answer is lost too, the meeting is read once: gone means deleted, still there means not
 *   deleted. If that read fails too, the meeting stays hidden and a message offers to try again with the same key.
 */
export function deleteFromList(
	m: { id: string; title: string; revision: string },
	reason: string,
	toast: (t: ToastInput) => void,
) {
	const key = crypto.randomUUID();
	const deleted = () => toast({ message: `${m.title} was deleted.`, tone: "success" });
	const notDeleted = (why: string) => {
		deletions.show(m.id);
		toast({ message: `${m.title} was not deleted. ${why}`, tone: "error" });
	};
	const attempt = async () => {
		const r = await sendTwice(() => deleteMeeting(key, m.revision, m.id, reason));
		if (r.status === "ok") return deleted();
		if (r.status === "refused") return notDeleted(problemText(r.code));
		const seen = await reloadMeeting(m.id).catch(lost);
		const state = seen.status === "ok" ? seen.value.status : "unknown";
		if (state === "missing") return deleted();
		if (state === "found") return notDeleted("We did not hear back from the server. Try again.");
		toast({
			message: `We could not confirm that ${m.title} was deleted. It stays hidden until we know.`,
			tone: "error",
			action: { label: "Try again", altText: "Reload the meetings list to check", onSelect: () => void attempt() },
		});
	};
	deletions.queue(m.id, () => void attempt());
}
