import {
	feedResult,
	markResult,
	readFeedRequest,
	readUnreadCountRequest,
	unreadCountResult,
	markAllVisibleReadRequest,
	markReadRequest,
	markSelectedReadRequest,
} from "@everyfield/contracts/notifications";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import {
	PAGE,
	RequestActor,
	accountOwner,
	audit,
	deny,
	jsonValue,
	noticeVisible,
	overdueSql,
	parse,
	readReply,
	runWrite,
	selfSql,
	type Tx,
} from "./core.ts";

const itemRow = z.object({
	id: z.uuid(),
	category: z.string(),
	title: z.string(),
	body: z.string().nullable(),
	eligibleAt: z.string(),
	read: z.boolean(),
	dueLocalDate: z.string().nullable(),
	overdue: z.boolean(),
	subject: z.unknown(),
	cursorAt: z.string(),
});
const pageRow = z.object({ account_id: z.uuid().nullable(), items: z.array(itemRow) });
const countRow = z.object({ account_id: z.uuid().nullable(), count: z.number().int() });
const markRow = z.object({
	me: z.uuid().nullable(),
	locked: z.uuid().nullable(),
	visible_ids: z.array(z.uuid()),
	changed: z.boolean(),
});

/**
 * The record an entry is about, from what the notice already stores (D-733): the scheduled email, task or meeting is
 * its source record. A Wiki review names the published global revision in its key; the entry links to that article by
 * the revision's slug. Every other category, and a review whose revision is not a published global one, has none.
 */
const subjectSql = sql`CASE split_part(n.logical_key,'/',2)
	WHEN 'scheduled_email_unsubscribe' THEN json_build_object('kind','communication','id',n.source_record_id)
	WHEN 'task_due' THEN json_build_object('kind','task','id',n.source_record_id)
	WHEN 'task_overdue' THEN json_build_object('kind','task','id',n.source_record_id)
	WHEN 'meeting_announcement' THEN json_build_object('kind','meeting','id',n.source_record_id)
	WHEN 'meeting_reminder' THEN json_build_object('kind','meeting','id',n.source_record_id)
	WHEN 'wiki_upstream_review' THEN (
		SELECT json_build_object('kind','article','id',r.article_id,'slug',r.slug) FROM article_revision r
		WHERE r.id = CASE WHEN split_part(n.logical_key,'/',3) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				THEN split_part(n.logical_key,'/',3)::uuid END
			AND r.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid AND r.published_at IS NOT NULL)
	END`;

function feedSql(
	session: string,
	accountId: string,
	category: string | null,
	cursorAt: string | null,
	cursorId: string | null,
	asOf: string,
	unread: boolean,
) {
	return sql`WITH ${selfSql(session, accountId)}
		SELECT (SELECT account_id FROM me) AS account_id,
			COALESCE((SELECT json_agg(item ORDER BY sort_at DESC, sort_id DESC) FROM (
				SELECT json_build_object(
					'id', n.id,
					'category', split_part(n.logical_key,'/',2),
					'title', n.title,
					'body', n.safe_body,
					'eligibleAt', to_char(n.eligible_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
					'read', n.read_at IS NOT NULL,
					'dueLocalDate', n.schedule_date,
					'overdue', ${overdueSql(asOf)},
					'subject', ${subjectSql},
					'cursorAt', to_char(n.eligible_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
				) AS item, n.eligible_at AS sort_at, n.id AS sort_id
				FROM notice n
				WHERE ${noticeVisible()}
					AND (${category}::text IS NULL OR split_part(n.logical_key,'/',2) = ${category})
					AND (${unread}::boolean IS NOT TRUE OR n.read_at IS NULL)
					AND (${cursorAt}::timestamptz IS NULL OR (n.eligible_at, n.id) < (${cursorAt}::timestamptz, ${cursorId}::uuid))
				ORDER BY n.eligible_at DESC, n.id DESC
				LIMIT ${PAGE + 1}
			) page), '[]'::json) AS items`;
}

export async function readFeed(
	db: Database,
	authority: RequestActor,
	raw: unknown,
	now: () => Date = () => new Date(),
) {
	return readReply(async () => {
		const input = parse(readFeedRequest, raw);
		const cursor = input.cursor?.split("|");
		const asOf = now().toISOString();
		const result = await db.execute(
			feedSql(
				authority.session,
				authority.actor.accountId,
				input.category ?? null,
				cursor?.[0] ?? null,
				cursor?.[1] ?? null,
				asOf,
				input.unread === true,
			),
		);
		const row = pageRow.parse({ ...result.rows[0], items: jsonValue(result.rows[0]?.items) });
		if (!row.account_id) deny();
		const more = row.items.length > PAGE;
		const visible = more ? row.items.slice(0, PAGE) : row.items;
		const last = visible.at(-1);
		return feedResult.parse({
			items: visible.map(({ id, category, title, body, eligibleAt, read, dueLocalDate, overdue, subject }) => ({
				id,
				category,
				title,
				body,
				eligibleAt,
				read,
				dueLocalDate,
				overdue,
				subject,
			})),
			nextCursor: more && last ? `${last.cursorAt}|${last.id}` : null,
		});
	});
}

export async function readUnreadCount(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(readUnreadCountRequest, raw);
		const result = await db.execute(sql`WITH ${selfSql(authority.session, authority.actor.accountId)}
			SELECT (SELECT account_id FROM me) AS account_id,
				(SELECT count(*)::int FROM notice n WHERE ${noticeVisible()} AND n.read_at IS NULL
					AND (${input.category ?? null}::text IS NULL OR split_part(n.logical_key,'/',2) = ${input.category ?? null})) AS count`);
		const row = countRow.parse(result.rows[0]);
		if (!row.account_id) deny();
		return unreadCountResult.parse({ count: row.count });
	});
}

async function mark(
	tx: Tx,
	session: string,
	accountId: string,
	expected: string,
	ids: string[] | null,
	cutoff: string | null,
) {
	// eligibleAt is an instant, so it stops at milliseconds. Include that whole millisecond.
	const eligible = cutoff
		? sql`n.eligible_at < ${cutoff}::timestamptz + interval '1 millisecond' AND n.eligible_at <= clock_timestamp()`
		: sql`n.eligible_at <= clock_timestamp()`;
	const idFilter = ids ? sql`n.id = ANY(${sql.param(ids)}::uuid[])` : sql`true`;
	const markedFrom = sql.raw(cutoff ? "updated" : "visible");
	const result = await tx.execute(sql`WITH ${selfSql(session, accountId)},
		locked AS (
			SELECT a.id FROM account a
			WHERE a.id = (SELECT account_id FROM me) AND a.revision = ${expected}::bigint
			FOR UPDATE
		),
		visible AS (
			SELECT n.id FROM notice n
			WHERE ${idFilter} AND ${noticeVisible(eligible)} AND (SELECT id FROM locked) IS NOT NULL
		),
		updated AS (
			UPDATE notice n SET read_at = clock_timestamp(), revision = n.revision + 1
			FROM visible v
			WHERE n.id = v.id AND n.read_at IS NULL
			RETURNING n.id
		)
		SELECT (SELECT account_id FROM me) AS me, (SELECT id FROM locked) AS locked,
			COALESCE((SELECT json_agg(id) FROM ${markedFrom}), '[]'::json) AS visible_ids,
			EXISTS(SELECT FROM updated) AS changed`);
	const row = markRow.parse({ ...result.rows[0], visible_ids: jsonValue(result.rows[0]?.visible_ids) });
	if (!row.me) deny();
	if (!row.locked) deny("conflict");
	return row;
}

export function markRead(db: Database, authority: RequestActor, raw: unknown) {
	const selected = accountOwner(authority.actor.accountId);
	return runWrite(
		db,
		authority,
		selected,
		raw,
		markReadRequest,
		"notifications.markRead",
		markResult,
		async (tx, cmd, input) => {
			const row = await mark(
				tx,
				authority.session,
				authority.actor.accountId,
				input.expectedRevision,
				[input.input.noticeId],
				null,
			);
			if (row.visible_ids.length !== 1) deny("access_denied");
			audit(cmd, {
				subjectId: input.input.noticeId,
				kind: row.changed ? "read" : "noop",
				fields: row.changed ? ["read"] : [],
			});
			return { markedIds: row.visible_ids };
		},
	);
}

export function markSelectedRead(db: Database, authority: RequestActor, raw: unknown) {
	const selected = accountOwner(authority.actor.accountId);
	return runWrite(
		db,
		authority,
		selected,
		raw,
		markSelectedReadRequest,
		"notifications.markSelectedRead",
		markResult,
		async (tx, cmd, input) => {
			const row = await mark(
				tx,
				authority.session,
				authority.actor.accountId,
				input.expectedRevision,
				input.input.noticeIds,
				null,
			);
			audit(cmd, {
				subjectId: authority.actor.accountId,
				kind: row.changed ? "read" : "noop",
				fields: row.changed ? ["read"] : [],
			});
			return { markedIds: row.visible_ids };
		},
	);
}

export function markAllVisibleRead(db: Database, authority: RequestActor, raw: unknown) {
	const selected = accountOwner(authority.actor.accountId);
	return runWrite(
		db,
		authority,
		selected,
		raw,
		markAllVisibleReadRequest,
		"notifications.markAllVisibleRead",
		markResult,
		async (tx, cmd, input) => {
			const row = await mark(
				tx,
				authority.session,
				authority.actor.accountId,
				input.expectedRevision,
				null,
				input.input.cutoff,
			);
			audit(cmd, {
				subjectId: authority.actor.accountId,
				kind: row.changed ? "read" : "noop",
				fields: row.changed ? ["read"] : [],
			});
			return { markedIds: row.visible_ids };
		},
	);
}
