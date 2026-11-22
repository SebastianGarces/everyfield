import { EmbeddingRefusal, openAiWikiEmbedding, type WikiEmbedFetch } from "./openai.ts";

export { EmbeddingRefusal } from "./openai.ts";
export { DAILY_QUERY_CAP_USD, recordSpend, tokensFor } from "./spend.ts";

const QUERY_TIMEOUT_MS = 1500;

export interface WikiQueryEmbedder {
	profile: string;
	dimensions: number;
	embed(text: string): Promise<{ vector: readonly number[]; tokens: number }>;
}

export function wikiQueryEmbedder(
	env: Record<string, string | undefined>,
	fetchImpl: WikiEmbedFetch = (url, init) => fetch(url, init),
): WikiQueryEmbedder | null {
	if (env.EVF_WIKI_EMBEDDINGS !== "openai") return null;
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
