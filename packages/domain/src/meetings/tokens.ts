import * as c from "@everyfield/contracts/meetings";
import type { Database } from "@everyfield/db/client";
import { sql, type SQLWrapper } from "@everyfield/db/query";
import { createHash, randomBytes } from "node:crypto";
import "server-only";
import { z } from "zod";
import { deny, parse, writer, type MeetingsContext, type Reader, type Tx } from "./core.ts";
import { displayTitle } from "./rows.ts";

// Public RSVP links (COM-010, REQ-MTG-009). The token is random, bound to one guest row (one meeting and one Person of
// one church), lives seven days and is stored only as its SHA-256. A newer token replaces the older one, so a guest has
// at most one live link. Opening a link reads only; an explicit answer sets the canonical RSVP and closes the link.

const TOKEN_DAYS = 7;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Mints the guest's RSVP token inside the caller's write: the invitation send or guest transaction that holds the
 * reviewed intent and records the audit row (no standalone token creation). Reads the guest under lock and queues the
 * token update into `writes`; the caller's one write statement applies it.
 */
export async function createRsvpToken(tx: Tx, ctx: MeetingsContext, raw: unknown, writes: SQLWrapper[]) {
	const input = parse(c.createRsvpTokenRequest, raw);
	const w = await writer(tx, ctx);
	if (!w.admin) deny();
	const r = await tx.execute(sql`SELECT g.id, g.revision::text AS revision, clock_timestamp() + make_interval(days => ${TOKEN_DAYS}) AS expires_at
		FROM participation g JOIN meeting m ON m.id = g.meeting_id JOIN person p ON p.id = g.person_id
		WHERE g.plant_id = ${w.plant.id}::uuid AND g.meeting_id = ${input.meetingId}::uuid AND g.person_id = ${input.personId}::uuid
		AND g.removed_at IS NULL AND p.state = 'live' AND m.retired_at IS NULL AND m.status IN ('planning', 'ready', 'in_progress')
		FOR UPDATE OF g`);
	if (!r.rows[0]) deny();
	const g = z.object({ id: z.uuid(), revision: z.string(), expires_at: z.coerce.date() }).parse(r.rows[0]);
	const token = randomBytes(32).toString("base64url");
	writes.push(sql`UPDATE participation SET rsvp_token_hash = ${digest(token)}, rsvp_token_expires_at = ${g.expires_at.toISOString()}::timestamptz,
		rsvp_token_open = true, revision = revision + 1 WHERE id = ${g.id}::uuid AND revision = ${g.revision}::bigint`);
	return c.rsvpTokenIssued.parse({ token, expiresAt: g.expires_at.toISOString(), guestId: g.id });
}

const viewRow = z.object({
	open: z.boolean(),
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
/** What the public page shows for a link: only the meeting basics and the guest's own answer. Never writes. */
export async function describeRsvpToken(db: Reader, raw: unknown) {
	const input = c.describeRsvpTokenRequest.safeParse(raw);
	if (!input.success) return c.rsvpTokenView.parse({ state: "unavailable" });
	const r = await db.execute(sql`SELECT g.rsvp_token_open AS open, g.rsvp_token_expires_at <= clock_timestamp() AS expired,
			coalesce(g.rsvp, 'pending') AS rsvp, p.first_name, p.display_name, m.title, m.type, m.vision_number, m.starts_at,
			m.local_date::text AS local_date, to_char(m.local_time, 'HH24:MI') AS local_time, m.timezone, m.venue_name, m.venue_address
		FROM participation g JOIN meeting m ON m.id = g.meeting_id JOIN person p ON p.id = g.person_id
		WHERE g.rsvp_token_hash = ${digest(input.data.token)} AND g.removed_at IS NULL AND m.retired_at IS NULL AND p.state = 'live'`);
	if (!r.rows[0]) return c.rsvpTokenView.parse({ state: "unavailable" });
	const v = viewRow.parse(r.rows[0]);
	return c.rsvpTokenView.parse({
		state: !v.open ? "answered" : v.expired ? "expired" : "pending",
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

/**
 * An explicit answer through a link: one statement locks the open, unexpired guest row, sets the canonical RSVP,
 * closes the link and writes the audit row. Of two concurrent answers the first wins; the second finds the link
 * closed. Attendance, cards, contacts and commitment are untouched. No session authority is used or granted.
 */
export async function answerRsvpToken(db: Database, raw: unknown) {
	const input = c.answerRsvpTokenRequest.safeParse(raw);
	if (!input.success)
		return {
			status: "refused" as const,
			error: c.meetingsError.parse({
				code: "invalid_input",
				details: { issues: input.error.issues.slice(0, 50).map((i) => ({ path: i.path.join("."), problem: i.message.slice(0, 200) })) },
				correlationId: crypto.randomUUID(),
				retry: "never",
			}),
		};
	const { token, rsvp } = input.data;
	const r = await db.execute(sql`WITH target AS (
			SELECT g.id, g.plant_id, g.meeting_id, coalesce(g.rsvp, 'pending') AS rsvp FROM participation g
			JOIN meeting m ON m.id = g.meeting_id JOIN person p ON p.id = g.person_id
			WHERE g.rsvp_token_hash = ${digest(token)} AND g.rsvp_token_open AND g.rsvp_token_expires_at > clock_timestamp()
			AND g.removed_at IS NULL AND m.retired_at IS NULL AND m.status IN ('planning', 'ready', 'in_progress') AND p.state = 'live'
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
		SELECT (SELECT rsvp FROM target) AS before, (SELECT count(*) FROM answered)::int AS answered,
			(SELECT count(*) FROM audit)::int AS audited`);
	const row = z.object({ before: c.rsvp.nullable(), answered: z.number().int() }).parse(r.rows[0]);
	if (!row.answered)
		return {
			status: "refused" as const,
			error: c.meetingsError.parse({ code: "token_closed", details: {}, correlationId: crypto.randomUUID(), retry: "never" }),
		};
	return {
		status: "ok" as const,
		value: c.rsvpTokenAnswer.parse({ rsvp, outcome: row.before === rsvp ? "noop" : "changed" }),
	};
}
