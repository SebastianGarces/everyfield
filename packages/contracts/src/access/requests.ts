import { z } from "zod";
import { personId } from "../common/values.ts";

export const organizationPersonRequest = z.strictObject({ personId });
