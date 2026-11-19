import type { Database } from "@everyfield/db/client";
import { jobDatabase } from "../database";
import { applyMailCallback } from "./webhook";
import { readBoundedBody } from "@everyfield/domain/operations";
import { Refusal, safeBoundary, safeResponse, signedRoute } from "../platform/boundary";
import { verifyCallback } from "../platform/webhook";

export async function resendWebhook(
	request: Request,
	resolveDb: () => Database | null,
	secret = process.env.RESEND_WEBHOOK_SECRET ?? "",
) {
	if (request.method !== "POST") return safeResponse({ code: "method_not_allowed" }, 405);
	if (secret.length < 32) return safeResponse({ code: "unavailable" }, 404);
	return safeBoundary(async () => {
		const bytes = await readBoundedBody(request, 16_384);
		if (!bytes) throw new Refusal("invalid_input", 413);
		let key: string;
		try {
			key = verifyCallback(bytes, request.headers, secret);
		} catch {
			return safeResponse({ code: "invalid_signature" }, 401);
		}
		const db = resolveDb();
		if (!db) return safeResponse({ code: "unavailable" }, 404);
		const result = await applyMailCallback(db, bytes, key);
		return safeResponse(result, result.result === "pending" ? 202 : 200);
	});
}

export function resendWebhookGet() {
	return safeResponse({ code: "method_not_allowed" }, 405);
}

export const resendWebhookPost = signedRoute(function resendWebhookPost(request: Request) {
	return resendWebhook(request, () => jobDatabase());
});
