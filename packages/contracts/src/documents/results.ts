import { z } from "zod";
import { correlationId, tenantId } from "../common/values.ts";
import { documentCategory, documentFormat, templateId } from "./values.ts";

const issue = z.strictObject({ path: z.string().max(200), problem: z.string().max(200) });
const error = <C extends string, D extends z.ZodRawShape>(code: C, details: D, retry: "never") =>
	z.strictObject({ code: z.literal(code), details: z.strictObject(details), correlationId, retry: z.literal(retry) });

/** Refusals a document-template read can return. An unknown template is "unavailable". */
export const documentsError = z.discriminatedUnion("code", [
	error("invalid_input", { issues: z.array(issue).max(50) }, "never"),
	error("unavailable", {}, "never"),
	error("invalid_subject", {}, "never"),
	error("render_failed", {}, "never"),
]);
export type DocumentsError = z.infer<typeof documentsError>;
export type DocumentsReply<T> = { status: "ok"; value: T } | { status: "refused"; error: DocumentsError };

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const mergeField = z.strictObject({
	key: z.string().min(1).max(80),
	label: z.string().min(1).max(200),
	required: z.boolean(),
	autoFill: z.string().min(1).max(80).nullable(),
});
export const templateView = z.strictObject({
	id: templateId,
	name: z.string().min(1).max(200),
	description: z.string().min(1).max(2000),
	category: documentCategory,
	phase: z.int().min(0).max(6).nullable(),
	formats: z.array(documentFormat).min(1).max(3),
	pageCount: z.int().min(1).max(20),
	wikiSlug: z.string().min(1).max(200).nullable(),
	mergeFields: z.array(mergeField).max(20),
	outline: z.array(z.string().min(1).max(2000)).min(1).max(20),
});
export const templatePage = z.strictObject({
	version: sha256,
	templateCount: z.int().min(0),
	formatCount: z.int().min(0),
	templates: z.array(templateView).max(20),
});

const fieldSource = z.enum(["override", "church_name", "pastor_name", "launch_date", "absent"]);
const resolvedField = z.strictObject({
	key: z.string().min(1).max(80),
	label: z.string().min(1).max(200),
	required: z.boolean(),
	value: z.string().max(2000).nullable(),
	source: fieldSource,
});
const contextValue = {
	templateId,
	templateVersion: sha256,
	plantId: tenantId,
	format: documentFormat,
	fields: z.array(resolvedField).max(20),
	missing: z.array(z.string().min(1).max(80)).max(20),
	sources: z.array(z.string().min(1).max(200)).max(5),
	complete: z.boolean(),
};
export const contextResult = z.strictObject(contextValue);
export const previewResult = z.strictObject({
	...contextValue,
	artifact: z.string().min(1).nullable(),
	digest: sha256.nullable(),
	engineVersion: sha256.nullable(),
});
