import { localDate } from "@everyfield/contracts/common";
import type {
	AssessedCriterion,
	Assessment,
	AssessmentView,
	LensTile,
	NewestRun,
	PlantFacts,
	TrendValue,
} from "@everyfield/contracts/intelligence";

// Plant Intelligence's pure model (WP-044): labels, dates and the words of each state. No React and no server code, so
// the UI tests call it directly.

type Status = "positive" | "measured" | "attention" | "risk" | "unknown";

/** "Nov 2, 2026" for a plant-local calendar date. */
export const dayText = (d: string) =>
	new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));

/** One fact value in words: Unknown for null, Yes or No, a date, a status, or the number. */
export function factText(value: string | number | boolean | number[] | null): string {
	if (value === null) return "Unknown";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
	if (typeof value === "number") return String(value);
	if (localDate.safeParse(value).success) return dayText(value);
	const words = value.replaceAll("_", " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export const QUALITY: Record<LensTile["quality"], { label: string; note: string }> = {
	measured: { label: "Measured", note: "Counted from your records in Everyfield." },
	attested: { label: "Attested", note: "Answered by an Owner or Admin. Nothing here is counted yet." },
	unknown: { label: "Unknown", note: "No evidence yet. Unknown is not the same as weak." },
};
export const STANDING: Record<LensTile["standing"], { label: string; status: Status }> = {
	attention: { label: "Attention", status: "risk" },
	watch: { label: "Watch", status: "attention" },
	noted: { label: "Noted", status: "measured" },
	strength: { label: "Strength", status: "positive" },
	not_raised: { label: "Not raised", status: "unknown" },
	insufficient: { label: "Not enough evidence", status: "unknown" },
};
export const CRITERION: Record<AssessedCriterion["status"], { label: string; status: Status }> = {
	met: { label: "Met", status: "positive" },
	not_met: { label: "Not met", status: "attention" },
	unknown: { label: "Unknown", status: "unknown" },
	not_tracked: { label: "Not tracked", status: "unknown" },
};
export const SEVERITY_LABEL: Record<Assessment["focus"]["severity"], string> = {
	critical: "Urgent",
	high: "Urgent",
	medium: "Watch",
	low: "Worth knowing",
	info: "Going well",
};

/** The one line about the newest run when it is not the current one, or null when the current one is the newest. */
export function newestText(newest: NewestRun | null, hasCurrent: boolean): string | null {
	if (!newest) return null;
	const kept = hasCurrent ? " The assessment below is still the latest complete one." : "";
	switch (newest.state) {
		case "preparing":
			return `A new assessment is being prepared.${kept}`;
		case "deferred":
			return `A new assessment is waiting for the assessment service and will try again shortly.${kept}`;
		case "failed":
			return `The newest assessment couldn't be finished. Everyfield will try again.${kept}`;
		case "needs_review":
			return `The newest assessments couldn't be finished, so the Everyfield team is looking at them.${kept}`;
	}
}

/** The cold-start heading: not prepared yet, on its way, or couldn't be prepared yet. Never an empty "all good". */
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

/** Next steps from the measured facts alone: each names a real gap the records show, with where to act on it. */
export function nextSteps(facts: PlantFacts): { title: string; detail: string; href: string }[] {
	const steps: { title: string; detail: string; href: string }[] = [];
	const a = facts.committedAdults;
	if (a.needsClassifying.length)
		steps.push({
			title: `Record adult or child for ${plural(a.needsClassifying.length, "person", "people")} with a commitment`,
			detail: "Committed adults stay Unknown until everyone with a commitment is classified.",
			href: "/people",
		});
	if (a.status !== "met")
		steps.push({
			title: "Record commitments as people join",
			detail: `${plural(a.known, "committed adult")} known so far. The Phase 1 criterion is 30.`,
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
			href: "/follow-ups",
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
			title: `Answer ${plural(unanswered, "attestation")}`,
			detail: "Prayer, generosity and readiness rest on your answers until Everyfield can count them.",
			href: "/intelligence/attestations",
		});
	return steps;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The phase line: the assessment's phase, and the current phase separately when they differ. */
export function phaseNote(view: Pick<AssessmentView, "currentPhase">, assessment: Pick<Assessment, "phase">) {
	return view.currentPhase === assessment.phase ? null : view.currentPhase;
}

export const trendText = (v: TrendValue) =>
	v.state === "measured" ? String(v.value) : v.state === "unknown" ? "Unknown" : "Not measured";
