import { z } from "zod";
import { localDate } from "../../common/time.ts";
import { operationId, personId, recordId, revision } from "../../common/values.ts";
import { creditKind, meetingSubtype, programName } from "./values.ts";

const outcome = z.enum(["changed", "noop"]);
const receipt = { receiptId: operationId, outcome };

export const trainingProgram = z.strictObject({
	id: recordId,
	teamId: recordId.nullable(),
	name: programName,
	required: z.boolean(),
	version: z.int().min(1),
	revision,
	archived: z.boolean(),
});
export const programMutationResult = z.strictObject({
	...receipt,
	program: trainingProgram,
});
export const rosterResult = z.strictObject({
	...receipt,
	programId: recordId,
	personIds: z.array(personId).max(500),
	added: z.int().min(0),
	removed: z.int().min(0),
});
export const requiredTrainingPreview = z.strictObject({
	programId: recordId,
	revision,
	personIds: z.array(personId).max(500),
	rosterDigest: z.string().length(64),
});
export const creditResult = z.strictObject({
	...receipt,
	personId,
	programId: recordId.nullable(),
	kind: creditKind,
	candidate: z.boolean(),
	verifierAccountId: recordId,
	earnedOn: localDate.nullable(),
});
export const meetingResult = z.strictObject({
	...receipt,
	meetingId: recordId,
	teamId: recordId,
	subtype: meetingSubtype,
	guestIds: z.array(personId).max(200),
});
export const attendanceResult = z.strictObject({
	...receipt,
	meetingId: recordId,
	personIds: z.array(personId).max(200),
});
const programRow = trainingProgram.extend({
	requiredPeople: z.int().min(0),
	compatibleCredits: z.int().min(0),
});
export const trainingList = z.strictObject({
	programs: z.array(programRow).max(100),
});
export const trainingMatrix = z.strictObject({
	programs: z
		.array(z.strictObject({ id: recordId, name: programName, personIds: z.array(personId).max(500) }))
		.max(100),
});
export const personTraining = z.strictObject({
	personId,
	currentTeams: z.array(z.string().min(1).max(200)).max(50),
	formerTeams: z.array(z.string().min(1).max(200)).max(50),
	concurrentAssignments: z.int().min(0),
	currentTrainingComplete: z.boolean(),
	earnedHistoryRetained: z.boolean(),
	distinctPeople: z.literal(1),
});
export const historyRow = z.strictObject({
	id: recordId,
	programId: recordId.nullable(),
	kind: creditKind,
	version: z.int().min(1).nullable(),
	earnedOn: localDate.nullable(),
	verifierAccountId: recordId.nullable(),
	attendanceDays: z.int().min(0).nullable(),
	volunteerDays: z.int().min(0).nullable(),
});
export const trainingHistory = z.strictObject({
	personId,
	credits: z.array(historyRow).max(200),
});
export const teamFacts = z.strictObject({
	teamId: recordId,
	filledSlots: z.int().min(0),
	openSlots: z.int().min(0),
	distinctPeople: z.int().min(0),
	memberAttendance: z.int().min(0),
	guestCount: z.int().min(0),
	rosterDenominator: z.int().min(0),
	trainingRate: z.number().nullable(),
	staffingRate: z.number().nullable(),
	attendanceRate: z.number().nullable(),
	weights: z.tuple([z.number(), z.number(), z.number()]),
	composite: z.number().nullable(),
});
export const teamMeetingRow = z.strictObject({
	id: recordId,
	subtype: meetingSubtype.nullable(),
	status: z.string().min(1).max(40),
	guestIds: z.array(personId).max(200),
});
export const teamMeetingList = z.strictObject({
	teamId: recordId,
	meetings: z.array(teamMeetingRow).max(100),
});
