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

export {
	MERGE_FIELD_LABEL as FIELD_LABEL,
	blockerText,
	conflictText,
	counted,
	kindTitle,
	listText,
	type Blocker,
	type InverseConflict,
	type ReferenceKind,
} from "@everyfield/contracts/people";
import type { ReferenceKind } from "@everyfield/contracts/people";

type Treatment = "move" | "deduplicate" | "keep" | "block";
export type Reference = { kind: ReferenceKind; count: number; treatment: Treatment };
export function referenceGroups(refs: readonly Reference[]) {
	return {
		moves: refs.filter((r) => r.treatment === "move" || r.treatment === "deduplicate"),
		stays: refs.filter((r) => r.treatment === "keep"),
		blocked: refs.filter((r) => r.treatment === "block"),
	};
}

export type Columns = Record<string, unknown>;
export type Households = Record<string, string>;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

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

export function defaultChoices(
	fields: readonly { field: MergeField; source: Columns; survivor: Columns }[],
): Partial<Record<MergeField, Side>> {
	const out: Partial<Record<MergeField, Side>> = {};
	for (const f of fields)
		out[f.field] =
			fieldText(f.field, f.survivor) === null && fieldText(f.field, f.source) !== null ? "source" : "survivor";
	return out;
}
export function sourceChoices(choices: Partial<Record<MergeField, Side>>): Partial<Record<MergeField, "source">> {
	const out: Partial<Record<MergeField, "source">> = {};
	for (const f of MERGE_FIELDS) if (choices[f] === "source") out[f] = "source";
	return out;
}

export function defaultSurvivor(
	a: { id: string; createdAt: string; linked: boolean },
	b: { id: string; createdAt: string; linked: boolean },
): string {
	if (a.linked !== b.linked) return a.linked ? a.id : b.id;
	return a.createdAt <= b.createdAt ? a.id : b.id;
}

export function pairHref(personId: string, withId: string, keep?: string): string {
	const q = new URLSearchParams({ person: personId, with: withId });
	if (keep) q.set("keep", keep);
	return `/people/duplicates?${q.toString()}`;
}
export const DISMISSED_HREF = "/people/duplicates?view=dismissed";

export type PairAction = "dismiss" | "restore";
export const pairKey = (p: { person: { id: string }; with: { id: string } }) => `${p.person.id}:${p.with.id}`;
export type PairState = { gone: readonly string[]; notices: Readonly<Record<string, string>> };
export const pairsAtStart: PairState = { gone: [], notices: {} };

export function pairSent(s: PairState, key: string): PairState {
	const notices = { ...s.notices };
	delete notices[key];
	return { gone: s.gone.includes(key) ? s.gone : [...s.gone, key], notices };
}
export function pairAnswered(s: PairState, key: string, action: PairAction, answer: Outcome<unknown>): PairState {
	if (answer.status === "ok") return s;
	return { gone: s.gone.filter((k) => k !== key), notices: { ...s.notices, [key]: pairNotice(action, answer) } };
}
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

export type ListedPair = { personId: string; withPersonId: string };
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
export const notDuplicateText = (person: string, other: string) => `${person} and ${other} marked not a duplicate.`;

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
const clean = (s: string | null) => (s && s.trim() ? s.trim() : null);
const cleanPart = <T extends { notes: string | null }>(v: T): T => ({ ...v, notes: clean(v.notes) });

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
export const totalOf = (v: Record<Lens, ScoreValue>) => LENSES.reduce((sum, l) => sum + v[l].score, 0);

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
