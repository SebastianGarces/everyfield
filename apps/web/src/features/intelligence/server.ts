import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { careError, type CarePage, type CareReply } from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createPrivateCare, type PrivateCare } from "@everyfield/domain/intelligence";
import "server-only";
import type { Outcome } from "./model.ts";
import { logFailure, type LogWord } from "@everyfield/domain/log";

const care = createPrivateCare();

export type CareViewer = { authority: RequestActor; displayName: string; role: "owner" | "admin" | "member" };

export async function careViewer(): Promise<CareViewer | null> {
	const v = await getViewer();
	const authority = v?.authority;
	if (!authority) return null;
	const ctx = authority.actor.context;
	if (ctx.kind !== "seat" || ctx.owner.kind !== "plant") return null;
	return { authority, displayName: v.displayName ?? "", role: ctx.role };
}

const report = <O extends string>(outcome: LogWord<O>, error: unknown) =>
	logFailure({ component: "private-care", outcome }, error);

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
