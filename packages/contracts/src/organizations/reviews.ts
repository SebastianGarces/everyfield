import { z } from "zod";
import { recordId } from "../common/values.ts";
import { localDate } from "../common/time.ts";

// Kept answers sent for review (T-385, D-1507). An Owner or Admin sends some of the questions of a pipeline import's
// kept-answers note, under a group name, to a current seat of the same organization. The reviewer reads only those
// questions with the note's current answers (D-1509) and gets no other duty (D-1511). No answer text goes into a send,
// a notification, an email or an audit row.

/** A question title of a kept-answers note, as the import wrote it. */
const question = z.string().min(1).max(500);
/** What the sender calls the chosen questions, such as "Credentialing questions". */
const reviewGroupName = z.string().trim().min(1).max(120);

/** The browser names the send's ID, so a repeated send (a double click or a retry) writes one send. */
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

/** A send as the note's readers see it on the note: who it went to, under what name, when, and which questions. */
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
	/** The person's name now: "Former participant" after a removal on request. */
	person: z.string(),
	groupName: z.string(),
	sender: z.string().nullable(),
	sentOn: localDate,
};
/** One row of the reviewer's Sent for review page. A send that is no longer shared shows no question. */
const reviewListItem = z.strictObject({ ...sendBase, shared: z.boolean() });
export const reviewList = z.strictObject({ items: z.array(reviewListItem).max(200) });
export type ReviewList = z.infer<typeof reviewList>;

/**
 * One send as its reviewer opens it: the chosen questions in the note's order, each with the note's current answer, or
 * null when the note no longer holds that question. Once withdrawn, the seat ended, the note or the person removed, it
 * holds no question or answer text.
 */
export const answerReview = z.discriminatedUnion("shared", [
	z.strictObject({
		...sendBase,
		shared: z.literal(true),
		answers: z.array(z.strictObject({ question, answer: z.string().nullable() })).max(200),
	}),
	z.strictObject({ ...sendBase, shared: z.literal(false) }),
]);
export type AnswerReview = z.infer<typeof answerReview>;
