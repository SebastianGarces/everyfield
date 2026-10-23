// Paid calls run only when the caller opts in. This module does not read the key until embedMany runs.

const MODEL = "text-embedding-3-small";
const PROFILE = "openai-text-embedding-3-small";
const DIMENSIONS = 1536;
const ENDPOINT = "https://api.openai.com/v1/embeddings";
const BATCH = 64;

export const openAiEmbeddingProfile = {
	profile: PROFILE,
	model: MODEL,
	dimensions: DIMENSIONS,
} as const;

export type WikiEmbedFetch = (url: string, init: RequestInit) => Promise<Response>;

function redact(message: string, key: string): string {
	return message.split(key).join("redacted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function requestBatch(input: readonly string[], key: string, fetchImpl: WikiEmbedFetch): Promise<number[][]> {
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
		throw new Error(redact(error instanceof Error ? error.message : "openai_request_failed", key));
	}
	if (!response.ok) {
		let detail = "";
		try {
			detail = await response.text();
		} catch {
			detail = "";
		}
		throw new Error(redact(`openai_http_${response.status}:${detail.slice(0, 180)}`, key));
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(redact(error instanceof Error ? error.message : "openai_response", key));
	}
	const data = isRecord(payload) ? payload.data : undefined;
	if (!Array.isArray(data) || data.length !== input.length) throw new Error("openai_incomplete");
	const ordered: number[][] = new Array(input.length);
	for (const row of data) {
		if (!isRecord(row) || typeof row.index !== "number" || !Number.isInteger(row.index))
			throw new Error("openai_incomplete");
		if (row.index < 0 || row.index >= input.length || ordered[row.index]) throw new Error("openai_incomplete");
		if (!Array.isArray(row.embedding)) throw new Error("openai_incomplete");
		const values = row.embedding;
		if (values.length !== DIMENSIONS || values.some((value) => typeof value !== "number" || !Number.isFinite(value)))
			throw new Error("openai_dimensions");
		ordered[row.index] = values.map((value) => Math.fround(value as number));
	}
	if (ordered.some((row) => row === undefined)) throw new Error("openai_incomplete");
	return ordered;
}

async function embedMany(
	texts: readonly string[],
	env: Record<string, string | undefined>,
	fetchImpl: WikiEmbedFetch,
): Promise<number[][]> {
	const key = env.OPENAI_API_KEY ?? "";
	if (key.length === 0) throw new Error("openai_key_missing");
	const vectors: number[][] = [];
	for (let start = 0; start < texts.length; start += BATCH) {
		vectors.push(...(await requestBatch(texts.slice(start, start + BATCH), key, fetchImpl)));
	}
	return vectors;
}

export function openAiWikiEmbedding(env: Record<string, string | undefined>, fetchImpl: WikiEmbedFetch = fetch) {
	return {
		profile: PROFILE,
		dimensions: DIMENSIONS,
		embedMany: (texts: readonly string[]) => embedMany(texts, env, fetchImpl),
	};
}
