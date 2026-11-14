import type { DemandKind, DraftRule, FailureCause } from "@everyfield/contracts/intelligence";

// The assessment review pages' words (PI-042). Pure, so a test can read them without React.

export const CAUSE: Record<FailureCause, { label: string; detail: string }> = {
	provider: {
		label: "Provider",
		detail: "The model provider was busy or did not answer within the draft's four attempts.",
	},
	output_check: {
		label: "Output check",
		detail: "Every draft broke at least one rule of the output check. The rules the final draft broke are listed.",
	},
	budget: { label: "Budget", detail: "The run reached its token budget before a draft passed." },
	persistence: {
		label: "Persistence",
		detail: "A draft passed, but saving the assessment failed, so nothing was published.",
	},
	deadline: { label: "Deadline", detail: "The provider asked to wait past the run's deadline." },
	guidance: { label: "Guidance", detail: "The methodology could not be read, or no reference is activated." },
};
export const DEMAND: Record<DemandKind, string> = {
	change: "A changed record or reference",
	time: "Seven days without a new assessment",
	manual: "An Owner or Admin asked",
	followup: "A newer run after an input changed",
};
export const RULE: Record<DraftRule, string> = {
	shape: "Wrong shape",
	missing_citation: "Missing citation",
	invented_citation: "Invented citation",
	invented_number: "Invented number",
	invented_date: "Invented date",
	unknown_as_known: "Unknown stated as known",
	private_content: "Private content",
	judgment: "Judgment",
	readiness_verdict: "Readiness verdict",
	action_claim: "Action claim",
};
/** "Nov 13, 2026, 3:42 PM" in UTC, so every operator reads the same time. */
export const timeLabel = (iso: string) =>
	`${new Date(iso).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	})} UTC`;
export const count = (n: number) => n.toLocaleString("en-US");
