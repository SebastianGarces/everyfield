import { requestDatabase } from "@/server/database";
import type { AssessmentHistory, AssessmentView, PlantFacts } from "@everyfield/contracts/intelligence";
import type { Catalog } from "@everyfield/contracts/phases";
import type { RequestActor } from "@everyfield/domain/access";
import { createAssessments, createFacts } from "@everyfield/domain/intelligence";
import { readCatalog } from "@everyfield/domain/phases";
import "server-only";
import { logFailure, type LogWord } from "@everyfield/domain/log";

const assessments = createAssessments();
const facts = createFacts();

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
		report("trends", error);
		return { status: "lost" };
	}
}
