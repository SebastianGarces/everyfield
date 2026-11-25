import { dayText, localDate, type Outcome } from "@everyfield/contracts/common";
import type {
	AssessedCriterion,
	Assessment,
	AssessmentError,
	LensTile,
	NewestRun,
	TrendValue,
} from "@everyfield/contracts/intelligence";

export type ActionOutcome<T> =
	Outcome<T, AssessmentError["code"], { error: AssessmentError }> | { status: "signed_out" };

type Status = "positive" | "measured" | "attention" | "risk" | "unknown";

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

export function refreshProblem(outcome: ActionOutcome<unknown>): string | null {
	switch (outcome.status) {
		case "ok":
			return null;
		case "signed_out":
			return "You're signed out, so nothing was requested. Sign in and try again.";
		case "refused":
			return "You can't request a new assessment for this church. Only its Owners and Admins can.";
		default:
			return "We couldn't request a new assessment. The assessment below is unchanged. Try again in a moment.";
	}
}

export const trendText = (v: TrendValue) =>
	v.state === "measured" ? String(v.value) : v.state === "unknown" ? "Unknown" : "Not measured";
