import { z } from "zod";
import { personId, recordId, accountId, operationId, revision, defineSafeError, safeError } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";
import { csvError } from "./csv/index.ts";
import { mergeErrors } from "./merge/errors.ts";
import {
	contactFields,
	plantOwner,
	organizationOwner,
	personLifecycle,
	stage,
	recruitmentSource,
	adultClassification,
	adultClassificationSource,
	currentCommitment,
	noteBody,
	pipelineColumn,
} from "./values.ts";
import { householdMembership } from "./fields/index.ts";

const identityFields = { id: personId, revision, createdAt: instant, ...contactFields, lifecycle: personLifecycle };
export const plantPerson = z
	.strictObject({
		...identityFields,
		owner: plantOwner,
		stage,
		source: recruitmentSource,
		sourceDetails: z.string().max(5000).nullable(),
		summaryNotes: z.string().max(5000).nullable(),
		/** The effective value: derived from the birth date when there is one, else the recorded value. */
		adultClassification,
		adultClassificationSource,
		birthDate: localDate.nullable(),
		commitment: currentCommitment,
	})
	.refine((v) => v.lifecycle.state !== "merged" || v.lifecycle.survivorId !== v.id);
// General/model projection. Protected organization notes have their own native
// access contract and never appear here, even for a reader who can read them.
export const organizationPerson = z
	.strictObject({ ...identityFields, owner: organizationOwner })
	.refine((v) => v.lifecycle.state !== "merged" || v.lifecycle.survivorId !== v.id);
export const personProjection = z.union([plantPerson, organizationPerson]);
export const personResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unavailable") }),
	z.strictObject({ status: z.literal("available"), person: personProjection }),
]);
export const peoplePage = z
	.strictObject({
		owner: plantOwner,
		items: z.array(plantPerson).max(100),
		next: z.int().min(2).nullable(),
		completeness: z.enum(["complete", "partial"]),
		total: z.int().min(0).nullable(),
	})
	.refine((v) => v.items.every((p) => p.owner.id === v.owner.id));
const pipelineCard = z.strictObject({
	person: plantPerson,
	activeParentDuties: z
		.array(
			z.strictObject({
				id: recordId,
				dueOn: localDate.nullable(),
				warning: z.enum(["overdue", "missing_due_date", "none"]),
			}),
		)
		.max(100),
	coverage: z.enum(["covered", "uncovered"]),
	// No recorded activity for longer than the church's warning or alert days in Settings (REQ-PPL-007).
	inactivity: z.strictObject({ lastActivityAt: instant, level: z.enum(["none", "warning", "alert"]) }),
});
export const pipelineResult = z
	.strictObject({
		owner: plantOwner,
		groups: z
			.array(
				z.strictObject({
					column: pipelineColumn,
					revision,
					cards: z.array(pipelineCard).max(100),
					total: z.int().min(0).nullable(),
					next: z.int().min(2).nullable(),
				}),
			)
			.length(5),
		completeness: z.enum(["complete", "partial"]),
	})
	.refine(
		(v) =>
			new Set(v.groups.map((g) => g.column)).size === 5 &&
			v.groups.every((g) =>
				g.cards.every(
					(c) =>
						c.person.owner.id === v.owner.id &&
						(g.column === "core_group"
							? ["core_group", "launch_team", "leader"].includes(c.person.stage)
							: c.person.stage === g.column),
				),
			),
	);
export const statusWarningsResult = z.strictObject({
	personId,
	revision,
	warnings: z
		.array(z.enum(["assessment_not_recorded", "interview_not_recorded", "commitment_not_recorded", "open_duties"]))
		.max(4),
	// Soft recorded-evidence guidance, never invented qualification or private detail.
	allowedStages: z
		.array(stage)
		.length(7)
		.refine((v) => new Set(v).size === 7),
	hardGate: z.literal(false),
	reviewRevision: revision,
	openDuties: z.array(z.strictObject({ id: recordId, revision })).max(100),
});
// No account IDs on another Person's profile or directory result.
export const accountLinkResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unavailable") }),
	z.strictObject({ status: z.literal("linked"), personId }),
	z.strictObject({ status: z.literal("unlinked") }),
]);
export const personMutationResult = z.strictObject({
	person: personProjection,
	receiptId: operationId,
	outcome: z.enum(["changed", "noop"]),
	needsOwner: z.array(recordId).max(100),
});
export const noteMutationResult = z.strictObject({
	receiptId: operationId,
	noteId: recordId,
	revision,
	// The person's revision after the note change: a note moves the person revision on.
	personRevision: revision,
	outcome: z.enum(["changed", "noop"]),
});
export const plantPersonMutationResult = personMutationResult.extend({ person: plantPerson });
// A verified email may propose candidates but never selects a human identity.
// This output belongs only to the owning authenticated provisioning workflow.
export const accountPersonResolution = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("linked"), personId }),
	z.strictObject({ status: z.literal("needs_selection"), candidatePersonIds: z.array(personId).min(1).max(100) }),
]);
export const actorAttribution = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("current_account"), accountId }),
	z.strictObject({ kind: z.literal("former_account"), scopeLocalToken: z.string().min(1).max(200) }),
]);
const activityBase = { id: recordId, occurredAt: instant, recordedAt: instant, actor: actorAttribution };
export const activity = z.discriminatedUnion("kind", [
	z.strictObject({ ...activityBase, kind: z.literal("note"), revision, body: noteBody, editedAt: instant.nullable() }),
	z.strictObject({ ...activityBase, kind: z.literal("note_removed"), revision }),
	z.strictObject({ ...activityBase, kind: z.literal("stage_changed"), from: stage, to: stage }),
	z.strictObject({
		...activityBase,
		kind: z.literal("activity"),
		action: z.enum([
			"created",
			"updated",
			"retired",
			"restored",
			"classification_recorded",
			"classification_corrected",
			"assessment_recorded",
			"interview_recorded",
			"commitment_recorded",
			"commitment_withdrawn",
			"commitment_reactivated",
			"commitment_corrected",
			"assessment_corrected",
			"interview_corrected",
			"person_merged",
			"person_unmerged",
		]),
		// An assessment, interview or commitment event names its record; the stage advance it caused shows with it.
		recordId: recordId.optional(),
		stage: z.strictObject({ from: stage, to: stage }).optional(),
		// A household join, leave or role change: the membership before and after, with the household name recorded
		// then, so the history still names a household after it is deleted (REQ-PPL-009).
		household: z.strictObject({ from: householdMembership.nullable(), to: householdMembership.nullable() }).optional(),
	}),
	z.strictObject({
		...activityBase,
		kind: z.literal("follow_up"),
		outcome: z.enum(["contacted", "attempted_no_contact", "administrative_completion", "no_longer_needed"]),
		// Null for a manual follow-up or a contact recorded with no task: only generated duties have one (REQ-TSK-012).
		obligationId: recordId.nullable(),
		// How the contact happened and its note, when one was recorded (REQ-MTG-022).
		channel: z.enum(["email", "in_person", "other", "phone", "text", "video"]).nullable(),
		notes: z.string().nullable(),
	}),
]);
export const activitiesResult = z.strictObject({
	owner: plantOwner,
	personId,
	items: z.array(activity).max(100),
	next: z.int().min(2).nullable(),
	completeness: z.enum(["complete", "partial"]),
});
type SafeError = (typeof safeError.options)[number];
type GenericInvalidInput = Extract<SafeError, { shape: { code: z.ZodLiteral<"invalid_input"> } }>;
export const peopleError = z.discriminatedUnion("code", [
	// A record's input names its reason where a person can fix one field: a date after today in the church's time zone, or
	// a document file that is not a readable PDF, JPG or PNG, or an adult or child record for a person whose birth date decides it.
	defineSafeError(
		"invalid_input",
		{ reason: z.enum(["future_date", "unreadable_document", "birth_date_decides"]).optional() },
		"never",
	),
	...safeError.options.filter(
		(o): o is Exclude<SafeError, GenericInvalidInput> => o.shape.code.value !== "invalid_input",
	),
	defineSafeError("unsupported_field", {}, "never"),
	defineSafeError("use_reviewed_unmerge", {}, "refresh"),
	defineSafeError("source_unavailable", {}, "same_request"),
	...csvError,
	...mergeErrors,
]);
/**
 * people.listDuplicatePairs: the pairs a CSV import added with "Add, review later" whose two people are both still
 * live, oldest first. `person` is the imported person, `with` the person it may duplicate.
 */
export const duplicatePairs = z.strictObject({
	items: z
		.array(
			z.strictObject({
				person: z.strictObject({ id: personId, displayName: z.string() }),
				with: z.strictObject({ id: personId, displayName: z.string() }),
			}),
		)
		.max(100),
	completeness: z.enum(["complete", "partial"]),
});
/** Duplicate hints: an exact hint shares an email or phone, a potential hint only a name. Never proof of identity. */
export const duplicateHints = z.strictObject({
	items: z
		.array(
			z.strictObject({
				personId,
				displayName: z.string(),
				match: z.enum(["exact", "potential"]),
				signals: z
					.array(z.enum(["email", "phone", "name"]))
					.min(1)
					.max(3),
			}),
		)
		.max(25),
	completeness: z.enum(["complete", "partial"]),
});
