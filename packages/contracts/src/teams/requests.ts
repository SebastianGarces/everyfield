import { z } from "zod";
import { digest, personId, recordId, requestKey } from "../common/values.ts";
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
export const editTeamRequest = commandEnvelope(teamTarget.extend(teamFacts.shape));
export const correctTeamRequest = commandEnvelope(
	teamTarget.extend({
		name: teamName,
		description,
		icon,
		state: teamState.optional(),
		reason: z.string().trim().min(1).max(500),
	}),
);
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

const selection = z.strictObject({
	teamKey: templateKey,
	roleKeys: z.array(roleKey).max(20),
	label: teamName.optional(),
	personId: personId.optional(),
	destinationTeamId: recordId.optional(),
});
const responsibilityLine = z.strictObject({
	teamId: recordId,
	sourceVersionId: recordId,
	sourceLine: z.string().trim().min(1).max(120),
	text: teamText,
	selected: z.boolean(),
});
export const initializeRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		expectedVersion: z.string().trim().min(1).max(40),
		reviewDigest: digest,
		mode: z.enum(["import", "read", "skip", "cancel"]),
		selections: z.array(selection).max(20),
		lines: z.array(responsibilityLine).max(20).optional(),
	}),
});
export const copyTeamRosterRequest = z.strictObject({
	requestKey,
	input: z.strictObject({ meetingId: recordId, teamId: recordId }),
});

export const listTeamsRequest = z.strictObject({ includeArchived: z.boolean().optional() });
export const teamHistoryRequest = z.strictObject({ teamId: recordId });
export const listRolesRequest = z.strictObject({ teamId: recordId });
export const listMembersRequest = z.strictObject({ teamId: recordId });
export const personAssignmentsRequest = z.strictObject({ personId });
export const listLeaderCandidatesRequest = z.strictObject({});
export const orgChartRequest = z.strictObject({ includeArchived: z.boolean().optional() });
export const orgChartExportRequest = z.strictObject({ includeArchived: z.boolean().optional() });
export const rosterPreviewRequest = z.strictObject({ meetingId: recordId, teamId: recordId });
