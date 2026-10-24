import { z } from "zod";
import { meetingTemplateTypes, templateCategories } from "./catalog.ts";

export const communicationStates = ["draft", "reviewed", "scheduled"] as const;
export const audienceGroups = ["core_group", "launch_team", "leaders", "prospects", "all"] as const;

/** A closed group token is a string. An unknown token matches nobody. */
export const audienceInput = z.strictObject({
	groups: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
	teamIds: z.array(z.uuid()).max(200).default([]),
	personIds: z.array(z.uuid()).max(500).default([]),
});
export type AudienceInput = z.infer<typeof audienceInput>;

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.nullable()
		.optional()
		.transform((value) => (value ? value : null));

export const templateName = z.string().trim().min(1).max(255);
export const templateDescription = z.string().trim().max(1000).nullable().optional();
export const templateSubject = z.string().trim().min(1).max(500);
export const templateBody = z.string().trim().min(1).max(100_000);
export const templateCategory = z.enum(templateCategories);
export const meetingTemplateType = z.enum(meetingTemplateTypes);

export const templateDraft = z.strictObject({
	name: templateName,
	description: templateDescription,
	category: templateCategory,
	meetingType: meetingTemplateType.nullable().optional(),
	subject: templateSubject,
	bodyHtml: templateBody,
});
export type TemplateDraft = z.infer<typeof templateDraft>;

export const templatePatch = templateDraft;
export type TemplatePatch = z.infer<typeof templatePatch>;

/** An incomplete draft may omit subject and body. `scheduledAt` is not part of a draft. */
export const draftInput = z.strictObject({
	communicationId: z.uuid().optional(),
	subject: optionalText(500),
	bodyHtml: z.string().max(100_000).nullable().optional(),
	audience: audienceInput.optional(),
	meetingId: z.uuid().nullable().optional(),
	templateId: z.uuid().nullable().optional(),
	templateSource: z.string().trim().min(1).max(80).nullable().optional(),
});
export type DraftInput = z.infer<typeof draftInput>;

export const mergeFields = z.record(z.string().regex(/^[a-z0-9_]+$/), z.string().max(500));
export type MergeFields = z.infer<typeof mergeFields>;
