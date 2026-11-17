import { requestDatabase } from "@/server/database";
import { launchMount } from "@/server/launch";
import { getViewer } from "@/server/request-context";
import { launchError, type GatheringOffer, type LaunchReply, type Plan } from "@everyfield/contracts/launch";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createLaunchReader, type LaunchWriter } from "@everyfield/domain/launch";
import "server-only";
import type { Outcome } from "./model.ts";

export type LaunchViewer = { authority: RequestActor; accountId: string; role: "owner" | "admin" | "member" };

export async function launchViewer(): Promise<LaunchViewer | null> {
	const v = await getViewer();
	const authority = v?.authority;
	if (!authority) return null;
	const ctx = authority.actor.context;
	if (ctx.kind !== "seat" || ctx.owner.kind !== "plant") return null;
	return { authority, accountId: authority.actor.accountId, role: ctx.role };
}
export const administers = (v: Pick<LaunchViewer, "role">) => v.role !== "member";

const reader = createLaunchReader();

export async function loadOffers(viewer: LaunchViewer): Promise<Outcome<GatheringOffer[]> | null> {
	if (!administers(viewer)) return null;
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await reader.readGatheringOffers(db, viewer.authority);
	} catch (error) {
		console.error(JSON.stringify({ component: "launch", outcome: "offers_read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export async function loadPlan(viewer: LaunchViewer): Promise<Outcome<Plan>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		const first = await reader.readPlan(db, viewer.authority);
		if (first.status !== "ok") return first;
		if (!first.value.repair || !administers(viewer)) return { status: "ok", value: first.value.plan };
		const mount = launchMount();
		if (!mount) return { status: "ok", value: first.value.plan };
		const repaired = await mount.writer.ensureReadiness(mount.db, viewer.authority);
		if (repaired.status !== "ok") return { status: "ok", value: first.value.plan };
		const again = await reader.readPlan(db, viewer.authority);
		return again.status === "ok" ? { status: "ok", value: again.value.plan } : again;
	} catch (error) {
		console.error(JSON.stringify({ component: "launch", outcome: "read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

const denied = () =>
	({
		status: "refused",
		error: launchError.parse({
			code: "access_denied",
			details: {},
			correlationId: crypto.randomUUID(),
			retry: "never",
		}),
	}) as const;

export async function read<T>(
	run: (
		reader: ReturnType<typeof createLaunchReader>,
		db: Database,
		authority: RequestActor,
	) => Promise<LaunchReply<T>>,
): Promise<Outcome<T>> {
	const viewer = await launchViewer();
	if (!viewer) return denied();
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await run(reader, db, viewer.authority);
	} catch (error) {
		console.error(JSON.stringify({ component: "launch", outcome: "read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export async function write<T>(
	run: (writer: LaunchWriter, db: Database, authority: RequestActor) => Promise<LaunchReply<T>>,
): Promise<Outcome<T>> {
	const viewer = await launchViewer();
	if (!viewer) return denied();
	const mount = launchMount();
	if (!mount) return { status: "lost" };
	try {
		return await run(mount.writer, mount.db, viewer.authority);
	} catch (error) {
		console.error(JSON.stringify({ component: "launch", outcome: "write_failed", error: String(error) }));
		return { status: "lost" };
	}
}
