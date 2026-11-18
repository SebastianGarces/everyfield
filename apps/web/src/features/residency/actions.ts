"use server";

import { residentCall } from "./server";
import { residentWriter } from "@everyfield/domain/organizations";

export async function markMilestone(input: unknown) {
	return residentCall((db, authority) => residentWriter.markMilestone(db, authority, input));
}
