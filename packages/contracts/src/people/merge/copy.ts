import type { z } from "zod";
import type { inverseConflict, mergeBlocker, referenceKind } from "./errors.ts";
import type { mergeField } from "./index.ts";

// The words a merge or Unmerge refusal uses, shared by the People screens and Evry so both say the same thing.

/** The reference kinds a merge review counts (the registry in packages/domain/src/people/person-reference-registry). */
export type ReferenceKind = z.infer<typeof referenceKind>;

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

// Refusals in words. Each names a cause the person can act on.

export type Blocker = z.infer<typeof mergeBlocker>;
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

export type InverseConflict = z.infer<typeof inverseConflict>;
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

/** The whole blocked answer, as the People merge review gives it: the heading, then each cause. */
export function mergeBlockedText(
	blockers: { causes: readonly Blocker[]; references: ReferenceKind[] },
	names: { source: string; survivor: string },
) {
	return ["This merge cannot run.", ...blockers.causes.map((c) => blockerText(c, names, blockers.references))].join(
		" ",
	);
}
/** Why Unmerge cannot run now, as the People Unmerge dialog says it. */
export function unmergeBlockedText(conflicts: readonly InverseConflict[], names: { source: string; survivor: string }) {
	return [
		"Cannot unmerge.",
		...conflicts.map((c) => conflictText(c, names)),
		`An Unmerge would lose those changes, so Everyfield will not run it. Correct ${names.survivor.split(" ")[0]}’s details by hand instead; each change is kept in the history.`,
	].join(" ");
}

/** A merge review's person fields, as the People merge review names them. */
export const MERGE_FIELD_LABEL: Record<z.infer<typeof mergeField>, string> = {
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
