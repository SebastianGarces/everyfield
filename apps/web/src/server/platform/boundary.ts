import "server-only";
import { randomUUID } from "node:crypto";

export const privateHeaders = {
	"Cache-Control": "private, no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};
export class Refusal extends Error {
	readonly code: "unavailable" | "invalid_input" | "origin_denied" | "conflict" | "rate_limited";
	readonly status: number;
	constructor(code: Refusal["code"], status: number) {
		super(code);
		this.code = code;
		this.status = status;
	}
}
export async function boundedBytes(request: Request, limit: number): Promise<Uint8Array> {
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			length += item.value.byteLength;
			if (length > limit) throw new Refusal("invalid_input", 413);
			chunks.push(item.value);
		}
	} finally {
		await reader.cancel();
	}
	return Buffer.concat(chunks);
}
export function safeResponse(body: unknown, status = 200) {
	return Response.json(body, { status, headers: privateHeaders });
}
export async function safeBoundary(body: () => Promise<Response>): Promise<Response> {
	const id = randomUUID();
	try {
		const result = await body();
		result.headers.set("X-Request-Id", id);
		return result;
	} catch (error) {
		// Never return SQL, stack, tokens, private subjects or provider payloads.
		const response = safeResponse(
			{ code: error instanceof Refusal ? error.code : "unavailable", requestId: id },
			error instanceof Refusal ? error.status : 503,
		);
		response.headers.set("X-Request-Id", id);
		return response;
	}
}
