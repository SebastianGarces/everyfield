import { z } from "zod";
import { localDate } from "../../common/time.ts";
import { digest, personId, recordId, requestKey } from "../../common/values.ts";
import { commandEnvelope } from "../../common/writes.ts";
import { meetingSubtype, programName } from "./values.ts";

const days = z.int().min(0).max(20000);
const people = z.array(personId).max(500);
const clock = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);

export const createProgramRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		name: programName,
		required: z.boolean(),
		teamId: recordId.nullable(),
	}),
});
export const correctProgramRequest = commandEnvelope(
	z.strictObject({
		programId: recordId,
		name: programName,
		required: z.boolean(),
		reason: z.string().trim().min(1).max(500),
	}),
);
export const previewRequiredTrainingRequest = z.strictObject({
	programId: recordId,
	personIds: people,
});
export const setRequiredTrainingRequest = commandEnvelope(
	z.strictObject({
		programId: recordId,
		personIds: people,
		rosterDigest: digest,
	}),
);
const programCredit = z.strictObject({
	kind: z.literal("program"),
	personId,
	programId: recordId,
	earnedOn: localDate,
});
const serviceSpan = z.strictObject({
	kind: z.literal("service"),
	personId,
	attendanceDays: days,
	volunteerDays: days,
});
export const attestCompletionRequest = commandEnvelope(z.discriminatedUnion("kind", [programCredit, serviceSpan]));
export const revokeCompletionRequest = commandEnvelope(z.strictObject({ personId, programId: recordId }));
export const recompleteTrainingRequest = commandEnvelope(
	z.strictObject({ personId, programId: recordId, earnedOn: localDate }),
);
export const scheduleTeamMeetingRequest = commandEnvelope(
	z.strictObject({
		teamId: recordId,
		subtype: meetingSubtype,
		date: localDate,
		time: clock,
		guestIds: z.array(personId).max(200),
	}),
);
export const recordTeamAttendanceRequest = commandEnvelope(
	z.strictObject({
		meetingId: recordId,
		personIds: z.array(personId).max(200),
	}),
);
export const listTrainingRequest = z.strictObject({});
export const trainingMatrixRequest = z.strictObject({});
export const personTrainingRequest = z.strictObject({ personId });
export const trainingHistoryRequest = z.strictObject({ personId });
export const staffingFactsRequest = z.strictObject({ teamId: recordId });
export const trainingHealthRequest = z.strictObject({ teamId: recordId });
export const listTeamMeetingsRequest = z.strictObject({ teamId: recordId });
