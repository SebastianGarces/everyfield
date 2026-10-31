import type { Database } from "@everyfield/db/client";
import type { EvryActor } from "../context/actor.ts";
import { closeLostRun, readConversation, type ConversationEvent } from "../conversations/store.ts";
import { liveRoom } from "./live.ts";
import { traceDelivery } from "./trace.ts";

const pause = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
	});

/**
 * Live text of the running turn, ahead of its saved events. `offset` is where `text` starts in the turn's whole text, so
 * a receiver that already has the first characters (a reconnect, a saved event) adds only what it lacks.
 */
export type LiveText = { turnId: string; offset: number; text: string };
export type Observed = { event: ConversationEvent } | { live: LiveText };

export type ObserveOptions = {
	/** How often saved events and the access check are read. */
	pollMs?: number;
	/** The longest live text goes undelivered without a passed access check (patterns.md: a live path rechecks). */
	staleMs?: number;
};

/**
 * evry.observeRun and evry.resumeRun: the conversation's saved events after a cursor, then each new saved event while
 * a run is active, plus the running turn's text the moment this process receives it. Reconnecting with the last seen
 * sequence resumes without gaps or duplicates. Observing never starts, repeats or extends a run, and each poll checks
 * ownership again. A lost run gets its interrupted end saved once (closeLostRun), which the next read delivers before the
 * stream ends. Live text skips the database, so it flows only while the last access check passed less than `staleMs`
 * ago, and a failed check drops what it holds.
 */
export async function* observeRun(
	db: Database,
	actor: EvryActor,
	conversationId: string,
	after: number,
	signal: AbortSignal,
	{ pollMs = 100, staleMs = 1_000 }: ObserveOptions = {},
): AsyncGenerator<Observed> {
	const queue: Observed[] = [];
	const inner = new AbortController();
	const stop = () => inner.abort();
	signal.addEventListener("abort", stop, { once: true });
	let failure: { error: unknown } | null = null;
	let polling = true;
	let checkedAt = 0;
	let wake: (() => void) | null = null;
	const poke = () => {
		const w = wake;
		wake = null;
		w?.();
	};
	let runTurn: string | null = null;

	// The saved events and the access check: one statement per read, with the live rule in it.
	const poller = (async () => {
		let cursor = after;
		let submitted: ConversationEvent | null = null;
		const delivered = new Set<string>();
		try {
			while (!inner.signal.aborted) {
				const page = await readConversation(db, actor, conversationId, cursor);
				checkedAt = Date.now();
				for (const event of page.events) {
					cursor = event.sequence;
					queue.push({ event });
					if (event.kind === "user_message") submitted = event;
					else if (event.kind === "assistant_text" && event.turnId && !delivered.has(event.turnId)) {
						delivered.add(event.turnId);
						const submittedAt = submitted?.turnId === event.turnId ? submitted.createdAt : null;
						traceDelivery(event.turnId, event.createdAt, submittedAt);
					}
				}
				runTurn = page.run?.turnId ?? null;
				poke();
				if (page.more) continue;
				if (!page.run) return;
				if (page.run.state === "lost" && (await closeLostRun(db, actor, conversationId, page.run.turnId))) continue;
				// The running turn's room wakes the live pump; the poll only needs the saved events and the check.
				await pause(pollMs, inner.signal);
			}
		} catch (error) {
			failure = { error };
			queue.length = 0;
		} finally {
			polling = false;
			inner.abort();
			poke();
		}
	})();

	// Live text: only after the first access check passed, and only for the turn the conversation is running.
	const pump = (async () => {
		const sent = new Map<string, number>();
		const first = new Set<string>();
		while (!inner.signal.aborted) {
			const room = liveRoom(conversationId);
			const turnId = room.turnId;
			if (turnId && checkedAt && turnId === runTurn) {
				const from = sent.get(turnId) ?? 0;
				if (room.text.length > from) {
					sent.set(turnId, room.text.length);
					queue.push({ live: { turnId, offset: from, text: room.text.slice(from) } });
					if (!first.has(turnId)) {
						first.add(turnId);
						traceDelivery(turnId, new Date(), null);
					}
					poke();
					continue;
				}
			}
			// Wake at the next text, or after a poll in case the first access check or the run id was not in yet.
			const wait = new AbortController();
			const timer = setTimeout(() => wait.abort(), pollMs);
			inner.signal.addEventListener("abort", () => wait.abort(), { once: true });
			await room.next(wait.signal);
			clearTimeout(timer);
		}
	})();

	try {
		while (true) {
			if (failure) throw (failure as { error: unknown }).error;
			const item = queue[0];
			if (item) {
				// Live text waits while the access check is stale; a failed check clears it.
				if ("live" in item && Date.now() - checkedAt > staleMs) {
					await new Promise<void>((resolve) => {
						wake = resolve;
						setTimeout(poke, 50);
					});
					continue;
				}
				queue.shift();
				yield item;
				continue;
			}
			if (!polling || signal.aborted) return;
			await new Promise<void>((resolve) => (wake = resolve));
		}
	} finally {
		inner.abort();
		signal.removeEventListener("abort", stop);
		await Promise.allSettled([poller, pump]);
	}
}

/** The saved events only, for callers that follow the durable record alone. */
export async function* observeConversation(
	db: Database,
	actor: EvryActor,
	conversationId: string,
	after: number,
	signal: AbortSignal,
	pollMs = 100,
): AsyncGenerator<ConversationEvent> {
	for await (const item of observeRun(db, actor, conversationId, after, signal, { pollMs }))
		if ("event" in item) yield item.event;
}
