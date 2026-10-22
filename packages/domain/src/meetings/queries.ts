import * as c from "@everyfield/contracts/meetings";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { deny, one, parse, read, type Reader } from "./core.ts";
import { card, guest, guestColumns, guestRow } from "./guests.ts";
import { kitColumns, kitItem, kitRow } from "./meetings.ts";
import { agendaOf, detail, meetingColumns, meetingRow, plantMeeting, summary } from "./rows.ts";

// Every read is one statement that checks the reader's live access (C13) after the request's verified viewer names
// them (D59/D60). Members read; prayer and question notes are only in live Owner/Admin projections. Missing, foreign
// and deleted meetings read as unavailable.

const current = (plantId: string, meetingId: string) =>
	sql`${plantMeeting(plantId, meetingId)} AND m.retired_at IS NULL`;
const guests = (where: SQL) =>
	sql`(SELECT coalesce(json_agg(x ORDER BY x.person_name, x.id), '[]') FROM (SELECT ${guestColumns}
		WHERE g.meeting_id = m.id AND g.removed_at IS NULL AND ${where}) x)`;

export const meetingsReader = {
	/**
	 * Upcoming, past or all meetings (default all), optionally by type, status and Vision kit readiness. Page numbers in
	 * a stable order: upcoming soonest first, otherwise latest first, ties by ID. A page past the end is empty, with the
	 * total of the whole filter.
	 */
	async list(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.listMeetingsRequest, raw);
			const types = [...new Set(i.types)],
				statuses = [...new Set(i.statuses)];
			const unchecked = sql`EXISTS (SELECT FROM meeting_kit_item k WHERE k.meeting_id = m.id AND NOT k.checked)`;
			const order = i.window === "upcoming" ? sql`f.starts_at ASC, f.id ASC` : sql`f.starts_at DESC, f.id DESC`;
			const { row } = await one(
				db,
				v,
				sql`WITH f AS (SELECT m.id, m.starts_at FROM meeting m WHERE m.plant_id = ${v.plantId}::uuid AND m.retired_at IS NULL
					AND (cardinality(${sql.param(types)}::text[]) = 0 OR m.type = ANY(${sql.param(types)}::text[]))
					AND (cardinality(${sql.param(statuses)}::text[]) = 0 OR m.status = ANY(${sql.param(statuses)}::text[]))
					AND CASE ${i.window} WHEN 'upcoming' THEN m.starts_at >= clock_timestamp() WHEN 'past' THEN m.starts_at < clock_timestamp() ELSE true END
					AND CASE ${i.preparation} WHEN 'complete' THEN m.kit_version IS NOT NULL AND NOT ${unchecked}
						WHEN 'incomplete' THEN m.type = 'vision_meeting' AND (m.kit_version IS NULL OR ${unchecked}) ELSE true END),
				page AS (SELECT f.id, row_number() OVER (ORDER BY ${order}) AS n FROM f ORDER BY ${order}
					LIMIT ${i.limit} OFFSET ${(i.page - 1) * i.limit})
				SELECT (SELECT count(*) FROM f)::int AS total,
					(SELECT coalesce(json_agg(x ORDER BY x.n), '[]') FROM (SELECT ${meetingColumns}, page.n FROM page
						JOIN meeting m ON m.id = page.id) x) AS items`,
			);
			const page = z.object({ total: z.number().int(), items: z.array(meetingRow) }).parse(row);
			return c.meetingPage.parse({
				items: page.items.map(summary),
				page: i.page,
				total: page.total,
				next: i.page * i.limit < page.total ? i.page + 1 : null,
			});
		});
	},
	async get(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.meetingRequest, raw);
			const { row } = await one(
				db,
				v,
				sql`SELECT ${meetingColumns} FROM meeting m WHERE ${current(v.plantId, i.meetingId)}`,
			);
			return c.meetingResult.parse(
				row ? { status: "available", meeting: detail(meetingRow.parse(row)) } : { status: "unavailable" },
			);
		});
	},
	/** Whether any current meeting of these types exists, whatever a window or filter shows (REQ-MTG-001). */
	async hasHistory(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.hasHistoryRequest, raw);
			const types = [...new Set(i.types)];
			const { row } = await one(
				db,
				v,
				sql`SELECT EXISTS (SELECT FROM meeting m WHERE m.plant_id = ${v.plantId}::uuid AND m.retired_at IS NULL
					AND (cardinality(${sql.param(types)}::text[]) = 0 OR m.type = ANY(${sql.param(types)}::text[]))) AS found`,
			);
			return c.historyResult.parse({ hasHistory: z.boolean().parse(row?.found), types });
		});
	},
	async readAgenda(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.meetingRequest, raw);
			const { row } = await one(
				db,
				v,
				sql`SELECT ${meetingColumns} FROM meeting m WHERE ${current(v.plantId, i.meetingId)}`,
			);
			if (!row) deny();
			return agendaOf(meetingRow.parse(row));
		});
	},
	/** The kit as stored; a read never seeds a missing kit (REQ-MTG-006). */
	async listKit(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.meetingRequest, raw);
			const { row } = await one(
				db,
				v,
				sql`SELECT m.kit_version, (SELECT coalesce(json_agg(row_to_json(k) ORDER BY k.position), '[]') FROM (${kitColumns}
					WHERE k.meeting_id = m.id) k) AS items FROM meeting m WHERE ${current(v.plantId, i.meetingId)}`,
			);
			if (!row) deny();
			const f = z.object({ kit_version: z.number().int().nullable(), items: z.array(kitRow) }).parse(row);
			const items = f.items.map(kitItem);
			return c.kitResult.parse({
				meetingId: i.meetingId,
				version: f.kit_version,
				items,
				checked: items.filter((k) => k.checked).length,
				total: items.length,
			});
		});
	},
	async listGuests(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.meetingRequest, raw);
			const { row } = await one(
				db,
				v,
				sql`SELECT ${guests(sql`true`)} AS guests FROM meeting m WHERE ${current(v.plantId, i.meetingId)}`,
			);
			if (!row) deny();
			return c.guestList.parse({ meetingId: i.meetingId, guests: z.array(guestRow).parse(row.guests).map(guest) });
		});
	},
	/** Recorded Vision cards. Notes appear only for Owner/Admin. */
	async listCards(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.meetingRequest, raw);
			const { row, admin } = await one(
				db,
				v,
				sql`SELECT ${guests(sql`g.card_response IS NOT NULL`)} AS guests FROM meeting m WHERE ${current(v.plantId, i.meetingId)}`,
			);
			if (!row) deny();
			return c.cardList.parse({
				meetingId: i.meetingId,
				cards: z
					.array(guestRow)
					.parse(row.guests)
					.map((g) => card(g, admin)),
			});
		});
	},
	/**
	 * Card responses with attended guests as the denominator; an attended guest without a card is unknown. Cards from
	 * guests who did not attend are counted apart. Nothing here infers attendance, consent or commitment.
	 */
	async cardBreakdown(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.meetingRequest, raw);
			const { row } = await one(
				db,
				v,
				sql`SELECT coalesce(json_agg(json_build_object('attended', g.presence = 'attended', 'response', g.card_response)), '[]') AS rows
					FROM meeting m LEFT JOIN participation g ON g.meeting_id = m.id AND g.removed_at IS NULL
					WHERE ${current(v.plantId, i.meetingId)} GROUP BY m.id`,
			);
			if (!row) deny();
			const rows = z
				.array(z.object({ attended: z.boolean().nullable(), response: c.cardResponse.nullable() }))
				.parse(row.rows)
				.filter((r) => r.attended !== null);
			const tally = (list: typeof rows) =>
				Object.fromEntries(c.cardResponse.options.map((o) => [o, list.filter((r) => r.response === o).length]));
			const attended = rows.filter((r) => r.attended),
				absent = rows.filter((r) => !r.attended && r.response);
			return c.cardBreakdown.parse({
				meetingId: i.meetingId,
				attended: {
					total: attended.length,
					withCard: attended.filter((r) => r.response).length,
					unknown: attended.filter((r) => !r.response).length,
					responses: tally(attended),
				},
				absentWithCard: { total: absent.length, responses: tally(absent) },
			});
		});
	},
	/** Who invited each current guest and their canonical RSVP. There is no invitation tree (REQ-MTG-019). */
	async invitationAttribution(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.meetingRequest, raw);
			const { row } = await one(
				db,
				v,
				sql`SELECT ${guests(sql`true`)} AS guests FROM meeting m WHERE ${current(v.plantId, i.meetingId)}`,
			);
			if (!row) deny();
			return c.attribution.parse({
				meetingId: i.meetingId,
				guests: z
					.array(guestRow)
					.parse(row.guests)
					.map((g) => {
						const x = guest(g);
						return { guestId: x.id, person: x.person, inviter: x.inviter, rsvp: x.rsvp, rsvpSource: x.rsvpSource };
					}),
			});
		});
	},
	/** What an invitation composer needs (Owner/Admin): the meeting, its agenda and the live guests it may address. */
	async communicationContext(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.meetingRequest, raw);
			const { row } = await one(
				db,
				v,
				sql`SELECT ${meetingColumns}, (SELECT coalesce(json_agg(json_build_object('guestId', g.id, 'personId', p.id,
						'displayName', p.display_name, 'hasEmail', p.email IS NOT NULL, 'rsvp', coalesce(g.rsvp, 'pending'))
						ORDER BY p.display_name, g.id), '[]') FROM participation g JOIN person p ON p.id = g.person_id
						WHERE g.meeting_id = m.id AND g.removed_at IS NULL AND p.state = 'live') AS recipients
					FROM meeting m WHERE ${current(v.plantId, i.meetingId)}`,
				true,
			);
			if (!row) deny();
			const m = meetingRow.parse(row);
			return c.communicationContext.parse({ meeting: summary(m), agenda: m.agenda, guests: row.recipients });
		});
	},
	/**
	 * Distinct practices actually held: completed, held at or before now and not voided. A deleted genuine practice still
	 * counts; scheduled, future, cancelled, not held and voided ones never do (REQ-KNOW-041/042/044/045).
	 */
	async listCompletedPreLaunchPractices(db: Reader, authority: RequestActor) {
		return read(authority, async (v) => {
			const { row } = await one(
				db,
				v,
				sql`SELECT coalesce(array_agg(m.id ORDER BY m.actual_occurrence_at, m.id), '{}') AS ids FROM meeting m
					WHERE m.plant_id = ${v.plantId}::uuid AND m.type = 'prelaunch_practice' AND m.status = 'completed'
					AND m.actual_occurrence_at <= clock_timestamp() AND m.occurrence_voided_at IS NULL`,
			);
			const ids = z.array(z.uuid()).parse(row?.ids);
			return c.completedPractices.parse({
				meetingIds: ids,
				count: ids.length,
				criterion: ids.length >= 3 ? "met" : "not_met",
			});
		});
	},
	/** The signed-in member's own answer for a meeting they are a guest of, through their account-linked live Person. */
	async getOwnRsvp(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (v) => {
			const i = parse(c.meetingRequest, raw);
			const { row } = await one(
				db,
				v,
				sql`SELECT g.id, g.revision::text AS revision, coalesce(g.rsvp, 'pending') AS rsvp, m.status
					FROM meeting m JOIN participation g ON g.meeting_id = m.id AND g.removed_at IS NULL
					JOIN person p ON p.id = g.person_id AND p.linked_account_id = ${v.accountId}::uuid AND p.state = 'live'
					WHERE ${current(v.plantId, i.meetingId)}`,
			);
			if (!row) deny();
			const g = z.object({ id: z.uuid(), revision: z.string(), rsvp: c.rsvp, status: c.meetingStatus }).parse(row);
			return c.ownRsvp.parse({
				meetingId: i.meetingId,
				guestId: g.id,
				rsvp: g.rsvp,
				responseAllowed: ["planning", "ready", "in_progress"].includes(g.status),
				revision: g.revision,
			});
		});
	},
};
