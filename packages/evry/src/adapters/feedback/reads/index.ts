import type { Database } from "@everyfield/db/client";
import type { FeedbackCategory, FeedbackReply, FeedbackStatus, OwnFeedback } from "@everyfield/contracts/feedback";
import { feedbackWriter } from "@everyfield/domain/feedback";
import { z } from "zod";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { plantSeat } from "../../native.ts";

// The signed-in account's own product feedback (WP-084), read through the same feedbackWriter calls Sent feedback
// (`/feedback`) makes: category, date, status and public issue, never the words, private details or triage history.
// Another account's feedback answers as one that does not exist. Church seats only: Evry adds nothing for
// organization logins (D-1434).

/** A category as Sent feedback names it. */
export const CATEGORY_NAME: Record<FeedbackCategory, string> = {
	bug: "Bug",
	suggestion: "Idea",
	question: "Question",
	other: "Other",
};
const STATUS_NAME: Record<FeedbackStatus, string> = {
	new: "New",
	reviewed: "Reviewed",
	resolved: "Resolved",
	dismissed: "Dismissed",
};
/** "Nov 13, 2026", as Sent feedback dates it. */
const sentOn = (iso: string) =>
	new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const row = (f: OwnFeedback): SourceRow => ({
	kind: "item",
	id: f.id,
	label: CATEGORY_NAME[f.category],
	fields: {
		category: f.category,
		sent: sentOn(f.submittedAt),
		status: STATUS_NAME[f.status],
		publicIssue: f.publicUrl,
		href: "/feedback",
	},
});
/** `more`: older feedback exists past these 25; Sent feedback pages through it. */
const answer = (operation: string, rows: SourceRow[], more = false): SourceResult => ({
	operation,
	status: rows.length || operation === "feedback.listOwn" ? "available" : "not_found",
	rows,
	total: more ? null : rows.length,
	page: 1,
	next: null,
	completeness: more ? "partial" : "complete",
	exclusions: [
		"the words you sent",
		"private details",
		"triage history",
		"other accounts' feedback",
		...(more ? ["older feedback (open Sent feedback for it)"] : []),
	],
});
const valueOf = <T>(reply: FeedbackReply<T>) => (reply.status === "ok" ? reply.value : null);

export const FEEDBACK_READS = [
	{
		operation: "feedback.listOwn",
		description:
			"The product feedback the user sent to the Everyfield team, newest first, up to 25: its type, the date it was sent, its status (New, Reviewed, Resolved or Dismissed) and its public issue once one exists. Never the words or details, and never another account's feedback",
		input: z.strictObject({}),
		allowed: plantSeat,
		async invoke(tx, actor): Promise<SourceResult> {
			const page = valueOf(await feedbackWriter.listOwn(tx as Database, actor.authority, {}));
			if (!page) return { ...answer("feedback.listOwn", []), status: "not_found" };
			return answer("feedback.listOwn", page.items.map(row), page.next !== null);
		},
	} satisfies ReadAdapter<Record<string, never>>,
	{
		operation: "feedback.getOwnStatus",
		description:
			"One piece of feedback the user sent, by its id from feedback.listOwn: its type, date, status and public issue. Feedback the user did not send is not found",
		input: z.strictObject({ feedbackId: z.uuid() }),
		allowed: plantSeat,
		async invoke(tx, actor, input): Promise<SourceResult> {
			const found = valueOf(await feedbackWriter.getOwnStatus(tx as Database, actor.authority, input));
			return answer("feedback.getOwnStatus", found ? [row(found)] : []);
		},
	} satisfies ReadAdapter<{ feedbackId: string }>,
] as const;
