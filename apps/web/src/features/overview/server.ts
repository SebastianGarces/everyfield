import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { Activity, DashboardReply, Metrics, OverviewFrame } from "@everyfield/contracts/dashboard";
import type { LaunchReply, Plan } from "@everyfield/contracts/launch";
import type { AssessmentReply, AssessmentView } from "@everyfield/contracts/intelligence";
import type { RequestActor } from "@everyfield/domain/access";
import { dashboardReader } from "@everyfield/domain/dashboard";
import { createAssessments } from "@everyfield/domain/intelligence";
import { createLaunchReader } from "@everyfield/domain/launch";
import { cache } from "react";
import "server-only";
import type { Loaded } from "./model.ts";

const launch = createLaunchReader();
const assessments = createAssessments();

async function load<T>(
	card: string,
	run: (
		db: NonNullable<ReturnType<typeof requestDatabase>>,
		authority: RequestActor,
	) => Promise<DashboardReply<T> | LaunchReply<T> | AssessmentReply<T>>,
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

export const loadFrame = cache((): Promise<Loaded<OverviewFrame>> =>
	load("frame", (db, a) => dashboardReader.readAvailableActions(db, a)),
);
export const loadMetrics = (): Promise<Loaded<Metrics>> =>
	load("metrics", (db, a) => dashboardReader.readMetrics(db, a));
export const loadActivity = (): Promise<Loaded<Activity>> =>
	load("activity", (db, a) => dashboardReader.readActivity(db, a));
export const loadLaunch = (): Promise<Loaded<Plan>> =>
	load("launch", async (db, a) => {
		const r = await launch.readPlan(db, a);
		return r.status === "ok" ? { status: "ok", value: r.value.plan } : r;
	});
export const loadIntelligence = (): Promise<Loaded<AssessmentView>> =>
	load("intelligence", (db, a) => assessments.readAssessment(db, a, {}));
