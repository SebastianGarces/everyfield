import { hash } from "../../hash.ts";
import { approvedWiki } from "../manifest/approved.ts";
import { openAiWikiEmbedding, type WikiEmbedFetch } from "./openai.ts";

// Local stand-in for a model. Values are float32 so the checksum matches the stored vector.
export function localEmbedding(text: string): number[] {
	const digest = hash(text);
	const values: number[] = [];
	for (let index = 0; index < approvedWiki.embeddingDimensions; index++) {
		const byte = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
		values.push(Math.fround(byte / 255));
	}
	return values;
}

export type WikiEmbedder = (text: string) => readonly number[] | Promise<readonly number[]>;
export type WikiEmbedMany = (
	texts: readonly string[],
) => Promise<{ vectors: readonly (readonly number[])[]; totalTokens: number }>;
export type { WikiEmbedFetch };

export interface ResolvedWikiEmbedding {
	profile: string;
	dimensions: number;
	embed?: WikiEmbedder;
	embedMany?: WikiEmbedMany;
}

// A present OPENAI_API_KEY is not an opt-in. Tests inject embed and stay on the local provider.
export function resolveWikiEmbedding(
	env: Record<string, string | undefined>,
	deps: {
		embed?: WikiEmbedder;
		embeddingProfile?: string;
		embeddingDimensions?: number;
		fetch?: WikiEmbedFetch;
	} = {},
): ResolvedWikiEmbedding {
	if (deps.embed) {
		return {
			profile: deps.embeddingProfile ?? approvedWiki.embeddingProfile,
			dimensions: deps.embeddingDimensions ?? approvedWiki.embeddingDimensions,
			embed: deps.embed,
		};
	}
	if (env.EVF_WIKI_EMBEDDINGS === "openai") {
		const provider = openAiWikiEmbedding(env, deps.fetch);
		return {
			profile: provider.profile,
			dimensions: provider.dimensions,
			embedMany: provider.embedMany,
		};
	}
	return {
		profile: approvedWiki.embeddingProfile,
		dimensions: approvedWiki.embeddingDimensions,
		embed: localEmbedding,
	};
}
