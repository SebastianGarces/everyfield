import type { LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, wrapLanguageModel } from "ai";
import { LIMITS } from "../context/limits.ts";
import { scriptedModel } from "./scripted.ts";

/** USD per million tokens. Every input token counts at the full rate, also when the provider served it from cache. */
export type Price = { input: number; output: number };
/** A paid model's price and the deployment's monthly limit, in millionths of a US dollar. */
export type Spend = { price: Price; capMicroUsd: number };
export type QualifiedModel =
	{ status: "qualified"; id: string; model: LanguageModelV4; spend?: Spend } | { status: "unavailable" };

/** The paid models Sebastian approved (D76), with OpenAI's standard prices from 2026-10-21. */
const OPENAI: Record<string, Price> = { "gpt-6-luna": { input: 0.1, output: 0.5 } };
/** Two databases (shared development and production) share D76's 40 USD a month. */
const DEFAULT_CAP_USD = 20;

/**
 * evry.selectQualifiedModel, from the server environment only. Off Vercel, EVRY_SCRIPTED_MODEL=1 selects the
 * deterministic scripted model that local previews and every automated test use; it wins over everything else, so a
 * test never makes a paid call. A deployment selects a paid model only when it names an approved one in EVRY_MODEL
 * and has OPENAI_API_KEY; then EVRY_MONTHLY_CAP_USD (default 20) limits its monthly spend. Otherwise a turn ends with
 * a truthful model_unavailable. A routing hint or model choice never changes authority.
 */
export function selectQualifiedModel(env: Record<string, string | undefined> = process.env): QualifiedModel {
	// Vercel sets VERCEL_ENV on every deployment; local previews and test runs have none.
	if (env.EVRY_SCRIPTED_MODEL === "1" && !env.VERCEL_ENV)
		return { status: "qualified", id: "evry-scripted", model: withTransientRetry(scriptedModel()) };
	const id = env.EVRY_MODEL ?? "";
	const price = Object.hasOwn(OPENAI, id) ? OPENAI[id] : undefined;
	const cap = Number(env.EVRY_MONTHLY_CAP_USD || DEFAULT_CAP_USD);
	if (!price || !env.OPENAI_API_KEY || !(cap >= 0)) return { status: "unavailable" };
	return {
		status: "qualified",
		id,
		model: withTransientRetry(createOpenAI({ apiKey: env.OPENAI_API_KEY })(id)),
		spend: { price, capMicroUsd: Math.round(cap * 1_000_000) },
	};
}

/** A turn's cost in millionths of a US dollar, rounded up. */
export const costMicroUsd = (price: Price, usage: { inputTokens: number; outputTokens: number }) =>
	Math.ceil(usage.inputTokens * price.input + usage.outputTokens * price.output);

/**
 * The most one turn can cost. The token budgets are checked after each model call, so the last call can pass them
 * by up to one more full prompt (input) and one more call's output.
 */
export const worstTurnMicroUsd = (price: Price) =>
	costMicroUsd(price, {
		inputTokens: 2 * LIMITS.inputTokens,
		outputTokens: LIMITS.outputTokens + LIMITS.outputTokensPerCall,
	});

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
