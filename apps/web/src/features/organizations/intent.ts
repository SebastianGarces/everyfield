"use client";

import type { Loadable } from "@everyfield/ui/display";
import { useCallback, useEffect, useRef, useState } from "react";
import { newRequestKey } from "./port";

/**
 * `refused`: the server answered `unavailable`. The request was checked and nothing changed.
 * `unknown`: no answer arrived. The change may have happened, so a retry reuses the same request key and the server
 * returns the original result instead of a second effect (REQ-IDN-020, REQ-IDN-021).
 */
export type Problem = "refused" | "unknown";

/** One user intent (send, leave, accept), with the request key kept across retries of that same intent. */
export function useIntent(intent: string) {
	const key = useRef<string | null>(null);
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<Problem | null>(null);

	async function run<T>(
		send: (requestKey: string) => Promise<T>,
		done: (reply: T) => boolean,
	): Promise<{ ok: true; reply: T } | { ok: false; problem: Problem | "busy" }> {
		if (pending) return { ok: false, problem: "busy" };
		key.current ??= newRequestKey(intent);
		setPending(true);
		setProblem(null);
		try {
			const reply = await send(key.current);
			// The server answered, so the next attempt is a new intent with a new key.
			key.current = null;
			if (done(reply)) return { ok: true, reply };
			setProblem("refused");
			return { ok: false, problem: "refused" };
		} catch {
			setProblem("unknown");
			return { ok: false, problem: "unknown" };
		} finally {
			setPending(false);
		}
	}

	function reset() {
		key.current = null;
		setProblem(null);
	}

	return { run, pending, problem, reset };
}

/**
 * Loads one read. A reply belongs to one fetch and attempt, so a slow earlier reply never replaces a later one and a
 * retry never shows an old failure. `reload` starts a new attempt; an error offers Try again.
 */
export function useLoad<T>(fetch: () => Promise<T>, errorTitle: string) {
	const [attempt, setAttempt] = useState(0);
	const [reply, setReply] = useState<{ attempt: number; fetch: () => Promise<T>; data?: T; failed?: true } | null>(
		null,
	);
	useEffect(() => {
		let live = true;
		fetch().then(
			(data) => live && setReply({ attempt, fetch, data }),
			() => live && setReply({ attempt, fetch, failed: true }),
		);
		return () => {
			live = false;
		};
	}, [fetch, attempt]);
	const reload = useCallback(() => setAttempt((n) => n + 1), []);
	const current = reply && reply.attempt === attempt && reply.fetch === fetch ? reply : null;
	const state: Loadable<T> = !current
		? { status: "loading" }
		: current.failed
			? { status: "error", title: errorTitle, onRetry: reload }
			: { status: "ready", data: current.data as T };
	return { state, reload };
}
