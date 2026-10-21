import type { Database } from "@everyfield/db/client";
import type { EvryActor } from "../context/actor.ts";
import { readConversation, type ConversationEvent } from "../conversations/store.ts";
import { traceDelivery } from "./trace.ts";

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
	pollMs = 100,
): AsyncGenerator<ConversationEvent> {
	let cursor = after;
	let submitted: ConversationEvent | null = null;
	const delivered = new Set<string>();
	while (!signal.aborted) {
		const page = await readConversation(db, actor, conversationId, cursor);
		for (const event of page.events) {
			cursor = event.sequence;
			yield event;
			// The consumer asks for the next event once it sent this one: the turn's first text was delivered now.
			if (event.kind === "user_message") submitted = event;
			else if (event.kind === "assistant_text" && event.turnId && !delivered.has(event.turnId)) {
				delivered.add(event.turnId);
				const submittedAt = submitted?.turnId === event.turnId ? submitted.createdAt : null;
				traceDelivery(event.turnId, event.createdAt, submittedAt);
			}
		}
		if (page.more) continue;
		if (!page.run) return;
		await pause(pollMs, signal);
	}
}
