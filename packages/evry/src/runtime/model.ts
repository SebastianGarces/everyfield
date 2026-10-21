import type { LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider";
import { APICallError, wrapLanguageModel } from "ai";
import { LIMITS } from "../context/limits.ts";
import { scriptedModel } from "./scripted.ts";

export type QualifiedModel = { status: "qualified"; id: string; model: LanguageModelV4 } | { status: "unavailable" };

/**
 * evry.selectQualifiedModel. A model qualifies only through measured task and effect evaluations, with provider
 * settings held on the server. None has been measured or approved yet, so production has no qualified model and a
 * turn ends with a truthful model_unavailable. Off Vercel, EVRY_SCRIPTED_MODEL=1 selects the deterministic scripted
 * model that local previews and tests use. A routing hint or model choice never changes authority.
 */
export function selectQualifiedModel(env: Record<string, string | undefined> = process.env): QualifiedModel {
	// Vercel sets VERCEL_ENV on every deployment; local previews and test runs have none.
	if (env.EVRY_SCRIPTED_MODEL === "1" && !env.VERCEL_ENV)
		return { status: "qualified", id: "evry-scripted", model: withTransientRetry(scriptedModel()) };
	return { status: "unavailable" };
}

const transient = (error: unknown) => APICallError.isInstance(error) && error.isRetryable;

/**
 * Two transient model retries with 1-second then 3-second backoff, inside the turn's wall-time budget (the caller's
 * abort signal ends the wait). Failures that are not transient, and errors after the stream started, are not retried.
 */
export function transientRetry(
	sleep = (ms: number, signal?: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
		}),
): LanguageModelV4Middleware {
	async function retry<T>(call: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await call();
			} catch (error) {
				const delay = LIMITS.modelRetryDelaysMs[attempt];
				if (delay === undefined || !transient(error) || signal?.aborted) throw error;
				await sleep(delay, signal);
			}
		}
	}
	return {
		specificationVersion: "v4",
		wrapGenerate: ({ doGenerate, params }) => retry(doGenerate, params.abortSignal),
		wrapStream: ({ doStream, params }) => retry(doStream, params.abortSignal),
	};
}

export function withTransientRetry(model: LanguageModelV4, middleware = transientRetry()): LanguageModelV4 {
	return wrapLanguageModel({ model, middleware }) as LanguageModelV4;
}
