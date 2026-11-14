"use server";

import { residentCall } from "@/server/organizations/residency";
import { residentWriter } from "@everyfield/domain/organizations";

// The My residency page's only write: the resident marks one of their own milestones done. The account comes from the
// session; the domain checks the live residency link and the enrollment again.

export async function markMilestone(input: unknown) {
	return residentCall((db, authority) => residentWriter.markMilestone(db, authority, input));
}
