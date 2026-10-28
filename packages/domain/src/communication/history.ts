import { randomUUID } from "node:crypto";
import { sql, type SQL } from "@everyfield/db/query";
import * as c from "@everyfield/contracts/communication";
import type { RequestActor } from "../access/session.ts";
import { liveRead } from "../access/session.ts";
import { addressAad, openText, type DeliveryKeys } from "./delivery.ts";
import {
	administers,
	command,
	deny,
	hash,
	parse,
	readerOf,
	type Command,
	type CommunicationContext,
	type Tx,
} from "./core.ts";
import { z } from "zod";

const HUB = ["draft", "scheduled", "sending", "sent", "logged", "cancelled", "failed", "unknown"] as const;
const one = (result: { rows: unknown[] }) => result.rows[0];
const asJson = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);
const STAMP = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

type Reader = { session: string; accountId: string; plantId: string; seatId: string; role: Command["actor"]["role"] };

function accessOf(authority: RequestActor) {
	const reader = readerOf(authority);
	return {
		reader,
		access: { session: reader.session, owner: reader.owner, seatId: reader.seatId, role: reader.role },
	};
}
function sessionActor(reader: Reader, admin: boolean) {
	return sql`EXISTS (SELECT 1 FROM live_session(${reader.session}::uuid) i
		JOIN account a ON a.id = i.account_id AND a.id = ${reader.accountId}::uuid AND a.auth_user_id IS NOT NULL
		JOIN seat st ON st.account_id = a.id AND st.id = ${reader.seatId}::uuid AND st.plant_id = ${reader.plantId}::uuid
			AND st.ended_at IS NULL AND st.accepted_at <= clock_timestamp() AND st.role = ${reader.role}
			AND (${admin}::boolean = false OR st.role <> 'member')
		WHERE i.registration_state = 'active' AND i.expires_at > clock_timestamp())`;
}
function allowed(
	access: { session: string; owner: ReturnType<typeof readerOf>["owner"]; seatId: string; role: Reader["role"] },
	reader: Reader,
	admin: boolean,
) {
	return sql`${liveRead(access, admin)} AND ${sessionActor(reader, admin)}`;
}
function actorBound(actor: Command["actor"], session: string) {
	return sessionActor(
		{ session, accountId: actor.accountId, plantId: actor.plantId, seatId: actor.seatId, role: actor.role },
		false,
	);
}
function writeBound(actor: Command["actor"], session: string) {
	return sessionActor(
		{ session, accountId: actor.accountId, plantId: actor.plantId, seatId: actor.seatId, role: actor.role },
		true,
	);
}
function requireAllowed(value: boolean) {
	if (value !== true) deny("access_denied");
}
function whenLive(live: SQL, query: SQL) {
	return sql`SELECT g.allowed, q.* FROM (SELECT ${live} AS allowed) g LEFT JOIN LATERAL (${query}) q ON g.allowed`;
}
function limitOf(value: unknown, fallback = 50) {
	const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
	if (!Number.isInteger(n) || n < 1) return fallback;
	return Math.min(n, 100);
}
function textOrNull(value: unknown) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text ? text.slice(0, 200) : null;
}
function stateOrNull(value: unknown) {
	return typeof value === "string" && (HUB as readonly string[]).includes(value) ? value : null;
}
function uuidOrNull(value: unknown) {
	return typeof value === "string" && z.uuid().safeParse(value).success ? value : null;
}
function channelIncludes(value: unknown) {
	if (value == null || value === "") return true;
	return typeof value === "string" && value.trim().toLowerCase() === "email";
}
function decodeCursor(value: unknown) {
	if (typeof value !== "string" || value.length < 1 || value.length > 200) return { epoch: null, id: null };
	let text = "";
	try {
		text = Buffer.from(value, "base64url").toString("utf8");
	} catch {
		return { epoch: null, id: null };
	}
	const cut = text.lastIndexOf("|");
	if (cut <= 0) return { epoch: null, id: null };
	const epoch = text.slice(0, cut);
	const id = text.slice(cut + 1);
	if (!/^\d+(\.\d+)?$/.test(epoch) || !z.uuid().safeParse(id).success) return { epoch: null, id: null };
	return { epoch, id };
}
function encodeCursor(epoch: string, id: string) {
	return Buffer.from(`${epoch}|${id}`).toString("base64url");
}
function stamp(column: SQL) {
	return sql`to_char(${column} AT TIME ZONE 'UTC', ${STAMP})`;
}
function mailOn(plantId: string) {
	return sql`m.tenant_id = ${plantId}::uuid AND m.purpose = 'communication' AND m.logical_key LIKE 'communication/' || c.id::text || '/%'`;
}
function hubState(plantId: string) {
	const on = mailOn(plantId);
	return sql`CASE
		WHEN c.state = 'draft' THEN 'draft'
		WHEN EXISTS (SELECT 1 FROM mail m WHERE ${on} AND (m.sent_at IS NOT NULL OR m.delivered_at IS NOT NULL OR m.state = 'sent')) THEN 'sent'
		WHEN EXISTS (SELECT 1 FROM mail m WHERE ${on} AND m.state = 'dispatched' AND m.sent_at IS NULL AND m.delivered_at IS NULL) THEN 'sending'
		WHEN EXISTS (SELECT 1 FROM mail m WHERE ${on} AND (m.state IN ('refused', 'failed') OR m.bounced_at IS NOT NULL))
			AND NOT EXISTS (SELECT 1 FROM mail m WHERE ${on} AND m.state NOT IN ('refused', 'failed', 'cancelled') AND m.bounced_at IS NULL) THEN 'failed'
		WHEN EXISTS (SELECT 1 FROM mail m WHERE ${on} AND m.state = 'cancelled')
			AND NOT EXISTS (SELECT 1 FROM mail m WHERE ${on} AND m.state <> 'cancelled') THEN 'cancelled'
		WHEN EXISTS (SELECT 1 FROM mail m WHERE ${on} AND m.state IN ('unknown', 'pending', 'dispatched')) THEN 'unknown'
		WHEN c.state = 'scheduled' THEN 'scheduled'
		ELSE 'unknown'
	END`;
}
function reachableSql(plantId: string) {
	return sql`(SELECT count(*)::int FROM mail m
		JOIN person p ON p.id = m.recipient_person_id AND p.tenant_id = m.tenant_id
		WHERE ${mailOn(plantId)} AND p.state = 'live' AND p.email IS NOT NULL AND btrim(p.email) <> ''
			AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.address_hash = m.address_hash AND s.cleared_at IS NULL))`;
}
function sentAtSql(plantId: string) {
	return stamp(sql`(SELECT min(coalesce(m.sent_at, m.accepted_at, m.delivered_at)) FROM mail m WHERE ${mailOn(plantId)})`);
}
function senderSql() {
	return sql`(SELECT p.display_name FROM person p WHERE p.linked_account_id = c.author_id AND p.tenant_id = c.plant_id AND p.state = 'live' ORDER BY p.id LIMIT 1)`;
}
function deliveredSql(plantId: string) {
	return sql`(SELECT count(*)::int FROM mail m WHERE ${mailOn(plantId)} AND m.delivered_at IS NOT NULL)`;
}

const rawItem = z.object({
	id: z.uuid(),
	subject: z.string().nullable(),
	meetingId: z.uuid().nullable(),
	createdAt: z.string(),
	epoch: z.string(),
	hubState: z.enum(HUB),
	reachable: z.number().int(),
	delivered: z.number().int(),
	scheduledAt: z.string().nullable(),
	sentAt: z.string().nullable(),
	senderName: z.string().nullable(),
});
const rawPage = z.object({ asOf: z.string(), items: z.array(rawItem) });

function pageValue(limit: number, payload: z.infer<typeof rawPage>) {
	const extra = payload.items.length > limit;
	const kept = payload.items.slice(0, limit);
	const items = kept.map((row) => ({
		id: row.id,
		subject: row.subject,
		state: row.hubState,
		channel: "email" as const,
		meetingId: row.meetingId,
		createdAt: row.createdAt,
		countsAsSent: row.hubState === "sent",
		rate: row.reachable > 0 ? row.delivered / row.reachable : null,
		reachable: row.reachable,
		delivered: row.delivered,
		scheduledAt: row.scheduledAt,
		sentAt: row.sentAt,
		senderName: row.senderName,
	}));
	const reachable = items.reduce((sum, row) => sum + row.reachable, 0);
	const delivered = items.reduce((sum, row) => sum + row.delivered, 0);
	const last = kept.at(-1);
	return {
		items,
		nextCursor: extra && last ? encodeCursor(last.epoch, last.id) : null,
		visibleCount: items.length,
		asOf: payload.asOf,
		complete: !extra,
		limit,
		rate: reachable > 0 ? delivered / reachable : null,
		draftCountsAsSent: false as const,
		unknownCountsAsSent: false as const,
		foreignRows: [] as string[],
	};
}

function itemsJson(
	plantId: string,
	extra: SQL,
	limit: number,
	state: string | null,
	query: string | null,
	epoch: string | null,
	cursorId: string | null,
) {
	const stateSql = hubState(plantId);
	return sql`coalesce((
		SELECT jsonb_agg((to_jsonb(s) - 'sort_at') ORDER BY s.sort_at DESC, s.id DESC)
		FROM (
			SELECT * FROM (
				SELECT c.id, c.subject, c.meeting_id AS "meetingId",
					${stamp(sql`c.created_at`)} AS "createdAt",
					extract(epoch FROM c.created_at)::text AS epoch,
					c.created_at AS sort_at,
					${stateSql} AS "hubState",
					${reachableSql(plantId)} AS reachable,
					${deliveredSql(plantId)} AS delivered,
					${stamp(sql`c.scheduled_at`)} AS "scheduledAt",
					${sentAtSql(plantId)} AS "sentAt",
					${senderSql()} AS "senderName"
				FROM communication c
				WHERE c.plant_id = ${plantId}::uuid
					AND ${extra}
					AND (${query}::text IS NULL OR position(lower(${query}) in lower(coalesce(c.subject, '') || ' ' || coalesce(c.body_text, ''))) > 0)
					AND (${epoch}::text IS NULL OR c.created_at < to_timestamp(${epoch}::numeric)
						OR (c.created_at = to_timestamp(${epoch}::numeric) AND c.id < ${cursorId}::uuid))
			) raw
			WHERE ${state}::text IS NULL OR raw."hubState" = ${state}
			ORDER BY raw.sort_at DESC, raw.id DESC
			LIMIT ${limit + 1}
		) s
	), '[]'::jsonb)`;
}

async function readPage(
	tx: Tx,
	authority: RequestActor,
	limit: number,
	cursor: { epoch: string | null; id: string | null },
	state: string | null,
	query: string | null,
	include: boolean,
	found: SQL,
	extra: SQL,
) {
	const { reader, access } = accessOf(authority);
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT ${found} AS found,
					CASE WHEN ${found} THEN jsonb_build_object(
						'asOf', ${stamp(sql`clock_timestamp()`)},
						'items', CASE WHEN ${include}::boolean THEN ${itemsJson(reader.plantId, extra, limit, state, query, cursor.epoch, cursor.id)} ELSE '[]'::jsonb END
					) ELSE NULL END AS payload`,
			),
		),
	) as { allowed: boolean; found: boolean | null; payload: unknown };
	requireAllowed(raw.allowed);
	if (raw.found !== true) deny("not_found");
	return pageValue(limit, rawPage.parse(asJson(raw.payload)));
}

export async function listHistory(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.historyQuery, request ?? {});
	const { reader } = accessOf(authority);
	const meetingId = uuidOrNull(input.meetingId);
	const personId = uuidOrNull(input.personId);
	const page = await readPage(
		tx,
		authority,
		limitOf(input.limit),
		decodeCursor(input.cursor),
		stateOrNull(input.state),
		textOrNull(input.query),
		channelIncludes(input.channel),
		sql`true`,
		sql`(${meetingId}::uuid IS NULL OR c.meeting_id = ${meetingId}::uuid)
			AND (${personId}::uuid IS NULL OR jsonb_exists(c.audience->'personIds', ${personId}::text)
				OR EXISTS (SELECT 1 FROM mail m WHERE ${mailOn(reader.plantId)} AND m.recipient_person_id = ${personId}::uuid))`,
	);
	return c.historyPage.parse(page);
}

export async function listForMeeting(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.meetingHistoryRequest, request);
	const plantId = accessOf(authority).reader.plantId;
	const page = await readPage(
		tx,
		authority,
		limitOf(input.limit),
		decodeCursor(input.cursor),
		null,
		null,
		true,
		sql`EXISTS (SELECT 1 FROM meeting parent WHERE parent.id = ${input.meetingId}::uuid AND parent.plant_id = ${plantId}::uuid)`,
		sql`c.meeting_id = ${input.meetingId}::uuid`,
	);
	return c.meetingHistoryResult.parse({ ...page, meetingId: input.meetingId });
}

const contactRow = z.object({
	outcomeId: z.uuid(),
	outcome: z.enum(["contacted", "attempted_no_contact", "administrative_completion", "no_longer_needed"]),
	occurredAt: z.string(),
	voided: z.boolean(),
	taskId: z.uuid().nullable(),
});

export async function listForPerson(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.personHistoryRequest, request);
	const { reader, access } = accessOf(authority);
	const limit = limitOf(input.limit);
	const cursor = decodeCursor(input.cursor);
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT
					EXISTS (SELECT 1 FROM person parent WHERE parent.id = ${input.personId}::uuid AND parent.tenant_id = ${reader.plantId}::uuid) AS found,
					CASE WHEN EXISTS (SELECT 1 FROM person parent WHERE parent.id = ${input.personId}::uuid AND parent.tenant_id = ${reader.plantId}::uuid)
					THEN jsonb_build_object(
						'asOf', ${stamp(sql`clock_timestamp()`)},
						'items', ${itemsJson(
							reader.plantId,
							sql`(jsonb_exists(c.audience->'personIds', ${input.personId}::text)
								OR EXISTS (SELECT 1 FROM mail m WHERE ${mailOn(reader.plantId)} AND m.recipient_person_id = ${input.personId}::uuid))`,
							limit,
							null,
							null,
							cursor.epoch,
							cursor.id,
						)},
						'lastConfirmedContactAt', (
							SELECT ${stamp(sql`max(o.occurred_at)`)} FROM contact_outcome o
							WHERE o.plant_id = ${reader.plantId}::uuid AND o.person_id = ${input.personId}::uuid
								AND o.voided_at IS NULL AND o.outcome = 'contacted'
						),
						'contacts', coalesce((
							SELECT jsonb_agg(jsonb_build_object(
								'outcomeId', o.id, 'outcome', o.outcome, 'occurredAt', ${stamp(sql`o.occurred_at`)},
								'voided', o.voided_at IS NOT NULL, 'taskId', o.task_id
							) ORDER BY o.recorded_at DESC, o.id DESC)
							FROM contact_outcome o
							WHERE o.plant_id = ${reader.plantId}::uuid AND o.person_id = ${input.personId}::uuid
						), '[]'::jsonb)
					) ELSE NULL END AS payload`,
			),
		),
	) as { allowed: boolean; found: boolean | null; payload: unknown };
	requireAllowed(raw.allowed);
	if (raw.found !== true) deny("not_found");
	const payload = z
		.object({
			asOf: z.string(),
			items: z.array(rawItem),
			lastConfirmedContactAt: z.string().nullable(),
			contacts: z.array(contactRow),
		})
		.parse(asJson(raw.payload));
	return c.personHistoryResult.parse({
		...pageValue(limit, payload),
		personId: input.personId,
		lastConfirmedContactAt: payload.lastConfirmedContactAt,
		contacts: payload.contacts,
	});
}

const totalsShape = z.object({
	state: z.enum(HUB),
	selected: z.number().int(),
	reachable: z.number().int(),
	attempted: z.number().int(),
	accepted: z.number().int(),
	sent: z.number().int(),
	delivered: z.number().int(),
	opened: z.number().int(),
	clicked: z.number().int(),
	bounced: z.number().int(),
	failed: z.number().int(),
	suppressed: z.number().int(),
	unknown: z.number().int(),
	asOf: z.string(),
	outcomes: z.array(z.enum(["accepted", "unknown", "rejected"])),
	sentForAll: z.boolean(),
});

export async function getDeliveryTotals(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.deliveryTotalsRequest, request);
	const { reader, access } = accessOf(authority);
	const on = mailOn(reader.plantId);
	const word = sql`CASE
		WHEN m.bounced_at IS NOT NULL OR m.state IN ('refused', 'failed', 'cancelled') THEN 'rejected'
		WHEN m.state IN ('accepted', 'sent') OR m.delivered_at IS NOT NULL OR m.sent_at IS NOT NULL OR m.accepted_at IS NOT NULL THEN 'accepted'
		ELSE 'unknown'
	END`;
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT (c.id IS NOT NULL) AS found,
					CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
						'state', ${hubState(reader.plantId)},
						'selected', GREATEST(
							(SELECT count(*)::int FROM mail m WHERE ${on}),
							jsonb_array_length(coalesce(c.audience->'personIds', '[]'::jsonb))
						),
						'reachable', CASE WHEN (SELECT count(*) FROM mail m WHERE ${on}) > 0 THEN ${reachableSql(reader.plantId)}
							ELSE (SELECT count(*)::int FROM person p
								WHERE p.tenant_id = c.plant_id AND p.state = 'live' AND p.email IS NOT NULL AND btrim(p.email) <> ''
									AND jsonb_exists(c.audience->'personIds', p.id::text)) END,
						'attempted', (SELECT count(*)::int FROM mail m WHERE ${on} AND m.state NOT IN ('pending', 'scheduled')),
						'accepted', (SELECT count(*)::int FROM mail m WHERE ${on} AND m.bounced_at IS NULL AND m.state NOT IN ('refused', 'failed')
							AND (m.state IN ('accepted', 'sent') OR m.accepted_at IS NOT NULL)),
						'sent', (SELECT count(*)::int FROM mail m WHERE ${on} AND (m.state = 'sent' OR m.sent_at IS NOT NULL)),
						'delivered', ${deliveredSql(reader.plantId)},
						'opened', (SELECT count(*)::int FROM mail m WHERE ${on} AND m.opened_at IS NOT NULL),
						'clicked', (SELECT count(*)::int FROM mail m WHERE ${on} AND m.clicked_at IS NOT NULL),
						'bounced', (SELECT count(*)::int FROM mail m WHERE ${on} AND m.bounced_at IS NOT NULL),
						'failed', (SELECT count(*)::int FROM mail m WHERE ${on} AND m.state IN ('refused', 'failed')),
						'suppressed', (SELECT count(*)::int FROM mail m WHERE ${on} AND EXISTS (
							SELECT 1 FROM suppression s WHERE s.address_hash = m.address_hash AND s.cleared_at IS NULL)),
						'unknown', (SELECT count(*)::int FROM mail m WHERE ${on} AND m.state IN ('unknown', 'dispatched')
							AND m.sent_at IS NULL AND m.delivered_at IS NULL AND m.accepted_at IS NULL),
						'asOf', ${stamp(sql`clock_timestamp()`)},
						'outcomes', coalesce((
							SELECT jsonb_agg(w.word ORDER BY w.ord)
							FROM (
								SELECT DISTINCT ${word} AS word,
									CASE ${word} WHEN 'accepted' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END AS ord
								FROM mail m WHERE ${on}
							) w
						), '[]'::jsonb),
						'sentForAll', (SELECT count(*) FROM mail m WHERE ${on}) > 0
							AND NOT EXISTS (SELECT 1 FROM mail m WHERE ${on} AND m.state <> 'sent' AND m.delivered_at IS NULL)
					) END AS payload
				FROM (SELECT 1) seed
				LEFT JOIN communication c ON c.id = ${input.communicationId}::uuid AND c.plant_id = ${reader.plantId}::uuid`,
			),
		),
	) as { allowed: boolean; found: boolean | null; payload: unknown };
	requireAllowed(raw.allowed);
	if (raw.found !== true) deny("not_found");
	const totals = totalsShape.parse(asJson(raw.payload));
	return c.deliveryTotalsResult.parse({
		communicationId: input.communicationId,
		...totals,
		rate: totals.reachable > 0 ? totals.delivered / totals.reachable : null,
	});
}

const detailShape = z.object({
	id: z.uuid(),
	revision: z.string(),
	state: z.enum(c.communicationStates),
	subject: z.string().nullable(),
	bodyHtml: z.string().nullable(),
	bodyText: z.string().nullable(),
	meetingId: z.uuid().nullable(),
	scheduledAt: z.string().nullable(),
	sentAt: z.string().nullable(),
	senderName: z.string().nullable(),
	recipients: z.array(
		z.object({
			personId: z.uuid().nullable(),
			mailId: z.uuid(),
			sealedAddress: z.string().nullable(),
			currentEmail: z.string().nullable(),
			deliveryStatus: z.string(),
			sentAt: z.string().nullable(),
			deliveredAt: z.string().nullable(),
			openedAt: z.string().nullable(),
			clickedAt: z.string().nullable(),
		}),
	),
});

export async function getDetail(tx: Tx, authority: RequestActor, request: unknown, keys?: DeliveryKeys) {
	const input = parse(c.recordRequest, request);
	const { reader, access } = accessOf(authority);
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT (c.id IS NOT NULL) AS found,
					CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
						'id', c.id, 'revision', c.revision::text, 'state', c.state, 'subject', c.subject,
						'bodyHtml', c.body_html, 'bodyText', c.body_text, 'meetingId', c.meeting_id,
						'scheduledAt', ${stamp(sql`c.scheduled_at`)}, 'sentAt', ${sentAtSql(reader.plantId)}, 'senderName', ${senderSql()},
						'recipients', coalesce((
							SELECT jsonb_agg(jsonb_build_object(
								'personId', m.recipient_person_id, 'mailId', m.id,
								'sealedAddress', m.recipient_address_encrypted, 'currentEmail', p.email,
								'deliveryStatus', CASE WHEN m.delivered_at IS NOT NULL THEN 'delivered' ELSE m.state END,
								'sentAt', ${stamp(sql`m.sent_at`)}, 'deliveredAt', ${stamp(sql`m.delivered_at`)},
								'openedAt', ${stamp(sql`m.opened_at`)}, 'clickedAt', ${stamp(sql`m.clicked_at`)}
							) ORDER BY m.created_at, m.id)
							FROM mail m
							LEFT JOIN person p ON p.id = m.recipient_person_id AND p.tenant_id = m.tenant_id
							WHERE m.tenant_id = c.plant_id AND m.purpose = 'communication'
								AND m.logical_key LIKE 'communication/' || c.id::text || '/%'
						), '[]'::jsonb)
					) END AS payload
				FROM (SELECT 1) seed
				LEFT JOIN communication c ON c.id = ${input.id}::uuid AND c.plant_id = ${reader.plantId}::uuid`,
			),
		),
	) as { allowed: boolean; found: boolean | null; payload: unknown };
	requireAllowed(raw.allowed);
	if (raw.found !== true) deny("not_found");
	const row = detailShape.parse(asJson(raw.payload));
	const recipients = row.recipients.map((item) => ({
		personId: item.personId,
		deliveryAddress:
			keys && item.sealedAddress
				? openText(keys.encryptionKey, item.sealedAddress, addressAad(reader.plantId, item.mailId))
				: null,
		currentPersonAddress: item.currentEmail,
		deliveryStatus: item.deliveryStatus,
		sentAt: item.sentAt,
		deliveredAt: item.deliveredAt,
		openedAt: item.openedAt,
		clickedAt: item.clickedAt,
	}));
	const first = recipients[0];
	return c.detailResult.parse({
		communicationId: row.id,
		revision: row.revision,
		state: row.state,
		subject: row.subject,
		bodyHtml: row.bodyHtml,
		bodyText: row.bodyText,
		meetingId: row.meetingId,
		scheduledAt: row.scheduledAt,
		sentAt: row.sentAt,
		senderName: row.senderName,
		deliveryAddress: first?.deliveryAddress ?? null,
		currentPersonAddress: first?.currentPersonAddress ?? null,
		deliveryStatus: first?.deliveryStatus ?? null,
		recipients,
	});
}

export async function listHistoryRecipients(tx: Tx, authority: RequestActor, request: unknown, keys?: DeliveryKeys) {
	const input = parse(c.recipientHistoryRequest, request);
	const { reader, access } = accessOf(authority);
	const limit = limitOf(input.limit);
	const cursor = decodeCursor(input.cursor);
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT
					EXISTS (SELECT 1 FROM communication c WHERE c.id = ${input.communicationId}::uuid AND c.plant_id = ${reader.plantId}::uuid) AS found,
					coalesce((
						SELECT jsonb_agg(to_jsonb(s) ORDER BY s.epoch, s."mailId")
						FROM (
							SELECT m.recipient_person_id AS "personId", p.display_name AS name, m.id AS "mailId",
								CASE WHEN m.delivered_at IS NOT NULL THEN 'delivered' ELSE m.state END AS "deliveryStatus",
								m.recipient_address_encrypted AS sealed,
								extract(epoch FROM m.created_at)::text AS epoch
							FROM mail m
							LEFT JOIN person p ON p.id = m.recipient_person_id AND p.tenant_id = m.tenant_id
							WHERE m.tenant_id = ${reader.plantId}::uuid AND m.purpose = 'communication'
								AND m.logical_key LIKE 'communication/' || ${input.communicationId}::text || '/%'
								AND (${cursor.epoch}::text IS NULL OR m.created_at > to_timestamp(${cursor.epoch}::numeric)
									OR (m.created_at = to_timestamp(${cursor.epoch}::numeric) AND m.id > ${cursor.id}::uuid))
							ORDER BY m.created_at, m.id
							LIMIT ${limit + 1}
						) s
					), '[]'::jsonb) AS items`,
			),
		),
	) as { allowed: boolean; found: boolean | null; items: unknown };
	requireAllowed(raw.allowed);
	if (raw.found !== true) deny("not_found");
	const rows = z
		.array(
			z.object({
				personId: z.uuid().nullable(),
				name: z.string().nullable(),
				mailId: z.uuid(),
				deliveryStatus: z.string(),
				sealed: z.string().nullable(),
				epoch: z.string(),
			}),
		)
		.parse(asJson(raw.items));
	const extra = rows.length > limit;
	const kept = rows.slice(0, limit);
	const last = kept.at(-1);
	return c.recipientHistoryResult.parse({
		communicationId: input.communicationId,
		items: kept.map((row) => ({
			personId: row.personId,
			name: row.name,
			deliveryStatus: row.deliveryStatus,
			deliveryAddress:
				keys && row.sealed ? openText(keys.encryptionKey, row.sealed, addressAad(reader.plantId, row.mailId)) : null,
		})),
		nextCursor: extra && last ? encodeCursor(last.epoch, last.mailId) : null,
		complete: !extra,
	});
}

export async function listMeetingTracking(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.meetingHistoryRequest, request);
	const { reader, access } = accessOf(authority);
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT
					EXISTS (SELECT 1 FROM meeting parent WHERE parent.id = ${input.meetingId}::uuid AND parent.plant_id = ${reader.plantId}::uuid) AS found,
					coalesce((
						SELECT jsonb_agg(jsonb_build_object(
							'personId', p.id, 'name', p.display_name,
							'deliveryStatus', CASE WHEN m.delivered_at IS NOT NULL THEN 'delivered' ELSE m.state END
						) ORDER BY p.display_name, p.id)
						FROM communication c
						JOIN mail m ON m.tenant_id = c.plant_id AND m.purpose = 'communication'
							AND m.logical_key LIKE 'communication/' || c.id::text || '/%'
						JOIN person p ON p.id = m.recipient_person_id AND p.tenant_id = m.tenant_id
						WHERE c.plant_id = ${reader.plantId}::uuid AND c.meeting_id = ${input.meetingId}::uuid
					), '[]'::jsonb) AS items`,
			),
		),
	) as { allowed: boolean; found: boolean | null; items: unknown };
	requireAllowed(raw.allowed);
	if (raw.found !== true) deny("not_found");
	return c.meetingTrackingResult.parse({ meetingId: input.meetingId, items: asJson(raw.items), complete: true });
}

export async function getExecutionResult(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.executionRequest, request);
	const { reader, access } = accessOf(authority);
	const bucket = sql`CASE
		WHEN m.bounced_at IS NOT NULL OR m.state IN ('refused', 'failed', 'cancelled') THEN 'refused'
		WHEN m.state IN ('unknown', 'dispatched', 'pending') AND m.accepted_at IS NULL AND m.sent_at IS NULL AND m.delivered_at IS NULL THEN 'unknown'
		WHEN m.state IN ('accepted', 'sent') OR m.accepted_at IS NOT NULL OR m.sent_at IS NOT NULL OR m.delivered_at IS NOT NULL THEN 'accepted'
		ELSE 'unknown'
	END`;
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT (c.id IS NOT NULL) AS found,
					CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
						'accepted', (SELECT count(*)::int FROM mail m WHERE ${mailOn(reader.plantId)} AND ${bucket} = 'accepted'),
						'refused', (SELECT count(*)::int FROM mail m WHERE ${mailOn(reader.plantId)} AND ${bucket} = 'refused'),
						'unknown', (SELECT count(*)::int FROM mail m WHERE ${mailOn(reader.plantId)} AND ${bucket} = 'unknown')
					) END AS payload
				FROM (SELECT 1) seed
				LEFT JOIN communication c ON c.id = ${input.communicationId}::uuid AND c.plant_id = ${reader.plantId}::uuid`,
			),
		),
	) as { allowed: boolean; found: boolean | null; payload: unknown };
	requireAllowed(raw.allowed);
	if (raw.found !== true) deny("not_found");
	const counts = z
		.object({ accepted: z.number().int(), refused: z.number().int(), unknown: z.number().int() })
		.parse(asJson(raw.payload));
	const status =
		counts.accepted === 0 && counts.unknown === 0 && counts.refused > 0
			? "failed"
			: counts.accepted === 0 && counts.refused === 0
				? "unknown"
				: counts.refused === 0 && counts.unknown === 0
					? "accepted"
					: "partial";
	return c.executionResult.parse({ communicationId: input.communicationId, status, ...counts });
}

const resendPerson = z.object({ id: z.uuid(), name: z.string(), eligible: z.boolean() });
const resendLoad = z.object({
	communication: z
		.object({
			id: z.uuid(),
			subject: z.string().nullable(),
			body_html: z.string().nullable(),
			body_text: z.string().nullable(),
			meeting_id: z.uuid().nullable(),
		})
		.nullable(),
	people: z.array(resendPerson),
	confirmed: z.boolean(),
});

function resendDoc(plantId: string, communicationId: string, selection: string) {
	const eligible = sql`(
		p.state = 'live' AND p.email IS NOT NULL AND btrim(p.email) <> ''
		AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.address_hash = m.address_hash AND s.cleared_at IS NULL)
		AND (
			(${selection} = 'delivered_nonopeners' AND m.delivered_at IS NOT NULL AND m.opened_at IS NULL
				AND m.clicked_at IS NULL AND m.sent_at IS NOT NULL AND m.sent_at <= clock_timestamp() - interval '24 hours')
			OR (${selection} = 'proven_failed' AND m.delivered_at IS NULL AND m.state <> 'unknown'
				AND (m.state IN ('refused', 'failed') OR m.bounced_at IS NOT NULL))
		)
	)`;
	return sql`jsonb_build_object(
		'communication', jsonb_build_object(
			'id', c.id, 'subject', c.subject, 'body_html', c.body_html, 'body_text', c.body_text, 'meeting_id', c.meeting_id
		),
		'confirmed', EXISTS (
			SELECT 1 FROM mail d
			WHERE d.tenant_id = c.plant_id AND d.purpose = 'communication'
				AND d.logical_key LIKE 'communication/' || c.id::text || '/%' AND d.delivered_at IS NOT NULL
		),
		'people', coalesce((
			SELECT jsonb_agg(jsonb_build_object('id', picked.id, 'name', picked.name, 'eligible', picked.eligible)
				ORDER BY picked.name, picked.id)
			FROM (
				SELECT DISTINCT ON (p.id) p.id, p.display_name AS name, ${eligible} AS eligible
				FROM mail m
				JOIN person p ON p.id = m.recipient_person_id AND p.tenant_id = m.tenant_id
				WHERE m.tenant_id = c.plant_id AND m.purpose = 'communication'
					AND m.logical_key = 'communication/' || c.id::text || '/' || p.id::text
				ORDER BY p.id, m.created_at DESC
			) picked
		), '[]'::jsonb)
	)`;
}

async function loadResend(
	tx: Tx,
	live: SQL,
	plantId: string,
	communicationId: string,
	selection: string,
	lock: boolean,
) {
	const raw = one(
		await tx.execute(
			whenLive(
				live,
				sql`SELECT ${resendDoc(plantId, communicationId, selection)} AS doc
					FROM communication c
					WHERE c.id = ${communicationId}::uuid AND c.plant_id = ${plantId}::uuid
					${lock ? sql`FOR UPDATE OF c` : sql``}`,
			),
		),
	) as { allowed: boolean; doc: unknown };
	requireAllowed(raw.allowed);
	if (raw.doc == null) deny("not_found");
	const loaded = resendLoad.parse(asJson(raw.doc));
	if (!loaded.communication) deny("not_found");
	return loaded;
}

function namesOf(people: z.infer<typeof resendPerson>[], eligible: boolean) {
	return people.filter((person) => person.eligible === eligible);
}

export async function listResendCandidates(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.resendCandidatesRequest, request);
	const { reader, access } = accessOf(authority);
	const loaded = await loadResend(
		tx,
		allowed(access, reader, true),
		reader.plantId,
		input.communicationId,
		input.selection,
		false,
	);
	const eligible = namesOf(loaded.people, true);
	return c.resendCandidatesResult.parse({
		communicationId: input.communicationId,
		selection: input.selection,
		eligibleIds: eligible.map((person) => person.id),
		eligibleNames: eligible.map((person) => person.name),
		excludedNames: namesOf(loaded.people, false).map((person) => person.name),
		openTrackingIsCertain: false,
		confirmedDelivery: loaded.confirmed,
	});
}

function pushEvent(
	cmd: Command,
	event: {
		id?: string;
		action: string;
		kind: string;
		subjectId: string;
		subjectType: string;
		before: Record<string, unknown> | null;
		after: Record<string, unknown> | null;
		reason?: string | null;
	},
) {
	cmd.events.push({
		id: event.id ?? randomUUID(),
		tenant_id: cmd.actor.plantId,
		actor_id: cmd.actor.accountId,
		actor_token: hash([cmd.actor.plantId, cmd.actor.accountId]),
		action: event.action,
		kind: event.kind,
		subject_type: event.subjectType,
		subject_id: event.subjectId,
		before_value: event.before,
		after_value: event.after,
		reason: event.reason ?? null,
		metadata: {},
	});
}

export async function executeResend(tx: Tx, context: CommunicationContext, raw: unknown) {
	const input = parse(c.executeResendRequest, raw);
	return command(tx, context, "communication.executeResend", input, async (cmd) => {
		if (!administers(cmd.actor)) deny("access_denied");
		const loaded = await loadResend(
			tx,
			writeBound(cmd.actor, context.session),
			cmd.actor.plantId,
			input.input.communicationId,
			input.input.selection,
			true,
		);
		const source = loaded.communication;
		if (!source) deny("not_found");
		const eligible = namesOf(loaded.people, true);
		if (eligible.length === 0) deny("invalid_subject");
		const id = randomUUID();
		const audience = { groups: [], teamIds: [], personIds: eligible.map((person) => person.id) };
		cmd.writes.push(
			sql`INSERT INTO communication (id, plant_id, author_id, revision, state, subject, body_html, body_text, template_source, meeting_id, audience)
				SELECT ${id}::uuid, ${cmd.actor.plantId}::uuid, ${cmd.actor.accountId}::uuid, 1, 'reviewed', ${source.subject},
					${source.body_html}, ${source.body_text}, ${`lineage:${source.id}`}, ${source.meeting_id}::uuid,
					${JSON.stringify(audience)}::jsonb
				WHERE ${writeBound(cmd.actor, context.session)}`,
		);
		pushEvent(cmd, {
			id: cmd.id,
			action: "communication.send_intended",
			kind: "resend",
			subjectType: "communication",
			subjectId: id,
			before: null,
			after: { state: "reviewed", template_source: `lineage:${source.id}`, audience },
		});
		return c.resendResult.parse({
			communicationId: id,
			newCommunications: 1,
			originalMutated: false,
			replayNewIntents: 0,
			openTrackingIsCertain: false,
			eligibleIds: audience.personIds,
			eligibleNames: eligible.map((person) => person.name),
		});
	});
}

const contactRead = z.object({
	found: z.boolean().nullable(),
	task_ok: z.boolean().nullable(),
	outcome_id: z.uuid().nullable(),
	outcome: z.string().nullable(),
	revision: z.string().nullable(),
	occurred_at: z.string().nullable(),
	db_now: z.string().nullable(),
	last_contact: z.string().nullable(),
});

export async function recordContactFromTask(tx: Tx, context: CommunicationContext, raw: unknown) {
	const input = parse(c.recordContactFromTaskRequest, raw);
	return command(tx, context, "communication.recordContactFromTask", input, async (cmd) => {
		const rawRow = one(
			await tx.execute(
				whenLive(
					actorBound(cmd.actor, context.session),
					sql`SELECT (t.id IS NOT NULL) AS found,
						(t.id IS NOT NULL AND t.status = 'complete' AND t.person_id IS NOT NULL AND t.deleted_at IS NULL AND t.parent_id IS NULL) AS task_ok,
						o.id AS outcome_id, o.outcome, o.revision::text AS revision,
						${stamp(sql`o.occurred_at`)} AS occurred_at,
						${stamp(sql`clock_timestamp()`)} AS db_now,
						(
							SELECT ${stamp(sql`max(x.occurred_at)`)} FROM contact_outcome x
							WHERE t.person_id IS NOT NULL AND x.plant_id = t.plant_id AND x.person_id = t.person_id
								AND x.voided_at IS NULL AND x.outcome = 'contacted'
						) AS last_contact
					FROM (SELECT 1) seed
					LEFT JOIN task t ON t.id = ${input.input.taskId}::uuid AND t.plant_id = ${cmd.actor.plantId}::uuid
					LEFT JOIN LATERAL (
						SELECT o.id, o.outcome, o.revision, o.occurred_at
						FROM contact_outcome o
						WHERE o.task_id = t.id AND o.plant_id = t.plant_id AND o.voided_at IS NULL
						ORDER BY o.recorded_at DESC, o.id DESC
						LIMIT 1
					) o ON true`,
				),
			),
		) as { allowed: boolean } & Record<string, unknown>;
		requireAllowed(rawRow.allowed);
		const row = contactRead.parse(rawRow);
		if (row.found !== true) deny("not_found");
		if (row.task_ok !== true || row.outcome_id == null || row.outcome !== "contacted") deny("invalid_subject");
		if (!row.occurred_at || !row.db_now || row.occurred_at > row.db_now) deny("invalid_input");
		pushEvent(cmd, {
			id: cmd.id,
			action: "followup.recorded",
			kind: "outcome",
			subjectType: "contact_outcome",
			subjectId: row.outcome_id,
			before: null,
			after: { outcome: "contacted", occurred_at: row.occurred_at, task_id: input.input.taskId },
		});
		return c.recordContactResult.parse({
			projectionRevision: row.revision,
			outcomeId: row.outcome_id,
			outcome: "contacted",
			lastConfirmedContactAt: row.last_contact ?? row.occurred_at,
		});
	});
}

const correctionRead = z.object({
	id: z.uuid(),
	revision: z.string(),
	person_id: z.uuid(),
	task_id: z.uuid().nullable(),
	outcome: z.enum(["contacted", "attempted_no_contact", "administrative_completion", "no_longer_needed"]),
	occurred_at: z.string(),
	voided: z.boolean(),
	author_id: z.uuid().nullable(),
	task_assignee: z.uuid().nullable(),
	task_live: z.boolean().nullable(),
	db_now: z.string(),
	others_contact: z.string().nullable(),
});

function laterContact(current: string | null, next: string | null) {
	return (
		[current, next]
			.filter((value): value is string => value != null)
			.sort()
			.at(-1) ?? null
	);
}

export async function correctContactLog(tx: Tx, context: CommunicationContext, raw: unknown) {
	const input = parse(c.correctContactLogRequest, raw);
	return command(tx, context, "communication.correctContactLog", input, async (cmd) => {
		const rawRow = one(
			await tx.execute(
				whenLive(
					actorBound(cmd.actor, context.session),
					sql`SELECT o.id, o.revision::text AS revision, o.person_id, o.task_id, o.outcome,
						${stamp(sql`o.occurred_at`)} AS occurred_at,
						o.voided_at IS NOT NULL AS voided,
						(
							SELECT a.actor_id FROM audit_event a
							WHERE a.tenant_id = o.plant_id AND a.subject_id = o.id AND a.action = 'followup.recorded'
							ORDER BY a.occurred_at, a.id
							LIMIT 1
						) AS author_id,
						t.assignee_id AS task_assignee,
						(t.id IS NOT NULL AND t.deleted_at IS NULL AND t.parent_id IS NULL) AS task_live,
						${stamp(sql`clock_timestamp()`)} AS db_now,
						(
							SELECT ${stamp(sql`max(x.occurred_at)`)} FROM contact_outcome x
							WHERE x.plant_id = o.plant_id AND x.person_id = o.person_id AND x.voided_at IS NULL
								AND x.outcome = 'contacted' AND x.id <> o.id
						) AS others_contact
					FROM contact_outcome o
					LEFT JOIN task t ON t.id = o.task_id AND t.plant_id = o.plant_id
					WHERE o.id = ${input.input.outcomeId}::uuid AND o.plant_id = ${cmd.actor.plantId}::uuid
					FOR UPDATE OF o`,
				),
			),
		) as { allowed: boolean; id?: string | null };
		requireAllowed(rawRow.allowed);
		if (rawRow.id == null) deny("not_found");
		const old = correctionRead.parse(rawRow);
		const own =
			old.task_id !== null &&
			old.task_live === true &&
			old.task_assignee === cmd.actor.accountId &&
			old.author_id === cmd.actor.accountId;
		if (!administers(cmd.actor) && !own) deny("access_denied");
		if (old.voided || old.revision !== input.expectedRevision) deny("conflict");
		const nextOutcome = input.input.outcome;
		const occurred = nextOutcome === "contacted" ? input.input.occurredAt : old.occurred_at;
		if (!occurred) deny("invalid_input");
		if (nextOutcome === "contacted" && !input.input.occurredAt) deny("invalid_input");
		if (occurred > old.db_now) deny("invalid_input");
		const nextId = randomUUID();
		const plant = cmd.actor.plantId;
		cmd.writes.push(
			sql`UPDATE contact_outcome SET voided_at = ${old.db_now}::timestamptz, revision = revision + 1
				WHERE id = ${old.id}::uuid AND plant_id = ${plant}::uuid AND revision = ${old.revision}::bigint
					AND ${actorBound(cmd.actor, context.session)}`,
		);
		cmd.writes.push(
			sql`INSERT INTO contact_outcome (id, plant_id, person_id, task_id, outcome, occurred_at, recorded_at, supersedes_id, revision, completes_task)
				SELECT ${nextId}::uuid, ${plant}::uuid, ${old.person_id}::uuid, ${old.task_id}::uuid, ${nextOutcome},
					${occurred}::timestamptz, ${old.db_now}::timestamptz, ${old.id}::uuid, 1, false
				WHERE ${occurred}::timestamptz <= ${old.db_now}::timestamptz AND ${actorBound(cmd.actor, context.session)}`,
		);
		if (old.outcome === "contacted" || nextOutcome === "contacted") {
			cmd.writes.push(
				sql`UPDATE plant SET material_revision = material_revision + 1
					WHERE id = ${plant}::uuid AND ${actorBound(cmd.actor, context.session)}`,
			);
		}
		pushEvent(cmd, {
			id: cmd.id,
			action: "followup.corrected",
			kind: "correct",
			subjectType: "contact_outcome",
			subjectId: nextId,
			before: { outcome: old.outcome, occurred_at: old.occurred_at },
			after: { outcome: nextOutcome, occurred_at: occurred, supersedes_id: old.id },
			reason: input.input.reason,
		});
		pushEvent(cmd, {
			action: "followup.corrected",
			kind: "supersede",
			subjectType: "contact_outcome",
			subjectId: old.id,
			before: { voided_at: null },
			after: { voided_at: old.db_now },
			reason: input.input.reason,
		});
		return c.contactCorrectionResult.parse({
			executionId: cmd.id,
			status: "corrected",
			affected: 1,
			excluded: 0,
			results: [
				{ outcomeId: old.id, outcome: old.outcome, voided: true },
				{ outcomeId: nextId, outcome: nextOutcome, voided: false },
			],
			correction: { supersedesId: old.id, outcomeId: nextId, outcome: nextOutcome, occurredAt: occurred },
			correlationId: cmd.id,
			lastConfirmedContactAt: laterContact(old.others_contact, nextOutcome === "contacted" ? occurred : null),
		});
	});
}
