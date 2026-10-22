import { z } from "zod";
import type { Instant } from "../common/time.ts";

// What a person says happened on a follow-up (REQ-MTG-022). Only contacted is contact; the other three close or fulfil
// work without contact credit.
export const outcome = z.enum(["contacted", "attempted_no_contact", "administrative_completion", "no_longer_needed"]);
export type Outcome = z.infer<typeof outcome>;
/** The outcomes that may complete a follow-up task (REQ-MTG-021). no_longer_needed closes it without credit. */
export const completing = ["contacted", "attempted_no_contact", "administrative_completion"] as const;
export const channel = z.enum(["email", "in_person", "other", "phone", "text", "video"]);
// A bounded operational note: trimmed, LF line endings, at most 2,000 characters.
export const notes = z
	.string()
	.transform((v) => v.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim())
	.pipe(z.string().max(2_000));
export const reason = z.string().trim().min(1).max(500);
export const obligationState = z.enum(["open", "complete", "no_longer_needed", "superseded"]);
export type ObligationState = z.infer<typeof obligationState>;

/** The exact elapsed window a first-Vision follow-up has, from the meeting's actual start (REQ-MTG-021). */
export const FOLLOW_UP_WINDOW_MS = 48 * 60 * 60 * 1000;
/** A completion at or after the origin and at most 48 elapsed hours later. */
export function within48Hours(origin: Instant, completion: Instant): boolean {
	const elapsed = Date.parse(completion) - Date.parse(origin);
	return elapsed >= 0 && elapsed <= FOLLOW_UP_WINDOW_MS;
}

export const measurementReason = z.enum([
	"measured",
	"immature",
	"waived",
	"superseded",
	"future_origin",
	"invalid_completion",
]);
export const measurement = z.strictObject({
	// Whether the obligation counts in the 48-hour denominator at asOf.
	eligible: z.boolean(),
	// Null when it does not count.
	success: z.boolean().nullable(),
	reason: measurementReason,
});
export type Measurement = z.infer<typeof measurement>;
/**
 * One first-Vision follow-up's 48-hour measure at a frozen asOf (REQ-MTG-021). `completion` is the actual instant of
 * the earliest effective typed outcome that completed its task, or null. A pending obligation younger than 48 hours is
 * not yet measured; once mature it is a miss. A completion before the origin or after asOf is invalid evidence. A
 * waived or superseded obligation never counts.
 */
export function measure(
	o: { originAt: Instant; state: ObligationState; completion: Instant | null },
	asOf: Instant,
): Measurement {
	const excluded = (reason: z.infer<typeof measurementReason>) => ({ eligible: false, success: null, reason });
	if (o.state === "superseded") return excluded("superseded");
	if (o.state === "no_longer_needed") return excluded("waived");
	if (Date.parse(o.originAt) > Date.parse(asOf)) return excluded("future_origin");
	if (o.state === "complete" && o.completion !== null) {
		if (Date.parse(o.completion) < Date.parse(o.originAt) || Date.parse(o.completion) > Date.parse(asOf))
			return excluded("invalid_completion");
		return { eligible: true, success: within48Hours(o.originAt, o.completion), reason: "measured" };
	}
	if (Date.parse(asOf) - Date.parse(o.originAt) < FOLLOW_UP_WINDOW_MS) return excluded("immature");
	return { eligible: true, success: false, reason: "measured" };
}
