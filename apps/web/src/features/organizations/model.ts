import { normalizedEmail } from "@everyfield/contracts/identity";
import type { Category, Choices, HistoryItem, NameOf, Organization, RelationshipPair } from "./port";

/** REQ-IDN-022 categories, in the words the settings sharing card already uses (WP-010/ui). */
export const CATEGORY_TEXT: Record<Category, { label: string; description: string }> = {
	people: { label: "People", description: "Counts only, never names or personal details" },
	meetings: { label: "Meetings", description: "Counts and attendance totals" },
	tasks: { label: "Tasks", description: "Counts and progress" },
	ministry_teams: { label: "Ministry teams", description: "Teams and how many serve" },
	wiki: { label: "Wiki", description: "Totals for articles your church writes" },
	activity: { label: "Activity updates", description: "Milestones sent to them as they happen" },
	shared_findings: { label: "Plant Intelligence findings", description: "Shown to you first, then shared" },
};
export const CATEGORIES = Object.keys(CATEGORY_TEXT) as Category[];

/** What no organization ever receives, whatever the switches say (REQ-IDN-022, REQ-IDN-031). */
export const NEVER_SHARED = "Names, personal details, private check-ins and notes about care are never shared.";

export function kindLabel(organization: Organization): string {
	return organization.organizationKind === "sending_network" ? "Sending network" : "Sending church";
}

/** The side of the pair that asked to connect: a plant, a sending church or a Discovery account. */
export function subjectOf(pair: RelationshipPair) {
	return pair.kind === "discovery" ? ({ kind: "account", id: pair.accountId } as const) : pair.subject;
}

export function subjectName(pair: RelationshipPair, nameOf: NameOf): string {
	return nameOf(subjectOf(pair));
}

/** "Mar 2, 2026" in the reader's zone. Relationship dates are calendar facts; the hour adds nothing. */
export function formatDay(instant: string, zone: string): string {
	return new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric" }).format(
		new Date(instant),
	);
}

export function countOn(choices: Choices): number {
	return CATEGORIES.filter((c) => choices[c]).length;
}

/**
 * The words for one history row (REQ-IDN-021). A withheld reason says so, so a Member never reads "no reason" for a
 * reason they may not see. A recorded empty reason shows nothing. Only an end takes a reason, so a withheld reason
 * on an approval says nothing.
 */
export function historyReason(item: HistoryItem): { kind: "text" | "withheld"; text: string } | null {
	if (item.reason.status === "withheld")
		return item.event === "ended" ? { kind: "withheld", text: "Reason not shown to your role" } : null;
	return item.reason.value ? { kind: "text", text: item.reason.value } : null;
}

export type NoticeKind = "relationship_approved" | "relationship_ended" | "sharing_changed";

/**
 * Coarse relationship notice text (REQ-NTF-009, REQ-IDN-022). It states only the committed event and the other
 * organization's name. It never names a sharing category, a switch or any shared body.
 */
export function noticeText(kind: NoticeKind, organizationName: string): string {
	switch (kind) {
		case "relationship_approved":
			return `Your church is now connected with ${organizationName}.`;
		case "relationship_ended":
			return `Your church's connection with ${organizationName} ended.`;
		case "sharing_changed":
			return `What your church shares with ${organizationName} changed.`;
	}
}

export function emailProblem(value: string): string | undefined {
	const v = value.trim();
	if (!v) return "Enter the email address of their Owner or Admin.";
	if (v.length > 320 || !normalizedEmail.safeParse(v).success)
		return "Enter a full email address, like pastor@church.org.";
	return undefined;
}
