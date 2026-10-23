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
});
const pageRow = z.object({ account_id: z.uuid().nullable(), items: z.array(itemRow) });
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
					'overdue', ${overdueSql(asOf)}
				) AS item, n.eligible_at AS sort_at, n.id AS sort_id
				FROM notice n
				WHERE ${noticeVisible()}
					AND (${category}::text IS NULL OR split_part(n.logical_key,'/',2) = ${category})
					AND (${cursorAt}::timestamptz IS NULL OR (n.eligible_at, n.id) < (${cursorAt}::timestamptz, ${cursorId}::uuid))
				ORDER BY n.eligible_at DESC, n.id DESC
				LIMIT ${PAGE + 1}
			) page), '[]'::json) AS items`;
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
			),
		);
		const row = pageRow.parse({ ...result.rows[0], items: jsonValue(result.rows[0]?.items) });
		if (!row.account_id) deny();
		const more = row.items.length > PAGE;
		const items = more ? row.items.slice(0, PAGE) : row.items;
		return feedResult.parse({
			items,
			nextCursor: more ? `${items[PAGE - 1]!.eligibleAt}|${items[PAGE - 1]!.id}` : null,
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

async function mark(tx: Tx, session: string, accountId: string, expected: string, ids: string[] | null, all: boolean) {
	const eligible = all ? sql`n.eligible_at <= (SELECT at FROM cutoff)` : sql`n.eligible_at <= clock_timestamp()`;
	const idFilter = ids ? sql`n.id = ANY(${sql.param(ids)}::uuid[])` : sql`true`;
	const markedFrom = sql.raw(all ? "updated" : "visible");
	const result = await tx.execute(sql`WITH ${selfSql(session, accountId)},
		cutoff AS (SELECT clock_timestamp() AS at),
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
				false,
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
				false,
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
			const row = await mark(tx, authority.session, authority.actor.accountId, input.expectedRevision, null, true);
			audit(cmd, {
				subjectId: authority.actor.accountId,
				kind: row.changed ? "read" : "noop",
				fields: row.changed ? ["read"] : [],
			});
			return { markedIds: row.visible_ids };
		},
	);
}
