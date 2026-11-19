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
import { logFailure, type LogWord } from "@everyfield/domain/log";

const launch = createLaunchReader();
const assessments = createAssessments();

async function load<T, C extends string>(
	card: LogWord<C>,
	run: (
		db: NonNullable<ReturnType<typeof requestDatabase>>,
		authority: RequestActor,
	) => Promise<DashboardReply<T> | LaunchReply<T> | AssessmentReply<T>>,
): Promise<Loaded<T>> {
	const authority = (await getViewer()).authority;
	if (!authority) return { status: "lost" };
	const db = requestDatabase();
	try {
		const reply = await run(db, authority);
		return reply.status === "ok" ? { status: "ok", value: reply.value } : { status: "denied" };
	} catch (error) {
		logFailure({ component: "overview", card, outcome: "read_failed" }, error);
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
