import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { wrapLanguageModel } from "ai";
import { z } from "zod";
import { EvryRefusal } from "../context/errors.ts";
import { LIMITS } from "../context/limits.ts";
import type { Price, Spend } from "./model.ts";

// Paid model spend (D77). Every paid model call reserves its own worst case in the month's counter before the provider
// sees it, and settles to its reported usage afterwards. A call that never reports usage keeps its reservation.

/**
 * The most input tokens one call can bill. A byte-level tokenizer never makes more tokens than the UTF-8 bytes it reads,
 * and JSON only adds bytes; each message adds a few framing tokens. Covers the prompt, tools and response format.
 */
export function inputTokenBound(params: LanguageModelV4CallOptions) {
	const { prompt, tools, toolChoice, responseFormat } = params;
	return Buffer.byteLength(JSON.stringify({ prompt, tools, toolChoice, responseFormat })) + 16 * prompt.length + 512;
}

/** One call's cost in millionths of a US dollar, rounded up, in the provider's price tier for its input size. */
export function callCostMicroUsd(price: Price, inputTokens: number, outputTokens: number) {
	const long = inputTokens > price.longContextAbove;
	return Math.ceil(inputTokens * price.input * (long ? 2 : 1) + outputTokens * price.output * (long ? 1.5 : 1));
}

/**
 * Reserves `micro` of this month's (UTC) spend when the month's charge stays within `cap`. Returns the month, or null
 * when the limit would be passed. One statement; its row lock ends with it.
 */
async function reserveSpend(db: Database, micro: number, cap: number): Promise<string | null> {
	const r = await db.execute(sql`
		INSERT INTO model_spend(month,charged_micro_usd)
		SELECT date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,${micro}::bigint WHERE ${micro}::bigint<=${cap}::bigint
		ON CONFLICT (month) DO UPDATE SET charged_micro_usd=model_spend.charged_micro_usd+EXCLUDED.charged_micro_usd
			WHERE model_spend.charged_micro_usd+EXCLUDED.charged_micro_usd<=${cap}::bigint
		RETURNING month::text`);
	return r.rows.length ? z.string().parse(r.rows[0]!.month) : null;
}

/** Gives back `micro` of a month's reservation (a negative amount charges more). One statement. */
async function refundSpend(db: Database, month: string, micro: number) {
	if (micro !== 0)
		await db.execute(
			sql`UPDATE model_spend SET charged_micro_usd=charged_micro_usd-${micro}::bigint WHERE month=${month}::date`,
		);
}

/**
 * The paid model for one run: each call's output is capped at the per-call budget, its worst case is reserved before
 * the provider sees it (refused with model_unavailable when the month's limit would be passed), and it settles once to
 * its reported usage. `charged` is what this run has committed so far.
 */
export function meteredModel(db: Database, model: LanguageModelV4, spend: Spend) {
	let charged = 0;
	const reserve = async (params: LanguageModelV4CallOptions) => {
		const input = inputTokenBound(params);
		const output = params.maxOutputTokens ?? LIMITS.outputTokensPerCall;
		const micro = callCostMicroUsd(spend.price, input, output);
		const month = await reserveSpend(db, micro, spend.capMicroUsd);
		if (!month) throw new EvryRefusal("model_unavailable");
		charged += micro;
		let settled = false;
		return async (usage: LanguageModelV4Usage) => {
			if (settled) return;
			settled = true;
			const actual = callCostMicroUsd(
				spend.price,
				usage.inputTokens.total ?? input,
				usage.outputTokens.total ?? output,
			);
			charged += actual - micro;
			// A failed refund keeps the larger charge.
			await refundSpend(db, month, micro - actual).catch(() => (charged += micro - actual));
		};
	};
	const metered = wrapLanguageModel({
		model,
		middleware: {
			specificationVersion: "v4",
			transformParams: async ({ params }) => ({
				...params,
				maxOutputTokens: Math.min(params.maxOutputTokens ?? LIMITS.outputTokensPerCall, LIMITS.outputTokensPerCall),
			}),
			wrapGenerate: async ({ doGenerate, params }) => {
				const settle = await reserve(params);
				const result = await doGenerate();
				await settle(result.usage);
				return result;
			},
			wrapStream: async ({ doStream, params }) => {
				const settle = await reserve(params);
				const result = await doStream();
				const settling = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
					async transform(part, controller) {
						if (part.type === "finish") await settle(part.usage);
						controller.enqueue(part);
					},
				});
				return { ...result, stream: result.stream.pipeThrough(settling) };
			},
		},
	}) as LanguageModelV4;
	return { model: metered, charged: () => charged };
}
