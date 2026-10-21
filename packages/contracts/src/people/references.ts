import { z } from "zod";
import { personId, revision } from "../common/values.ts";
import { tenantOwner } from "./values.ts";

export const lockedPersonReference = z.strictObject({
	owner: tenantOwner,
	personId,
	revision,
	state: z.literal("live"),
});
// Merge, its review and its inverse live in ./merge/ (WP-015).
