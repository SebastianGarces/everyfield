import type { LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, wrapLanguageModel } from "ai";
import { LIMITS } from "../context/limits.ts";
import { scriptedModel } from "./scripted.ts";
import { runsOffVercel } from "@everyfield/db/deployment";

export type Price = { input: number; output: number; longContextAbove: number };
export type Spend = { price: Price; capMicroUsd: number };
export type QualifiedModel =
	{ status: "qualified"; id: string; model: LanguageModelV4; spend?: Spend } | { status: "unavailable" };

const OPENAI: Record<string, Price> = { "gpt-6-luna": { input: 0.1, output: 0.5, longContextAbove: 272_000 } };
const DEFAULT_CAP_USD = 20;

export function selectQualifiedModel(env: Record<string, string | undefined> = process.env): QualifiedModel {
	if (env.EVRY_SCRIPTED_MODEL === "1" && runsOffVercel(env))
		return { status: "qualified", id: "evry-scripted", model: withTransientRetry(scriptedModel()) };
	const paid = paidModel(env);
	return paid ? { status: "qualified", ...paid, model: withTransientRetry(paid.model) } : { status: "unavailable" };
}

export function paidModel(
	env: Record<string, string | undefined>,
): { id: string; model: LanguageModelV4; spend: Spend } | null {
	const id = env.EVRY_MODEL ?? "";
	const price = Object.hasOwn(OPENAI, id) ? OPENAI[id] : undefined;
	const cap = Number(env.EVRY_MONTHLY_CAP_USD || DEFAULT_CAP_USD);
	if (!price || !env.OPENAI_API_KEY || !(cap >= 0)) return null;
	return {
		id,
		model: createOpenAI({ apiKey: env.OPENAI_API_KEY })(id),
		spend: { price, capMicroUsd: Math.round(cap * 1_000_000) },
	};
}

const transient = (error: unknown) => APICallError.isInstance(error) && error.isRetryable;

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
