import { requestDatabase } from "@/server/database";
import type { AssessmentHistory, AssessmentView, PlantFacts } from "@everyfield/contracts/intelligence";
import type { Catalog } from "@everyfield/contracts/phases";
import type { RequestActor } from "@everyfield/domain/access";
import { createAssessments, createFacts } from "@everyfield/domain/intelligence";
import { readCatalog } from "@everyfield/domain/phases";
import "server-only";

// The Plant Intelligence pages reach the assessment domain here. They read saved results only: no read calls a model
// (PI-024). Every read rechecks the live Owner or Admin seat inside its own statement (C13). A database failure reads
// as lost, never as an empty assessment.

const assessments = createAssessments();
const facts = createFacts();

export type Loaded<T> = { status: "ok"; value: T } | { status: "denied" | "lost" };

const report = (what: string, error: unknown) =>
	console.error(
		JSON.stringify({ component: "plant-intelligence", what, outcome: "read_failed", error: String(error) }),
	);

/** /intelligence: the current assessment with its newest run (one statement), the measured facts (one) and the catalog. */
export async function loadAssessment(
	authority: RequestActor,
): Promise<Loaded<{ view: AssessmentView; facts: PlantFacts; catalog: Catalog }>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
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

/** /intelligence/trends: the latest twelve published runs' trend facts. One statement. */
export async function loadTrends(
	authority: RequestActor,
): Promise<Loaded<{ history: AssessmentHistory; catalog: Catalog }>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		const [history, catalog] = await Promise.all([assessments.readHistory(db, authority, {}), readCatalog()]);
		if (history.status !== "ok") return { status: "denied" };
		return { status: "ok", value: { history: history.value, catalog } };
	} catch (error) {
		report("trends", error);
		return { status: "lost" };
	}
}
