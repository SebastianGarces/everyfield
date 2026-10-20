import { z } from "zod";
import { personId, recordId } from "../common/values.ts";

// Session and selected context come from the server adapter, never these bodies.
export const currentActorRequest = z.strictObject({});
export const organizationPersonRequest = z.strictObject({ personId });

export type OrganizationPersonRequest = z.infer<typeof organizationPersonRequest>;
export const organizationNotesRequest = organizationPersonRequest.extend({
	after: recordId.optional(),
});
