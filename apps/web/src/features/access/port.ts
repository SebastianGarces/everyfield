import type { OrganizationNotesResult, PipelineAccessResult } from "@everyfield/contracts/access";

export type PipelineDuty = Extract<PipelineAccessResult, { status: "allowed" }>["duties"][number];
export type AllowedNotes = Extract<OrganizationNotesResult, { status: "allowed" }>;

export type ReadNotes = (after: AllowedNotes["next"]) => Promise<OrganizationNotesResult>;

declare const staffNotes: unique symbol;
export type StaffNotesAccess = PipelineAccessResult & { readonly [staffNotes]: true };

export function canReadStaffNotes(access: PipelineAccessResult): access is StaffNotesAccess {
	return access.status === "allowed" && access.duties.some((duty) => duty.canReadStaffNotes);
}

export const DUTY_LABEL: Record<PipelineDuty["kind"], string> = {
	organization_administration: "Administrator",
	responsible_staff: "Responsible staff",
	program_director: "Program director",
};
