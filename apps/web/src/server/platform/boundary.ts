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
		const response = safeResponse(
			{ code: error instanceof Refusal ? error.code : "unavailable", requestId: id },
			error instanceof Refusal ? error.status : 503,
		);
		response.headers.set("X-Request-Id", id);
		return response;
	}
}
