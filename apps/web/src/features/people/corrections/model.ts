// Pure rules of the duplicate review, merge, Unmerge and record correction screens (WP-015/ui). No React and no server
// code, so the rules run the same in the browser, on the server and in node tests.

import { sendTwice, type Outcome } from "../../../components/save/model.ts";
import { CLASSIFICATION_LABEL, SOURCE_LABEL, type ClassificationValue, type SourceValue } from "../model.ts";

const MERGE_FIELDS = [
	"displayName",
	"firstName",
	"lastName",
	"email",
	"phone",
	"address",
	"source",
	"summaryNotes",
	"birthDate",
	"adultClassification",
	"household",
	"photo",
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type Side = "source" | "survivor";

export const FIELD_LABEL: Record<MergeField, string> = {
	displayName: "Name",
	firstName: "First name",
	lastName: "Last name",
	email: "Email",
	phone: "Phone",
	address: "Address",
	source: "How you met",
	summaryNotes: "Summary",
	birthDate: "Birth date",
	adultClassification: "Adult or child",
	household: "Household",
	photo: "Photo",
};

/** The reference kinds a merge review counts (the registry in packages/domain/src/people/person-reference-registry). */
export type ReferenceKind =
	| "tag"
	| "skill"
	| "note"
	| "assessment"
	| "interview"
	| "commitment"
	| "merged_person"
	| "correction"
	| "commitment_change"
	| "commitment_witness"
	| "merge_record"
	| "attestation"
	| "attestation_history"
	| "email_opt_out"
	| "duplicate_dismissal"
	| "contact_outcome"
	| "development_enrollment"
	| "invitation"
	| "mail"
	| "meeting_kit_item"
	| "obligation"
	| "participation"
	| "participation_inviter"
	| "pipeline_person"
	| "residency_link"
	| "task"
	| "team_leader"
	| "team_tenure"
	| "training_assignment"
	| "training_credit";

/** What each kind is called in a count: "2 notes". The singular is used for one. */
const KIND_LABEL: Record<ReferenceKind, [one: string, many: string]> = {
	tag: ["tag", "tags"],
	skill: ["skill", "skills"],
	note: ["note", "notes"],
	assessment: ["4 C's assessment", "4 C's assessments"],
	interview: ["interview", "interviews"],
	commitment: ["commitment card", "commitment cards"],
	merged_person: ["earlier merged person", "earlier merged people"],
	correction: ["record correction", "record corrections"],
	commitment_change: ["commitment withdrawal or reactivation", "commitment withdrawals and reactivations"],
	commitment_witness: ["card they witnessed", "cards they witnessed"],
	merge_record: ["earlier merge", "earlier merges"],
	attestation: ["attestation", "attestations"],
	attestation_history: ["earlier attestation", "earlier attestations"],
	email_opt_out: ["email unsubscribe", "email unsubscribes"],
	duplicate_dismissal: ["pair marked not a duplicate", "pairs marked not a duplicate"],
	contact_outcome: ["follow-up outcome", "follow-up outcomes"],
	development_enrollment: ["development enrollment", "development enrollments"],
	invitation: ["invitation", "invitations"],
	mail: ["email", "emails"],
	meeting_kit_item: ["meeting kit item", "meeting kit items"],
	obligation: ["follow-up", "follow-ups"],
	participation: ["meeting attendance", "meeting attendances"],
	participation_inviter: ["guest they invited", "guests they invited"],
	pipeline_person: ["organization pipeline entry", "organization pipeline entries"],
	residency_link: ["residency link", "residency links"],
	task: ["task", "tasks"],
	team_leader: ["ministry leader role", "ministry leader roles"],
	team_tenure: ["ministry role", "ministry roles"],
	training_assignment: ["training assignment", "training assignments"],
	training_credit: ["training credit", "training credits"],
};
export const counted = (kind: ReferenceKind, count: number) => `${count} ${KIND_LABEL[kind][count === 1 ? 0 : 1]}`;
/** A kind as a list heading: "Notes". */
export const kindTitle = (kind: ReferenceKind) => KIND_LABEL[kind][1].replace(/^./, (c) => c.toUpperCase());
/** "notes, tasks and emails": the plural names of `kinds`, for a sentence. */
const kindList = (kinds: readonly ReferenceKind[]) => listText(kinds.map((k) => KIND_LABEL[k][1]));
export function listText(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

type Treatment = "move" | "deduplicate" | "keep" | "block";
export type Reference = { kind: ReferenceKind; count: number; treatment: Treatment };
/** The review's references split by what the merge does with them. */
export function referenceGroups(refs: readonly Reference[]) {
	return {
		moves: refs.filter((r) => r.treatment === "move" || r.treatment === "deduplicate"),
		stays: refs.filter((r) => r.treatment === "keep"),
		blocked: refs.filter((r) => r.treatment === "block"),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Field values. A review field holds the Person columns it covers, as the database holds them.

export type Columns = Record<string, unknown>;
/** Names of the households in the review, by household ID (read only when the household field differs). */
export type Households = Record<string, string>;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A field value in words, or null when that side has none. */
export function fieldText(field: MergeField, v: Columns, households: Households = {}): string | null {
	switch (field) {
		case "displayName":
			return text(v.display_name);
		case "firstName":
			return text(v.first_name);
		case "lastName":
			return text(v.last_name);
		case "email":
			return text(v.email);
		case "phone":
			return text(v.phone);
		case "summaryNotes":
			return text(v.notes);
		case "birthDate":
			return text(v.birth_date);
		case "address": {
			const city = [text(v.city), text(v.state_province)].filter(Boolean).join(", ");
			const line = [text(v.street), city || null, text(v.postal_code), text(v.country)].filter(Boolean).join(" · ");
			return line || null;
		}
		case "source": {
			const s = text(v.source);
			const label = s && s in SOURCE_LABEL ? SOURCE_LABEL[s as SourceValue] : null;
			const details = text(v.source_details);
			return label && details ? `${label} · ${details}` : (label ?? details);
		}
		case "adultClassification": {
			const c = text(v.adult_classification);
			return c && c !== "unknown" && c in CLASSIFICATION_LABEL ? CLASSIFICATION_LABEL[c as ClassificationValue] : null;
		}
		case "household": {
			const id = text(v.household_id);
			if (!id) return null;
			const role = text(v.household_role);
			const name = households[id] ?? "A household";
			return role ? `${name} · ${role.replace(/_/g, " ")}` : name;
		}
		case "photo":
			return text(v.photo_object_id) ? "Has a photo" : null;
	}
}

/**
 * The side each differing field starts on. The survivor's value stays unless it is empty and the source has one, so a
 * merge never drops a known email or phone by default. The reviewer can still choose either side for every field.
 */
export function defaultChoices(
	fields: readonly { field: MergeField; source: Columns; survivor: Columns }[],
): Partial<Record<MergeField, Side>> {
	const out: Partial<Record<MergeField, Side>> = {};
	for (const f of fields)
		out[f.field] =
			fieldText(f.field, f.survivor) === null && fieldText(f.field, f.source) !== null ? "source" : "survivor";
	return out;
}
/** The request's field choices: only fields taken from the source; a field left out keeps the survivor's value. */
export function sourceChoices(choices: Partial<Record<MergeField, Side>>): Partial<Record<MergeField, "source">> {
	const out: Partial<Record<MergeField, "source">> = {};
	for (const f of MERGE_FIELDS) if (choices[f] === "source") out[f] = "source";
	return out;
}

/**
 * Which of two people stays when the address does not say: the one with an Everyfield account (a linked person must
 * survive), otherwise the one added first.
 */
export function defaultSurvivor(
	a: { id: string; createdAt: string; linked: boolean },
	b: { id: string; createdAt: string; linked: boolean },
): string {
	if (a.linked !== b.linked) return a.linked ? a.id : b.id;
	return a.createdAt <= b.createdAt ? a.id : b.id;
}

/** The duplicates page address for a pair. `keep` names the person who stays; without it the default applies. */
export function pairHref(personId: string, withId: string, keep?: string): string {
	const q = new URLSearchParams({ person: personId, with: withId });
	if (keep) q.set("keep", keep);
	return `/people/duplicates?${q.toString()}`;
}
/** The Dismissed view: the pairs marked "Not a duplicate", each with Restore (D-790). */
export const DISMISSED_HREF = "/people/duplicates?view=dismissed";

// ---------------------------------------------------------------------------------------------------------------
// "Not a duplicate" on the list and Restore in the Dismissed view (D-789). The row leaves at once; a refused or lost
// answer puts it back where it was with a notice that says what happened. A repeat writes nothing, so Try again is safe.

export type PairAction = "dismiss" | "restore";
export const pairKey = (p: { person: { id: string }; with: { id: string } }) => `${p.person.id}:${p.with.id}`;
/** The rows sent away and not answered yet or saved (`gone`), and each row's notice after a failed answer. */
export type PairState = { gone: readonly string[]; notices: Readonly<Record<string, string>> };
export const pairsAtStart: PairState = { gone: [], notices: {} };

/** The row leaves the list as its action is sent; its earlier notice goes with it. */
export function pairSent(s: PairState, key: string): PairState {
	const notices = { ...s.notices };
	delete notices[key];
	return { gone: s.gone.includes(key) ? s.gone : [...s.gone, key], notices };
}
/** A saved answer keeps the row gone. Any other answer puts it back in its place with its notice. */
export function pairAnswered(s: PairState, key: string, action: PairAction, answer: Outcome<unknown>): PairState {
	if (answer.status === "ok") return s;
	return { gone: s.gone.filter((k) => k !== key), notices: { ...s.notices, [key]: pairNotice(action, answer) } };
}
/** The rows still shown, in their original order. */
export const pairsShown = <P extends { person: { id: string }; with: { id: string } }>(
	items: readonly P[],
	s: PairState,
) => items.filter((p) => !s.gone.includes(pairKey(p)));

export function pairNotice(action: PairAction, answer: Exclude<Outcome<unknown>, { status: "ok" }>): string {
	if (answer.status === "lost")
		return action === "dismiss"
			? "We could not confirm this. It may have saved. Reload to check, or try again."
			: "We could not confirm the restore. It may have saved. Reload to check, or try again.";
	if (answer.code === "pair_unavailable")
		return "Nothing changed. One of them was merged or retired, so this pair is no longer listed. Reload to see the list as it is now.";
	return action === "dismiss"
		? "Nothing changed. The pair was not marked. Try again."
		: "Nothing changed. The pair was not restored. Try again.";
}

// ---------------------------------------------------------------------------------------------------------------
// "Not a duplicate" on the side-by-side review of a listed pair (T-268). It dismisses the listed direction (the imported
// person first, whichever order the address names them in), then the screen returns to the list. A refusal keeps the
// reviewer on the review, which reads again to show where the people stand; a lost answer says it may have saved.

export type ListedPair = { personId: string; withPersonId: string };
/** What the review does after its dismiss: back to the list, or stay with a notice and maybe read the pair again. */
export type ReviewDismissed = { next: "list" } | { next: "review"; reread: boolean; text: string };

export function reviewDismissed(answer: Outcome<unknown>): ReviewDismissed {
	if (answer.status === "ok") return { next: "list" };
	if (answer.status === "lost")
		return {
			next: "review",
			reread: false,
			text: "We did not hear back from the server, so the pair may have been marked not a duplicate. Reload the page to see where it stands.",
		};
	if (answer.code === "pair_unavailable")
		return {
			next: "review",
			reread: true,
			text: "Nothing changed. One of them was merged or retired, or the pair is no longer on the list. The page now shows where they stand.",
		};
	return {
		next: "review",
		reread: true,
		text: "Nothing changed. You cannot mark these people. Your seat may have changed; reload the page.",
	};
}

/**
 * One review's "Not a duplicate". The write sets a state, so a lost answer is sent once more as it is. While one is in
 * flight another call sends nothing and answers null, so a double click dismisses once.
 */
export function reviewDismiss(send: (input: ListedPair) => Promise<Outcome<unknown>>) {
	let pending = false;
	return async (listed: ListedPair): Promise<ReviewDismissed | null> => {
		if (pending) return null;
		pending = true;
		try {
			return reviewDismissed(await sendTwice(() => send(listed)));
		} finally {
			pending = false;
		}
	};
}
/** The list's confirmation after a dismiss from the review: both people, imported person first. */
export const notDuplicateText = (person: string, other: string) => `${person} and ${other} marked not a duplicate.`;

// ---------------------------------------------------------------------------------------------------------------
// Refusals in words. Each names a cause the person can act on.

export type Blocker = "linked_account_collision" | "linked_source" | "unregistered_reference";
export function blockerText(cause: Blocker, names: { source: string; survivor: string }, kinds: ReferenceKind[]) {
	switch (cause) {
		case "linked_account_collision":
			return `${names.source} and ${names.survivor} both have an Everyfield account. Two accounts cannot become one person.`;
		case "linked_source":
			return names.source === names.survivor
				? "The record with an Everyfield account must be the one you keep."
				: `${names.source} has an Everyfield account, so ${names.source} must be the person you keep.`;
		case "unregistered_reference":
			return `${names.source} has ${kindList(kinds)} on record. Merging people with this history is not available in Everyfield yet.`;
	}
}

export type InverseConflict = "survivor_changed" | "source_changed" | "references_changed";
export function conflictText(cause: InverseConflict, names: { source: string; survivor: string }) {
	switch (cause) {
		case "survivor_changed":
			return `${names.survivor}'s details changed after the merge.`;
		case "source_changed":
			return `${names.source}'s record changed after the merge.`;
		case "references_changed":
			return `${names.survivor} has records that are new, moved or corrected since the merge, or was merged again.`;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Record corrections (REQ-PPL-015). A correction sends only the fields the person changed.

export const LENSES = ["committed", "compelled", "contagious", "courageous"] as const;
export type Lens = (typeof LENSES)[number];
export const LENS_LABEL: Record<Lens, string> = {
	committed: "Committed",
	compelled: "Compelled",
	contagious: "Contagious",
	courageous: "Courageous",
};
export const CRITERIA = ["maturity", "gifted", "chemistry", "rightReasons", "season"] as const;
export type Criterion = (typeof CRITERIA)[number];
export const CRITERION_LABEL: Record<Criterion, string> = {
	maturity: "Spiritual maturity",
	gifted: "Gifted for the role",
	chemistry: "Team chemistry",
	rightReasons: "Right reasons",
	season: "Right season",
};
export const RATINGS = ["pass", "concern", "fail"] as const;
export type Rating = (typeof RATINGS)[number];
export const RATING_LABEL: Record<Rating, string> = { pass: "Pass", concern: "Concern", fail: "Fail" };
export const RESULTS = ["qualified", "qualified_with_notes", "not_qualified", "follow_up"] as const;
export type InterviewResult = (typeof RESULTS)[number];
export const RESULT_LABEL: Record<InterviewResult, string> = {
	qualified: "Qualified",
	qualified_with_notes: "Qualified with notes",
	not_qualified: "Not qualified",
	follow_up: "Follow up",
};

export type ScoreValue = { score: number; notes: string | null };
type RatingValue = { rating: Rating; notes: string | null };
export type AssessmentValues = { occurredOn: string } & Record<Lens, ScoreValue>;
export type InterviewValues = { occurredOn: string; result: InterviewResult; nextSteps: string | null } & Record<
	Criterion,
	RatingValue
>;
export type CommitmentValues = { notes: string | null };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Empty text is no text: a cleared note saves as null, as the record holds it. */
const clean = (s: string | null) => (s && s.trim() ? s.trim() : null);
const cleanPart = <T extends { notes: string | null }>(v: T): T => ({ ...v, notes: clean(v.notes) });

/** The changed parts of a correction form, in the request's shape; empty when nothing changed. */
export function assessmentChanges(base: AssessmentValues, draft: AssessmentValues) {
	const out: Partial<AssessmentValues> = {};
	if (draft.occurredOn !== base.occurredOn) out.occurredOn = draft.occurredOn;
	for (const l of LENSES) if (!same(cleanPart(draft[l]), cleanPart(base[l]))) out[l] = cleanPart(draft[l]);
	return out;
}
export function interviewChanges(base: InterviewValues, draft: InterviewValues) {
	const out: Partial<InterviewValues> = {};
	if (draft.occurredOn !== base.occurredOn) out.occurredOn = draft.occurredOn;
	for (const k of CRITERIA) if (!same(cleanPart(draft[k]), cleanPart(base[k]))) out[k] = cleanPart(draft[k]);
	if (draft.result !== base.result) out.result = draft.result;
	if (clean(draft.nextSteps) !== clean(base.nextSteps)) out.nextSteps = clean(draft.nextSteps);
	return out;
}
export function commitmentChanges(base: CommitmentValues, draft: CommitmentValues) {
	return clean(draft.notes) !== clean(base.notes) ? { notes: clean(draft.notes) } : {};
}
/** The 4 C's total, as the server computes it: the sum of the four scores. */
export const totalOf = (v: Record<Lens, ScoreValue>) => LENSES.reduce((sum, l) => sum + v[l].score, 0);

/** A corrected field's name in words, as the history lists it. */
export function correctedFieldLabel(field: string): string {
	if (field === "occurredOn") return "Date";
	if (field === "nextSteps") return "Next steps";
	if (field === "result") return "Result";
	if (field === "notes") return "Notes";
	if (field === "kind") return "Card kind";
	if (field === "voided") return "Voided";
	if (field in LENS_LABEL) return LENS_LABEL[field as Lens];
	if (field in CRITERION_LABEL) return CRITERION_LABEL[field as Criterion];
	return field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}
/** A corrected value in words: a score, a rating with notes, a result or plain text. */
export function correctedValueText(v: unknown): string {
	if (v === null || v === undefined || v === "") return "None";
	if (typeof v === "string") return v in RESULT_LABEL ? RESULT_LABEL[v as InterviewResult] : v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (typeof v === "object") {
		const o = v as Record<string, unknown>;
		const head =
			typeof o.score === "number"
				? `${o.score} of 5`
				: typeof o.rating === "string" && o.rating in RATING_LABEL
					? RATING_LABEL[o.rating as Rating]
					: null;
		const notes = typeof o.notes === "string" && o.notes ? o.notes : null;
		if (head) return notes ? `${head} · ${notes}` : head;
	}
	return JSON.stringify(v);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * What is wrong with a role date correction before anything is sent, by field (REQ-TEAM-006). Empty when it can save.
 * A role held now has no end date to correct.
 */
export function roleDateProblems(f: {
	role: { endedOn: string | null };
	startedOn: string;
	endedOn: string;
	reason: string;
}): Partial<Record<"startedOn" | "endedOn" | "reason", string>> {
	const ended = f.role.endedOn !== null;
	return {
		...(DATE.test(f.startedOn) ? {} : { startedOn: "Choose a start date." }),
		...(ended && !DATE.test(f.endedOn) ? { endedOn: "Choose an end date." } : {}),
		...(ended && DATE.test(f.startedOn) && DATE.test(f.endedOn) && f.endedOn < f.startedOn
			? { endedOn: "The end date cannot be before the start date." }
			: {}),
		...(f.reason.trim() ? {} : { reason: "Say why the dates change. The ministry's history keeps it." }),
	};
}
