import type { Database } from "@everyfield/db/client";
import { jobDatabase } from "../../../../server/database";
import { applyMailCallback } from "../../../../server/jobs/webhook";
import { boundedBytes, safeBoundary, safeResponse } from "../../../../server/platform/boundary";
import { verifyCallback } from "../../../../server/platform/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read at most 16 KB, verify the provider signature once, then hand those verified bytes to the mail applier. */
export async function resendWebhook(
	request: Request,
	resolveDb: () => Database | null,
	secret = process.env.RESEND_WEBHOOK_SECRET ?? "",
) {
	if (request.method !== "POST") return safeResponse({ code: "method_not_allowed" }, 405);
	if (secret.length < 32) return safeResponse({ code: "unavailable" }, 404);
	return safeBoundary(async () => {
		const bytes = await boundedBytes(request, 16_384);
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

export function GET() {
	return safeResponse({ code: "method_not_allowed" }, 405);
}

export function POST(request: Request) {
	return resendWebhook(request, () => jobDatabase());
}
