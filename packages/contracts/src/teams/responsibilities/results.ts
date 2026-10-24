import { z } from "zod";
import { operationId, recordId, revision } from "../../common/values.ts";
import { RESPONSIBILITY_PAGE } from "./catalog.ts";

const outcome = z.enum(["changed", "noop"]);
const receipt = { receiptId: operationId, outcome };
const offerState = z.enum(["accepted", "declined"]).nullable();
const lineText = z.string().min(1).max(2000);

export const responsibilityItem = z.strictObject({
	id: recordId,
	revision,
	sourceLine: z.string().min(1).max(120),
	text: lineText,
	sortOrder: z.int().min(1),
	completedOn: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.nullable(),
});
export const responsibilityPage = z.strictObject({
	teamId: recordId,
	offer: offerState,
	page: z.int().min(1),
	items: z.array(responsibilityItem).max(RESPONSIBILITY_PAGE),
});
export const previewLine = z.strictObject({
	key: z.string().min(1).max(80),
	text: lineText,
	sortOrder: z.int().min(1),
});
export const previewPage = z.strictObject({
	teamId: recordId,
	offer: offerState,
	lines: z.array(previewLine).max(20),
});
export const offerResult = z.strictObject({
	...receipt,
	teamId: recordId,
	decision: z.enum(["accept", "decline"]),
	revision,
	createdIds: z.array(recordId).max(20),
});
export const addResult = z.strictObject({
	...receipt,
	id: recordId,
	teamId: recordId,
	revision,
	sourceLine: z.string().min(1).max(120),
	text: lineText,
});
export const editResult = z.strictObject({ ...receipt, id: recordId, revision, text: lineText });
export const completeResult = z.strictObject({
	...receipt,
	id: recordId,
	revision,
	completedOn: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.nullable(),
});
export const deleteResult = z.strictObject({ ...receipt, id: recordId, revision });
