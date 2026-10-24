import { z } from "zod";
import { localDate } from "../common/time.ts";
import { correlationId, operationId, personId, recordId, revision } from "../common/values.ts";
import { TEMPLATE_VERSION, leaderSource, teamState } from "./values.ts";

const issue = z.strictObject({ path: z.string().max(200), problem: z.string().max(200) });
const error = <C extends string, D extends z.ZodRawShape>(
	code: C,
	details: D,
	retry: "never" | "refresh" | "same_request",
) =>
	z.strictObject({ code: z.literal(code), details: z.strictObject(details), correlationId, retry: z.literal(retry) });

/** Every refusal a teams operation can return. Missing rows are "unavailable". */
export const teamsError = z.discriminatedUnion("code", [
	error("invalid_input", { issues: z.array(issue).max(50) }, "never"),
	error("unsupported_filter", {}, "never"),
	error("unavailable", {}, "never"),
	error("access_denied", {}, "never"),
	error("invalid_subject", {}, "never"),
	error("conflict", {}, "refresh"),
	error("occupied", { roleId: recordId.optional() }, "never"),
	error("stale_template_version", {}, "never"),
	error("stale_review", {}, "never"),
	error("required_write_failed", {}, "same_request"),
]);
export type TeamsError = z.infer<typeof teamsError>;
export type TeamsReply<T> = { status: "ok"; value: T } | { status: "refused"; error: TeamsError };

const outcome = z.enum(["changed", "noop"]);
const receipt = { receiptId: operationId, outcome };

export const team = z.strictObject({
	id: recordId,
	revision,
	name: z.string().min(1).max(200),
	description: z.string().min(1).max(2000).nullable(),
	icon: z.string().min(1).max(40).nullable(),
	templateKey: z.string().min(1).max(80).nullable(),
	state: teamState,
	archived: z.boolean(),
	sortOrder: z.int().min(0),
	leaderPersonId: personId.nullable(),
	leaderSource: leaderSource.nullable(),
	leaderRoleId: recordId.nullable(),
	activeCount: z.int().min(0),
});
export const teamMutationResult = z.strictObject({
	...receipt,
	team,
	stableKey: z.string().nullable(),
});
export const teamPage = z.strictObject({
	items: z.array(team).max(200),
	ordinaryIds: z.array(recordId).max(200),
	archivedIds: z.array(recordId).max(200),
});

export const historyEntry = z.strictObject({
	id: recordId,
	kind: z.string().min(1).max(80),
	occurredAt: z.string().min(1),
	reason: z.string().nullable(),
	before: z.record(z.string(), z.unknown()).nullable(),
	after: z.record(z.string(), z.unknown()).nullable(),
});
export const teamHistory = z.strictObject({
	teamId: recordId,
	entries: z.array(historyEntry).max(200),
});

export const teamRole = z.strictObject({
	id: recordId,
	teamId: recordId,
	revision,
	name: z.string().min(1).max(200),
	description: z.string().min(1).max(2000).nullable(),
	leadership: z.boolean(),
	timeCommitment: z.string().min(1).max(2000).nullable(),
	desiredSkills: z.string().min(1).max(2000).nullable(),
	templateKey: z.string().min(1).max(80).nullable(),
	retired: z.boolean(),
	occupantPersonId: personId.nullable(),
	occupantName: z.string().nullable(),
});
export const roleMutationResult = z.strictObject({
	...receipt,
	role: teamRole,
	activeStaffingSlots: z.int().min(0),
	historicalOccupant: z.string().nullable(),
});
export const rolePage = z.strictObject({
	teamId: recordId,
	roles: z.array(teamRole).max(100),
});

export const membershipResult = z.strictObject({
	...receipt,
	tenureId: recordId.nullable(),
	roleId: recordId.nullable(),
	personId,
	stage: z.string().min(1).max(40),
	warning: z.enum(["overload"]).nullable(),
	teamCount: z.int().min(0),
});
export const memberRow = z.strictObject({
	personId,
	name: z.string().min(1).max(200),
	roleId: recordId,
	roleName: z.string().min(1).max(200),
	startedOn: localDate,
	endedOn: localDate.nullable(),
	active: z.boolean(),
	live: z.boolean(),
});
export const memberPage = z.strictObject({
	teamId: recordId,
	members: z.array(memberRow).max(500),
	history: z.array(memberRow).max(500),
});
export const assignmentRow = z.strictObject({
	teamId: recordId,
	teamName: z.string().min(1).max(200),
	roleId: recordId,
	roleName: z.string().min(1).max(200),
	desiredSkills: z.string().min(1).max(2000).nullable(),
	startedOn: localDate,
	endedOn: localDate.nullable(),
	active: z.boolean(),
});
export const personAssignments = z.strictObject({
	personId,
	assignments: z.array(assignmentRow).max(200),
});
export const leaderCandidate = z.strictObject({
	personId,
	name: z.string().min(1).max(200),
	stage: z.string().min(1).max(40),
});
export const leaderCandidates = z.strictObject({
	people: z.array(leaderCandidate).max(50),
});

export const catalogRole = z.strictObject({
	key: z.string().min(1).max(80),
	name: z.string().min(1).max(200),
	leadership: z.boolean(),
});
export const catalogTeam = z.strictObject({
	key: z.string().min(1).max(80),
	name: z.string().min(1).max(200),
	roles: z.array(catalogRole).max(20),
});
export const catalogPage = z.strictObject({
	version: z.literal(TEMPLATE_VERSION),
	teams: z.array(catalogTeam).max(20),
	newTenantRows: z.literal(0),
});

export const initializeResult = z.strictObject({
	...receipt,
	teamKeys: z.array(z.string()).max(20),
	roleKeys: z.array(z.string()).max(50),
	newTenantRows: z.int().min(0),
	newTeams: z.int().min(0),
	newSelectedRoles: z.int().min(0),
	createdResponsibilities: z.int().min(0),
	importedRows: z.int().min(0),
	newRows: z.int().min(0),
	importOfferAvailable: z.boolean(),
	stableKey: z.string().nullable(),
	label: z.string().nullable(),
	phase: z.int(),
});

export const chartNode = z.strictObject({
	id: recordId,
	name: z.string().min(1).max(200),
	templateKey: z.string().nullable(),
	parentId: recordId.nullable(),
	archived: z.boolean(),
	leaderName: z.string().nullable(),
});
export const orgChart = z.strictObject({
	nodes: z.array(chartNode).max(200),
});
export const orgChartExport = z.strictObject({
	format: z.literal("pdf"),
	pdf: z.string().min(1),
	svg: z.string().min(1),
	lines: z.array(z.string().min(1).max(200)).max(800),
	nodes: z.array(chartNode).max(200),
});

export const rosterPreview = z.strictObject({
	meetingId: recordId,
	teamId: recordId,
	personIds: z.array(personId).max(500),
});
export const rosterCopyResult = z.strictObject({
	...receipt,
	meetingId: recordId,
	teamId: recordId,
	addedPersonIds: z.array(personId).max(500),
	skippedPersonIds: z.array(personId).max(500),
});
