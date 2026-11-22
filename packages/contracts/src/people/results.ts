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
	longText,
	pipelineColumn,
} from "./values.ts";
import { householdMembership } from "./fields/index.ts";
import { avatarRoute } from "../settings/results.ts";

const identityFields = { id: personId, revision, createdAt: instant, ...contactFields, lifecycle: personLifecycle };
export const plantPerson = z
	.strictObject({
		...identityFields,
		owner: plantOwner,
		stage,
		source: recruitmentSource,
		sourceDetails: z.string().max(5000).nullable(),
		summaryNotes: z.string().max(5000).nullable(),
		adultClassification,
		adultClassificationSource,
		birthDate: localDate.nullable(),
		commitment: currentCommitment,
	})
	.refine((v) => v.lifecycle.state !== "merged" || v.lifecycle.survivorId !== v.id);
export const organizationPerson = z
	.strictObject({ ...identityFields, owner: organizationOwner })
	.refine((v) => v.lifecycle.state !== "merged" || v.lifecycle.survivorId !== v.id);
export const personProjection = z.union([plantPerson, organizationPerson]);
export const personResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unavailable") }),
	z.strictObject({ status: z.literal("available"), person: personProjection }),
]);
export const listPhoto = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("person"), personId, versionId: recordId }),
	z.strictObject({ kind: z.literal("account"), accountId, versionId: recordId }),
]);
export function listPhotoRoute(photo: z.infer<typeof listPhoto>): string {
	return photo.kind === "person"
		? `/people/${photo.personId}/photo/${photo.versionId}`
		: avatarRoute({ accountId: photo.accountId, versionId: photo.versionId });
}
export const personPhoto = z.strictObject({ personId, photo: listPhoto });
export type PersonPhoto = z.infer<typeof personPhoto>;
export const personPhotos = z.strictObject({ photos: z.array(personPhoto).max(100) });
export const peoplePage = z
	.strictObject({
		owner: plantOwner,
		items: z.array(plantPerson).max(100),
		photos: z.array(personPhoto).max(100),
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
	allowedStages: z
		.array(stage)
		.length(7)
		.refine((v) => new Set(v).size === 7),
	hardGate: z.literal(false),
	reviewRevision: revision,
	openDuties: z.array(z.strictObject({ id: recordId, revision })).max(100),
});
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
	personRevision: revision,
	outcome: z.enum(["changed", "noop"]),
});
export const plantPersonMutationResult = personMutationResult.extend({ person: plantPerson });
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
	z.strictObject({
		...activityBase,
		kind: z.literal("note"),
		revision,
		body: longText,
		editedAt: instant.nullable(),
		authorName: z.string().min(1).nullable(),
	}),
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
			"duplicate_dismissed",
			"duplicate_restored",
		]),
		recordId: recordId.optional(),
		stage: z.strictObject({ from: stage, to: stage }).optional(),
		household: z.strictObject({ from: householdMembership.nullable(), to: householdMembership.nullable() }).optional(),
		withPerson: z.strictObject({ id: personId, displayName: z.string() }).optional(),
	}),
	z.strictObject({
		...activityBase,
		kind: z.literal("follow_up"),
		outcome: z.enum(["contacted", "attempted_no_contact", "administrative_completion", "no_longer_needed"]),
		obligationId: recordId.nullable(),
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
	defineSafeError("pair_unavailable", {}, "refresh"),
	...csvError,
	...mergeErrors,
]);
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
const pairPerson = z.strictObject({ id: personId, displayName: z.string() });
export const organizationDuplicatePairs = z.strictObject({
	items: z
		.array(
			z.strictObject({
				person: pairPerson,
				with: pairPerson,
				shared: z
					.array(z.enum(["email", "phone"]))
					.min(1)
					.max(2),
			}),
		)
		.max(100),
	completeness: z.enum(["complete", "partial"]),
});
export const dismissedDuplicatePairs = z.strictObject({
	zone: z.string(),
	items: z
		.array(
			z.strictObject({
				person: pairPerson,
				with: pairPerson,
				dismissedBy: z.string().nullable(),
				dismissedAt: instant,
			}),
		)
		.max(100),
	completeness: z.enum(["complete", "partial"]),
});
export const duplicatePairChange = z.strictObject({ outcome: z.enum(["changed", "noop"]) });
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
