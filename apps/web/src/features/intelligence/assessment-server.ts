import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type {
	AssessmentHistory,
	AssessmentReply,
	AssessmentView,
	PlantFacts,
} from "@everyfield/contracts/intelligence";
import type { Database } from "@everyfield/db/client";
import type { Catalog } from "@everyfield/contracts/phases";
import type { RequestActor } from "@everyfield/domain/access";
import { createAssessments, createFacts, type Assessments } from "@everyfield/domain/intelligence";
import { readCatalog } from "@everyfield/domain/phases";
import "server-only";
import type { ActionOutcome } from "./assessment-model.ts";
import { isTransient, logFailure, type LogWord } from "@everyfield/domain/log";
import { LOST, transient, unexpected } from "../../server/platform/transient.ts";

const assessments = createAssessments();
const facts = createFacts();

export async function runAssessment<T>(
	component: "refresh" | "seen" | "feedback" | "citation",
	body: (a: Assessments, db: Database, authority: RequestActor) => Promise<AssessmentReply<T>>,
): Promise<ActionOutcome<T>> {
	const { authority } = await getViewer();
	if (!authority) return { status: "signed_out" };
	const db = requestDatabase();
	return transient(
		{ component: "assessment", outcome: `${component}_failed` },
		() => body(assessments, db, authority),
		LOST,
	);
}

export type Loaded<T> = { status: "ok"; value: T } | { status: "denied" | "lost" };

const report = <W extends string>(what: LogWord<W>, error: unknown) =>
	logFailure({ component: "plant-intelligence", what, outcome: "read_failed" }, error);

export async function loadAssessment(
	authority: RequestActor,
): Promise<Loaded<{ view: AssessmentView; facts: PlantFacts; catalog: Catalog }>> {
	const db = requestDatabase();
	try {
		const [view, measured, catalog] = await Promise.all([
			assessments.readAssessment(db, authority, {}),
			facts.readFacts(db, authority),
			readCatalog(),
		]);
		if (view.status !== "ok" || measured.status !== "ok") return { status: "denied" };
		return { status: "ok", value: { view: view.value, facts: measured.value, catalog } };
	} catch (error) {
		if (!isTransient(error))
			throw unexpected({ component: "plant-intelligence", what: "assessment", outcome: "read_failed" }, error);
		report("assessment", error);
		return { status: "lost" };
	}
}

export async function loadTrends(
	authority: RequestActor,
): Promise<Loaded<{ history: AssessmentHistory; catalog: Catalog }>> {
	const db = requestDatabase();
	try {
		const [history, catalog] = await Promise.all([assessments.readHistory(db, authority, {}), readCatalog()]);
		if (history.status !== "ok") return { status: "denied" };
		return { status: "ok", value: { history: history.value, catalog } };
	} catch (error) {
		if (!isTransient(error))
			throw unexpected({ component: "plant-intelligence", what: "trends", outcome: "read_failed" }, error);
		report("trends", error);
		return { status: "lost" };
	}
}
