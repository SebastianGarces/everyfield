"use client";

import { useRef, useState } from "react";
import { errorReference, errorText, sameValue } from "./model";
import { newRequestKey, type Reply, type SettingsError } from "./port";

/** The reference of a write whose reply never arrived: it may have been applied. */
export const OFFLINE_REFERENCE = "EF-OFFLINE";

export type Refusal = { message: string; reference: string; code: SettingsError["code"] };

export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export function refusalOf(error: SettingsError): Refusal {
	return { message: errorText(error), reference: errorReference(error), code: error.code };
}

/** One write for a section save the store runs: a fresh request key, and a refusal in words. */
export async function attempt<T>(prefix: string, call: (requestKey: string) => Promise<Reply<T>>): Promise<Outcome<T>> {
	const reply = await call(newRequestKey(prefix));
	return reply.status === "ok" ? { ok: true, value: reply.value } : { ok: false, refusal: refusalOf(reply.error) };
}

/**
 * Runs one write at a time and keeps its refusal. A retry of the same payload reuses its request key, so the server
 * returns the recorded result instead of applying it twice; a changed payload gets a new key.
 */
export function useWrite(prefix: string) {
	const [pending, setPending] = useState(false);
	const [refusal, setRefusal] = useState<Refusal | null>(null);
	const last = useRef<{ payload: unknown; key: string } | null>(null);

	const keyFor = (payload: unknown) => {
		if (last.current && sameValue(last.current.payload, payload)) return last.current.key;
		const key = newRequestKey(prefix);
		last.current = { payload, key };
		return key;
	};

	async function run<T>(payload: unknown, call: (requestKey: string) => Promise<Reply<T>>): Promise<Outcome<T>> {
		setPending(true);
		setRefusal(null);
		try {
			const reply = await call(keyFor(payload));
			if (reply.status === "ok") {
				last.current = null;
				return { ok: true, value: reply.value };
			}
			const refused = refusalOf(reply.error);
			setRefusal(refused);
			return { ok: false, refusal: refused };
		} catch {
			const refused: Refusal = {
				message: "Everyfield could not be reached, so this may not have saved. Load the latest version to check.",
				reference: OFFLINE_REFERENCE,
				code: "unknown",
			};
			setRefusal(refused);
			return { ok: false, refusal: refused };
		} finally {
			setPending(false);
		}
	}

	return { pending, refusal, setRefusal, run };
}
