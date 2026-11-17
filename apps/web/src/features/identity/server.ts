import "server-only";
import { InvitationRefusal } from "@everyfield/domain/identity";
import { z } from "zod";

export type Reply = { status: "ok"; value: unknown } | { status: "refused"; code: string; retryAt: string | null };

export const refused = (code: string, retryAt: string | null = null): Reply => ({ status: "refused", code, retryAt });

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
