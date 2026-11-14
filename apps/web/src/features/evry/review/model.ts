// The Evry review card's rules (WP-053/ui), as plain data and pure functions. The server's review is the only truth
// about a prepared change: its review status (pending, approved, cancelled, expired) and the recorded outcome of the
// approved revision are separate (REQ-EVR-033). The card derives what it shows from that review and the time the
// approval has left on the server's clock; the browser's clock is never read.

import type { MailReport, RecipientOutcome } from "@everyfield/contracts/communication";
import { SOURCE_LABEL, STAGE_LABEL, type SourceValue, type StageValue } from "../../people/model.ts";
import type { ProjectedError } from "../conversation/model.ts";

export type Operation =
	| "people.createPerson"
	| "people.updatePerson"
	| "people.changeStatus"
	| "people.deletePerson"
	| "people.setPersonPhoto"
	| "people.removePersonPhoto"
	| OrganizationOperation
	| "communication.saveDraft"
	| "communication.scheduleReviewed"
	| "communication.rescheduleReviewed"
	| "communication.cancelScheduledReviewed"
	| "communication.replaceScheduledReviewed"
	| "notifications.markSelectedRead"
	| "notifications.markAllVisibleRead"
	| "notifications.setPreferences"
	| "notifications.digestCadence.set"
	| TeamsOperation
	| "phases.declare"
	| "phases.transition"
	| "signals.attest"
	| "signals.correct"
	| "signals.reaffirm";

/** The Ministries reviewed writes (WP-070): shown as before and after, never revised in place. */
const TEAMS_TITLE = {
	"teams.create": "Add a ministry",
	"teams.edit": "Update a ministry",
	"teams.archive": "Archive a ministry",
	"teams.restore": "Restore a ministry",
	"teams.createRole": "Add a role",
	"teams.editRole": "Update a role",
	"teams.retireRole": "Retire a role",
	"teams.assignRole": "Fill a role",
	"teams.assignMember": "Add to a ministry",
	"teams.removeRole": "End a role",
	"teams.endMembership": "Leave a ministry",
	"teams.reactivateMembership": "Return to a role",
	"teams.appointLeader": "Appoint a leader",
	"teams.initialize": "Import ministries",
	"teams.importRoles": "Import roles",
	"teams.scheduleMeeting": "Schedule a team meeting",
	"teams.offerResponsibilities": "Playbook responsibilities",
	"teams.addResponsibility": "Add a responsibility",
	"teams.editResponsibility": "Update a responsibility",
	"teams.completeResponsibility": "Tick a responsibility",
	"teams.deleteResponsibility": "Remove a responsibility",
	"teams.createProgram": "Add a training program",
	"teams.correctProgram": "Correct a training program",
	"teams.setRequiredTrainingParticipants": "Set required training",
	"teams.attestCompletion": "Record a training completion",
	"teams.revokeCompletion": "Revoke a training completion",
	"teams.recompleteTraining": "Record training again",
} as const;
type TeamsOperation = keyof typeof TEAMS_TITLE;
export const isTeams = (operation: Operation): operation is TeamsOperation => operation in TEAMS_TITLE;

/** The household, tag, skill, note and import writes (WP-064), whose reviews are not revised field by field. */
export type OrganizationOperation =
	| "people.addToHousehold"
	| "people.createHouseholdWithHead"
	| "people.updateHousehold"
	| "people.deleteHousehold"
	| "people.removeFromHousehold"
	| "people.setHouseholdRole"
	| "people.propagateAddress"
	| "people.createTag"
	| "people.updateTag"
	| "people.deleteTag"
	| "people.assignTag"
	| "people.removeTag"
	| "people.addSkill"
	| "people.updateSkill"
	| "people.removeSkill"
	| "people.addNote"
	| "people.editNote"
	| "people.deleteNote"
	| "people.executeBulkImport";

export type Change = { field: string; before: unknown; after: unknown };
/** One person a change reaches beyond its target, such as a household member or a person being tagged. */
export type ReviewedPerson = { id: string; label: string; changes: Change[]; unchanged?: string };
/** One row of a reviewed import and its planned outcome. */
export type ReviewedRow = {
	row: number;
	outcome: "create" | "create_and_review" | "skip" | "fail";
	label: string | null;
	reason: string | null;
};
/** What became of one person after approval: changed, or not and why. */
export type PersonOutcome = { id: string; label: string; outcome: "changed" | "unchanged"; reason?: string };
export type ImportOutcome = {
	status: "in_progress" | "complete" | "partial";
	counts: { created: number; skipped: number; failed: number; remaining: number };
	failed: { row: number; reason: string }[];
};

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
		target: {
			kind:
				| "person"
				| "message"
				| "team"
				| "role"
				| "training"
				| "responsibility"
				| "household"
				| "tag"
				/** A phase or signal change targets the church itself. */
				| "plant";
			id: string;
			label: string;
		} | null;
		changes: Change[];
		people?: ReviewedPerson[];
		rows?: ReviewedRow[];
		/** A plain reason the change cannot be approved as asked; the card shows it and offers no Approve. */
		refusal?: string;
		withheld?: true;
	};
	/** "failed" is only on rows saved before PR 245, which said "nothing was changed" without proof (R5-3). */
	outcome: "completed" | "failed" | "refused" | "unknown" | null;
	executing: boolean;
	receipt: {
		receiptId?: string;
		revision?: string;
		code?: string;
		report?: MailReport;
		people?: PersonOutcome[];
		import?: ImportOutcome;
		/** A refusal because a record changed: the records as they are now. */
		current?: { id: string; label: string; value: string | null }[];
	} | null;
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
	household: "Household",
	householdRole: "Role",
	householdAddress: "Address",
	address: "Address",
	name: "Name",
	tag: "Tag",
	createTag: "New tag",
	color: "Color",
	taggedPeople: "People with it",
	skill: "Skill",
	category: "Category",
	proficiency: "Level",
	notes: "Skill notes",
	note: "Note",
	// Ministries
	description: "Description",
	archived: "Archived",
	leadership: "Leadership role",
	timeCommitment: "Time commitment",
	desiredSkills: "Desired skills",
	retired: "Retired",
	filledBy: "Filled by",
	member: "Member",
	leader: "Leader",
	ministries: "Ministries",
	roles: "Roles",
	date: "Date",
	time: "Time",
	subtype: "Kind",
	title: "Title",
	offer: "Offer",
	responsibilities: "Responsibilities",
	responsibility: "Responsibility",
	text: "Text",
	done: "Done",
	required: "Required",
	requiredPeople: "Required people",
	person: "Person",
	completedOn: "Completed on",
	completedAgainOn: "Completed again on",
	completion: "Completion",
	phase: "Phase",
	direction: "Direction",
	openCriteria: "Not met yet",
	signal: "Signal",
	value: "Answer",
	asOf: "True as of",
	detail: "In your words",
	reference: "Written down in",
};
export const fieldLabel = (field: string) => FIELD_LABEL[field] ?? field;

const TEAM_STATE: Record<string, string> = { forming: "Forming", active: "Active", paused: "Paused" };
const DATE_FIELDS = new Set(["birthDate", "date", "completedOn", "completedAgainOn", "asOf"]);

/** Values People shows capitalized: a household role, a skill's category and level, a tag color. */
const CAPITALIZED = new Set(["householdRole", "category", "proficiency", "color"]);
const CLASSIFICATION_LABEL: Record<string, string> = { adult: "Adult", child: "Child", unknown: "Not recorded" };
const dateFormat = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

const DIRECTION_TEXT: Record<string, string> = {
	forward: "Forward, to the next phase",
	skip_forward: "Forward, skipping a phase",
	backward: "Backward, to an earlier phase",
};
const ANSWER_TEXT: Record<string, string> = { yes: "Yes", not_yet: "Not yet", retracted: "Retracted" };
/** A phase or a signal is reviewed as its number or key with its name: the card shows the name. */
const named = (value: unknown, name: "name" | "label") =>
	value && typeof value === "object" && name in value ? String((value as Record<string, unknown>)[name]) : null;

/** A reviewed value as text. Empty values say so; an id (a photo upload) is never shown. */
export function valueText(field: string, value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (field === "phase") return named(value, "name");
	if (field === "signal") return named(value, "label");
	if (field === "direction") return DIRECTION_TEXT[String(value)] ?? String(value);
	if (field === "value") return ANSWER_TEXT[String(value)] ?? String(value);
	// A reaffirmation dates the answer on the day it runs.
	if (field === "asOf" && value === "today") return "Today, when you approve";
	// A photo is a stored file: its short reference tells two uploads apart. The card shows the image where People allows it.
	if (field === "photo") return `Photo ${photoRef(value)}`;
	if (field === "stage") return STAGE_LABEL[value as StageValue] ?? String(value);
	if (field === "source") return SOURCE_LABEL[value as SourceValue] ?? String(value);
	if (field === "adultClassification") return CLASSIFICATION_LABEL[String(value)] ?? String(value);
	if (field === "state")
		return value === "live"
			? "Current"
			: value === "retired"
				? "Removed"
				: (TEAM_STATE[String(value)] ?? String(value));
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (CAPITALIZED.has(field) && typeof value === "string") return value.charAt(0).toUpperCase() + value.slice(1);
	if (DATE_FIELDS.has(field) && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
		return dateFormat.format(new Date(`${value}T00:00:00Z`));
	return String(value);
}

/**
 * REQ-EVR-011: approval applies only to content the person could inspect. A new photo is approvable once the card
 * shows its exact upload (GET /api/evry/proposals/{id}/photo); until then, or when the upload is gone, it is not.
 */
export const approvable = (review: Pick<Review, "operation">, uploadShown: boolean) =>
	review.operation !== "people.setPersonPhoto" || uploadShown;

/** What an empty value is called: no household is "None", and a note, skill or tag that goes away is "Removed". */
export function emptyText(field: string, after: boolean) {
	if (field === "photo") return "No photo";
	if (field === "household" || field === "householdRole") return "None";
	if (after && ["note", "skill", "category", "proficiency", "tag"].includes(field)) return "Removed";
	return "Empty";
}

/** The first 8 characters of a photo's file id, upper case, as people read a reference. */
export const photoRef = (value: unknown) => String(value).slice(0, 8).toUpperCase();

/** The person's open tasks a stage change or removal hands back as needing an owner, from the review. */
const handedBack = (changes: readonly Change[]) =>
	Number(changes.find((c) => c.field === "openTasksNeedingOwner")?.after ?? 0);

/**
 * The changes the card lists as before and after. The task count and a new tag are said once in words instead, and a
 * tag change on several people shows on each of them.
 */
export const shownChanges = (review: Pick<Review, "operation" | "review">) =>
	review.review.changes.filter(
		(c) =>
			c.field !== "openTasksNeedingOwner" &&
			c.field !== "createTag" &&
			!(c.field === "tag" && (review.operation === "people.assignTag" || review.operation === "people.removeTag")),
	);

const TITLE: Record<Operation, string> = {
	...TEAMS_TITLE,
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
	"notifications.markSelectedRead": "Mark notifications read",
	"notifications.markAllVisibleRead": "Mark all notifications read",
	"notifications.setPreferences": "Change notification settings",
	"notifications.digestCadence.set": "Change how often your digest comes",
	"phases.declare": "Record the starting phase",
	"phases.transition": "Move the phase",
	"signals.attest": "Record a signal",
	"signals.correct": "Correct a signal",
	"signals.reaffirm": "Reaffirm a signal",
	"people.addToHousehold": "Add to a household",
	"people.createHouseholdWithHead": "Create a household",
	"people.updateHousehold": "Update a household",
	"people.deleteHousehold": "Delete a household",
	"people.removeFromHousehold": "Take out of a household",
	"people.setHouseholdRole": "Change a household role",
	"people.propagateAddress": "Update a household's address",
	"people.createTag": "Create a tag",
	"people.updateTag": "Update a tag",
	"people.deleteTag": "Delete a tag",
	"people.assignTag": "Tag people",
	"people.removeTag": "Take a tag off people",
	"people.addSkill": "Add a skill",
	"people.updateSkill": "Update a skill",
	"people.removeSkill": "Remove a skill",
	"people.addNote": "Add a note",
	"people.editNote": "Edit a note",
	"people.deleteNote": "Delete a note",
	"people.executeBulkImport": "Import people",
};
export const operationTitle = (operation: Operation) => TITLE[operation];

/** A phase or signal change: the church is its target and the phase journey or Attestations page shows the result. */
export const isIntelligence = (operation: Operation) => /^(phases|signals)\./.test(operation);
/** Where the result of a phase or signal change shows. */
export const intelligencePage = (operation: Operation) =>
	operation.startsWith("phases.")
		? { href: "/intelligence", label: "Open the phase journey" }
		: { href: "/intelligence/attestations", label: "Open attestations" };
/** The exit criteria of the current phase a forward move leaves open, each with its status in words. */
export const openCriteria = (review: Review) => {
	const value = review.review.changes.find((c) => c.field === "openCriteria")?.after;
	return Array.isArray(value) ? (value as { label: string; status: string }[]) : null;
};

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
	// NTF-003: read is only read.
	if (review.operation === "notifications.markSelectedRead" || review.operation === "notifications.markAllVisibleRead")
		return "Marking read doesn't complete or change any task.";
	const tasks = handedBack(review.review.changes);
	const owner =
		tasks > 0 ? `${tasks.toLocaleString()} open ${tasks === 1 ? "task" : "tasks"} will need a new owner.` : null;
	if (review.operation === "people.deletePerson")
		return ["They leave the current people list. Their history stays.", owner].filter(Boolean).join(" ");
	const direction = review.review.changes.find((c) => c.field === "direction")?.after;
	if (direction === "backward") return "This is a move backward. The phase journey keeps every earlier move.";
	if (review.operation === "phases.transition")
		return "You decide when the church moves. The exit criteria are advisory.";
	const created = review.review.changes.find((c) => c.field === "createTag")?.after;
	if (created) return `The tag ${String(created)} will be created.`;
	switch (review.operation) {
		case "people.updateHousehold":
			return "Members keep their own addresses.";
		case "people.removeFromHousehold":
			return "They keep their own address.";
		case "people.propagateAddress":
			return "Everyone listed gets the household's address. If anyone's record changes before you approve, nothing is changed for anyone.";
		case "people.deleteTag":
			return "It comes off everyone who has it. Their history keeps it.";
		case "people.executeBulkImport":
			return importSummary(review.review.rows ?? []);
	}
	return owner;
}

/** "2 people will be added · 1 row skipped · 2 rows fail": the planned outcome of a reviewed import. */
export function importSummary(rows: readonly ReviewedRow[]) {
	const n = (outcome: ReviewedRow["outcome"][]) => rows.filter((r) => outcome.includes(r.outcome)).length;
	const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
	const add = n(["create", "create_and_review"]);
	return [
		`${plural(add, "person", "people")} will be added`,
		n(["skip"]) ? `${plural(n(["skip"]), "row", "rows")} skipped` : null,
		n(["fail"]) ? `${plural(n(["fail"]), "row fails", "rows fail")}` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

/** What the outcome of each planned import row is called on the card. */
export const ROW_OUTCOME: Record<ReviewedRow["outcome"], string> = {
	create: "Add",
	create_and_review: "Add, review later",
	skip: "Skip",
	fail: "Fails",
};

/**
 * The head of a saved change that reached several people: it counts who changed, so a change that left anyone out
 * never reads as done for everyone.
 */
export function peopleResult(review: Review): string | null {
	const people = review.receipt?.people;
	if (!people?.length) return null;
	const changed = people.filter((p) => p.outcome === "changed").length;
	if (changed === people.length) return people.length === 1 ? "Saved" : `Saved for all ${people.length}`;
	return `${changed} of ${people.length} changed`;
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
	asOf: "date",
	detail: "long",
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
const FIXED = new Set([
	"photo",
	"state",
	"openTasksNeedingOwner",
	"phase",
	"direction",
	"openCriteria",
	"signal",
	"value",
]);
/** Values that may be empty. A name and a reason are required, and a signal's date and words. */
const REQUIRED = new Set(["displayName", "reason", "stage", "source", "adultClassification", "asOf", "detail"]);
/** Adult or child is required until a birth date is entered: then it comes from the birth date (REQ-PPL-026). */
export const isRequired = (field: string, birthDate = false) =>
	field === "adultClassification" ? !birthDate : REQUIRED.has(field);

/** The review has a birth date, as revised: an edited value wins over the reviewed one. */
export function hasBirthDate(review: Review, edits: Record<string, string>) {
	const c = review.review.changes.find((x) => x.field === "birthDate");
	if (!c) return false;
	return c.field in edits ? (edits[c.field] ?? "").trim() !== "" : Boolean(c.after);
}

/** Writes that only add something: their review shows the new values without an empty "before". */
const ADDS = new Set<Operation>(["people.createPerson", "people.addNote", "people.addSkill", "people.createTag"]);
export const addsOnly = (operation: Operation) => ADDS.has(operation);

/** The People, phase and signal writes whose review can be rebuilt (and, but for a reaffirm, revised) on the card. */
const REVISABLE = new Set<Operation>([
	"people.createPerson",
	"people.updatePerson",
	"people.changeStatus",
	"people.deletePerson",
	"people.setPersonPhoto",
	"people.removePersonPhoto",
	"phases.declare",
	"phases.transition",
	"signals.attest",
	"signals.correct",
	"signals.reaffirm",
]);
export const editableChanges = (review: Review) =>
	review.review.withheld || !REVISABLE.has(review.operation) || review.operation === "signals.reaffirm"
		? []
		: review.review.changes.filter((c) => !FIXED.has(c.field));

/** The native command's input for this review with `edits` applied, or null when the review can't be rebuilt. */
export function reviseInput(review: Review, edits: Record<string, string> = {}): unknown {
	if (!REVISABLE.has(review.operation) && !isMail(review.operation)) return null;
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
	const key = (after("signal") as { key?: string } | undefined)?.key;
	const reference = after("reference");
	const signalFacts = () => ({
		key,
		value: after("value"),
		asOf: after("asOf"),
		detail: after("detail"),
		...(typeof reference === "string" ? { reference } : {}),
	});
	switch (review.operation) {
		case "phases.declare":
			return { phase: (after("phase") as { phase: number }).phase };
		case "phases.transition":
			return { toPhase: (after("phase") as { phase: number }).phase, reason: after("reason") };
		case "signals.attest":
			return signalFacts();
		case "signals.correct":
			return after("value") === "retracted" ? { action: "retract", key } : { action: "correct", ...signalFacts() };
		case "signals.reaffirm":
			return { key };
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
export function refusalText(code: string | undefined, target: string | null): string {
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
		case "review_stale":
			return "People changed after Evry checked this file, so nothing was imported. Ask Evry to check it again.";
		case "file_changed":
			return "This file changed after Evry checked it, so nothing was imported. Ask Evry to check it again.";
		default:
			return "People refused this change, so nothing was saved.";
	}
}

/** Why a phase or signal change was refused. Nothing was saved in each case. */
export function intelligenceRefusalText(code: string | undefined): string {
	switch (code) {
		case "revision_conflict":
		case "conflict":
		case "not_current":
			return "The phase or signal changed after Evry prepared this, so nothing was saved. Ask Evry to prepare it again.";
		case "already_declared":
			return "This church already has its starting phase, so nothing was saved. Ask Evry to move the phase instead.";
		case "no_change":
			return "The signal already has that answer, so nothing was saved.";
		case "access_denied":
			return "Your seat no longer allows this change, so nothing was saved. Only an Owner or Admin can change it.";
		case "invalid_input":
		case "invalid_reason":
		case "not_reaffirmable":
			return "Everyfield did not accept these values, so nothing was saved. Ask Evry to prepare it again.";
		default:
			return "Everyfield refused this change, so nothing was saved.";
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

// ---------------------------------------------------------------------------------------------------------------
// Notifications: the account's own bell and settings (WP-082). Nothing here names another person.

export const isNotification = (operation: Operation) => operation.startsWith("notifications.");

export type ReviewedNotice = { id: string; title: string; category: string; at: string; zone: string };
const isNotice = (value: unknown): value is ReviewedNotice =>
	!!value && typeof value === "object" && "id" in value && "title" in value && "at" in value;
/** The notices a mark-selected review will mark read, newest first, as the review listed them. */
export const reviewedNotices = (review: Review) =>
	review.review.changes.flatMap((c) => (c.field === "notice" && isNotice(c.before) ? [c.before] : []));
/** "Sat, Nov 7, 9:15 AM": when the notice arrived, in the church's zone. */
export const noticeWhen = ({ at, zone }: ReviewedNotice) =>
	new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(at));

const CHANNEL_LABEL: Record<string, string> = { email: "Email", in_app: "In-app" };
/** Each category a settings review touches, with every channel's value before and after, in the review's order. */
export function settingChanges(review: Review) {
	const groups = new Map<string, { channel: string; before: boolean; after: boolean }[]>();
	for (const c of review.review.changes) {
		const [category, channel] = c.field.split(".");
		if (!category || !channel || typeof c.before !== "boolean" || typeof c.after !== "boolean") continue;
		groups.set(category, [
			...(groups.get(category) ?? []),
			{ channel: CHANNEL_LABEL[channel] ?? channel, before: c.before, after: c.after },
		]);
	}
	return [...groups].map(([category, channels]) => ({ category, channels }));
}

type DigestSlot = { cadence: string; weekday: number; hour: number };
const isSlot = (value: unknown): value is DigestSlot =>
	!!value && typeof value === "object" && "cadence" in value && "weekday" in value && "hour" in value;
const WEEKDAY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const hourText = (hour: number) => `${hour % 12 || 12}:00 ${hour < 12 ? "AM" : "PM"}`;
/** "Weekly on Mondays at 8:00 AM" or "Daily at 8:00 AM": the church digest's schedule for this account. */
export const digestSchedule = (value: unknown) =>
	isSlot(value)
		? value.cadence === "daily"
			? `Daily at ${hourText(value.hour)}`
			: `Weekly on ${WEEKDAY[value.weekday] ?? "Sundays"} at ${hourText(value.hour)}`
		: null;
