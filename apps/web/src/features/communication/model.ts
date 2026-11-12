// The shapes the Messages screens share. They match the WP-027 contract results. This module imports only a contract
// type; the client's preview (preview.ts) imports the contract renderer, which runs the sanitizer in the browser.

import type { hubStates as contractHubStates } from "@everyfield/contracts/communication";

type ContractHubState = (typeof contractHubStates)[number];

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
/** `unsubscribedAt`: when they unsubscribed from this church's Messages email. They cannot be added then. */
export type Recipient = { id: string; displayName: string; email: string | null; unsubscribedAt: string | null };
export type AudienceSummary = {
	resolvedDistinctPeople: number;
	eligibleRecipients: number;
	missingEmailExclusions: string[];
	duplicateAddressesRemoved: number;
	recipients: { id: string; displayName: string; email: string }[];
	complete: boolean;
	/** People who unsubscribed from this church's email. Not in eligibleRecipients; they get nothing. */
	unsubscribedExclusions: { id: string; displayName: string; unsubscribedAt: string }[];
};

export type PageData = {
	templates: Template[];
	teams: Team[];
	churchName: string;
	/** The app origin, for the RSVP preview link. */
	origin: string;
};

/** `details` is the refusal's own safe facts. */
export type Outcome<T> =
	| { status: "ok"; value: T }
	| { status: "refused"; code: string; details?: Readonly<Record<string, unknown>> }
	| { status: "lost" };

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
	/** Refused by Everyfield because the person unsubscribed from this church's email. Not in rejectedCount. */
	unsubscribedCount: number;
};

/** Per recipient, what the email service confirmed for a cancel or time change. */
type ProviderTally = { confirmedCount: number; sentCount: number; openCount: number };
export type CancelReport = ProviderTally & { scheduledCancel: "reconcile" | "confirmed" | "none" };
export type ReplaceReport = { replacementAllowed: boolean };
export type RescheduleReport = ProviderTally & {
	rescheduleStatus: "accepted" | "unknown";
	scheduledAt: string;
	heldAt: string | null;
};
export type Restore = { at: string; actorName: string | null; reason: string };
export type SuppressionReport = { address: string; active: boolean; restores: Restore[] };
export type RestoreReport = { suppressionClears: number };

/** The counts every handoff result names. */
const counts = (report: DeliveryReport) =>
	`Accepted ${report.acceptedCount}. Refused ${report.rejectedCount}. No answer ${report.unknownCount}.` +
	unsubscribedNote(report.unsubscribedCount);

const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);

/** The count of people who unsubscribed from this church's email, when there are any. */
export const unsubscribedNote = (count: number) => (count > 0 ? ` Unsubscribed ${count}.` : "");

/** Why nobody got it: the email service refused them, they unsubscribed from this church's email, or both. */
export function refusedAllText(unsubscribed: number, refused: number): string {
	if (unsubscribed === 0) return `The email service refused all ${refused}.`;
	if (refused === 0) return "Every recipient unsubscribed from this church's email.";
	return "Some recipients unsubscribed from this church's email and the email service refused the rest.";
}

const refusedAll = (report: DeliveryReport, outcome: "sent" | "scheduled") =>
	`Not ${outcome}. ${refusedAllText(report.unsubscribedCount, report.rejectedCount)}`;

/** A send-now result. Acceptance is not arrival, and an answer that never came is not a success. */
export function deliveryText(report: DeliveryReport): string {
	if (report.acceptedCount > 0) return `The email service accepted it and sends it now. ${counts(report)}`;
	if (report.unknownCount > 0)
		return `Not confirmed. The email service gave no answer. ${counts(report)} It was not sent again.`;
	return `${refusedAll(report, "sent")} ${counts(report)} The message stays saved in Messages.`;
}

/**
 * A scheduled handoff result. Everyfield keeps a scheduled email until its send time, so "Scheduled" counts the people
 * it goes to then; anyone who unsubscribes before then gets nothing. "Not scheduled" is a refusal for everyone.
 */
export function scheduleText(report: DeliveryReport, when: string): string {
	if (report.acceptedCount > 0)
		return `Scheduled for ${when}. It goes to ${people(report.acceptedCount)} then.${unsubscribedNote(report.unsubscribedCount)}`;
	if (report.unknownCount > 0)
		return `Not confirmed. The email service gave no answer. ${counts(report)} Check result to ask it again.`;
	return `${refusedAll(report, "scheduled")} ${counts(report)} The message stays saved in Messages.`;
}

const wentOut = (count: number) => `${count} already went out and cannot be recalled.`;
/** The note a not-confirmed cancel or time change adds when some email already went out, else nothing. */
export const sentNote = (count: number) => (count > 0 ? ` ${wentOut(count)}` : "");

export function cancelText(report: CancelReport): string {
	if (report.scheduledCancel === "none") return "Nothing is waiting at the email service to cancel.";
	const sent = sentNote(report.sentCount);
	if (report.scheduledCancel === "reconcile")
		return `Cancel not confirmed. Confirmed ${report.confirmedCount}. Not confirmed ${report.openCount}.${sent} Check again to ask the email service.`;
	// Email that already went out leads: the message is not cancelled while any of it went out (criterion 7).
	if (report.sentCount > 0)
		return report.confirmedCount === 0
			? `${wentOut(report.sentCount)} Nothing was cancelled.`
			: `${wentOut(report.sentCount)} The email service stopped the other ${report.confirmedCount}.`;
	if (report.confirmedCount === 0) return "Not cancelled.";
	return `Cancelled for ${people(report.confirmedCount)}. No email went out.`;
}

export function replaceText(report: ReplaceReport): string {
	if (report.replacementAllowed)
		return "Every previous send is cancelled. Write a new message to send again. No email was sent.";
	return "A replacement stays blocked until every recipient is confirmed cancelled. No email was sent.";
}

export function rescheduleText(report: RescheduleReport, when: (iso: string) => string): string {
	const sent = sentNote(report.sentCount);
	if (report.rescheduleStatus === "unknown")
		return `Time change not confirmed. You asked for ${when(report.scheduledAt)}. The email service still holds ${report.heldAt ? when(report.heldAt) : "the earlier time"} for ${report.openCount}.${sent} Check again to ask the email service.`;
	if (report.sentCount > 0)
		return report.confirmedCount === 0
			? `${wentOut(report.sentCount)} The send time did not change.`
			: `${wentOut(report.sentCount)} The other ${report.confirmedCount} now wait for ${when(report.scheduledAt)}. This change did not send the email.`;
	return `The send time is now ${when(report.scheduledAt)}. This change did not send the email.`;
}

export function restoreText(report: RestoreReport): string {
	if (report.suppressionClears > 0) return "This address can receive email again. No new email was sent.";
	return "This address was already clear. No new email was sent.";
}

export const hubStates = [
	"draft",
	"scheduled",
	"not_scheduled",
	"unsubscribed",
	"sending",
	"sent",
	"logged",
	"cancelled",
	"cancel_unconfirmed",
	"time_unconfirmed",
	"failed",
	"unknown",
] as const satisfies readonly ContractHubState[];
export type HubState = (typeof hubStates)[number];
export const hubLabel: Record<HubState, string> = {
	draft: "Draft",
	scheduled: "Scheduled",
	not_scheduled: "Not scheduled",
	unsubscribed: "Not sent: unsubscribed",
	sending: "Sending",
	sent: "Sent",
	logged: "Logged",
	cancelled: "Cancelled",
	cancel_unconfirmed: "Cancel not confirmed",
	time_unconfirmed: "Time change not confirmed",
	failed: "Not sent",
	unknown: "Not confirmed",
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
	/** Refused because the person unsubscribed from this church's email. Not in failed. */
	unsubscribed: number;
	unknown: number;
	cancelled: number;
	cancelOpen: number;
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
	/** The time the email service holds once it holds the message, else the saved time. */
	scheduledAt: string | null;
	/** A requested time the email service has not confirmed for every recipient. */
	requestedAt: string | null;
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

type ContactOutcome = "contacted" | "attempted_no_contact" | "administrative_completion" | "no_longer_needed";
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
	/** When the person unsubscribed from this church's email. Only an Owner or Admin sees it. */
	emailOptOutAt: string | null;
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

/** What one Send now or Schedule did. `report` is null when the email was saved but the handoff did not finish. */
export type HandoffResult = {
	communicationId: string;
	revision: string;
	scheduledAt: string;
	report: DeliveryReport | null;
	sendIssue: string | null;
};

export const scheduledNotSentText =
	"The email is saved, but the email service did not receive it. Open it from Messages to send it again.";

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
