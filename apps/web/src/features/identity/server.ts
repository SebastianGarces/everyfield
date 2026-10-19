import "server-only";
import { sessionResult, type SessionResult } from "@everyfield/contracts/identity";
import { InvitationRefusal } from "@everyfield/domain/identity";
import { headers } from "next/headers";
import { z } from "zod";
import { identityHandler } from "@/server/identity";

// Shared server helpers for the invitation and seat actions (WP-008/ui ruling U1). The session always comes from the
// identity mount for this request; the browser never sends an account, session or workspace.

/** A command's answer as plain data. A refusal means the server checked it and changed nothing. */
export type Reply = { status: "ok"; value: unknown } | { status: "refused"; code: string; retryAt: string | null };

export const refused = (code: string, retryAt: string | null = null): Reply => ({ status: "refused", code, retryAt });

/** This request's own native session, or null when the identity mount cannot answer. */
export async function currentSession(): Promise<SessionResult | null> {
	const origin = process.env.IDENTITY_ORIGIN;
	if (!origin) return null;
	const cookie = (await headers()).get("cookie");
	const response = await identityHandler(
		new Request(new URL("/api/auth/get-session", origin), {
			headers: { host: new URL(origin).host, ...(cookie ? { cookie } : {}) },
		}),
	);
	if (!response.ok) return null;
	const parsed = sessionResult.safeParse(await response.json().catch(() => null));
	return parsed.success ? parsed.data : null;
}

/**
 * Runs one domain call and turns the domain's own refusal into data. Any other failure is thrown on, so the browser
 * treats it as a lost reply and keeps the command frozen for an exact retry.
 */
export async function answer(call: () => Promise<unknown>): Promise<Reply> {
	try {
		return { status: "ok", value: await call() };
	} catch (e) {
		if (e instanceof InvitationRefusal) {
			const details = e.value.details as { retryAt?: string };
			return refused(e.value.code, details.retryAt ?? null);
		}
		if (e instanceof z.ZodError) return refused("invalid_input");
		throw e;
	}
}
