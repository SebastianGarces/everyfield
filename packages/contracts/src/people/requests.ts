import { z } from "zod";
import { personId, recordId, revision, requestKey } from "../common/values.ts";
import { localDate, instant } from "../common/time.ts";
import { commandEnvelope } from "../common/transaction.ts";
import { contactFields, displayName, recruitmentSource, stage, adultClassification, noteBody, reason, pageInput } from "./values.ts";

// No owner, account link, creator, storage key, authority or approval in bodies.
export const createPersonRequest = z.strictObject({ requestKey, input: z.strictObject({
  ...contactFields, stage: stage.default("prospect"), source: recruitmentSource.default("other"),
  sourceDetails: z.string().trim().max(5000).nullable().optional(),
  summaryNotes: z.string().trim().max(5000).nullable().optional(),
  adultClassification: adultClassification.default("unknown"), birthDate: localDate.nullable().optional(),
}) });
export const updatePersonRequest = commandEnvelope(z.strictObject({ personId, patch: z.strictObject({
  displayName: displayName.optional(), firstName: contactFields.firstName, lastName: contactFields.lastName,
  email: contactFields.email, phone: contactFields.phone, street: contactFields.street,
  city: contactFields.city, stateProvince: contactFields.stateProvince,
  postalCode: contactFields.postalCode, country: contactFields.country,
  source: recruitmentSource.optional(), sourceDetails: z.string().trim().max(5000).nullable().optional(),
  summaryNotes: z.string().trim().max(5000).nullable().optional(), birthDate: localDate.nullable().optional(),
}) }));
// Same transaction caller owns Launch attendance. No name/email matching branch.
export const guestSelection = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("existing"), personId }),
  z.strictObject({ kind: z.literal("new"), displayName,
    email: contactFields.email, phone: contactFields.phone }),
]);
export const personRequest = z.strictObject({ personId });
export const ownAccountPersonRequest = z.strictObject({});
export const listPeopleRequest = z.strictObject({
  ...pageInput, search: z.string().trim().max(255).optional(),
  view: z.enum(["list", "card", "pipeline"]).default("list"),
  stages: z.array(stage).max(7).default([]), sources: z.array(recruitmentSource).max(8).default([]),
  tags: z.array(recordId).max(100).default([]), tagOperator: z.literal("all").default("all"),
  adultClassification: adultClassification.optional(),
  commitment: z.enum(["active", "withdrawn", "unknown", "any"]).default("any"),
  archived: z.enum(["exclude", "include", "only"]).default("exclude"),
  sort: z.literal("created_at_id").default("created_at_id"),
});
export const activityRequest = z.strictObject({ personId, ...pageInput,
  kinds: z.array(z.enum(["note", "activity", "follow_up"])).max(3).optional() });
export const addNoteRequest = commandEnvelope(z.strictObject({ personId, body: noteBody,
  meetingId: recordId.optional() }));
export const editNoteRequest = commandEnvelope(z.strictObject({ personId, noteId: recordId, body: noteBody, reason }));
export const deleteNoteRequest = commandEnvelope(z.strictObject({ personId, noteId: recordId, reason }));
export const handoffChoice = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("assign"), dutyId: recordId, expectedRevision: revision, toPersonId: personId }),
  z.strictObject({ kind: z.literal("needs_owner"), dutyId: recordId, expectedRevision: revision }),
]);
export const changeStatusRequest = commandEnvelope(z.strictObject({ personId, stage, reason,
  handoffs: z.array(handoffChoice).max(100) }));
export const retirePersonRequest = commandEnvelope(z.strictObject({ personId, reason,
  reviewRevision: revision, handoffs: z.array(handoffChoice).max(100) }));
export const restorePersonRequest = commandEnvelope(z.strictObject({ personId }));
export const classifyAdultRequest = commandEnvelope(z.strictObject({ personId,
  classification: adultClassification, occurredOn: localDate, reason }));
export const reorderPipelineRequest = commandEnvelope(z.strictObject({
  column: z.enum(["prospect", "attendee", "following_up", "interviewed", "core_group"]),
  personIds: z.array(personId).max(100).refine(v => new Set(v).size === v.length),
}));
export const pipelineMetricsRequest = z.strictObject({ asOf: instant, from: localDate, through: localDate })
  .refine(v => v.from <= v.through);

// Organization identity never carries plant recruitment or commitment fields.
export const createOrganizationPersonRequest = z.strictObject({ requestKey, input: z.strictObject(contactFields) });
export const updateOrganizationPersonRequest = commandEnvelope(z.strictObject({ personId,
  patch: z.strictObject(contactFields).partial() }));
export const removeOrganizationPersonRequest = commandEnvelope(z.strictObject({ personId, reason }));
export const exportOrganizationPersonRequest = z.strictObject({ personId, format: z.literal("csv") });
