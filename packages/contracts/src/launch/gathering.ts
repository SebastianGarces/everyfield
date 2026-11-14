import { z } from "zod";
import { recordId, requestKey, revision } from "../common/values.ts";
import { localDate, type LocalDate } from "../common/time.ts";
import { GATHERING_NAME_MAX } from "../organizations/requests.ts";

// How a church ends its gathering phase (T-296): Launch Sunday, or the milestone an organization it is affiliated with
// offers, such as "Constituted as a church". The church's Owner or Admin chooses and records when it was reached.
// Choosing or recording never moves the phase, changes the launch date, or creates a task or a readiness milestone.

export const GATHERING_NOTE_MAX = 2000;

/** A milestone one organization the church is affiliated with offers it now. */
export const gatheringOffer = z.strictObject({
	organizationId: recordId,
	organizationName: z.string(),
	name: z.string().max(GATHERING_NAME_MAX),
	description: z.string().nullable(),
});
export type GatheringOffer = z.infer<typeof gatheringOffer>;

/**
 * The church's path. On the milestone path, `offered` is the organization's milestone while it still offers it to
 * this church (null once it is turned off or the affiliation ends), and `reached` is the record, under the name it was
 * reached with.
 */
export const gatheringPath = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("launch_sunday") }),
	z.strictObject({
		kind: z.literal("milestone"),
		organizationId: recordId.nullable(),
		/** Null once the organization itself is gone. */
		organizationName: z.string().nullable(),
		offered: z.strictObject({ name: z.string(), description: z.string().nullable() }).nullable(),
		reached: z.strictObject({ name: z.string(), date: localDate, note: z.string().nullable() }).nullable(),
	}),
]);
export type GatheringPath = z.infer<typeof gatheringPath>;

/** Why a recorded milestone was refused, so the form can say it next to the field. */
export const gatheringProblem = z.enum(["invalid_date", "date_in_future", "note_too_long"]);
export type GatheringProblem = z.infer<typeof gatheringProblem>;
/** The record as saved (note trimmed, blank to null), or the problem with it. `today` is the church-local date. */
export function checkGathering(
	input: { date: string; note: string | null },
	today: LocalDate,
): { ok: true; value: { date: LocalDate; note: string | null } } | { ok: false; problem: GatheringProblem } {
	const date = localDate.safeParse(input.date);
	if (!date.success) return { ok: false, problem: "invalid_date" };
	if (date.data > today) return { ok: false, problem: "date_in_future" };
	const note = (input.note ?? "").replace(/\r\n?/g, "\n").trim() || null;
	if (note && note.length > GATHERING_NOTE_MAX) return { ok: false, problem: "note_too_long" };
	return { ok: true, value: { date: date.data, note } };
}

const envelope = { requestKey, expectedRevision: revision };
/** Use an offered milestone, or Launch Sunday again. `expectedRevision` is the plan's revision. */
export const choosePathRequest = z.strictObject({
	...envelope,
	input: z.union([
		z.strictObject({ path: z.literal("launch_sunday") }),
		z.strictObject({ path: z.literal("milestone"), organizationId: recordId }),
	]),
});
const record = { date: z.string().max(40), note: z.string().nullable() };
export const recordGatheringRequest = z.strictObject({ ...envelope, input: z.strictObject(record) });
export const correctGatheringRequest = z.strictObject({
	...envelope,
	input: z.strictObject({ ...record, reason: z.string() }),
});
export const clearGatheringRequest = z.strictObject({ ...envelope, input: z.strictObject({ reason: z.string() }) });
