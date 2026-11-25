import { EMBEDDING_PATH, providerAllowed } from "@everyfield/db/provider";
import { EmbeddingRefusal, openAiWikiEmbedding, type WikiEmbedFetch } from "./openai.ts";

export { EmbeddingRefusal } from "./openai.ts";
export { hash, vectorHash } from "../../hash.ts";
export {
	DAILY_PUBLISH_CAP_USD,
	DAILY_QUERY_CAP_USD,
	estimateTokens,
	recordSpend,
	RUN_CAP_USD,
	tokensFor,
	usdFor,
} from "./spend.ts";

const QUERY_TIMEOUT_MS = 1500;
const PASSAGE_TIMEOUT_MS = 30_000;
const PASSAGE_CHARS = 1200;

export interface WikiQueryEmbedder {
	profile: string;
	dimensions: number;
	embed(text: string): Promise<{ vector: readonly number[]; tokens: number }>;
}

export function wikiQueryEmbedder(
	env: Record<string, string | undefined>,
	fetchImpl: WikiEmbedFetch = (url, init) => fetch(url, init),
): WikiQueryEmbedder | null {
	if (env.EVF_WIKI_EMBEDDINGS !== "openai" || !providerAllowed(env, EMBEDDING_PATH)) return null;
	const provider = openAiWikiEmbedding(env, fetchImpl, QUERY_TIMEOUT_MS);
	return {
		profile: provider.profile,
		dimensions: provider.dimensions,
		async embed(text) {
			const { vectors, totalTokens } = await provider.embedMany([text]);
			const [vector] = vectors;
			if (!vector) throw new EmbeddingRefusal("openai_incomplete", totalTokens);
			return { vector, tokens: totalTokens };
		},
	};
}

export interface WikiPassageEmbedder {
	profile: string;
	dimensions: number;
	embedMany(texts: readonly string[]): Promise<{ vectors: number[][]; totalTokens: number }>;
}

export function passageTexts(text: string): string[] {
	const chars = Array.from(text);
	const texts: string[] = [];
	for (let start = 0; start < chars.length; start += PASSAGE_CHARS)
		texts.push(chars.slice(start, start + PASSAGE_CHARS).join(""));
	return texts;
}

export function wikiPassageEmbedder(
	env: Record<string, string | undefined>,
	fetchImpl: WikiEmbedFetch = (url, init) => fetch(url, init),
	timeoutMs = PASSAGE_TIMEOUT_MS,
): WikiPassageEmbedder | null {
	if (env.EVF_WIKI_EMBEDDINGS !== "openai" || !providerAllowed(env, EMBEDDING_PATH)) return null;
	return openAiWikiEmbedding(env, fetchImpl, timeoutMs);
}
