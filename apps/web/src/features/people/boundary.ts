import "server-only";
import { getViewer } from "@/server/request-context";
import { instant, recordId } from "@everyfield/contracts/common";
import type { z } from "zod";
import type { Outcome } from "../../components/save/model.ts";
import type { read, Viewer } from "./server.ts";

export type Reply<T> = Awaited<ReturnType<typeof read<T>>>;
const denied = { status: "refused", code: "access_denied" } as const;
export const invalid = { status: "refused", code: "invalid_input" } as const;

export type Receipt = { id: z.infer<typeof recordId>; at: z.infer<typeof instant>; changed: boolean };
export const receipt = (r: { receiptId: string; outcome: "changed" | "noop" }): Receipt => ({
	id: recordId.parse(r.receiptId),
	at: instant.parse(new Date().toISOString()),
	changed: r.outcome === "changed",
});

export function outcome<T, U>(reply: Reply<T>, map: (value: T) => U): Outcome<U> {
	if (reply.status === "failed") return { status: "lost" };
	if (reply.status === "refused") {
		const { code, details } = reply.error;
		const reason = code === "invalid_input" ? details.reason : undefined;
		return reason ? { status: "refused", code, reason } : { status: "refused", code };
	}
	return { status: "ok", value: map(reply.value) };
}

export async function boundary<T>(run: (viewer: Viewer) => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const v = await getViewer();
	return v.people ? run(v.people) : denied;
}

export async function parsed<S extends z.ZodType, T>(
	schema: S,
	raw: unknown,
	run: (viewer: Viewer, input: z.output<S>) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
	return boundary(async (v) => {
		const input = schema.safeParse(raw);
		return input.success ? run(v, input.data) : invalid;
	});
}
