// The Evry review card's rules (WP-053/ui), as plain data and pure functions. The server's review is the only truth
// about a prepared change: its review status (pending, approved, cancelled, expired) and the recorded outcome of the
// approved revision are separate (REQ-EVR-033). The card derives what it shows from that review and the time the
// approval has left on the server's clock; the browser's clock is never read.

import { SOURCE_LABEL, STAGE_LABEL, type SourceValue, type StageValue } from "../../people/model.ts";
import type { ProjectedError } from "../conversation/model.ts";

export type Operation =
	| "people.createPerson"
	| "people.updatePerson"
	| "people.changeStatus"
	| "people.deletePerson"
	| "people.setPersonPhoto"
	| "people.removePersonPhoto";

export type Change = { field: string; before: unknown; after: unknown };

/** evry.readReview, as the API sends it (packages/evry/src/proposals/store.ts, proposalRow). */
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
		target: { kind: "person"; id: string; label: string } | null;
		changes: Change[];
		withheld?: true;
	};
	/** "failed" is only on rows saved before #245, which said "nothing was changed" without proof (R5-3). */
	outcome: "completed" | "failed" | "refused" | "unknown" | null;
	executing: boolean;
	receipt: { receiptId?: string; revision?: string; code?: string } | null;
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
};
export const fieldLabel = (field: string) => FIELD_LABEL[field] ?? field;

const CLASSIFICATION_LABEL: Record<string, string> = { adult: "Adult", child: "Child", unknown: "Not recorded" };
const dateFormat = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

/** A reviewed value as text. Empty values say so; an id (a photo upload) is never shown. */
export function valueText(field: string, value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	// A photo is a stored file: its short reference tells two uploads apart. The card shows the image where People allows it.
	if (field === "photo") return `Photo ${photoRef(value)}`;
	if (field === "stage") return STAGE_LABEL[value as StageValue] ?? String(value);
	if (field === "source") return SOURCE_LABEL[value as SourceValue] ?? String(value);
	if (field === "adultClassification") return CLASSIFICATION_LABEL[String(value)] ?? String(value);
	if (field === "state") return value === "live" ? "Current" : value === "retired" ? "Removed" : String(value);
	if (field === "birthDate" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
		return dateFormat.format(new Date(`${value}T00:00:00Z`));
	return String(value);
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
export const handedBack = (changes: readonly Change[]) =>
	Number(changes.find((c) => c.field === "openTasksNeedingOwner")?.after ?? 0);

/** The changes the card lists as before and after; the task count is said once in words instead. */
export const shownChanges = (changes: readonly Change[]) => changes.filter((c) => c.field !== "openTasksNeedingOwner");

const TITLE: Record<Operation, string> = {
	"people.createPerson": "Add a person",
	"people.updatePerson": "Update a person",
	"people.changeStatus": "Change a stage",
	"people.deletePerson": "Remove a person",
	"people.setPersonPhoto": "Set a photo",
	"people.removePersonPhoto": "Remove a photo",
};
export const operationTitle = (operation: Operation) => TITLE[operation];

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
export const isRequired = (field: string) => REQUIRED.has(field);

export const editableChanges = (review: Review) =>
	review.review.withheld ? [] : review.review.changes.filter((c) => !FIXED.has(c.field));

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
	}
}

/** The first required value left empty, for the form's own message before anything is sent. */
export function missingRequired(review: Review, edits: Record<string, string>) {
	return editableChanges(review).find((c) => isRequired(c.field) && (edits[c.field] ?? "").trim() === "") ?? null;
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
		default:
			return "People refused this change, so nothing was saved.";
	}
}

/** What the card says after an action the server refused or never answered. */
export function actionNotice(error: ProjectedError | "lost"): string {
	if (error === "lost") return "Not confirmed. Check your connection, then try again.";
	switch (error.code) {
		case "review_changed":
			return "This review changed in another window. Check it again before you approve.";
		case "review_expired":
			return "This review expired before it was approved. Nothing was changed.";
		case "review_closed":
			return "This review is already closed.";
		case "photo_unavailable":
			return "The uploaded photo is no longer available, so nothing was saved.";
		case "invalid_input":
			return "Some values are not valid. Check them, then update the review.";
		case "access_denied":
		case "not_found":
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
