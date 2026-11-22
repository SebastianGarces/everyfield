const MODEL = "text-embedding-3-small";
const PROFILE = "openai-text-embedding-3-small";
const DIMENSIONS = 1536;
const ENDPOINT = "https://api.openai.com/v1/embeddings";
const BATCH = 64;

export type WikiEmbedFetch = (url: string, init: RequestInit) => Promise<Response>;

export class EmbeddingRefusal extends Error {
	readonly code: string;
	readonly usageTokens: number;
	constructor(code: string, usageTokens = 0) {
		super(code);
		this.name = "EmbeddingRefusal";
		this.code = code;
		this.usageTokens = usageTokens;
	}
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
	timeoutMs: number | null,
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
			...(timeoutMs === null ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
		});
	} catch (error) {
		throw new EmbeddingRefusal(
			error instanceof Error && error.name === "TimeoutError" ? "openai_timeout" : "openai_request_failed",
		);
	}
	if (!response.ok) throw new EmbeddingRefusal(`openai_http_${response.status}`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new EmbeddingRefusal("openai_response");
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
	timeoutMs: number | null,
): Promise<{ vectors: number[][]; totalTokens: number }> {
	const key = env.OPENAI_API_KEY ?? "";
	if (key.length === 0) throw new EmbeddingRefusal("openai_key_missing");
	const vectors: number[][] = [];
	let totalTokens = 0;
	for (let start = 0; start < texts.length; start += BATCH) {
		try {
			const batch = await requestBatch(texts.slice(start, start + BATCH), key, fetchImpl, timeoutMs);
			totalTokens += batch.totalTokens;
			vectors.push(...batch.vectors);
		} catch (error) {
			if (!(error instanceof EmbeddingRefusal)) throw new EmbeddingRefusal("openai_request_failed", totalTokens);
			throw new EmbeddingRefusal(error.code, totalTokens + error.usageTokens);
		}
	}
	return { vectors, totalTokens };
}

export function openAiWikiEmbedding(
	env: Record<string, string | undefined>,
	fetchImpl: WikiEmbedFetch = fetch,
	timeoutMs: number | null = null,
) {
	return {
		profile: PROFILE,
		dimensions: DIMENSIONS,
		embedMany: (texts: readonly string[]) => embedMany(texts, env, fetchImpl, timeoutMs),
	};
}
