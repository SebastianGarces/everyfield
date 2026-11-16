import { z } from "zod";
import type { Instant } from "../common/time.ts";

export const outcome = z.enum(["contacted", "attempted_no_contact", "administrative_completion", "no_longer_needed"]);
export type Outcome = z.infer<typeof outcome>;
export const completing = ["contacted", "attempted_no_contact", "administrative_completion"] as const;
export const channel = z.enum(["email", "in_person", "other", "phone", "text", "video"]);
export const notes = z
	.string()
	.transform((v) => v.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim())
	.pipe(z.string().max(2_000));
export const reason = z.string().trim().min(1).max(500);
export const obligationState = z.enum(["open", "complete", "no_longer_needed", "superseded"]);
export type ObligationState = z.infer<typeof obligationState>;

export const CLOCK_ALLOWANCE_MS = 2 * 60 * 1000;
export const FOLLOW_UP_WINDOW_MS = 48 * 60 * 60 * 1000;
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
	eligible: z.boolean(),
	success: z.boolean().nullable(),
	reason: measurementReason,
});
export type Measurement = z.infer<typeof measurement>;
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
