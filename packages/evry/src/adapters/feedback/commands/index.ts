import { createHash } from "node:crypto";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { DESCRIPTION_MAX, feedbackCategory } from "@everyfield/contracts/feedback";
import { feedbackWriter } from "@everyfield/domain/feedback";
import { z } from "zod";
import { change, nativeWrite, notes, plantSeat, settled, target } from "../../native.ts";
import { CATEGORY_NAME } from "../reads/index.ts";

// Product feedback sent through Evry (WP-084): the user reviews the exact feedback first, then approval runs the same
// feedbackWriter.submit the feedback dialog runs, on the executor's transaction, so the feedback row, its
// feedback.received audit row and its feedback_publication job commit with the proposal outcome, once, under the effect
// key (PUB57-006: it reaches the Everyfield team and starts nothing else). The church and role come from the seat on the
// server, as the dialog's do; the page is Evry's own.

/** The page a feedback sent through Evry names: there is no screen behind it. */
const EVRY_PAGE = "Evry";

/** The signed-in account with its seat's church and role, as feedbackWriter stores them, as `a`, `s` and `n`. */
const sender = (seatId: string | null, accountId: string) =>
	sql`FROM account a CROSS JOIN LATERAL seat_identity(a.id) n
		LEFT JOIN LATERAL (SELECT p.name AS church, initcap(st.role) AS role FROM seat st JOIN plant p ON p.id=st.plant_id
			WHERE st.id=${seatId}::uuid AND st.account_id=a.id AND st.ended_at IS NULL) s ON true
		WHERE a.id=${accountId}::uuid`;

/**
 * The feedback request key for an effect key: the same UUID every time (an RFC 9562 version 8 UUID from its SHA-256),
 * so a retried effect replays the feedback it saved instead of saving a second one.
 */
function requestKeyOf(effectKey: string) {
	const h = createHash("sha256").update(effectKey).digest("hex");
	const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const submit = nativeWrite({
	operation: "feedback.submit",
	description:
		"Propose sending product feedback to the Everyfield team in the user's own words, with its type: bug (something broke), suggestion (an idea), question or other. The church and the user's role go with it. The team reads it; sending it changes nothing in Everyfield. Nothing is sent until the user approves the exact review.",
	input: z.strictObject({
		category: feedbackCategory,
		description: z.string().trim().min(1).max(DESCRIPTION_MAX),
	}),
	allowed: plantSeat,
	review(actor, value) {
		const args = { category: value.category, description: value.description, page: EVRY_PAGE, address: null };
		return sql`SELECT jsonb_build_object(
				'target',${target("account", sql`a.id`, sql`'Feedback to the Everyfield team'::text`)},
				'changes',jsonb_build_array(
					${change("type", sql`'null'::jsonb`, CATEGORY_NAME[value.category])},
					${change("feedback", sql`'null'::jsonb`, value.description)},
					jsonb_build_object('field','church','before','null'::jsonb,'after',to_jsonb(s.church)),
					jsonb_build_object('field','yourRole','before','null'::jsonb,'after',to_jsonb(s.role)),
					${change("page", sql`'null'::jsonb`, EVRY_PAGE)}),
				'notes',${notes(["The Everyfield team reads every message. Sending it changes nothing in your church or in Everyfield."])}
					||jsonb_build_array('If we have a question, we reply to '||(SELECT c.email FROM access_account_contact(a.id) c)||'.')) AS review,
			${JSON.stringify(args)}::jsonb AS args
			${sender(actor.seatId, actor.accountId)}`;
	},
	async run(tx, _context, request, { authority, ports }) {
		const saved = settled(
			await feedbackWriter.submit(
				tx as unknown as Database,
				authority,
				{ ...request, requestKey: requestKeyOf(request.requestKey) },
				{ appVersion: ports.appVersion },
			),
		);
		return { receiptId: saved.id };
	},
});

export const FEEDBACK_COMMANDS = { "feedback.submit": submit } as const;
