import { z } from "zod";
import { localDate } from "../common/time.ts";
import { personId, recordId, requestKey, revision } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import {
	adultClassification,
	contactFields,
	displayName,
	longText,
	pageInput,
	pipelineColumn,
	recruitmentSource,
	stage,
} from "./values.ts";

export const createPersonRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		...contactFields,
		stage: stage.default("prospect"),
		source: recruitmentSource.default("other"),
		sourceDetails: z.string().trim().max(5000).nullable().optional(),
		summaryNotes: z.string().trim().max(5000).nullable().optional(),
		adultClassification: adultClassification.default("unknown"),
		birthDate: localDate.nullable().optional(),
	}),
});
export const updatePersonRequest = commandEnvelope(
	z.strictObject({
		personId,
		patch: z.strictObject({
			displayName: displayName.optional(),
			firstName: contactFields.firstName,
			lastName: contactFields.lastName,
			email: contactFields.email,
			phone: contactFields.phone,
			street: contactFields.street,
			city: contactFields.city,
			stateProvince: contactFields.stateProvince,
			postalCode: contactFields.postalCode,
			country: contactFields.country,
			source: recruitmentSource.optional(),
			sourceDetails: z.string().trim().max(5000).nullable().optional(),
			summaryNotes: z.string().trim().max(5000).nullable().optional(),
			birthDate: localDate.nullable().optional(),
		}),
	}),
);
export const personRequest = z.strictObject({ personId });
export const personPhotosRequest = z.strictObject({ personIds: z.array(personId).max(100) });
export const ownAccountPersonRequest = z.strictObject({});
export const listPeopleRequest = z.strictObject({
	...pageInput,
	search: z.string().trim().max(255).optional(),
	view: z.enum(["list", "card", "pipeline"]).default("list"),
	stages: z.array(stage).max(7).default([]),
	sources: z.array(recruitmentSource).max(8).default([]),
	tags: z.array(recordId).max(100).default([]),
	tagOperator: z.literal("all").default("all"),
	adultClassification: adultClassification.optional(),
	commitment: z.enum(["active", "withdrawn", "unknown", "any"]).default("any"),
	archived: z.enum(["exclude", "include", "only"]).default("exclude"),
	sort: z.literal("created_at_id").default("created_at_id"),
	column: pipelineColumn.optional(),
});
export const activityRequest = z.strictObject({
	personId,
	...pageInput,
	kinds: z
		.array(z.enum(["note", "activity", "follow_up"]))
		.max(3)
		.optional(),
});
export const addNoteRequest = commandEnvelope(
	z.strictObject({ personId, body: longText, meetingId: recordId.optional() }),
);
export const editNoteRequest = commandEnvelope(
	z.strictObject({ personId, noteId: recordId, body: longText, reason: longText }),
);
export const deleteNoteRequest = commandEnvelope(z.strictObject({ personId, noteId: recordId, reason: longText }));
export const handoffChoice = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("assign"), dutyId: recordId, expectedRevision: revision, toPersonId: personId }),
	z.strictObject({ kind: z.literal("needs_owner"), dutyId: recordId, expectedRevision: revision }),
]);
export const changeStatusRequest = commandEnvelope(
	z.strictObject({ personId, stage, reason: longText, handoffs: z.array(handoffChoice).max(100) }),
);
export const retirePersonRequest = commandEnvelope(
	z.strictObject({ personId, reason: longText, reviewRevision: revision, handoffs: z.array(handoffChoice).max(100) }),
);
export const restorePersonRequest = commandEnvelope(z.strictObject({ personId }));
export const classifyAdultRequest = commandEnvelope(
	z.strictObject({ personId, classification: adultClassification, occurredOn: localDate, reason: longText }),
);
export const reorderPipelineRequest = commandEnvelope(
	z
		.strictObject({
			column: pipelineColumn,
			personId,
			afterId: personId.nullable(),
		})
		.refine((v) => v.afterId !== v.personId),
);

export const createOrganizationPersonRequest = z.strictObject({ requestKey, input: z.strictObject(contactFields) });
export const duplicatePairRequest = z.strictObject({ personId, withPersonId: personId });
export const duplicateCheckRequest = z.strictObject({
	displayName: z.string().max(255).optional(),
	email: z.string().max(320).optional(),
	phone: z.string().max(255).optional(),
	excludePersonId: personId.optional(),
});
