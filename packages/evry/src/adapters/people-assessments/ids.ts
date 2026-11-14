import { z } from "zod";

const uuid = z.uuid();
/**
 * A record id the model passes back from an earlier result. Each tool schema reaches the model on every call, and
 * z.uuid()'s pattern is about 170 characters per id, so these inputs use this short one; the refinement, which the
 * model never sees, still accepts only a UUID before any statement runs.
 */
export const id = z
	.string()
	.regex(/^[0-9a-f-]{36}$/i)
	.refine((v) => uuid.safeParse(v).success, "not an id");
const isoDate = z.iso.date();
/** A church-local calendar date, YYYY-MM-DD, with the same short pattern for the same reason. */
export const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((v) => isoDate.safeParse(v).success, "not a date")
	.describe("YYYY-MM-DD in the church's time zone");
