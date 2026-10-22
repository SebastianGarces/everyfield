import "server-only";
import { getViewer } from "@/server/request-context";
import { instant, recordId } from "@everyfield/contracts/common";
import type { z } from "zod";
import type { Outcome } from "../../components/save/model.ts";
import type { read, Viewer } from "./server.ts";

// The browser boundary every People server action shares: rebuild the viewer, parse the input, map the producer's reply.

export type Reply<T> = Awaited<ReturnType<typeof read<T>>>;
export const denied = { status: "refused", code: "access_denied" } as const;
export const invalid = { status: "refused", code: "invalid_input" } as const;

/**
 * What a saved change adds to the person's Activity: the write's audit record, when it was saved and whether it changed
 * anything. The screen shows the new entry from this answer instead of reloading the page.
 */
export type Receipt = { id: z.infer<typeof recordId>; at: z.infer<typeof instant>; changed: boolean };
export const receipt = (r: { receiptId: string; outcome: "changed" | "noop" }): Receipt => ({
	// The audit record's ID is the receipt's, and it is the entry's ID in Activity.
	id: recordId.parse(r.receiptId),
	at: instant.parse(new Date().toISOString()),
	changed: r.outcome === "changed",
});

export function outcome<T, U>(reply: Reply<T>, map: (value: T) => U): Outcome<U> {
	if (reply.status === "failed") return { status: "lost" };
	if (reply.status === "refused") return { status: "refused", code: reply.error.code };
	return { status: "ok", value: map(reply.value) };
}

/** Rebuilds the viewer and parses the raw input; refuses before any database work when either fails. */
export async function boundary<S extends z.ZodType, T>(
	schema: S,
	raw: unknown,
	run: (viewer: Viewer, input: z.output<S>) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
	const v = await getViewer();
	if (!v?.people) return denied;
	const input = schema.safeParse(raw);
	if (!input.success) return invalid;
	return run(v.people, input.data);
}
