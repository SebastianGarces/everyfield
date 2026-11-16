import { normalizedEmail } from "@everyfield/contracts/identity";
import type { Category, HistoryItem, NameOf, Organization, RelationshipPair } from "./port";

export const CATEGORY_TEXT: Record<Category, { label: string; description: string }> = {
	people: { label: "People", description: "Counts only, never names or personal details" },
	meetings: { label: "Meetings", description: "Counts and attendance totals" },
	tasks: { label: "Tasks", description: "Counts and progress" },
	ministry_teams: { label: "Ministry teams", description: "Teams and how many serve" },
	wiki: { label: "Wiki", description: "Totals for articles your church writes. Their Wiki also shows in Wiki sources" },
	activity: { label: "Activity updates", description: "Milestones sent to them as they happen" },
	shared_findings: { label: "Plant Intelligence findings", description: "Shown to you first, then shared" },
};
export const CATEGORIES = Object.keys(CATEGORY_TEXT) as Category[];

export const NEVER_SHARED = "Names, personal details, private check-ins and notes about care are never shared.";

export function kindLabel(organization: Organization): string {
	return organization.organizationKind === "sending_network" ? "Sending network" : "Sending church";
}

export function subjectOf(pair: RelationshipPair) {
	return pair.kind === "discovery" ? ({ kind: "account", id: pair.accountId } as const) : pair.subject;
}

export function subjectName(pair: RelationshipPair, nameOf: NameOf): string {
	return nameOf(subjectOf(pair));
}

export function historyReason(item: HistoryItem): { kind: "text" | "withheld"; text: string } | null {
	if (item.reason.status === "withheld")
		return item.event === "ended" ? { kind: "withheld", text: "Reason not shown to your role" } : null;
	return item.reason.value ? { kind: "text", text: item.reason.value } : null;
}

export type NoticeKind = "relationship_approved" | "relationship_ended" | "sharing_changed";

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
