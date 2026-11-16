import { z } from "zod";
import { recordId, requestKey, revision } from "../common/values.ts";
import { localDate, type LocalDate } from "../common/time.ts";
import { GATHERING_NAME_MAX } from "../organizations/requests.ts";

export const GATHERING_NOTE_MAX = 2000;

export const gatheringOffer = z.strictObject({
	organizationId: recordId,
	organizationName: z.string(),
	name: z.string().max(GATHERING_NAME_MAX),
	description: z.string().nullable(),
});
export type GatheringOffer = z.infer<typeof gatheringOffer>;

export const gatheringPath = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("launch_sunday") }),
	z.strictObject({
		kind: z.literal("milestone"),
		organizationId: recordId.nullable(),
		organizationName: z.string().nullable(),
		offered: z.strictObject({ name: z.string(), description: z.string().nullable() }).nullable(),
		reached: z.strictObject({ name: z.string(), date: localDate, note: z.string().nullable() }).nullable(),
	}),
]);
export type GatheringPath = z.infer<typeof gatheringPath>;

export const gatheringProblem = z.enum(["invalid_date", "date_in_future", "note_too_long"]);
export type GatheringProblem = z.infer<typeof gatheringProblem>;
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
