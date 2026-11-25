import { counted } from "../common/text.ts";
import type { NewestRun } from "./assessment.ts";
import type { PlantFacts } from "./facts.ts";

export type ColdStartStep = { title: string; detail: string; href: string };

export function coldStartTitle(newest: NewestRun | null): { title: string; body: string } {
	if (newest?.state === "preparing" || newest?.state === "deferred")
		return {
			title: "Your first assessment is on its way",
			body: "Everyfield is preparing it in the background from your records. It shows here when it is ready.",
		};
	if (newest)
		return {
			title: "Your first assessment couldn't be prepared yet",
			body: "Everyfield will try again on its own. Nothing is lost, and nothing here is a result yet.",
		};
	return {
		title: "Your first assessment hasn't been prepared yet",
		body: "Everyfield prepares one in the background when your records change, and at least once a week.",
	};
}

function nextSteps(facts: PlantFacts): ColdStartStep[] {
	const steps: ColdStartStep[] = [];
	const a = facts.committedAdults;
	if (a.needsClassifying.length)
		steps.push({
			title: `Record adult or child for ${counted(a.needsClassifying.length, "person", "people")} with a commitment`,
			detail: "Committed adults stay Unknown until everyone with a commitment is classified.",
			href: "/people",
		});
	if (a.status !== "met")
		steps.push({
			title: "Record commitments as people join",
			detail: `${counted(a.known, "committed adult")} known so far. The Phase 1 criterion is 30.`,
			href: "/people",
		});
	if (facts.vision.status === "unknown")
		steps.push({
			title: "Record your Vision meetings and who came",
			detail: "Vision rhythm is measured from held meetings with their attendance.",
			href: "/meetings",
		});
	if (facts.followUps.status === "unknown")
		steps.push({
			title: "Track follow-ups after meetings",
			detail: "Follow-ups are measured once one is due and recorded.",
			href: "/tasks/follow-ups",
		});
	if (facts.coverage.filled < facts.coverage.slots)
		steps.push({
			title: "Fill the ministry responsibilities",
			detail: `${facts.coverage.filled} of ${facts.coverage.slots} have someone assigned.`,
			href: "/ministries",
		});
	const unanswered = facts.attestations.filter((s) => s.state !== "answered").length;
	if (unanswered)
		steps.push({
			title: `Answer ${counted(unanswered, "attestation")}`,
			detail: "Prayer, generosity and readiness rest on your answers until Everyfield can count them.",
			href: "/intelligence/attestations",
		});
	return steps;
}

export const coldStartGuidance = (newest: NewestRun | null, facts: PlantFacts) => ({
	...coldStartTitle(newest),
	results: "Until then there are no results to show, so nothing here is met or unmet.",
	steps: nextSteps(facts),
	noSteps: "Your records show no gap to act on yet.",
});
