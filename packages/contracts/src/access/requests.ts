import { z } from "zod";
import { personId, recordId, revision } from "../common/values.ts";
import { subject } from "../common/audit.ts";
import { operationName } from "../common/transaction.ts";

// Session and selected context come from the server adapter, never these bodies.
export const currentActorRequest = z.strictObject({});
export const organizationPersonRequest = z.strictObject({ personId });

// Internal application query only, never an Evry tool or a mutation grant.
// Native private-care operations have their own author-bound native boundary;
// they are deliberately absent from the C0 shared operation vocabulary.
export const sharedOperationCheckRequest = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("read"),
		operation: operationName,
		subject,
		purpose: z.enum(["native", "model", "export", "organization_aggregate"]),
	}),
	z.strictObject({ kind: z.literal("write"), operation: operationName, subject, expectedRevision: revision }),
]);

// Both adapters use the same domain request. Human approval of exact Evry
// effects is server-owned and checked separately, never asserted in this input.
export type SharedOperationCheckRequest = z.infer<typeof sharedOperationCheckRequest>;
export type OrganizationPersonRequest = z.infer<typeof organizationPersonRequest>;
export const organizationNotesRequest = organizationPersonRequest.extend({
	after: recordId.optional(),
});
