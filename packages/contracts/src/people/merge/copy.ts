import type { z } from "zod";
import type { inverseConflict, leadershipConflict, mergeBlocker, referenceKind } from "./errors.ts";
import type { attendanceChange, mergeField } from "./index.ts";

export type ReferenceKind = z.infer<typeof referenceKind>;

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
	launch_guest: ["Launch Sunday guest link", "Launch Sunday guest links"],
	task: ["task", "tasks"],
	team_leader: ["team they lead", "teams they lead"],
	team_tenure: ["ministry role", "ministry roles"],
	training_assignment: ["training assignment", "training assignments"],
	training_credit: ["training credit", "training credits"],
	answer_review: ["answer send for review", "answer sends for review"],
};
export const counted = (kind: ReferenceKind, count: number) => `${count} ${KIND_LABEL[kind][count === 1 ? 0 : 1]}`;
export const kindTitle = (kind: ReferenceKind) => KIND_LABEL[kind][1].replace(/^./, (c) => c.toUpperCase());
const kindList = (kinds: readonly ReferenceKind[]) => listText(kinds.map((k) => KIND_LABEL[k][1]));
export function listText(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export type Blocker = z.infer<typeof mergeBlocker>;
export type BlockerDetails = {
	leadership: readonly z.infer<typeof leadershipConflict>[];
	invitations: readonly { recipientEmail: string }[];
};
export function blockerText(cause: Blocker, names: { source: string; survivor: string }, details: BlockerDetails) {
	switch (cause) {
		case "linked_account_collision":
			return `${names.source} and ${names.survivor} both have an Everyfield account. Two accounts cannot become one person.`;
		case "linked_source":
			return names.source === names.survivor
				? "The record with an Everyfield account must be the one you keep."
				: `${names.source} has an Everyfield account, so ${names.source} must be the person you keep.`;
		case "enrollment_collision":
			return `${names.source} and ${names.survivor} are both enrolled in the same program. One person can’t hold two enrollments in one program.`;
		case "leadership_conflict":
			return [
				...details.leadership.map(
					(l) => `${names.source} is ${l.sourceRole} and ${names.survivor} is ${l.survivorRole} on ${l.team}.`,
				),
				"One person can’t hold two current roles on one team, so end one of those roles first.",
			].join(" ");
		case "residency_invitation_collision":
			return `${names.source} has a pending residency invitation to ${listText(details.invitations.map((i) => i.recipientEmail))}, and ${names.survivor} already has a residency link or a pending residency invitation. Revoke the invitation first.`;
	}
}

const PRESENCE_LABEL = { attended: "Attended", excused: "Excused", absent: "Absent" } as const;
const ANSWER_LABEL = { confirmed: "Going", declined: "Not going" } as const;
export type AttendanceChange = z.infer<typeof attendanceChange>;
export function attendanceText(
	a: AttendanceChange,
	people: { source: { personId: string; displayName: string }; survivor: { personId: string; displayName: string } },
) {
	const name = (id: string) => (id === people.source.personId ? people.source : people.survivor).displayName;
	const other = (id: string) => (id === people.source.personId ? people.survivor : people.source).displayName;
	switch (a.change) {
		case "combined":
			return `${a.meeting}: both are on this meeting, so ${people.survivor.displayName} keeps one attendance (${PRESENCE_LABEL[a.presence]}).`;
		case "rsvp_replaced":
			return `${a.meeting}: ${other(a.pendingPersonId)}’s RSVP (${ANSWER_LABEL[a.answer]}) replaces ${name(a.pendingPersonId)}’s pending RSVP.`;
		case "inviter_cleared":
			return `${a.meeting}: ${name(a.inviterPersonId)} invited ${other(a.inviterPersonId)}, so the attendance stays with no inviter.`;
	}
}

export type InverseConflict = z.infer<typeof inverseConflict>;
export function conflictText(
	cause: InverseConflict,
	names: { source: string; survivor: string },
	changed: readonly ReferenceKind[] = [],
) {
	switch (cause) {
		case "survivor_changed":
			return `${names.survivor}'s details changed after the merge.`;
		case "source_changed":
			return `${names.source}'s record changed after the merge.`;
		case "references_changed":
			return changed.length
				? `${names.survivor}’s ${kindList(changed)} changed after the merge.`
				: `${names.survivor} has records that are new, moved or corrected since the merge, or was merged again.`;
		case "mail_sent":
			return `The merge moved email sent to ${names.source} into ${names.survivor}'s communication history, and sent email is never unsent.`;
	}
}
export function unmergeAdvice(conflicts: readonly InverseConflict[], names: { survivor: string }) {
	const fix = `Correct ${names.survivor.split(" ")[0]}’s details by hand instead; each change is kept in the history.`;
	return conflicts.every((c) => c === "mail_sent")
		? `An Unmerge cannot take back sent email, so Everyfield will not run it. ${fix}`
		: `An Unmerge would lose those changes, so Everyfield will not run it. ${fix}`;
}

export function mergeBlockedText(
	blockers: BlockerDetails & { causes: readonly Blocker[] },
	names: { source: string; survivor: string },
) {
	return ["This merge cannot run.", ...blockers.causes.map((c) => blockerText(c, names, blockers))].join(" ");
}
export function unmergeBlockedText(
	conflicts: readonly InverseConflict[],
	names: { source: string; survivor: string },
	changed: readonly ReferenceKind[] = [],
) {
	return [
		"Cannot unmerge.",
		...conflicts.map((c) => conflictText(c, names, changed)),
		unmergeAdvice(conflicts, names),
	].join(" ");
}

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
