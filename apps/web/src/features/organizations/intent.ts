"use client";

import type { Loadable } from "@everyfield/ui/display";
import { useCallback, useEffect, useRef, useState } from "react";
import { newRequestKey } from "./port";

/**
 * `refused`: the server checked the command and changed nothing. `code` names why when the API says (for example
 * `pending_invitation`).
 * `unknown`: no answer arrived. The change may have happened, so the command stays frozen: a retry resends the exact
 * same command with the same request key, and the server returns the original result instead of a second effect
 * (REQ-IDN-020, REQ-IDN-021). The API hashes the whole command, so a retry must never carry edited input.
 */
export type Problem = "refused" | "unknown";

/** A refusal the server returned as data. `run` implementations throw it; `useIntent` reports it as `refused`. */
export class Refusal extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

/**
 * The commands of one kind of intent (send, leave, resend), with one frozen command per `slot` (a dialog, or one
 * invitation row). While a slot holds an unconfirmed command, `held` names it: the screen locks that command's
 * fields and every other slot, and Try again resends it unchanged. `release` drops it when the person closes the
 * dialog; the caller then reloads, so the screen shows what the server has.
 */
export function useIntent<C>(intent: string) {
	const frozen = useRef<{ slot: string; command: C } | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [problem, setProblem] = useState<Problem | null>(null);
	const [code, setCode] = useState<string | null>(null);
	const [held, setHeld] = useState<string | null>(null);

	async function run<K extends C, T>(
		slot: string,
		make: (requestKey: string) => K,
		send: (command: K) => Promise<T>,
		done: (reply: T) => boolean,
	): Promise<{ ok: true; reply: T } | { ok: false; problem: Problem | "busy" }> {
		if (pending !== null || (frozen.current && frozen.current.slot !== slot)) return { ok: false, problem: "busy" };
		// A slot only ever freezes the command its own `make` built, so the stored command has this call's type.
		const command = (frozen.current?.command as K | undefined) ?? make(newRequestKey(intent));
		frozen.current = { slot, command };
		setPending(slot);
		setProblem(null);
		setCode(null);
		const answered = (ok: boolean, why: string | null) => {
			frozen.current = null;
			setHeld(null);
			if (!ok) {
				setProblem("refused");
				setCode(why);
			}
		};
		try {
			const reply = await send(command);
			const ok = done(reply);
			answered(ok, null);
			return ok ? { ok: true, reply } : { ok: false, problem: "refused" };
		} catch (e) {
			if (e instanceof Refusal) {
				answered(false, e.code);
				return { ok: false, problem: "refused" };
			}
			setProblem("unknown");
			setHeld(slot);
			return { ok: false, problem: "unknown" };
		} finally {
			setPending(null);
		}
	}

	function release() {
		frozen.current = null;
		setHeld(null);
		setProblem(null);
		setCode(null);
	}

	return { run, pending, problem, code, held, release };
}

/**
 * Loads one read. A reply belongs to one fetch and attempt, so a slow earlier reply never replaces a later one and a
 * retry never shows an old failure. `reload` starts a new attempt; while it runs, the last data stays on screen so a
 * save never blanks the list. Only the first load shows the skeleton, and an error offers Try again. `update` applies
 * a confirmed command's answer to the data on screen, so a change needs no second read.
 */
export function useLoad<T>(fetch: () => Promise<T>, errorTitle: string, initial?: T) {
	const [attempt, setAttempt] = useState(0);
	type Reply = { attempt: number; fetch: () => Promise<T>; data?: T; failed?: true };
	// Data the server rendered with the page shows at once; the first fetch runs only after a command (reload).
	const [reply, setReply] = useState<Reply | null>(initial === undefined ? null : { attempt: 0, fetch, data: initial });
	const [shown, setShown] = useState<{ fetch: () => Promise<T>; data: T } | null>(
		initial === undefined ? null : { fetch, data: initial },
	);
	useEffect(() => {
		if (attempt === 0 && initial !== undefined) return;
		let live = true;
		fetch().then(
			(data) => {
				if (!live) return;
				setReply({ attempt, fetch, data });
				setShown({ fetch, data });
			},
			() => live && setReply({ attempt, fetch, failed: true }),
		);
		return () => {
			live = false;
		};
	}, [fetch, attempt, initial]);
	const reload = useCallback(() => setAttempt((n) => n + 1), []);
	const update = useCallback((change: (data: T) => T) => {
		setReply((r) => (r && r.data !== undefined ? { ...r, data: change(r.data) } : r));
		setShown((s) => (s ? { ...s, data: change(s.data) } : s));
	}, []);
	const current = reply && reply.attempt === attempt && reply.fetch === fetch ? reply : null;
	const last = shown && shown.fetch === fetch ? shown : null;
	const state: Loadable<T> = current?.failed
		? { status: "error", title: errorTitle, onRetry: reload }
		: current
			? { status: "ready", data: current.data as T }
			: last
				? { status: "ready", data: last.data }
				: { status: "loading" };
	/** True while a reload runs over data already on screen: commands built from that data would be stale. */
	const refreshing = !current && last !== null;
	return { state, reload, update, refreshing };
}
