"use client";

import type { Loadable } from "@everyfield/ui/display";
import { useRef, useState } from "react";
import { useLocalRead } from "./read.tsx";
import { READ_FAILED, thrownRead } from "./read-failed.ts";

export type Problem = "refused" | "unknown";

const newRequestKey = (intent: string) => `${intent}-${crypto.randomUUID()}`;

export class Refusal extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

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

type Loaded<T> = { data: T } | { failed: "lost" | "failed" };

export function useLoad<T>(fetch: () => Promise<T>, errorTitle: string, initial?: T) {
	const loaded = useLocalRead((): Promise<Loaded<T>> => fetch().then((data) => ({ data })), {
		failed: (error): Loaded<T> => ({ failed: thrownRead(error).status }),
		fresh: Infinity,
		keep: (value) => "data" in value,
		initial: initial === undefined ? undefined : { data: initial },
	});
	const state: Loadable<T> = !loaded.value
		? { status: "loading" }
		: "failed" in loaded.value
			? {
					status: "error",
					title: errorTitle,
					...(loaded.value.failed === "failed" ? { text: READ_FAILED } : {}),
					onRetry: loaded.retry,
				}
			: { status: "ready", data: loaded.value.data };
	const update = (change: (data: T) => T) =>
		loaded.patch((current) => ("data" in current ? { data: change(current.data) } : current));
	return { state, reload: loaded.reload, update, refreshing: loaded.reloading };
}
