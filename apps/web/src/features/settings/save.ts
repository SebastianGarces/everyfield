"use client";

import { useRef, useState } from "react";
import { errorReference, errorText, same } from "./model";
import { newRequestKey, type BrandError, type Reply, type SettingsError } from "./port";

export const OFFLINE_REFERENCE = "EF-OFFLINE";

export type Refusal = { message: string; reference: string; code: SettingsError["code"] | BrandError["code"] };

export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export function refusalOf(error: SettingsError): Refusal {
	return { message: errorText(error), reference: errorReference(error), code: error.code };
}

export async function attempt<T>(prefix: string, call: (requestKey: string) => Promise<Reply<T>>): Promise<Outcome<T>> {
	const reply = await call(newRequestKey(prefix));
	return reply.status === "ok" ? { ok: true, value: reply.value } : { ok: false, refusal: refusalOf(reply.error) };
}

export function useWrite(prefix: string) {
	const [pending, setPending] = useState(false);
	const [refusal, setRefusal] = useState<Refusal | null>(null);
	const last = useRef<{ payload: unknown; key: string } | null>(null);

	const keyFor = (payload: unknown) => {
		if (last.current && same(last.current.payload, payload)) return last.current.key;
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
