import type { OrganizationNotesResult, PipelineAccessResult } from "@everyfield/contracts/access";

// The access screens read only contract results. They never decide authority: the server re-checks every
// operation, and a hidden control is not a refusal (REQ-IDN-005).

export type PipelineDuty = Extract<PipelineAccessResult, { status: "allowed" }>["duties"][number];
export type AllowedNotes = Extract<OrganizationNotesResult, { status: "allowed" }>;

/** Reads one page of protected staff notes (orgPeople.readNotes). `after` is the contract's `next` cursor. */
export type ReadNotes = (after: AllowedNotes["next"]) => Promise<OrganizationNotesResult>;

/**
 * Only the administration and responsible-staff duties read staff notes (REQ-MUL-002). A program director alone
 * gets no notes panel and no hint that notes exist (WP-006/ui R5).
 */
export function canReadStaffNotes(access: PipelineAccessResult): boolean {
	return access.status === "allowed" && access.duties.some((duty) => duty.canReadStaffNotes);
}

export const DUTY_LABEL: Record<PipelineDuty["kind"], string> = {
	organization_administration: "Administrator",
	responsible_staff: "Responsible staff",
	program_director: "Program director",
};
