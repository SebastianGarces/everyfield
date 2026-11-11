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
import { sql, type SQL } from "@everyfield/db/query";
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
	cursorAt: z.string(),
});
const pageRow = z.object({ account_id: z.uuid().nullable(), items: z.array(itemRow) });
const headRow = z.object({ unread: z.number().int().nullable(), revision: z.string().nullable() });
const countRow = z.object({ account_id: z.uuid().nullable(), count: z.number().int() });
const markRow = z.object({
	me: z.uuid().nullable(),
	locked: z.uuid().nullable(),
	visible_ids: z.array(z.uuid()),
	changed: z.boolean(),
});

function feedSql(
	session: string,
	accountId: string,
	category: string | null,
	cursorAt: string | null,
	cursorId: string | null,
	asOf: string,
	unread: boolean,
	extra: SQL = sql``,
) {
	return sql`WITH ${selfSql(session, accountId)}
		SELECT (SELECT account_id FROM me) AS account_id, ${extra}
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

function feedValue(items: z.infer<typeof itemRow>[]) {
	const more = items.length > PAGE;
	const visible = more ? items.slice(0, PAGE) : items;
	const last = visible.at(-1);
	return feedResult.parse({
		items: visible.map(({ id, category, title, body, eligibleAt, read, dueLocalDate, overdue }) => ({
			id,
			category,
			title,
			body,
			eligibleAt,
			read,
			dueLocalDate,
			overdue,
		})),
		nextCursor: more && last ? `${last.cursorAt}|${last.id}` : null,
	});
}

export async function readFeed(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(readFeedRequest, raw);
		const cursor = input.cursor?.split("|");
		const asOf = input.asOf ?? new Date().toISOString();
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
		return feedValue(row.items);
	});
}

/**
 * The feed's first page, the unread count of the same category and the account revision that marks carry, in one
 * statement (REQ-NTF-003). The feed page and the bell open read this.
 */
export async function readFeedPage(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(readFeedRequest.omit({ cursor: true }), raw);
		const category = input.category ?? null;
		const result = await db.execute(
			feedSql(
				authority.session,
				authority.actor.accountId,
				category,
				null,
				null,
				input.asOf ?? new Date().toISOString(),
				input.unread === true,
				sql`(SELECT count(*)::int FROM notice n WHERE ${noticeVisible()} AND n.read_at IS NULL
					AND (${category}::text IS NULL OR split_part(n.logical_key,'/',2) = ${category})) AS unread,
				(SELECT revision::text FROM account WHERE id = (SELECT account_id FROM me)) AS revision,`,
			),
		);
		const row = pageRow.parse({ ...result.rows[0], items: jsonValue(result.rows[0]?.items) });
		const head = headRow.parse(result.rows[0]);
		if (!row.account_id || head.unread === null || head.revision === null) deny();
		return { feed: feedValue(row.items), unread: head.unread, revision: head.revision };
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
