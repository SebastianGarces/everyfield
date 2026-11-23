import { dayText } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/intelligence";
import { sql } from "@everyfield/db/query";
import { createAssessments } from "@everyfield/domain/intelligence";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, ReviewContext, ReviewedWrite } from "../../../proposals/types.ts";
import { plantAdmin } from "../../native.ts";

const assessments = createAssessments();
type Card = { label: string; changes: { field: string; before: unknown; after: unknown }[]; notes: string[] };

function assessmentWrite<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	prepare(view: c.AssessmentView, input: I): { card: Card; refusal?: string | null; args: object } | null;
	run(
		tx: Parameters<ReviewedWrite<I>["execute"]>[0],
		authority: Parameters<ReviewedWrite<I>["execute"]>[5]["authority"],
		args: Record<string, unknown>,
	): Promise<c.AssessmentReply<unknown>>;
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: plantAdmin,
		async review(actor: EvryActor, input: I, context: ReviewContext) {
			const reply = await assessments.readAssessment(context.db, actor.authority, {});
			if (reply.status !== "ok") return null;
			const p = spec.prepare(reply.value, input);
			if (!p) return null;
			const review = {
				target: { kind: "church", id: actor.owner.id, label: p.card.label },
				changes: p.card.changes,
				notes: p.card.notes,
				...(p.refusal && { refusal: p.refusal }),
			};
			return sql`SELECT ${JSON.stringify(review)}::jsonb AS review, ${JSON.stringify(p.args)}::jsonb AS args`;
		},
		async execute(tx, _context, args, _effectKey, _reminders, native): Promise<EffectResult> {
			const reply = await spec.run(tx, native.authority, args as Record<string, unknown>);
			return reply.status === "ok" ? { revision: "1" } : { refused: reply.error.code };
		},
	};
}

export const requestRefresh = assessmentWrite({
	operation: "intelligence.requestRefresh",
	description:
		"Propose asking Everyfield for a fresh Plant Intelligence assessment, as the screen's Refresh does. It is prepared in the background from the church's records and shows on the Plant Intelligence screen when ready; the current one stays until then. Owners and Admins. Nothing is requested until the user approves",
	input: z.strictObject({}),
	prepare(view) {
		const now = view.current ? `Latest assessment, measured ${dayText(view.current.measuredOn)}` : "No assessment yet";
		const preparing = view.newest?.state === "preparing" || view.newest?.state === "deferred";
		return {
			card: {
				label: "Plant Intelligence",
				changes: [{ field: "assessment", before: now, after: "A new assessment is requested" }],
				notes: [
					"Everyfield prepares it in the background from your records. The current assessment stays until the new one is ready.",
				],
			},
			refusal: preparing ? "A new assessment is already being prepared, so there's nothing to request." : null,
			args: { requestId: randomUUID() },
		};
	},
	run: (tx, authority, args) => assessments.requestRefresh(tx, authority, args),
});

const RATING = { useful: "Useful", not_useful: "Not useful" } as const;
const feedbackInput = z.strictObject({
	ordinal: z.int().min(0).max(5),
	rating: c.feedbackRating,
	comment: z.string().max(c.FEEDBACK_COMMENT_MAX).optional(),
});
export const submitFeedback = assessmentWrite({
	operation: "intelligence.submitFeedback",
	description:
		"Propose the user's own rating of one finding of the latest assessment, useful or not useful, by its ordinal from intelligence.readAssessment (0 is the focus), with their comment in their own words if they gave one. It is saved as the screen's feedback is: only the user's own rating changes, never the assessment. Owners and Admins. Nothing is saved until the user approves",
	input: feedbackInput,
	prepare(view, input) {
		const a = view.current;
		if (!a) return null;
		const point = [a.focus, ...a.supporting, ...a.positives][input.ordinal];
		if (!point) return null;
		const mine = view.feedback.find((f) => f.ordinal === input.ordinal);
		const comment = input.comment?.trim() ?? "";
		const same = mine?.rating === input.rating && (mine.comment ?? "") === comment;
		return {
			card: {
				label: point.title,
				changes: [
					{ field: "rating", before: mine ? RATING[mine.rating] : null, after: RATING[input.rating] },
					...(comment || mine?.comment
						? [{ field: "comment", before: mine?.comment ?? null, after: comment || null }]
						: []),
				],
				notes: [
					`Your feedback on this finding of the assessment measured ${dayText(a.measuredOn)}. It changes nothing in the assessment.`,
				],
			},
			refusal: same ? "You already rated this finding that way, so nothing would change." : null,
			args: { runId: a.runId, ordinal: input.ordinal, rating: input.rating, comment },
		};
	},
	run: (tx, authority, args) => assessments.submitFeedback(tx, authority, args),
});

export const ASSESSMENT_INTELLIGENCE_COMMANDS = {
	"intelligence.requestRefresh": requestRefresh,
	"intelligence.submitFeedback": submitFeedback,
} as const;
