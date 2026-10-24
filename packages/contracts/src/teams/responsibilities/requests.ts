import { z } from "zod";
import { recordId } from "../../common/values.ts";
import { commandEnvelope } from "../../common/writes.ts";

const lineKey = z.string().trim().min(1).max(80);
const lineText = z.string().trim().min(1).max(2000);

export const listRequest = z.strictObject({
	teamId: recordId,
	page: z.int().min(1).max(1000).optional(),
});
export const previewRequest = z.strictObject({ teamId: recordId });
export const offerRequest = commandEnvelope(
	z.strictObject({
		teamId: recordId,
		decision: z.enum(["accept", "decline"]),
		selected: z.array(lineKey).max(20),
	}),
);
export const addRequest = commandEnvelope(z.strictObject({ teamId: recordId, text: lineText }));
export const editRequest = commandEnvelope(z.strictObject({ responsibilityId: recordId, text: lineText }));
export const completeRequest = commandEnvelope(z.strictObject({ responsibilityId: recordId, done: z.boolean() }));
export const deleteRequest = commandEnvelope(z.strictObject({ responsibilityId: recordId }));
