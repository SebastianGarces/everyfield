import { z } from "zod";
import { localDate } from "../common/time.ts";
import { personId, recordId, requestKey } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import { roleKey, teamIcon, teamName, teamState, teamText, templateKey } from "./values.ts";

const description = teamText.nullable().optional();
const icon = teamIcon.nullable().optional();
const teamTarget = z.strictObject({ teamId: recordId });
const roleTarget = z.strictObject({ roleId: recordId });
const teamFacts = z.strictObject({
	name: teamName.optional(),
	description,
	icon,
	state: teamState.optional(),
});

export const createTeamRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		name: teamName,
		description,
		icon,
		state: teamState.optional(),
	}),
});
/** The reason for a change is optional. A blank or whitespace-only reason means a plain edit entry in the history. */
const editReason = z
	.string()
	.max(500)
	.transform((text) => text.trim() || undefined)
	.optional();
export const editTeamRequest = commandEnvelope(teamTarget.extend({ ...teamFacts.shape, reason: editReason }));
export const archiveTeamRequest = commandEnvelope(teamTarget);
export const restoreTeamRequest = commandEnvelope(teamTarget);

const roleFacts = z.strictObject({
	name: teamName.optional(),
	description,
	leadership: z.boolean().optional(),
	timeCommitment: teamText.nullable().optional(),
	desiredSkills: teamText.nullable().optional(),
});
export const createRoleRequest = z.strictObject({
	requestKey,
	input: teamTarget.extend({
		name: teamName,
		description,
		leadership: z.boolean().optional(),
		timeCommitment: teamText.nullable().optional(),
		desiredSkills: teamText.nullable().optional(),
	}),
});
export const editRoleRequest = commandEnvelope(roleTarget.extend(roleFacts.shape));
export const retireRoleRequest = commandEnvelope(roleTarget);

export const assignRoleRequest = commandEnvelope(z.strictObject({ roleId: recordId, teamId: recordId, personId }));
export const endMembershipRequest = commandEnvelope(z.strictObject({ teamId: recordId, personId }));
export const reactivateMembershipRequest = commandEnvelope(z.strictObject({ roleId: recordId, personId }));
export const appointLeaderRequest = commandEnvelope(z.strictObject({ teamId: recordId, personId }));
/**
 * Fixes the recorded dates of one ministry role a person held or holds; the expected revision is the tenure's. A role
 * held now keeps no end date: ending it is leaving the ministry. A reason is required and stays in the history.
 */
export const correctTenureRequest = commandEnvelope(
	z
		.strictObject({
			tenureId: recordId,
			startedOn: localDate,
			endedOn: localDate.nullable(),
			reason: z.string().trim().min(1, "reason_required").max(500),
		})
		.refine((v) => v.endedOn === null || v.endedOn >= v.startedOn, { path: ["endedOn"], message: "before_start" }),
);

const selection = z.strictObject({
	teamKey: templateKey,
	roleKeys: z.array(roleKey).max(20),
	destinationTeamId: recordId.optional(),
});
export const initializeRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		expectedVersion: z.string().trim().min(1).max(40),
		mode: z.enum(["import", "read", "skip", "cancel"]),
		selections: z.array(selection).max(20),
	}),
});

export const listTeamsRequest = z.strictObject({ includeArchived: z.boolean().optional() });
export const teamHistoryRequest = z.strictObject({ teamId: recordId });
export const listRolesRequest = z.strictObject({ teamId: recordId });
export const teamRevisionRequest = z.strictObject({ teamId: recordId });
export const listMembersRequest = z.strictObject({ teamId: recordId });
export const personAssignmentsRequest = z.strictObject({ personId });
export const listLeaderCandidatesRequest = z.strictObject({
	q: z.string().trim().min(1).max(80).optional(),
});
export const orgChartRequest = z.strictObject({ includeArchived: z.boolean().optional() });
export const orgChartExportRequest = z.strictObject({ includeArchived: z.boolean().optional() });

/** One ministry with its roles and current people. */
export const getTeamRequest = z.strictObject({ teamId: recordId });
/** Current ministry people, by name and optionally in one ministry. */
export const searchMembersRequest = z.strictObject({
	q: z.string().trim().min(1).max(80).optional(),
	teamId: recordId.optional(),
});
/** Every current ministry's staffing and leader, and the church's totals. */
export const staffingSummaryRequest = z.strictObject({});
/** People serving on at least `minTeams` distinct current ministries (default 2, the advisory overload line). */
export const personTeamCountsRequest = z.strictObject({ minTeams: z.int().min(1).max(20).optional() });
/** What an import of the chosen catalog ministries and roles would add; nothing is created. */
export const previewTemplateImportRequest = z.strictObject({ selections: z.array(selection).min(1).max(20) });
/** A role a person holds, ended: the person leaves that one role and keeps the rest. */
export const removeRoleRequest = commandEnvelope(z.strictObject({ roleId: recordId, personId }));
