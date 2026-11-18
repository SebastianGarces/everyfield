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

export type LiveText = { turnId: string; offset: number; text: string };
export type Observed = { event: ConversationEvent } | { live: LiveText };

export type ObserveOptions = {
	pollMs?: number;
	staleMs?: number;
	first?: Awaited<ReturnType<typeof readConversation>>;
};

export async function* observeRun(
	db: Database,
	actor: EvryActor,
	conversationId: string,
	after: number,
	signal: AbortSignal,
	{ pollMs = 100, staleMs = 1_000, first }: ObserveOptions = {},
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
	const withheld = new Set<string>();

	const poller = (async () => {
		let cursor = after;
		let submitted: ConversationEvent | null = null;
		const delivered = new Set<string>();
		try {
			while (!inner.signal.aborted) {
				const page = first ?? (await readConversation(db, actor, conversationId, cursor));
				first = undefined;
				checkedAt = Date.now();
				for (const event of page.events) {
					cursor = event.sequence;
					queue.push({ event });
					if (event.kind === "assistant_text" && event.turnId && event.body.withheld === true)
						withheld.add(event.turnId);
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

	const pump = (async () => {
		const sent = new Map<string, number>();
		while (!inner.signal.aborted) {
			const room = liveRoom(conversationId);
			const turnId = room.turnId;
			if (turnId && checkedAt && turnId === runTurn && !withheld.has(turnId)) {
				const from = sent.get(turnId) ?? 0;
				if (room.text.length > from) {
					sent.set(turnId, room.text.length);
					queue.push({ live: { turnId, offset: from, text: room.text.slice(from) } });
					poke();
					continue;
				}
			}
			await room.next(AbortSignal.any([inner.signal, AbortSignal.timeout(pollMs)]));
		}
	})();

	try {
		while (true) {
			if (failure) throw (failure as { error: unknown }).error;
			const item = queue[0];
			if (item) {
				const unchecked = "live" in item && Date.now() - checkedAt > staleMs;
				if (unchecked && polling) {
					await new Promise<void>((resolve) => (wake = resolve));
					continue;
				}
				queue.shift();
				if (unchecked || ("live" in item && withheld.has(item.live.turnId))) continue;
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
