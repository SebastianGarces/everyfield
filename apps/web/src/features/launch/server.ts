import { requestDatabase } from "@/server/database";
import { plantSeat, type PlantSeat } from "@/server/request-context";
import { launchError, type GatheringOffer, type LaunchReply, type Plan } from "@everyfield/contracts/launch";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createLaunchReader, type LaunchWriter } from "@everyfield/domain/launch";
import "server-only";
import { launchMount } from "./mount.ts";
import type { Outcome } from "./model.ts";
import { LOST, transient } from "../../server/platform/transient.ts";
import { readDb, guardedWrite } from "../../server/platform/tx.ts";

export const administers = (v: Pick<PlantSeat, "role">) => v.role !== "member";

const reader = createLaunchReader();

export async function loadOffers(viewer: PlantSeat): Promise<Outcome<GatheringOffer[]> | null> {
	if (!administers(viewer)) return null;
	const db = requestDatabase();
	return transient(
		{ component: "launch", outcome: "offers_read_failed" },
		() => reader.readGatheringOffers(db, viewer.authority),
		LOST,
	);
}

export async function loadPlan(viewer: PlantSeat): Promise<Outcome<Plan>> {
	return readDb("launch", async (db) => {
		const first = await reader.readPlan(db, viewer.authority);
		if (first.status !== "ok") return first;
		if (!first.value.repair || !administers(viewer)) return { status: "ok", value: first.value.plan };
		const mount = launchMount();
		const repaired = await mount.writer.ensureReadiness(mount.db, viewer.authority);
		if (repaired.status !== "ok") return { status: "ok", value: first.value.plan };
		const again = await reader.readPlan(db, viewer.authority);
		return again.status === "ok" ? { status: "ok", value: again.value.plan } : again;
	});
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
	viewer: PlantSeat | null,
	run: (
		reader: ReturnType<typeof createLaunchReader>,
		db: Database,
		authority: RequestActor,
	) => Promise<LaunchReply<T>>,
): Promise<Outcome<T>> {
	if (!viewer) return denied();
	return readDb("launch", (db) => run(reader, db, viewer.authority));
}

export async function write<T>(
	run: (writer: LaunchWriter, db: Database, authority: RequestActor) => Promise<LaunchReply<T>>,
): Promise<Outcome<T>> {
	const viewer = await plantSeat();
	if (!viewer) return denied();
	const mount = launchMount();
	return guardedWrite("launch", () => run(mount.writer, mount.db, viewer.authority));
}
