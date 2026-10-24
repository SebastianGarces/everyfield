import type { Database } from "@everyfield/db/client";
import { jobDatabase } from "../../../../server/database";
import { mailCallbackHandler } from "../../../../server/jobs/webhook";
import { safeResponse } from "../../../../server/platform/boundary";
import { verifyCallback } from "../../../../server/platform/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Verify the provider signature, then hand the same bytes to the one mail callback applier. */
export async function resendWebhook(
	request: Request,
	resolveDb: () => Database | null,
	secret = process.env.RESEND_WEBHOOK_SECRET ?? "",
) {
	if (request.method !== "POST") return safeResponse({ code: "method_not_allowed" }, 405);
	if (secret.length < 32) return safeResponse({ code: "unavailable" }, 404);
	const bytes = new Uint8Array(await request.arrayBuffer());
	try {
		verifyCallback(bytes, request.headers, secret);
	} catch {
		return safeResponse({ code: "invalid_signature" }, 401);
	}
	const db = resolveDb();
	if (!db) return safeResponse({ code: "unavailable" }, 404);
	const next = new Request(request.url, { method: "POST", headers: request.headers, body: bytes });
	return mailCallbackHandler(db, secret)(next);
}

export function GET() {
	return safeResponse({ code: "method_not_allowed" }, 405);
}

export function POST(request: Request) {
	return resendWebhook(request, () => jobDatabase());
}
