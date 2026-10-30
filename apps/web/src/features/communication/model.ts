// The shapes the Messages screens share. They match the WP-027 contract results. The client does not import the
// sanitizer.

export const audienceGroups = ["core_group", "launch_team", "leaders", "prospects", "all"] as const;
type AudienceGroup = (typeof audienceGroups)[number];

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
export type Recipient = { id: string; displayName: string; email: string | null };
export type AudienceSummary = {
	resolvedDistinctPeople: number;
	eligibleRecipients: number;
	missingEmailExclusions: string[];
	duplicateAddressesRemoved: number;
	recipients: { id: string; displayName: string; email: string }[];
	complete: boolean;
};

export type PageData = {
	drafts: Draft[];
	templates: Template[];
	teams: Team[];
	churchName: string;
	/** The app origin, for the RSVP preview link. */
	origin: string;
};

export type Outcome<T> = { status: "ok"; value: T } | { status: "refused"; code: string } | { status: "lost" };

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
		case "rsvp_needs_meeting":
			return "This message has an RSVP link. Start it from the meeting, or remove the RSVP line.";
		case "unavailable":
			return "Email delivery is not set up on this server. Nothing was sent.";
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

export type DeliveryReport = {
	status: "accepted" | "partial" | "uncertain" | "failed" | "accepted_unknown";
	acceptedCount: number;
	rejectedCount: number;
	unknownCount: number;
};

export type CancelReport = { scheduledCancel: "reconcile" | "confirmed" | "none" };
export type ReplaceReport = { replacementAllowed: boolean };
export type RescheduleReport = { rescheduleStatus: "accepted" | "unknown"; scheduledAt: string };
export type SuppressionReport = { address: string; active: boolean };
export type RestoreReport = { suppressionClears: number };

/** Provider acceptance is not delivery, and an unknown result is not a success. */
export function deliveryText(report: DeliveryReport): string {
	if (report.status === "failed") return "The provider refused this email. No recipient was accepted.";
	if (report.status === "uncertain" || report.status === "accepted_unknown")
		return "The provider did not confirm this email. It was not sent again.";
	if (report.status === "partial") {
		return `Accepted ${report.acceptedCount}. Refused ${report.rejectedCount}. No result yet for ${report.unknownCount}. Nothing was marked sent.`;
	}
	if (report.acceptedCount === 1) return "The provider accepted 1 recipient. Accepted does not mean delivered.";
	return `The provider accepted ${report.acceptedCount} recipients. Accepted does not mean delivered.`;
}

export function cancelText(report: CancelReport): string {
	if (report.scheduledCancel === "confirmed")
		return "The provider cancelled the scheduled send. Mail that already went out stays out.";
	if (report.scheduledCancel === "reconcile")
		return "Cancellation was requested. The provider has not confirmed it. Mail that already went out cannot be recalled.";
	return "No provider send is waiting to cancel. Mail that already went out cannot be recalled.";
}

export function replaceText(report: ReplaceReport): string {
	if (report.replacementAllowed)
		return "Every previous send is cancelled. Write a new message to send again. No email was sent.";
	return "A replacement stays blocked until every previous send is cancelled. No email was sent.";
}

export function rescheduleText(report: RescheduleReport, when: string): string {
	if (report.rescheduleStatus === "unknown")
		return `The send time is now ${when}. The provider has not confirmed that time.`;
	return `The send time is now ${when}. This change did not send the email.`;
}

export function restoreText(report: RestoreReport): string {
	if (report.suppressionClears > 0) return "This address can receive email again. No new email was sent.";
	return "This address was already clear. No new email was sent.";
}

export const hubStates = ["draft", "scheduled", "sending", "sent", "logged", "cancelled", "failed", "unknown"] as const;
export type HubState = (typeof hubStates)[number];
export const hubLabel: Record<HubState, string> = {
	draft: "Draft",
	scheduled: "Scheduled",
	sending: "Sending",
	sent: "Sent",
	logged: "Logged",
	cancelled: "Cancelled",
	failed: "Failed",
	unknown: "Unknown",
};

export type HistoryItem = {
	id: string;
	subject: string | null;
	state: HubState;
	channel: "email";
	meetingId: string | null;
	createdAt: string;
	countsAsSent: boolean;
	rate: number | null;
	reachable: number;
	delivered: number;
	scheduledAt: string | null;
	sentAt: string | null;
	senderName: string | null;
};

export type HistoryPage = {
	items: HistoryItem[];
	nextCursor: string | null;
	visibleCount: number;
	asOf: string;
	complete: boolean;
	limit: number;
	rate: number | null;
};

export type DeliveryTotals = {
	communicationId: string;
	state: HubState;
	selected: number;
	reachable: number;
	attempted: number;
	accepted: number;
	sent: number;
	delivered: number;
	opened: number;
	clicked: number;
	bounced: number;
	failed: number;
	suppressed: number;
	unknown: number;
	asOf: string;
	rate: number | null;
	outcomes: ("accepted" | "unknown" | "rejected")[];
	sentForAll: boolean;
};

export type DetailRecipient = {
	personId: string | null;
	deliveryAddress: string | null;
	currentPersonAddress: string | null;
	deliveryStatus: string;
	sentAt: string | null;
	deliveredAt: string | null;
	openedAt: string | null;
	clickedAt: string | null;
};

export type MessageDetail = {
	communicationId: string;
	revision: string;
	state: DraftState;
	subject: string | null;
	bodyHtml: string | null;
	bodyText: string | null;
	meetingId: string | null;
	scheduledAt: string | null;
	sentAt: string | null;
	senderName: string | null;
	deliveryAddress: string | null;
	currentPersonAddress: string | null;
	deliveryStatus: string | null;
	recipients: DetailRecipient[];
};

export type NamedRecipient = {
	personId: string | null;
	name: string | null;
	deliveryStatus: string;
	deliveryAddress: string | null;
};

export type MessageView = {
	detail: MessageDetail;
	totals: DeliveryTotals;
	recipients: NamedRecipient[];
	recipientsComplete: boolean;
};

export type ResendReview = {
	communicationId: string;
	eligibleIds: string[];
	eligibleNames: string[];
	excludedNames: string[];
	confirmedDelivery: boolean;
};

export type SavedResend = {
	communicationId: string;
	eligibleIds: string[];
	eligibleNames: string[];
};

const contactOutcomes = ["contacted", "attempted_no_contact", "administrative_completion", "no_longer_needed"] as const;
type ContactOutcome = (typeof contactOutcomes)[number];
export const contactLabel: Record<ContactOutcome, string> = {
	contacted: "Contacted",
	attempted_no_contact: "Attempt, no contact",
	administrative_completion: "Administrative completion",
	no_longer_needed: "No longer needed",
};

export type ContactRow = {
	outcomeId: string;
	outcome: ContactOutcome;
	occurredAt: string;
	voided: boolean;
	taskId: string | null;
};

export type PersonHistory = HistoryPage & {
	personId: string;
	lastConfirmedContactAt: string | null;
	contacts: ContactRow[];
};

export type MeetingHistory = HistoryPage & { meetingId: string };

export type TrackingRow = { personId: string; name: string; deliveryStatus: string };

/** Delivered divided by reachable. A zero reachable count has no rate. */
export function rateText(delivered: number, reachable: number, rate: number | null): string {
	if (rate === null || reachable === 0) return "No reachable recipients, so there is no delivery rate.";
	const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(rate);
	return `${delivered} delivered of ${reachable} reachable (${percent}).`;
}

export type MeetingContext = {
	id: string;
	type: MeetingType | "prelaunch_practice";
	title: string;
	date: string;
	time: string;
	place: string | null;
	guests: { id: string; displayName: string }[];
};

/** What one Send now did. `report` is null when the email was saved and scheduled but the send step did not finish. */
export type SendNowResult = {
	communicationId: string;
	revision: string;
	scheduledAt: string;
	report: DeliveryReport | null;
	sendIssue: string | null;
};

export const scheduledNotSentText =
	"The email is saved and scheduled, but it was not sent. Open it from Messages to send it again.";

/** The Messages address. Every state the page can show is one of these. */
export type Route =
	| { kind: "history"; message: string | null; meeting: string | null; person: string | null }
	| { kind: "compose"; id: string | "new"; step: Step; handoff: Handoff | null }
	| { kind: "templates"; template: string | "new" | null }
	| { kind: "address" };
export const steps = ["who", "write", "review"] as const;
export type Step = (typeof steps)[number];
export type Handoff = { meeting: string; template: string | null; recipients: "guests" | null };

type Query = Record<string, string | null | undefined>;

/** Reads the address. Unknown values fall back to the history list. */
export function parseRoute(q: Query): Route {
	const step = steps.find((value) => value === q.step) ?? "who";
	if (q.compose) return { kind: "compose", id: q.compose, step, handoff: null };
	if (q.meeting && q.template) {
		return {
			kind: "compose",
			id: "new",
			step: "write",
			handoff: { meeting: q.meeting, template: q.template, recipients: q.recipients === "guests" ? "guests" : null },
		};
	}
	if (q.view === "templates") return { kind: "templates", template: q.template ?? null };
	if (q.view === "address") return { kind: "address" };
	return { kind: "history", message: q.message ?? null, meeting: q.meeting ?? null, person: q.person ?? null };
}

/** The address for a route. It round-trips with parseRoute. */
export function routeHref(route: Route): string {
	const params = new URLSearchParams();
	if (route.kind === "compose") {
		params.set("compose", route.id);
		params.set("step", route.step);
	} else if (route.kind === "templates") {
		params.set("view", "templates");
		if (route.template) params.set("template", route.template);
	} else if (route.kind === "address") {
		params.set("view", "address");
	} else {
		if (route.message) params.set("message", route.message);
		if (route.meeting) params.set("meeting", route.meeting);
		if (route.person) params.set("person", route.person);
	}
	const text = params.toString();
	return text ? `/communication?${text}` : "/communication";
}
