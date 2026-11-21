import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";

const USD_PER_MILLION_TOKENS = 0.02;
export const RUN_CAP_USD = 1;
export const DAILY_QUERY_CAP_USD = 0.25;

type SpendPurpose = "query" | "rebuild";

export const usdFor = (tokens: number) => (tokens * USD_PER_MILLION_TOKENS) / 1_000_000;
export const tokensFor = (usd: number) => Math.floor((usd * 1_000_000) / USD_PER_MILLION_TOKENS);

export function estimateTokens(texts: readonly string[]): number {
	return texts.reduce((total, text) => total + Math.ceil(Buffer.byteLength(text) / 3) + 1, 0);
}

export async function recordSpend(db: Database, purpose: SpendPurpose, tokens: number): Promise<void> {
	if (tokens <= 0) return;
	await db.execute(sql`
		INSERT INTO embedding_spend(day, purpose, usage)
		VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date, ${purpose}, ${tokens}::bigint)
		ON CONFLICT (day, purpose) DO UPDATE SET usage = embedding_spend.usage + EXCLUDED.usage`);
}
