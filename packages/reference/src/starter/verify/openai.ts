// Paid calls run only when the caller opts in. This module does not read the key until embedMany runs.

const MODEL = "text-embedding-3-small";
const PROFILE = "openai-text-embedding-3-small";
const DIMENSIONS = 1536;
const ENDPOINT = "https://api.openai.com/v1/embeddings";
const BATCH = 64;

export type WikiEmbedFetch = (url: string, init: RequestInit) => Promise<Response>;

export class EmbeddingRefusal extends Error {
	readonly usageTokens: number;
	constructor(reason: string, usageTokens = 0) {
		super(reason);
		this.name = "EmbeddingRefusal";
		this.usageTokens = usageTokens;
	}
}

function redact(message: string, key: string): string {
	return message.split(key).join("redacted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function usageTokens(payload: unknown): number {
	if (!isRecord(payload) || !isRecord(payload.usage)) return 0;
	const tokens = payload.usage.total_tokens;
	return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : 0;
}

async function requestBatch(
	input: readonly string[],
	key: string,
	fetchImpl: WikiEmbedFetch,
): Promise<{ vectors: number[][]; totalTokens: number }> {
	let response: Response;
	try {
		response = await fetchImpl(ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: MODEL, input, encoding_format: "float" }),
		});
	} catch (error) {
		throw new EmbeddingRefusal(redact(error instanceof Error ? error.message : "openai_request_failed", key));
	}
	if (!response.ok) {
		let detail = "";
		try {
			detail = await response.text();
		} catch {
			detail = "";
		}
		throw new EmbeddingRefusal(redact(`openai_http_${response.status}:${detail.slice(0, 180)}`, key));
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new EmbeddingRefusal(redact(error instanceof Error ? error.message : "openai_response", key));
	}
	const reported = usageTokens(payload);
	const data = isRecord(payload) ? payload.data : undefined;
	if (!Array.isArray(data) || data.length !== input.length) throw new EmbeddingRefusal("openai_incomplete", reported);
	const ordered: number[][] = new Array(input.length);
	for (const row of data) {
		if (!isRecord(row) || typeof row.index !== "number" || !Number.isInteger(row.index))
			throw new EmbeddingRefusal("openai_incomplete", reported);
		if (row.index < 0 || row.index >= input.length || ordered[row.index])
			throw new EmbeddingRefusal("openai_incomplete", reported);
		if (!Array.isArray(row.embedding)) throw new EmbeddingRefusal("openai_incomplete", reported);
		const values = row.embedding;
		if (values.length !== DIMENSIONS || values.some((value) => typeof value !== "number" || !Number.isFinite(value)))
			throw new EmbeddingRefusal("openai_dimensions", reported);
		ordered[row.index] = values.map((value) => Math.fround(value as number));
	}
	if (ordered.some((row) => row === undefined)) throw new EmbeddingRefusal("openai_incomplete", reported);
	return { vectors: ordered, totalTokens: reported };
}

async function embedMany(
	texts: readonly string[],
	env: Record<string, string | undefined>,
	fetchImpl: WikiEmbedFetch,
): Promise<{ vectors: number[][]; totalTokens: number }> {
	const key = env.OPENAI_API_KEY ?? "";
	if (key.length === 0) throw new EmbeddingRefusal("openai_key_missing");
	const vectors: number[][] = [];
	let totalTokens = 0;
	for (let start = 0; start < texts.length; start += BATCH) {
		try {
			const batch = await requestBatch(texts.slice(start, start + BATCH), key, fetchImpl);
			totalTokens += batch.totalTokens;
			vectors.push(...batch.vectors);
		} catch (error) {
			const reported = error instanceof EmbeddingRefusal ? error.usageTokens : 0;
			const reason =
				error instanceof EmbeddingRefusal
					? error.message
					: redact(error instanceof Error ? error.message : "openai_request_failed", key);
			throw new EmbeddingRefusal(reason, totalTokens + reported);
		}
	}
	return { vectors, totalTokens };
}

export function openAiWikiEmbedding(env: Record<string, string | undefined>, fetchImpl: WikiEmbedFetch = fetch) {
	return {
		profile: PROFILE,
		dimensions: DIMENSIONS,
		embedMany: (texts: readonly string[]) => embedMany(texts, env, fetchImpl),
	};
}
