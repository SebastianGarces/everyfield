import { z } from "zod";

const uuid = z.uuid();
export const id = z
	.string()
	.regex(/^[0-9a-f-]{36}$/i)
	.refine((v) => uuid.safeParse(v).success, "not an id");
const isoDate = z.iso.date();
export const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((v) => isoDate.safeParse(v).success, "not a date")
	.describe("YYYY-MM-DD in the church's time zone");
