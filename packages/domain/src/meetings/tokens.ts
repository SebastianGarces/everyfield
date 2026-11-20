import * as c from "@everyfield/contracts/meetings";
import type { Database } from "@everyfield/db/client";
import { sql, type SQLWrapper, type SqlLiteral } from "@everyfield/db/query";
import { createHash, randomBytes } from "node:crypto";
import "server-only";
import { z } from "zod";
import { plantVisible, refused, type Reader } from "./core.ts";
import { displayTitle } from "./rows.ts";

const TOKEN_DAYS = 7;
export const rsvpTokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");

const ANSWERING_SQL = c.answeringStatuses.map((s) => `'${s}'`).join(", ");
export const meetingOpenSql = <AliasName extends string>(alias: SqlLiteral<AliasName>) =>
	sql`${sql.raw(alias)}.retired_at IS NULL AND ${sql.raw(alias)}.status IN (${sql.raw(ANSWERING_SQL)})`;

export const newRsvpToken = () => randomBytes(32).toString("base64url");

export function rsvpTokenUpdate(plantId: string, meetingId: string, pairs: SQLWrapper) {
	return sql`UPDATE participation g SET rsvp_token_hash = t.token_hash,
			rsvp_token_expires_at = greatest(clock_timestamp() + make_interval(days => ${TOKEN_DAYS}), m.starts_at),
			rsvp_token_open = true, revision = g.revision + 1
		FROM ${pairs} t, meeting m
		WHERE m.id = ${meetingId}::uuid AND m.plant_id = ${plantId}::uuid AND ${meetingOpenSql("m")}
			AND g.meeting_id = m.id AND g.plant_id = ${plantId}::uuid AND g.person_id = t.person_id AND g.removed_at IS NULL
		RETURNING g.id`;
}

const viewRow = z.object({
	open: z.boolean(),
	closed: z.boolean(),
	expired: z.boolean(),
	rsvp: c.rsvp,
	first_name: z.string().nullable(),
	display_name: z.string(),
	title: z.string().nullable(),
	type: c.meetingType,
	vision_number: z.number().int().nullable(),
	starts_at: z.coerce.date(),
	local_date: z.string(),
	local_time: z.string(),
	timezone: z.string(),
	venue_name: z.string().nullable(),
	venue_address: z.string().nullable(),
});
export async function describeRsvpToken(db: Reader, raw: unknown) {
	const input = c.describeRsvpTokenRequest.safeParse(raw);
	if (!input.success) return c.rsvpTokenView.parse({ state: "unavailable" });
	const r = await db.execute(sql`SELECT g.rsvp_token_open AS open, NOT (${meetingOpenSql("m")}) AS closed,
			g.rsvp_token_expires_at <= clock_timestamp() AS expired,
			coalesce(g.rsvp, 'pending') AS rsvp, p.first_name, p.display_name, m.title, m.type, m.vision_number, m.starts_at,
			m.local_date::text AS local_date, to_char(m.local_time, 'HH24:MI') AS local_time, m.timezone, m.venue_name, m.venue_address
		FROM participation g JOIN meeting m ON m.id = g.meeting_id JOIN person p ON p.id = g.person_id
		WHERE g.rsvp_token_hash = ${rsvpTokenDigest(input.data.token)} AND g.removed_at IS NULL AND m.retired_at IS NULL AND p.state = 'live'
			AND ${plantVisible(sql`g.plant_id`)}`);
	if (!r.rows[0]) return c.rsvpTokenView.parse({ state: "unavailable" });
	const v = viewRow.parse(r.rows[0]);
	return c.rsvpTokenView.parse({
		state: v.closed ? "closed" : !v.open ? "answered" : v.expired ? "expired" : "pending",
		meeting: {
			displayTitle: displayTitle(v),
			startsAt: v.starts_at.toISOString(),
			localDate: v.local_date,
			localTime: v.local_time,
			zone: v.timezone,
			venue: v.venue_name === null ? null : { name: v.venue_name, address: v.venue_address ?? "" },
		},
		guestFirstName: v.first_name?.trim() || v.display_name.split(/\s+/)[0],
		rsvp: v.rsvp,
	});
}

export async function answerRsvpToken(db: Database, raw: unknown) {
	const input = c.answerRsvpTokenRequest.safeParse(raw);
	if (!input.success)
		return refused("invalid_input", {
			issues: input.error.issues
				.slice(0, 50)
				.map((i) => ({ path: i.path.join("."), problem: i.message.slice(0, 200) })),
		});
	const { token, rsvp } = input.data;
	const r = await db.execute(sql`WITH target AS (
			SELECT g.id, g.plant_id, g.meeting_id, coalesce(g.rsvp, 'pending') AS rsvp FROM participation g
			JOIN meeting m ON m.id = g.meeting_id JOIN person p ON p.id = g.person_id
			WHERE g.rsvp_token_hash = ${rsvpTokenDigest(token)} AND g.rsvp_token_open AND g.rsvp_token_expires_at > clock_timestamp()
			AND g.removed_at IS NULL AND ${meetingOpenSql("m")} AND p.state = 'live' AND ${plantVisible(sql`g.plant_id`)}
			FOR UPDATE OF g
		), answered AS (
			UPDATE participation g SET rsvp = ${rsvp}, rsvp_source = 'token', rsvp_at = clock_timestamp(), rsvp_token_open = false,
				revision = g.revision + 1 FROM target t WHERE g.id = t.id RETURNING g.id
		), audit AS (
			INSERT INTO audit_event (tenant_id, system_cause, action, kind, subject_type, subject_id, before_value, after_value, metadata)
			SELECT t.plant_id, 'rsvp_token', 'meetings.rsvp_recorded', 'edit', 'participation', t.id,
				jsonb_build_object('rsvp', t.rsvp, 'tokenOpen', true), jsonb_build_object('rsvp', ${rsvp}::text, 'tokenOpen', false),
				jsonb_build_object('meetingId', t.meeting_id, 'source', 'token') FROM target t RETURNING 1
		)
		SELECT (SELECT count(*) FROM answered)::int AS answered`);
	const row = z.object({ answered: z.number().int() }).parse(r.rows[0]);
	if (!row.answered) return refused("token_closed");
	return {
		status: "ok" as const,
		value: c.rsvpTokenAnswer.parse({ rsvp }),
	};
}
