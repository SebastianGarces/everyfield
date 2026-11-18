import { z } from "zod";
import { recordId } from "../common/values.ts";
import { localDate } from "../common/time.ts";

const question = z.string().min(1).max(500);
const reviewGroupName = z.string().trim().min(1).max(120);

export const sendAnswersRequest = z.strictObject({
	reviewId: recordId,
	noteId: recordId,
	groupName: reviewGroupName,
	questions: z
		.array(question)
		.min(1)
		.max(200)
		.refine((q) => new Set(q).size === q.length, "Each question once."),
	reviewerSeatId: recordId,
});
export const withdrawReviewRequest = z.strictObject({ reviewId: recordId });

export const noteReview = z.strictObject({
	id: recordId,
	reviewer: z.string(),
	groupName: z.string(),
	sentOn: localDate,
	questions: z.array(question).max(200),
});
export type NoteReview = z.infer<typeof noteReview>;

const sendBase = {
	id: recordId,
	person: z.string(),
	groupName: z.string(),
	sender: z.string().nullable(),
	sentOn: localDate,
};
const reviewListItem = z.strictObject({ ...sendBase, shared: z.boolean() });
export const reviewList = z.strictObject({ items: z.array(reviewListItem).max(200) });
export type ReviewList = z.infer<typeof reviewList>;

export const answerReview = z.discriminatedUnion("shared", [
	z.strictObject({
		...sendBase,
		shared: z.literal(true),
		answers: z.array(z.strictObject({ question, answer: z.string().nullable() })).max(200),
	}),
	z.strictObject({ ...sendBase, shared: z.literal(false) }),
]);
export type AnswerReview = z.infer<typeof answerReview>;
