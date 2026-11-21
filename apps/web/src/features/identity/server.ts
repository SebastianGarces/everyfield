import "server-only";
import { invitationRefusals } from "@everyfield/domain/identity";
import { z } from "zod";

export type Reply = { status: "ok"; value: unknown } | { status: "refused"; code: string; retryAt: string | null };

export const refused = (code: string, retryAt: string | null = null): Reply => ({ status: "refused", code, retryAt });

export async function answer(call: () => Promise<unknown>): Promise<Reply> {
	try {
		return { status: "ok", value: await call() };
	} catch (e) {
		if (e instanceof invitationRefusals.Refusal) {
			const { error } = invitationRefusals.refusalOf(e);
			return refused(error.code, "retryAt" in error.details ? error.details.retryAt : null);
		}
		if (e instanceof z.ZodError) return refused("invalid_input");
		throw e;
	}
}
