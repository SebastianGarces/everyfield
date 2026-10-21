import { z } from "zod";
import { personId, recordId, accountId, operationId, revision, defineSafeError, safeError } from "../common/values.ts";
import { instant, localDate, timeZone } from "../common/time.ts";
import {
	contactFields,
	plantOwner,
	organizationOwner,
	tenantOwner,
	personLifecycle,
	stage,
	recruitmentSource,
	adultClassification,
	currentCommitment,
	firstAcquisition,
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
		adultClassification,
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
	warnings: z.array(z.enum(["interview_not_recorded", "commitment_not_recorded", "open_duties"])).max(3),
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
	outcome: z.enum(["changed", "noop"]),
});
export const plantPersonMutationResult = personMutationResult.extend({ person: plantPerson });
export const organizationPersonMutationResult = personMutationResult.extend({ person: organizationPerson });
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
export const retainedPersonHistory = z.strictObject({
	owner: tenantOwner,
	personId,
	receiptId: operationId,
	attribution: actorAttribution,
});
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
		]),
		// A household join, leave or role change: the membership before and after, with the household name recorded
		// then, so the history still names a household after it is deleted (REQ-PPL-009).
		household: z.strictObject({ from: householdMembership.nullable(), to: householdMembership.nullable() }).optional(),
	}),
	z.strictObject({
		...activityBase,
		kind: z.literal("follow_up"),
		outcome: z.enum(["contacted", "attempted_no_contact", "administrative_completion", "no_longer_needed"]),
		obligationId: recordId,
	}),
]);
export const activitiesResult = z.strictObject({
	owner: plantOwner,
	personId,
	items: z.array(activity).max(100),
	next: z.int().min(2).nullable(),
	completeness: z.enum(["complete", "partial"]),
});
// Eligibility snapshot for the People-owned projection. Consumers freeze both
// asOf and sourceRevision and resolve canonical lineage before counting.
export const commitmentObservation = z.strictObject({
	owner: plantOwner,
	personId,
	asOf: instant,
	zone: timeZone,
	sourceRevision: revision,
	lifecycle: personLifecycle,
	classification: adultClassification,
	current: currentCommitment,
	firstAcquisition,
});

export const classificationMutationResult = z.strictObject({
	receiptId: operationId,
	outcome: z.enum(["changed", "noop"]),
	observation: commitmentObservation,
});
const count = z.int().min(0);
const transition = z
	.strictObject({ from: stage, to: stage, distinctPeople: count })
	.refine((v) => stage.options.indexOf(v.to) === stage.options.indexOf(v.from) + 1);
export const conversion = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unknown"), reason: z.enum(["cohort_unavailable", "empty_cohort"]) }),
	z
		.strictObject({ status: z.literal("known"), cohortPeople: z.int().positive(), cohortTransitionPeople: count })
		.refine((v) => v.cohortTransitionPeople <= v.cohortPeople),
]);
export const pipelineMetricsResult = z
	.strictObject({
		owner: plantOwner,
		asOf: instant,
		zone: timeZone,
		sourceRevision: revision,
		from: localDate,
		through: localDate,
		unit: z.literal("distinct_canonical_people"),
		currentStages: z
			.array(z.strictObject({ stage, distinctPeople: count }))
			.length(7)
			.refine((v) => new Set(v.map((r) => r.stage)).size === 7),
		transitions: z
			.array(transition.safeExtend({ conversion }))
			.max(6)
			.refine((v) => new Set(v.map((r) => r.from)).size === v.length),
	})
	.refine((v) => v.from <= v.through);
export const peopleError = z.discriminatedUnion("code", [
	...safeError.options,
	defineSafeError("unsupported_field", {}, "never"),
	defineSafeError("use_reviewed_unmerge", {}, "refresh"),
	defineSafeError("source_unavailable", {}, "same_request"),
]);
