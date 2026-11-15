"use client";

import { Button } from "@everyfield/ui/controls";
import { useSyncExternalStore } from "react";
import type { Replies } from "./replies";

export function RepliesControl({ replies, toggle = true }: { replies: Replies; toggle?: boolean }) {
	const held = useSyncExternalStore(replies.subscribe, replies.held, replies.held);
	const waiting = useSyncExternalStore(replies.subscribe, replies.waiting, () => 0);
	if (!toggle && !held) return null;
	return (
		<span className="flex flex-wrap items-center gap-2">
			{toggle ? (
				<Button size="sm" variant="secondary" aria-pressed={held} onClick={() => replies.hold(!held)}>
					{held ? "Replies held" : "Hold replies"}
				</Button>
			) : null}
			{held ? (
				<Button size="sm" variant="secondary" disabled={waiting === 0} onClick={replies.answer}>
					{waiting === 1 ? "Answer the waiting call" : `Answer ${waiting} waiting calls`}
				</Button>
			) : null}
		</span>
	);
}
