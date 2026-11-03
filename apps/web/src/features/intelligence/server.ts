import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { careError, type CarePage, type CareReply } from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createPrivateCare, type PrivateCare } from "@everyfield/domain/intelligence";
import "server-only";
import type { Outcome } from "./model.ts";

// The private check-in page reaches the privateCare domain here. Pages and actions share the request's one viewer
// (D59/D60), and every read and write rechecks the live Owner or Admin seat and the author inside its statement. Failures
// log their kind only: no answer, note, week or count ever reaches a log line (REQ-KNOW-069, audit.md).

const care = createPrivateCare();

export type CareViewer = { authority: RequestActor; displayName: string; role: "owner" | "admin" | "member" };

/** The request's plant seat, or null for a signed-out reader, an organization seat or an account without a seat. */
export async function careViewer(): Promise<CareViewer | null> {
	const v = await getViewer();
	const authority = v?.authority;
	if (!authority) return null;
	const ctx = authority.actor.context;
	if (ctx.kind !== "seat" || ctx.owner.kind !== "plant") return null;
	return { authority, displayName: v.displayName ?? "", role: ctx.role };
}

const report = (outcome: string, error: unknown) =>
	console.error(
		JSON.stringify({ component: "private-care", outcome, kind: (error as { code?: string })?.code ?? "unknown" }),
	);

/** The /me/check-in page: the twelve-week strip, whose first week is this week. One statement. */
export async function loadCheckIn(viewer: CareViewer): Promise<Outcome<CarePage>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await care.readTrends(db, viewer.authority, {});
	} catch (error) {
		report("read_failed", error);
		return { status: "lost" };
	}
}

/** One check-in operation for the request's viewer. */
export async function run<T>(
	body: (care: PrivateCare, db: Database, authority: RequestActor) => Promise<CareReply<T>>,
): Promise<Outcome<T>> {
	const viewer = await careViewer();
	if (!viewer)
		return {
			status: "refused",
			error: careError.parse({
				code: "access_denied",
				details: {},
				correlationId: crypto.randomUUID(),
				retry: "never",
			}),
		};
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await body(care, db, viewer.authority);
	} catch (error) {
		report("call_failed", error);
		return { status: "lost" };
	}
}
