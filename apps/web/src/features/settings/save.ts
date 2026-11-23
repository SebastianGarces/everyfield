"use client";

import type { Lost, Outcome as Shared } from "@everyfield/contracts/common";
import { useRef, useState } from "react";
import { errorReference, errorText, same } from "./model";
import { newRequestKey, type BrandError, type Reply, type SettingsError } from "./port";

export const OFFLINE_REFERENCE = "EF-OFFLINE";

type Code = SettingsError["code"] | BrandError["code"];

export type Refusal = { message: string; reference: string; code: Code };

export type Outcome<T> = Shared<T, Code, Omit<Refusal, "code">>;

export type Unsaved = Exclude<Outcome<unknown>, { status: "ok" }>;

export const LOST: Lost = { status: "lost" };

export const OFFLINE: Refusal = {
	message: "Everyfield could not be reached, so this may not have saved. Load the latest version to check.",
	reference: OFFLINE_REFERENCE,
	code: "unknown",
};

export function refusalOf(error: SettingsError): Refusal {
	return { message: errorText(error), reference: errorReference(error), code: error.code };
}

export const refused = (refusal: Refusal): Unsaved => ({ status: "refused", ...refusal });

export function refusalFor(outcome: Unsaved, lost: Refusal = OFFLINE): Refusal {
	if (outcome.status === "lost") return lost;
	return { message: outcome.message, reference: outcome.reference, code: outcome.code };
}

export async function attempt<T>(prefix: string, call: (requestKey: string) => Promise<Reply<T>>): Promise<Outcome<T>> {
	const reply = await call(newRequestKey(prefix));
	return reply.status === "ok" ? reply : refused(refusalOf(reply.error));
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
				return reply;
			}
			const shown = refusalOf(reply.error);
			setRefusal(shown);
			return refused(shown);
		} catch {
			setRefusal(OFFLINE);
			return LOST;
		} finally {
			setPending(false);
		}
	}

	return { pending, refusal, setRefusal, run };
}
