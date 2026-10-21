import type { Database } from "@everyfield/db/client";
import type { EvryActor } from "../context/actor.ts";
import { readConversation, type ConversationEvent } from "../conversations/store.ts";

const pause = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
	});

/**
 * evry.observeRun and evry.resumeRun: the conversation's saved events after a cursor, then each new saved event while
 * a run is active. Reconnecting with the last seen sequence resumes without gaps or duplicates. Observing only reads:
 * it never starts, repeats or extends a run, and each poll checks ownership again.
 */
export async function* observeConversation(
	db: Database,
	actor: EvryActor,
	conversationId: string,
	after: number,
	signal: AbortSignal,
	pollMs = 250,
): AsyncGenerator<ConversationEvent> {
	let cursor = after;
	while (!signal.aborted) {
		const page = await readConversation(db, actor, conversationId, cursor);
		for (const event of page.events) {
			cursor = event.sequence;
			yield event;
		}
		if (page.more) continue;
		if (!page.run) return;
		await pause(pollMs, signal);
	}
}
