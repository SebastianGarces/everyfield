import { z } from "zod";
import { personId } from "../common/values.ts";

// Session and selected context come from the server adapter, never these bodies.
export const organizationPersonRequest = z.strictObject({ personId });

export type OrganizationPersonRequest = z.infer<typeof organizationPersonRequest>;
