// The Evry review card's rules (WP-053/ui), as plain data and pure functions. The server's review is the only truth
// about a prepared change: its review status (pending, approved, cancelled, expired) and the recorded outcome of the
// approved revision are separate (REQ-EVR-033). The card derives what it shows from that review and the time the
// approval has left on the server's clock; the browser's clock is never read.

import type { MailReport, RecipientOutcome } from "@everyfield/contracts/communication";
import { SOURCE_LABEL, STAGE_LABEL, type SourceValue, type StageValue } from "../../people/model.ts";
import { TASK_REFUSAL, type ProjectedError } from "../conversation/model.ts";

export type Operation =
	| "people.createPerson"
	| "people.updatePerson"
	| "people.changeStatus"
	| "people.deletePerson"
	| "people.setPersonPhoto"
	| "people.removePersonPhoto"
	| "communication.saveDraft"
	| "communication.scheduleReviewed"
	| "communication.rescheduleReviewed"
	| "communication.cancelScheduledReviewed"
	| "communication.replaceScheduledReviewed"
	| TaskOperation;
/** The Tasks and Follow-up reviewed writes (WP-068). They are approved or cancelled as Evry prepared them. */
type TaskOperation =
	| "tasks.create"
	| "tasks.configureRecurrence"
	| "tasks.edit"
	| "tasks.complete"
	| "tasks.completeOccurrence"
	| "tasks.reopen"
	| "tasks.changeStatus"
	| "tasks.waive"
	| "tasks.delete"
	| "tasks.bulkComplete"
	| "tasks.bulkReschedule"
	| "tasks.createSubtask"
	| "tasks.setSubtaskCompletion"
	| "tasks.removeSubtask"
	| "tasks.createFollowUp"
	| "tasks.assignFollowUp"
	| "tasks.reopenObligation"
	| "followups.recordOutcome"
	| "followups.correctOutcome";

export type Change = { field: string; before: unknown; after: unknown };

/** evry.readReview, as the API sends it (packages/evry/src/proposals/review.ts, proposalRow). */
export type Review = {
	id: string;
	conversationId: string;
	operation: Operation;
	revision: number;
	digest: string;
	expiresAt: string;
	approvedAt: string | null;
	status: "pending" | "approved" | "cancelled" | "expired";
	review: {
		target: { kind: "person" | "message" | "task"; id: string; label: string } | null;
		changes: Change[];
		/** A plain reason the change cannot be approved as asked; the card shows it and offers no Approve. */
		refusal?: string;
		withheld?: true;
	};
	/** "failed" is only on rows saved before PR 245, which said "nothing was changed" without proof (R5-3). */
	outcome: "completed" | "failed" | "refused" | "unknown" | null;
	executing: boolean;
	receipt: { receiptId?: string; revision?: string; code?: string; report?: MailReport } | null;
	/** A pending message review whose message changed since: it can only be reviewed again. */
	stale: boolean;
	/** The server's time when it answered: the approval's time left is counted from it. */
	now: string;
};

/**
 * What the card is now. pending can be approved, revised or cancelled until it expires; running means the approved
 * change is queued or running in the background; the rest are final for this revision, except that an unconfirmed
 * run can be tried again while its approval lasts.
 */
export type Phase =
	"pending" | "expired" | "cancelled" | "running" | "completed" | "refused" | "unconfirmed" | "withheld";

/**
 * The approval's time left when the server answered, in milliseconds, on the server's clock. The card waits that long
 * on its own timer, so a browser clock set hours ahead or behind changes nothing.
 */
export const approvalLeft = (review: Review) => Date.parse(review.expiresAt) - Date.parse(review.now);

/** `lapsed`: the approval's time ran out since the server answered (approvalLeft, counted on the card's timer). */
export function phaseOf(review: Review, lapsed: boolean): Phase {
	if (review.outcome === "completed") return "completed";
	if (review.review.withheld) return "withheld";
	if (review.status === "cancelled") return "cancelled";
	if (review.status === "expired") return "expired";
	if (review.status === "pending") return lapsed ? "expired" : "pending";
	if (review.outcome === "refused") return "refused";
	// An old "failed" row is as unproven as "unknown": the change may or may not be saved, and Try again settles it.
	if (review.outcome === "failed" || review.outcome === "unknown") return "unconfirmed";
	return "running";
}

/** An unconfirmed run can go again under the same approval until it expires. */
export const retryable = (review: Review, lapsed: boolean) =>
	(review.outcome === "failed" || review.outcome === "unknown") && !lapsed;

// ---------------------------------------------------------------------------------------------------------------
// What will change: each field with its value before and after, in the words the People screens use.

const FIELD_LABEL: Record<string, string> = {
	displayName: "Name",
	firstName: "First name",
	lastName: "Last name",
	email: "Email",
	phone: "Phone",
	street: "Street",
	city: "City",
	stateProvince: "State or province",
	postalCode: "Postal code",
	country: "Country",
	source: "Source",
	sourceDetails: "Source details",
	summaryNotes: "Notes",
	birthDate: "Birth date",
	stage: "Stage",
	adultClassification: "Age group",
	reason: "Reason",
	photo: "Photo",
	state: "Status",
	status: "Status",
	title: "Title",
	description: "Description",
	priority: "Priority",
	category: "Category",
	due: "Due",
	owners: "Owners",
	recurrence: "Repeats",
	relatedTo: "Related to",
	nextOccurrence: "Next occurrence",
	outcome: "Outcome",
	occurredAt: "When",
	channel: "How",
	notes: "Note",
	followUp: "Follow-up",
};
export const fieldLabel = (field: string) => FIELD_LABEL[field] ?? field;

const CLASSIFICATION_LABEL: Record<string, string> = { adult: "Adult", child: "Child", unknown: "Not recorded" };
const dateFormat = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

const TASK_STATUS: Record<string, string> = {
	not_started: "Not started",
	in_progress: "In progress",
	blocked: "Blocked",
	complete: "Complete",
	no_longer_needed: "No longer needed",
	deleted: "Deleted",
	// A checklist item a review adds or removes.
	added: "Added",
	removed: "Removed",
};
const OUTCOME: Record<string, string> = {
	contacted: "Contacted (a conversation happened)",
	attempted_no_contact: "Attempted, no conversation",
	administrative_completion: "Administrative completion",
	no_longer_needed: "No longer needed",
	withdrawn: "Withdrawn",
};
const CHANNEL: Record<string, string> = {
	phone: "Phone call",
	text: "Text message",
	in_person: "In person",
	video: "Video call",
	email: "Email",
	other: "Other",
};
const PRIORITY: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
const CATEGORY: Record<string, string> = {
	general: "General",
	follow_up: "Follow-up",
	vision_meeting: "Vision meeting",
	launch_prep: "Launch prep",
	administrative: "Administrative",
	ministry_team: "Ministry team",
	training: "Training",
	promotion: "Promotion",
	facilities: "Facilities",
	recurring: "Recurring",
};
const FREQUENCY: Record<string, string> = {
	daily: "Daily",
	weekly: "Weekly",
	biweekly: "Every two weeks",
	monthly: "Monthly",
	quarterly: "Quarterly",
	yearly: "Yearly",
};
/** What an empty value means for these fields, instead of "Empty". */
const NONE: Record<string, string> = { owners: "Needs owner", due: "No due date", recurrence: "Doesn't repeat" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A church-local date, or date and time, as the reviews write it ("2026-11-16", "2026-11-13 14:05 America/Chicago" or
 * "2026-11-16T09:00"): "Mon, Nov 16, 2026" or "Fri, Nov 13, 2026, 2:05 PM (Chicago time)". The zone is the church's.
 */
export function localWhen(value: string): string {
	const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?(?: (\S+))?$/.exec(value);
	if (!m) return value;
	const at = new Date(`${m[1]}T${m[2] ?? "00"}:${m[3] ?? "00"}:00Z`);
	if (Number.isNaN(at.getTime())) return value;
	const date = at.toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
	if (!m[2]) return date;
	const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
	const place = m[4]?.split("/").at(-1)?.replaceAll("_", " ");
	return `${date}, ${time}${place ? ` (${place} time)` : ""}`;
}
/**
 * "weekly on Mondays, until 2026-12-31, America/Chicago" as "Weekly on Mondays, until Thu, Dec 31, 2026
 * (America/Chicago)": the series repeats in the church's zone, so the card names it.
 */
function repeats(value: string) {
	if (value === "stopped") return "Stops repeating";
	const all = value.split(", ");
	const zone = all.find((p) => p.includes("/"));
	const [rule = "", ...rest] = all.filter((p) => p !== zone);
	const [frequency = "", ...tail] = rule.split(" ");
	const head = [FREQUENCY[frequency] ?? frequency, ...tail].join(" ");
	const text = [head, ...rest.map((p) => p.replace(/^until (\S+)$/, (_, d: string) => `until ${localWhen(d)}`))].join(
		", ",
	);
	return zone ? `${text} (${zone})` : text;
}

/** A reviewed value as text. Empty values say so; an id (a photo upload) is never shown. */
export function valueText(field: string, value: unknown): string | null {
	if (value === null || value === undefined || value === "") return NONE[field] ?? null;
	// A photo is a stored file: its short reference tells two uploads apart. The card shows the image where People allows it.
	if (field === "photo") return `Photo ${photoRef(value)}`;
	if (field === "stage") return STAGE_LABEL[value as StageValue] ?? String(value);
	if (field === "source") return SOURCE_LABEL[value as SourceValue] ?? String(value);
	if (field === "adultClassification") return CLASSIFICATION_LABEL[String(value)] ?? String(value);
	if (field === "state") return value === "live" ? "Current" : value === "retired" ? "Removed" : String(value);
	if (field === "birthDate" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
		return dateFormat.format(new Date(`${value}T00:00:00Z`));
	if (field === "status" || field === "followUp") return TASK_STATUS[String(value)] ?? String(value);
	if (field === "outcome") return OUTCOME[String(value)] ?? String(value);
	if (field === "channel") return CHANNEL[String(value)] ?? String(value);
	if (field === "priority") return PRIORITY[String(value)] ?? String(value);
	if (field === "category") return CATEGORY[String(value)] ?? String(value);
	if ((field === "due" || field === "occurredAt") && typeof value === "string") return localWhen(value);
	if (field === "recurrence" && typeof value === "string") return repeats(value);
	// A changed link names its record by id only; the card never shows an id.
	if (field === "relatedTo" && typeof value === "string" && UUID.test(value)) return "A linked record";
	return String(value);
}

/**
 * Reviews that list one row per item (a task, a checklist item or a person's follow-up) under the item's name, with
 * the value each row changes. Null for a review of named fields.
 */
const ITEM_FIELD: Partial<Record<Operation, string>> = {
	"tasks.bulkComplete": "status",
	"tasks.bulkReschedule": "due",
	"tasks.createSubtask": "status",
	"tasks.setSubtaskCompletion": "status",
	"tasks.removeSubtask": "status",
	"tasks.assignFollowUp": "owners",
};
export const itemField = (operation: Operation) => ITEM_FIELD[operation] ?? null;
const CREATES = new Set<Operation>([
	"people.createPerson",
	"tasks.create",
	"tasks.createFollowUp",
	"followups.recordOutcome",
]);
const NO_BEFORE = new Set(["reason", "notes", "nextOccurrence"]);
/** A change shows its value now, then the new one; a new record, a new item, a reason or a note shows only the new. */
export const showsBefore = (review: Pick<Review, "operation">, change: Change) =>
	!NO_BEFORE.has(change.field) &&
	(change.before !== null && change.before !== undefined
		? true
		: !CREATES.has(review.operation) && !itemField(review.operation));

export const isTasks = (operation: Operation) => operation.startsWith("tasks.") || operation.startsWith("followups.");

/** What the card names as changed: the target, a new task's title, or the number of items a review lists. */
export function subjectName(review: Review): string {
	const { target, changes } = review.review;
	if (target) return target.label;
	if (review.operation === "tasks.create") return String(changes.find((c) => c.field === "title")?.after ?? "New task");
	const n = changes.length;
	if (review.operation === "tasks.assignFollowUp")
		return `${n.toLocaleString()} ${n === 1 ? "follow-up" : "follow-ups"}`;
	return `${n.toLocaleString()} ${n === 1 ? "task" : "tasks"}`;
}

/** The sentence a screen reader hears when an approved change is saved. */
export function savedText(review: Review): string {
	const who = review.review.target?.label;
	if (!isTasks(review.operation)) return who ? `Saved. ${who} is updated.` : "Saved.";
	const name = subjectName(review);
	const status = review.review.changes.find((c) => c.field === "status")?.after;
	switch (review.operation) {
		case "tasks.create":
			return `Saved. ${name} is in Tasks.`;
		case "tasks.complete":
		case "tasks.completeOccurrence":
			return `Saved. ${name} is complete.`;
		case "tasks.reopen":
		case "tasks.reopenObligation":
			return `Saved. ${name} is open again.`;
		case "tasks.waive":
			return `Saved. ${name} is closed as no longer needed.`;
		case "tasks.changeStatus":
			return `Saved. ${name} is now ${(valueText("status", status) ?? "updated").toLowerCase()}.`;
		case "tasks.delete":
			return `Saved. ${name} is deleted.`;
		case "tasks.bulkComplete":
			return `Saved. ${name} ${review.review.changes.length === 1 ? "is" : "are"} complete.`;
		case "tasks.bulkReschedule":
			return `Saved. ${name} ${review.review.changes.length === 1 ? "has" : "have"} a new due date.`;
		case "tasks.createSubtask":
		case "tasks.setSubtaskCompletion":
		case "tasks.removeSubtask":
			return `Saved. The checklist of ${name} is updated.`;
		case "tasks.configureRecurrence":
			return `Saved. The schedule of ${name} is updated.`;
		case "tasks.createFollowUp":
			return `Saved. ${name} has a new follow-up.`;
		case "tasks.assignFollowUp":
			return "Saved. The follow-up owners are updated.";
		case "followups.recordOutcome":
			return `Saved. The contact with ${name} is logged.`;
		case "followups.correctOutcome":
			return `Saved. The contact log of ${name} is corrected.`;
		default:
			return `Saved. ${name} is updated.`;
	}
}

/** Where the card's done state leads: the person, the task in Tasks, or Tasks. Null when there is nothing to open. */
export function openAfter(review: Review): { href: string; label: string } | null {
	const who = review.review.target;
	if (review.review.withheld || isMail(review.operation)) return null;
	if (!isTasks(review.operation))
		return who && review.operation !== "people.deletePerson"
			? { href: `/people/${who.id}`, label: `Open ${who.label}` }
			: null;
	if (who?.kind === "person") return { href: `/people/${who.id}`, label: `Open ${who.label}` };
	if (review.operation === "tasks.delete") return { href: "/tasks", label: "Open Tasks" };
	return who?.kind === "task"
		? { href: `/tasks?task=${who.id}`, label: "Open task" }
		: { href: "/tasks", label: "Open Tasks" };
}

/**
 * REQ-EVR-011: approval applies only to content the person could inspect. A new photo is approvable once the card
 * shows its exact upload (GET /api/evry/proposals/{id}/photo); until then, or when the upload is gone, it is not.
 */
export const approvable = (review: Pick<Review, "operation">, uploadShown: boolean) =>
	review.operation !== "people.setPersonPhoto" || uploadShown;

/** The first 8 characters of a photo's file id, upper case, as people read a reference. */
export const photoRef = (value: unknown) => String(value).slice(0, 8).toUpperCase();

/** The person's open tasks a stage change or removal hands back as needing an owner, from the review. */
const handedBack = (changes: readonly Change[]) =>
	Number(changes.find((c) => c.field === "openTasksNeedingOwner")?.after ?? 0);

/** The changes the card lists as before and after; the task count is said once in words instead. */
export const shownChanges = (changes: readonly Change[]) => changes.filter((c) => c.field !== "openTasksNeedingOwner");

const TITLE: Record<Operation, string> = {
	"communication.saveDraft": "Save an email draft",
	"communication.scheduleReviewed": "Schedule an email",
	"communication.rescheduleReviewed": "Change the send time",
	"communication.cancelScheduledReviewed": "Cancel a scheduled email",
	"communication.replaceScheduledReviewed": "Replace a scheduled email",
	"people.createPerson": "Add a person",
	"people.updatePerson": "Update a person",
	"people.changeStatus": "Change a stage",
	"people.deletePerson": "Remove a person",
	"people.setPersonPhoto": "Set a photo",
	"people.removePersonPhoto": "Remove a photo",
	"tasks.create": "Create a task",
	"tasks.configureRecurrence": "Repeat a task",
	"tasks.edit": "Edit a task",
	"tasks.complete": "Complete a task",
	"tasks.completeOccurrence": "Complete this occurrence",
	"tasks.reopen": "Reopen a task",
	"tasks.changeStatus": "Change a task's status",
	"tasks.waive": "Close as no longer needed",
	"tasks.delete": "Delete a task",
	"tasks.bulkComplete": "Complete tasks",
	"tasks.bulkReschedule": "Reschedule tasks",
	"tasks.createSubtask": "Update a checklist",
	"tasks.setSubtaskCompletion": "Update a checklist",
	"tasks.removeSubtask": "Update a checklist",
	"tasks.createFollowUp": "Add a follow-up",
	"tasks.assignFollowUp": "Assign follow-ups",
	"tasks.reopenObligation": "Reopen a follow-up",
	"followups.recordOutcome": "Log a contact",
	"followups.correctOutcome": "Correct a contact log entry",
};
export const operationTitle = (operation: Operation) => TITLE[operation];

// ---------------------------------------------------------------------------------------------------------------
// Email: the five reviewed Communication writes (MAIL51-009). The email service is the only source of "confirmed".

export const isMail = (operation: Operation) => operation.startsWith("communication.");
type SendTime = { at: string; zone: string };
const asTime = (value: unknown): SendTime | null =>
	value && typeof value === "object" && "at" in value && "zone" in value ? (value as SendTime) : null;
export const sendTimeOf = (review: Review, side: "before" | "after") =>
	asTime(review.review.changes.find((c) => c.field === "sendAt")?.[side]);
const part = (at: string, zone: string, options: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat("en-US", { ...options, timeZone: zone }).format(new Date(at));
const zoneName = (at: string, zone: string, timeZoneName: "short" | "long") =>
	new Intl.DateTimeFormat("en-US", { timeZoneName, timeZone: zone })
		.formatToParts(new Date(at))
		.find((p) => p.type === "timeZoneName")?.value ?? zone;
/** "Fri, 9:00 AM CST": the day, the time and the zone, in the church's own zone. */
const sendTime = ({ at, zone }: SendTime) =>
	`${part(at, zone, { weekday: "short" })}, ${part(at, zone, { hour: "numeric", minute: "2-digit" })} ${zoneName(at, zone, "short")}`;
/** "Fri, Nov 6, 9:00 AM CST": the date, the time and the zone, in the church's own zone. */
export const sendTimeShort = ({ at, zone }: SendTime) =>
	`${part(at, zone, { weekday: "short", month: "short", day: "numeric" })}, ${part(at, zone, { hour: "numeric", minute: "2-digit" })} ${zoneName(at, zone, "short")}`;
/** "Fri, Nov 6, 9:00 AM CST (Central Standard Time)": the full date and the zone's name. */
export const sendTimeFull = ({ at, zone }: SendTime) =>
	`${sendTimeShort({ at, zone })} (${zoneName(at, zone, "long")})`;
/** A saved report's time on the card, in the church's zone. */
export const reportTime = (at: string, review: Review) => {
	const zone = sendTimeOf(review, "after")?.zone;
	return zone ? sendTime({ at, zone }) : null;
};

/** The church-local wall time the Evry tools take back for a review again: "2026-11-06T09:00". */
function localTime({ at, zone }: SendTime) {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		})
			.formatToParts(new Date(at))
			.map((x) => [x.type, x.value]),
	);
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const GROUP_LABEL: Record<string, string> = {
	all: "Everyone",
	core_group: "Core group",
	launch_team: "Launch team",
	leaders: "Leaders",
	prospects: "Prospects",
};
type AudienceValue = {
	groups: string[];
	teamIds: string[];
	personIds: string[];
	recipients: number;
	noAddress: number;
};
const audienceOf = (value: unknown): AudienceValue | null =>
	value && typeof value === "object" && "recipients" in value ? (value as AudienceValue) : null;
/** The native command's audience, without the counts the review added. */
function audienceArgs(value: unknown) {
	const a = audienceOf(value);
	return a && { groups: a.groups, teamIds: a.teamIds, personIds: a.personIds };
}
/** "Launch team, 2 people · 4 with an email address · 1 with no email address". */
export function audienceText(value: unknown) {
	const a = audienceOf(value);
	if (!a) return null;
	const who = [
		...a.groups.map((g) => GROUP_LABEL[g] ?? g),
		...(a.teamIds.length ? [`${a.teamIds.length} ${a.teamIds.length === 1 ? "team" : "teams"}`] : []),
		...(a.personIds.length ? [`${a.personIds.length} ${a.personIds.length === 1 ? "person" : "people"}`] : []),
	].join(", ");
	const count = `${a.recipients} with an email address`;
	return [who || "Nobody chosen", count, a.noAddress ? `${a.noAddress} with no email address` : null]
		.filter(Boolean)
		.join(" · ");
}
export const LEFT_OUT_REASON: Record<string, string> = {
	no_address: "No email address",
	blocked: "Blocked after a bounce",
	unsubscribed: "Unsubscribed",
};

/** The report is not confirmed and the email service can be asked again. */
export const checkable = (review: Review) =>
	review.outcome === "completed" && review.receipt?.report?.confirmation === "not_confirmed";

const MAIL_PENDING: Record<string, string> = {
	"communication.saveDraft": "Review before saving",
	"communication.scheduleReviewed": "Review before scheduling",
	"communication.rescheduleReviewed": "Review the new time",
	"communication.cancelScheduledReviewed": "Review before cancelling",
	"communication.replaceScheduledReviewed": "Review the replacement",
};
/** The head of a review the server refused on the card itself, such as a time outside the window it can hold. */
const MAIL_REFUSED: Record<string, string> = {
	"communication.scheduleReviewed": "Can't schedule this email",
	"communication.rescheduleReviewed": "Can't move this email",
	"communication.replaceScheduledReviewed": "Can't replace this email",
};
/** The note on a review the Owner dismissed: what stays as it was. */
export const MAIL_DISMISSED: Partial<Record<Operation, string>> = {
	"communication.saveDraft": "You closed this review. Nothing was saved.",
	"communication.scheduleReviewed": "You closed this review. The draft stays saved and is not scheduled.",
	"communication.rescheduleReviewed": "You closed this review. The message still sends at its set time.",
	"communication.cancelScheduledReviewed": "You closed this review. The message still sends at its set time.",
	"communication.replaceScheduledReviewed":
		"You closed this review. The message still sends as it was, at its set time.",
};
/** The head of an email card once it has a saved outcome: only what the email service confirmed is called done. */
export function mailHead(
	review: Review,
	phase: string,
): { title: string; tone: "amber" | "green" | "magenta" | "gray" } | null {
	if (!isMail(review.operation)) return null;
	if (phase === "pending")
		return {
			title: review.stale
				? "Message changed"
				: review.review.refusal
					? (MAIL_REFUSED[review.operation] ?? "Can't do this")
					: MAIL_PENDING[review.operation]!,
			tone: "amber",
		};
	if (phase === "running")
		return {
			title: review.operation === "communication.saveDraft" ? "Saving…" : "Working with the email service…",
			tone: "amber",
		};
	if (phase === "refused") return { title: "Refused", tone: "magenta" };
	// "Cancelled" is the word for a cancel the email service confirmed, so a dismissed review never uses it.
	if (phase === "cancelled") return { title: "Review closed", tone: "gray" };
	if (phase !== "completed") return null;
	const report = review.receipt?.report;
	if (!report) return { title: "Saved", tone: "green" };
	switch (report.kind) {
		case "schedule":
			if (report.confirmation === "confirmed")
				return { title: `Scheduled for ${reportTime(report.scheduledAt, review)}`, tone: "green" };
			return report.confirmation === "refused"
				? { title: "Not scheduled", tone: "magenta" }
				: { title: "Schedule not confirmed", tone: "amber" };
		case "reschedule":
			if (report.confirmation === "confirmed")
				return { title: `Moved to ${reportTime(report.scheduledAt, review)}`, tone: "green" };
			if (report.confirmation === "not_confirmed") return { title: "Time change not confirmed", tone: "amber" };
			return report.sent
				? { title: "Not moved: already sent", tone: "magenta" }
				: { title: "Nothing to move", tone: "gray" };
		case "cancel":
			if (report.confirmation === "not_confirmed") return { title: "Cancel not confirmed", tone: "amber" };
			if (report.cancelled) return { title: report.sent ? "Cancelled, some already sent" : "Cancelled", tone: "green" };
			return report.sent
				? { title: "Not cancelled: already sent", tone: "magenta" }
				: { title: "Nothing to cancel", tone: "gray" };
		case "replace":
			return report.confirmation === "confirmed"
				? { title: `Replacement scheduled for ${reportTime(report.scheduledAt, review)}`, tone: "green" }
				: { title: "Replacement not confirmed", tone: "amber" };
		case "replace_stopped":
			return report.confirmation === "not_confirmed"
				? { title: "Not replaced: cancel not confirmed", tone: "amber" }
				: { title: "Not replaced", tone: "magenta" };
	}
}

/** What became of one recipient of the old send, in plain words. */
export const RECIPIENT_OUTCOME: Record<RecipientOutcome, string> = {
	cancelled: "Cancelled",
	sent: "Already sent",
	open: "Cancel not confirmed",
};

/** The one sentence under the target that says what happens to them beyond the listed fields. */
export function consequence(review: Review): string | null {
	const tasks = handedBack(review.review.changes);
	const owner =
		tasks > 0 ? `${tasks.toLocaleString()} open ${tasks === 1 ? "task" : "tasks"} will need a new owner.` : null;
	if (review.operation === "people.deletePerson")
		return ["They leave the current people list. Their history stays.", owner].filter(Boolean).join(" ");
	return owner;
}

// ---------------------------------------------------------------------------------------------------------------
// Revise: the owner changes a reviewed value. The native command's input is rebuilt from the review, so a revision
// sends exactly the reviewed facts with only the edited values changed.

export type FieldKind = "text" | "long" | "date" | "email" | "choice";
const KIND: Record<string, FieldKind> = {
	summaryNotes: "long",
	sourceDetails: "long",
	reason: "long",
	birthDate: "date",
	email: "email",
	stage: "choice",
	source: "choice",
	adultClassification: "choice",
};
export const fieldKind = (field: string): FieldKind => KIND[field] ?? "text";

export const CHOICES: Record<string, { value: string; label: string }[]> = {
	stage: Object.entries(STAGE_LABEL).map(([value, label]) => ({ value, label })),
	source: Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label })),
	adultClassification: Object.entries(CLASSIFICATION_LABEL).map(([value, label]) => ({ value, label })),
};

/** Fields a person may edit in a revision. Photos, the removal itself and the task count are fixed facts. */
const FIXED = new Set(["photo", "state", "openTasksNeedingOwner"]);
/** Values that may be empty. A name and a reason are required. */
const REQUIRED = new Set(["displayName", "reason", "stage", "source", "adultClassification"]);
/** Adult or child is required until a birth date is entered: then it comes from the birth date (REQ-PPL-026). */
export const isRequired = (field: string, birthDate = false) =>
	field === "adultClassification" ? !birthDate : REQUIRED.has(field);

/** The review has a birth date, as revised: an edited value wins over the reviewed one. */
export function hasBirthDate(review: Review, edits: Record<string, string>) {
	const c = review.review.changes.find((x) => x.field === "birthDate");
	if (!c) return false;
	return c.field in edits ? (edits[c.field] ?? "").trim() !== "" : Boolean(c.after);
}

/** Only a People review can be revised field by field. Email, Tasks and Follow-up reviews are approved as prepared. */
export const editableChanges = (review: Review) =>
	review.review.withheld || !review.operation.startsWith("people.")
		? []
		: review.review.changes.filter((c) => !FIXED.has(c.field));

/** The native command's input for this review with `edits` applied, or null when the review can't be rebuilt. */
export function reviseInput(review: Review, edits: Record<string, string> = {}): unknown {
	const { target, changes } = review.review;
	const value = (c: Change) => {
		if (!(c.field in edits)) return c.after;
		const text = edits[c.field]!.trim();
		return text === "" ? null : text;
	};
	const after = (field: string) => {
		const c = changes.find((x) => x.field === field);
		return c ? value(c) : undefined;
	};
	if (review.operation === "people.createPerson")
		return Object.fromEntries(changes.map((c) => [c.field, value(c)]).filter(([, v]) => v !== null));
	if (review.operation === "communication.saveDraft") {
		const audience = audienceArgs(after("audience"));
		return audience ? { subject: after("subject"), body: after("body"), audience } : null;
	}
	if (!target) return null;
	const personId = target.id;
	switch (review.operation) {
		case "people.updatePerson":
			return { personId, patch: Object.fromEntries(changes.map((c) => [c.field, value(c)])) };
		case "people.changeStatus":
			return { personId, stage: after("stage"), reason: after("reason") };
		case "people.deletePerson":
			return { personId, reason: after("reason") };
		case "people.setPersonPhoto":
			return { personId, uploadId: after("photo") };
		case "people.removePersonPhoto":
			return { personId };
		case "communication.scheduleReviewed":
		case "communication.rescheduleReviewed": {
			const at = sendTimeOf(review, "after");
			return at ? { communicationId: target.id, sendAt: localTime(at) } : null;
		}
		case "communication.cancelScheduledReviewed":
			return { communicationId: target.id };
		case "communication.replaceScheduledReviewed": {
			const audience = audienceArgs(after("audience"));
			const body = after("body");
			return {
				communicationId: target.id,
				...(typeof body === "string" ? { body } : {}),
				...(audience ? { audience } : {}),
			};
		}
		// An expired review of one task's status is prepared again from its task; the others are asked of Evry again.
		case "tasks.complete":
		case "tasks.completeOccurrence":
		case "tasks.reopen":
		case "tasks.delete":
			return target.kind === "task" ? { taskId: target.id } : null;
		case "tasks.changeStatus":
			return target.kind === "task" ? { taskId: target.id, status: after("status") } : null;
		case "tasks.waive": {
			const reason = after("reason");
			return target.kind === "task" ? { taskId: target.id, ...(typeof reason === "string" ? { reason } : {}) } : null;
		}
		default:
			return null;
	}
}

/** The first required value left empty, for the form's own message before anything is sent. */
export function missingRequired(review: Review, edits: Record<string, string>) {
	const dated = hasBirthDate(review, edits);
	return (
		editableChanges(review).find((c) => isRequired(c.field, dated) && (edits[c.field] ?? "").trim() === "") ?? null
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Words: refusals and notices say what happened and what to do next, and never more than the server said.

/** Why a run was refused, from the saved receipt code. Nothing was changed in each case. */
export function refusalText(code: string | undefined, target: string | null, operation?: Operation): string {
	if (operation && isTasks(operation)) return taskRefusalText(code, target);
	const who = target ?? "this person";
	switch (code) {
		case "revision_conflict":
		case "conflict":
			return `${who}'s record changed after Evry prepared this, so nothing was saved. Ask Evry to prepare it again.`;
		case "access_denied":
			return "Your seat no longer allows this change, so nothing was saved.";
		case "invalid_input":
		case "invalid_subject":
		case "unsupported_field":
			return "People did not accept these values, so nothing was saved. Ask Evry to prepare it again.";
		case "not_found":
		case "source_unavailable":
			return `${who} is no longer available, so nothing was saved.`;
		default:
			return "People refused this change, so nothing was saved.";
	}
}

/** Why a Tasks or Follow-up change was refused when it ran. */
function taskRefusalText(code: string | undefined, target: string | null): string {
	switch (code) {
		case "revision_conflict":
		case "conflict":
		case "stale":
			return `${target ?? "This"} changed after Evry prepared this, so nothing was saved. Ask Evry to prepare it again.`;
		case "access_denied":
		case "unauthorized":
			return "Your seat no longer allows this change, so nothing was saved.";
		case "not_assigned":
		case "owner_ineligible":
		case "assignee_ineligible":
			return `${TASK_REFUSAL[code]} Nothing was saved.`;
		case "open_successor":
			return "Another occurrence of this task is open, so nothing was saved.";
		case "protected_source":
			return "A meeting made this task, so it can't be changed this way. Nothing was saved.";
		case "nonexistent_local_time":
		case "ambiguous_local_time":
			return "A clock change makes that time skip or repeat in your church's time zone, so nothing was saved. Ask Evry for another time.";
		case "invalid_input":
			return "Tasks did not accept these values, so nothing was saved. Ask Evry to prepare it again.";
		case "not_found":
		case "source_unavailable":
			return `${target ?? "This task"} is no longer available, so nothing was saved.`;
		default:
			return "Tasks refused this change, so nothing was saved.";
	}
}

/** Why an email effect was refused. The email service had not been asked unless the text says otherwise. */
export function mailRefusalText(code: string | undefined): string {
	switch (code) {
		case "revision_conflict":
			return "This message changed since the review, so nothing was done and the email service was not asked. Ask Evry to review it again.";
		case "stale_review":
			return "The recipients or the content changed since the review, so nothing was sent to the email service. Ask Evry to review it again.";
		case "schedule_window_exceeded":
			return "Everyfield can hold an email for up to 30 days and can't send in the past. Pick another time.";
		case "access_denied":
			return "Your seat no longer allows email changes, so nothing was done.";
		case "mail_unavailable":
			return "This server cannot reach the email service, so nothing was done.";
		case "not_found":
			return "This message is no longer in Messages, so nothing was done.";
		case "rsvp_needs_meeting":
			return "This email has an RSVP link and no open meeting, so nothing was done.";
		default:
			return "Messages refused this change, so nothing was done.";
	}
}

/** Why a step after the first one stopped, in a sentence that follows what did happen. */
export function stoppedReason(code: string | undefined): string {
	switch (code) {
		case "stale_review":
			return "The recipients or the content changed since the review.";
		case "schedule_window_exceeded":
			return "The send time is no longer within the next 30 days.";
		case "rsvp_needs_meeting":
			return "This email has an RSVP link, and its meeting is no longer open.";
		case "access_denied":
			return "Your seat no longer allows email changes.";
		case "provider_refused":
			return "The email service refused every recipient.";
		default:
			return "Messages refused the next step.";
	}
}

/** What the card says after an action the server refused or never answered. */
export function actionNotice(error: ProjectedError | "lost", mail: boolean): string {
	if (error === "lost") return "Not confirmed. Check your connection, then try again.";
	switch (error.code) {
		case "review_changed":
			if (mail) return "This message changed since the review. Nothing was done. Review it again.";
			return "This review changed in another window. Check it again before you approve.";
		case "review_expired":
			return "This review expired before it was approved. Nothing was changed.";
		case "review_closed":
			return "This review is already closed.";
		case "photo_unavailable":
			return "The uploaded photo is no longer available, so nothing was saved.";
		case "not_assigned":
		case "owner_ineligible":
		case "assignee_ineligible":
			return `${TASK_REFUSAL[error.code]} Nothing was changed.`;
		case "invalid_input":
			return "Some values are not valid. Check them, then update the review.";
		case "not_found":
			if (mail) return "This message is no longer waiting to send, so there is nothing to review again.";
		// falls through
		case "access_denied":
			// An earlier approval may already have run, so this says nothing about the change itself.
			return "Your seat no longer allows this, so Evry can't show the result.";
		default:
			return "This did not go through. Try again.";
	}
}

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export const clock = (iso: string) => time.format(new Date(iso));

/**
 * The delay before the next read of a running change, counted from the previous reply. An approved change is first
 * readable as saved about 0.5 to 0.75 s after the click (production build, 20 runs), so the first read waits for that
 * and the next reads follow 50 ms apart: Saved shows within the one-second budget. A slower change backs off to one
 * read every 2 seconds.
 */
export const pollDelay = (attempt: number) => [350, 50, 50, 50, 50, 800, 1200][attempt] ?? 2000;
