import { z } from "zod";
import { personId, recordId } from "../common/values.ts";
import { MERGE_KEY_MAX, MERGE_VALUE_MAX, documentCategory, documentFormat, templateId } from "./values.ts";

const overrides = z.record(z.string().trim().min(1).max(80), z.string().max(MERGE_VALUE_MAX)).optional();

export const listTemplatesRequest = z.strictObject({
	category: documentCategory.optional(),
	phase: z.int().min(0).max(6).optional(),
	format: documentFormat.optional(),
});
export const getTemplateRequest = z.strictObject({ templateId });
export const contextualTemplatesRequest = z.strictObject({
	wikiSlug: z.string().trim().min(1).max(200).optional(),
	category: documentCategory.optional(),
	phase: z.int().min(0).max(6).optional(),
	meetingId: recordId.optional(),
	teamId: recordId.optional(),
});
const contextInput = {
	templateId,
	format: documentFormat,
	overrides,
	personId: personId.optional(),
	meetingId: recordId.optional(),
	teamId: recordId.optional(),
};
export const resolveContextRequest = z.strictObject(contextInput).superRefine((value, ctx) => {
	const subjects = [value.personId, value.meetingId, value.teamId].filter((item) => item !== undefined);
	const keys = Object.keys(value.overrides ?? {});
	if (subjects.length > 1) ctx.addIssue({ code: "custom", path: ["personId"], message: "Name one subject." });
	if (keys.length > MERGE_KEY_MAX)
		ctx.addIssue({ code: "custom", path: ["overrides"], message: "Too many merge fields." });
});
export const previewRequest = resolveContextRequest;
