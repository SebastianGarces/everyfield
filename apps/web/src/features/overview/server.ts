import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { Activity, DashboardReply, Metrics, OverviewFrame } from "@everyfield/contracts/dashboard";
import type { LaunchReply, Plan } from "@everyfield/contracts/launch";
import type { RequestActor } from "@everyfield/domain/access";
import { dashboardReader } from "@everyfield/domain/dashboard";
import { createLaunchReader } from "@everyfield/domain/launch";
import { cache } from "react";
import "server-only";
import type { Loaded } from "./model.ts";

// Overview reaches the dashboard and Launch domains here. The page and its cards share the request's one viewer
// (D59/D60), and each card reads on its own, so one failed read leaves the other cards showing (ADM-005). Every read
// rechecks the live seat inside its own statement (C13).

const launch = createLaunchReader();

/** One read for the request's plant seat. A thrown error or a missing database reads as lost, never as empty. */
async function load<T>(
	card: string,
	run: (
		db: NonNullable<ReturnType<typeof requestDatabase>>,
		authority: RequestActor,
	) => Promise<DashboardReply<T> | LaunchReply<T>>,
): Promise<Loaded<T>> {
	const authority = (await getViewer())?.authority;
	const db = requestDatabase();
	if (!authority || !db) return { status: "lost" };
	try {
		const reply = await run(db, authority);
		return reply.status === "ok" ? { status: "ok", value: reply.value } : { status: "denied" };
	} catch (error) {
		console.error(JSON.stringify({ component: "overview", card, outcome: "read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

/** The church as this seat sees it: name, saved phase, quick actions, setup gaps and prompts. One statement. */
export const loadFrame = cache((): Promise<Loaded<OverviewFrame>> =>
	load("frame", (db, a) => dashboardReader.readAvailableActions(db, a)),
);
export const loadMetrics = (): Promise<Loaded<Metrics>> =>
	load("metrics", (db, a) => dashboardReader.readMetrics(db, a));
export const loadActivity = (): Promise<Loaded<Activity>> =>
	load("activity", (db, a) => dashboardReader.readActivity(db, a));
/** The Launch plan as /launch reads it, without its readiness repair: Overview never writes. */
export const loadLaunch = (): Promise<Loaded<Plan>> =>
	load("launch", async (db, a) => {
		const r = await launch.readPlan(db, a);
		return r.status === "ok" ? { status: "ok", value: r.value.plan } : r;
	});
