// The shapes the Messages screens share. They match the WP-027 contract results. The client does not import the
// sanitizer.

export const audienceGroups = ["core_group", "launch_team", "leaders", "prospects", "all"] as const;
export type AudienceGroup = (typeof audienceGroups)[number];

export const groupLabel: Record<AudienceGroup, string> = {
	core_group: "Core group",
	launch_team: "Launch team",
	leaders: "Leaders",
	prospects: "Prospects",
	all: "All people",
};

export const templateCategories = ["meeting_invitation", "meeting_reminder", "follow_up", "announcement"] as const;
export type TemplateCategory = (typeof templateCategories)[number];
export const categoryLabel: Record<TemplateCategory, string> = {
	meeting_invitation: "Meeting invitation",
	meeting_reminder: "Meeting reminder",
	follow_up: "Follow-up",
	announcement: "Announcement",
};

export const meetingTypes = ["vision_meeting", "orientation", "team_meeting"] as const;
export type MeetingType = (typeof meetingTypes)[number];
export const meetingLabel: Record<MeetingType, string> = {
	vision_meeting: "Vision meeting",
	orientation: "Orientation",
	team_meeting: "Team meeting",
};

export type Audience = { groups: string[]; teamIds: string[]; personIds: string[] };
export const emptyAudience = (): Audience => ({ groups: [], teamIds: [], personIds: [] });

export type DraftState = "draft" | "reviewed" | "scheduled";
export type Draft = {
	communicationId: string;
	revision: string;
	state: DraftState;
	subject: string | null;
	bodyHtml: string | null;
	bodyText: string | null;
	audience: Audience;
	meetingId: string | null;
	templateId: string | null;
	templateSource: string | null;
};

export type Template = {
	templateId: string;
	revision: string;
	sourceKey: string | null;
	name: string;
	description: string | null;
	category: TemplateCategory;
	meetingType: MeetingType | null;
	subject: string;
	bodyHtml: string;
	archived: boolean;
	origin: "system" | "plant";
};

export type Team = { id: string; name: string };
export type Recipient = { id: string; displayName: string; email: string };
export type AudienceSummary = {
	resolvedDistinctPeople: number;
	eligibleRecipients: number;
	missingEmailExclusions: string[];
	duplicateAddressesRemoved: number;
};
export type Preview = {
	previewBody: string;
	eligibleEmails: string[];
	excludedMissingEmail: string[];
	duplicateAddressesRemoved: number;
};

export type PageData = { drafts: Draft[]; templates: Template[]; teams: Team[] };

export type Outcome<T> = { status: "ok"; value: T } | { status: "refused"; code: string } | { status: "lost" };

export const stateLabel: Record<DraftState, string> = {
	draft: "Draft",
	reviewed: "Reviewed",
	scheduled: "Scheduled",
};

/** What the person can do about a refusal. The code stays the server's word. */
export function refusalText(code: string): string {
	switch (code) {
		case "access_denied":
			return "An Owner or Admin seat is required to change messages.";
		case "schedule_window_exceeded":
			return "Choose a send time from now through the next 30 days.";
		case "protected_source":
			return "System templates stay as they are. Fork the template to change a copy.";
		case "referenced":
			return "This template is used by a message. Archive it instead of deleting it.";
		case "not_found":
			return "That record is no longer here. Reload the page.";
		case "conflict":
			return "This record changed. Reload it, then try again.";
		case "stale_review":
			return "The message changed after review. Preview it again before you schedule it.";
		case "invalid_subject":
			return "That meeting or template is not in this church.";
		case "invalid_input":
			return "Check the subject, the message, and that at least one person can receive it.";
		default:
			return "Unable to save. Try again in a moment.";
	}
}

/** A system template is code. Its id is not a church row, so a draft stores the source key instead. */
export function templateBinding(template: Template): { templateId: string | null; templateSource: string | null } {
	if (template.origin === "system") return { templateId: null, templateSource: template.sourceKey };
	return { templateId: template.templateId, templateSource: template.sourceKey };
}

export function originLabel(template: Template): string {
	if (template.origin === "system") return "System template";
	if (template.sourceKey) return "Church copy";
	return "Church template";
}

export function outcomeText<T>(result: Outcome<T>): string | null {
	if (result.status === "ok") return null;
	if (result.status === "lost") return "Unable to reach the church records. Try again in a moment.";
	return refusalText(result.code);
}
