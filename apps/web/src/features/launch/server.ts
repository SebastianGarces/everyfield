import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import { launchError, type GatheringOffer, type LaunchReply, type Plan } from "@everyfield/contracts/launch";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createLaunchReader, type LaunchWriter } from "@everyfield/domain/launch";
import "server-only";
import { launchMount } from "./mount.ts";
import type { Outcome } from "./model.ts";
import { LOST, transient } from "@/server/platform/transient";

export type LaunchViewer = { authority: RequestActor; accountId: string; role: "owner" | "admin" | "member" };

export async function launchViewer(): Promise<LaunchViewer | null> {
	const v = await getViewer();
	const authority = v.authority;
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
	return transient(
		{ component: "launch", outcome: "offers_read_failed" },
		() => reader.readGatheringOffers(db, viewer.authority),
		LOST,
	);
}

export async function loadPlan(viewer: LaunchViewer): Promise<Outcome<Plan>> {
	const db = requestDatabase();
	return transient(
		{ component: "launch", outcome: "read_failed" },
		async () => {
			const first = await reader.readPlan(db, viewer.authority);
			if (first.status !== "ok") return first;
			if (!first.value.repair || !administers(viewer)) return { status: "ok", value: first.value.plan };
			const mount = launchMount();
			const repaired = await mount.writer.ensureReadiness(mount.db, viewer.authority);
			if (repaired.status !== "ok") return { status: "ok", value: first.value.plan };
			const again = await reader.readPlan(db, viewer.authority);
			return again.status === "ok" ? { status: "ok", value: again.value.plan } : again;
		},
		LOST,
	);
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
	viewer: LaunchViewer | null,
	run: (
		reader: ReturnType<typeof createLaunchReader>,
		db: Database,
		authority: RequestActor,
	) => Promise<LaunchReply<T>>,
): Promise<Outcome<T>> {
	if (!viewer) return denied();
	const db = requestDatabase();
	return transient({ component: "launch", outcome: "read_failed" }, () => run(reader, db, viewer.authority), LOST);
}

export async function write<T>(
	run: (writer: LaunchWriter, db: Database, authority: RequestActor) => Promise<LaunchReply<T>>,
): Promise<Outcome<T>> {
	const viewer = await launchViewer();
	if (!viewer) return denied();
	const mount = launchMount();
	return transient(
		{ component: "launch", outcome: "write_failed" },
		() => run(mount.writer, mount.db, viewer.authority),
		LOST,
	);
}
