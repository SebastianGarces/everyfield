"use client";

import { recordView, setBookmark, setSourceOrder, updateProgress } from "./actions.ts";

const writes = { recordView, setBookmark, setSourceOrder, updateProgress };

/** Keeps the write actions in the production build. The wiki screen belongs to WP-034/ui. */
export function WikiActionHost() {
	return <span hidden>{Object.keys(writes).length}</span>;
}
