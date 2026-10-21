// Pure rules of the duplicate review, merge, Unmerge and record correction screens (WP-015/ui). No React and no server
// code, so the rules run the same in the browser, on the server and in node tests.

import { CLASSIFICATION_LABEL, SOURCE_LABEL, type ClassificationValue, type SourceValue } from "../model.ts";

export const MERGE_FIELDS = [
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
	| "commitment_witness"
	| "merge_record"
	| "attestation"
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
	| "team_tenure";

/** What each kind is called in a count: "2 notes". The singular is used for one. */
export const KIND_LABEL: Record<ReferenceKind, [one: string, many: string]> = {
	tag: ["tag", "tags"],
	skill: ["skill", "skills"],
	note: ["note", "notes"],
	assessment: ["Four Cs assessment", "Four Cs assessments"],
	interview: ["interview", "interviews"],
	commitment: ["commitment card", "commitment cards"],
	merged_person: ["earlier merged person", "earlier merged people"],
	correction: ["record correction", "record corrections"],
	commitment_witness: ["card they witnessed", "cards they witnessed"],
	merge_record: ["earlier merge", "earlier merges"],
	attestation: ["attestation", "attestations"],
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
};
export const counted = (kind: ReferenceKind, count: number) => `${count} ${KIND_LABEL[kind][count === 1 ? 0 : 1]}`;
/** A kind as a list heading: "Notes". */
export const kindTitle = (kind: ReferenceKind) => KIND_LABEL[kind][1].replace(/^./, (c) => c.toUpperCase());
/** "notes, tasks and emails": the plural names of `kinds`, for a sentence. */
export const kindList = (kinds: readonly ReferenceKind[]) => listText(kinds.map((k) => KIND_LABEL[k][1]));
export function listText(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export type Treatment = "move" | "deduplicate" | "keep" | "block";
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
 * Which of two people stays when the address does not say: the one with an EveryField account (a linked person must
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

// ---------------------------------------------------------------------------------------------------------------
// Refusals in words. Each names a cause the person can act on.

export type Blocker = "linked_account_collision" | "linked_source" | "unregistered_reference";
export function blockerText(cause: Blocker, names: { source: string; survivor: string }, kinds: ReferenceKind[]) {
	switch (cause) {
		case "linked_account_collision":
			return `${names.source} and ${names.survivor} both have an EveryField account. Two accounts cannot become one person.`;
		case "linked_source":
			return `${names.source} has an EveryField account, so ${names.source} must be the person you keep.`;
		case "unregistered_reference":
			return `${names.source} still has ${kindList(kinds)}. EveryField cannot move these yet. Finish or reassign them, then review again.`;
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
export type RatingValue = { rating: Rating; notes: string | null };
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
/** The Four Cs total, as the server computes it: the sum of the four scores. */
export const totalOf = (v: Record<Lens, ScoreValue>) => LENSES.reduce((sum, l) => sum + v[l].score, 0);

/** A record value applied over its record: the record as the server holds it after a saved correction. */
export function applied<T extends object>(record: T, changes: Partial<T>): T {
	return { ...record, ...changes };
}

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
