import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { ReadAdapter, SourceResult } from "../../../catalog/types.ts";

// The Communication reads. Evry finds the church's drafts and scheduled messages by subject and send time, so "cancel
// the Friday email" names one message id. Only the safe identifying fields reach the model: never a body or an address.
// Any seat in the church may read them; writes need Owner or Admin.

const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
const listInput = z.strictObject({
	subject: z.string().trim().min(1).max(200).optional().describe("Words from the subject"),
	state: z.enum(["draft", "scheduled"]).optional(),
	sendOn: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.describe("The church's local date a scheduled message sends on, like 2026-11-06"),
	limit: z.int().min(1).max(50).optional(),
});
const messageRow = z.object({
	id: z.uuid(),
	subject: z.string().nullable(),
	state: z.string(),
	sends_at: z.string().nullable(),
	sends_at_instant: z.string().nullable(),
	zone: z.string(),
	held: z.number().int(),
});

const mailOf = (message: string) =>
	`m.tenant_id=${message}.plant_id AND m.logical_key LIKE 'communication/'||${message}.id||'/%'`;
/**
 * Recipients still to go out for message `c`, so a cancel or a time change has something to act on: waiting in Everyfield
 * for the send time (`scheduled`, T-241), or held by the email service.
 */
const holding = (message: string) =>
	`${mailOf(message)} AND m.state IN ('scheduled','accepted','unknown','dispatched')`;
export const held = sql.raw(`(SELECT count(*)::int FROM mail m WHERE ${holding("c")})`);
/** Of those, the recipients the email service never answered about: they have no email service id to move by. */
export const unanswered = sql.raw(
	`(SELECT count(*)::int FROM mail m WHERE ${mailOf("c")} AND m.state IN ('unknown','dispatched'))`,
);
/**
 * Message `c` can still go out. A cancel, a replacement or a sent email changes only mail rows, so a message whose every
 * recipient is finished stays `scheduled`, and the read must not offer it as the one to act on.
 */
const canStillGoOut = sql.raw(
	`(c.state='draft' OR NOT EXISTS(SELECT FROM mail m WHERE ${mailOf("c")})
		OR EXISTS(SELECT FROM mail m WHERE ${mailOf("c")} AND m.state NOT IN ('sent','cancelled','refused','failed')))`,
);
/** Of those, the recipients with no cancel asked: a cancel or a sent email in Messages lowers it. */
export const untouchedMail = (message: string) =>
	`(SELECT count(*)::int FROM mail m WHERE ${holding(message)} AND m.cancel_requested_at IS NULL)`;

export const listMessages: ReadAdapter<z.infer<typeof listInput>> = {
	operation: "communication.list",
	description:
		"Find this church's email drafts and scheduled messages by subject words, state or send date. Each row has the message id, subject, state and send time in the church's time zone.",
	input: listInput,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		const limit = input.limit ?? 20;
		const words = input.subject ? `%${input.subject.replace(/[\\%_]/g, "\\$&")}%` : null;
		const r = await tx.execute(sql`
			SELECT c.id,c.subject,c.state,
				to_char(c.scheduled_at AT TIME ZONE pl.timezone,'Dy YYYY-MM-DD HH24:MI') AS sends_at,
				to_char(c.scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sends_at_instant,pl.timezone AS zone,
				${held} AS held
			FROM communication c JOIN plant pl ON pl.id=c.plant_id
			WHERE c.plant_id=${actor.owner.id}::uuid AND c.state IN ('draft','scheduled') AND ${canStillGoOut}
				AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}
				AND (${input.state ?? null}::text IS NULL OR c.state=${input.state ?? null})
				AND (${words}::text IS NULL OR c.subject ILIKE ${words} ESCAPE '\\')
				AND (${input.sendOn ?? null}::text IS NULL OR to_char(c.scheduled_at AT TIME ZONE pl.timezone,'YYYY-MM-DD')=${input.sendOn ?? null})
			ORDER BY c.scheduled_at NULLS LAST,c.created_at DESC,c.id LIMIT ${limit + 1}`);
		const rows = r.rows.map((raw) => messageRow.parse(raw));
		const shown = rows.slice(0, limit);
		return {
			operation: "communication.list",
			status: shown.length ? "available" : "not_found",
			rows: shown.map((m) => ({
				kind: "message" as const,
				id: m.id,
				label: m.subject || "Untitled draft",
				fields: {
					state: m.state,
					sendsAt: m.sends_at,
					sendsAtInstant: m.sends_at_instant,
					zone: m.zone,
					// A scheduled message the email service holds can be cancelled, moved or replaced; a draft can only be scheduled.
					handedOff: m.held > 0,
				},
			})),
			total: rows.length > limit ? null : shown.length,
			page: 1,
			next: null,
			completeness: rows.length > limit ? "partial" : "complete",
			exclusions: ["message bodies", "email addresses", "sent messages"],
		};
	},
};

/** The installed Communication read tools, in catalog order. */
export const COMMUNICATION_READS = [listMessages] as const;
