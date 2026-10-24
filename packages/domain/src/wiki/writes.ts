import type { Owner } from "@everyfield/contracts/common";
import {
	readingResult,
	recordViewRequest,
	setBookmarkRequest,
	setSourceOrderRequest,
	sourceOrderResult,
	updateProgressRequest,
	type WikiReply,
} from "@everyfield/contracts/wiki";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { corpusCtes } from "./corpus.ts";
import { deny, meSql, runWrite, selectedOwner, WikiOutcome, parse, type Command } from "./core.ts";

type ReadingValue = z.infer<typeof readingResult>;
type OrderValue = z.infer<typeof sourceOrderResult>;

function readingValue(partial: Partial<ReadingValue> & Pick<ReadingValue, "errorCode" | "written">): ReadingValue {
	return readingResult.parse({
		revision: "0",
		completed: false,
		observedFraction: "0",
		bookmarked: false,
		meaningfulUpdateLabel: false,
		earnedCreditRetained: false,
		...partial,
	});
}
function orderValue(partial: Partial<OrderValue> & Pick<OrderValue, "errorCode">): OrderValue {
	return sourceOrderResult.parse({
		historyAdded: 0,
		churches: [],
		networks: [],
		revision: "0",
		crmLeadPermission: false,
		orgEditorPermission: false,
		rightsAdded: 0,
		orderUnchanged: partial.errorCode != null,
		...partial,
	});
}
function duplicates(ids: string[]): boolean {
	return new Set(ids).size !== ids.length;
}

async function saveReading(
	db: Database,
	authority: RequestActor,
	operation: string,
	input: {
		requestKey: string;
		expectedRevision: string;
		input: { articleId: string; plantId?: string; fraction?: string; desired?: boolean };
	},
	mode: "progress" | "view" | "bookmark",
): Promise<WikiReply<ReadingValue>> {
	const owner = selectedOwner(authority);
	const account: Owner = { kind: "account", id: authority.actor.accountId };
	const fraction = input.input.fraction ?? "0";
	const desired = input.input.desired ?? false;
	const plantId = input.input.plantId ?? null;
	return runWrite(db, authority, account, operation, input, readingResult, async (tx) => {
		const result = await tx.execute(sql`WITH ${corpusCtes({ authority, owner }, { kind: "current" })},
			visible AS (
				SELECT * FROM picked WHERE article_id = ${input.input.articleId}::uuid AND NOT hidden LIMIT 1
			),
			existing AS (
				SELECT r.* FROM reading r
				WHERE r.account_id = (SELECT account_id FROM me LIMIT 1)
					AND r.article_id = ${input.input.articleId}::uuid
			),
			plant_ok AS (
				SELECT ${
					plantId
						? sql`EXISTS (
							SELECT FROM seat s
							WHERE s.account_id = (SELECT account_id FROM me LIMIT 1)
								AND s.plant_id = ${plantId}::uuid
								AND s.ended_at IS NULL
								AND s.accepted_at <= clock_timestamp()
						)`
						: sql`false`
				} AS ok
			),
			ins AS (
				INSERT INTO reading (
					id, account_id, article_id, last_revision_id, plant_context_id, observed_fraction,
					last_viewed_at, completed_at, completed_revision_id, completed_fraction, policy_version,
					last_read_meaningful_sequence, bookmarked, revision
				)
				SELECT
					COALESCE(e.id, gen_random_uuid()),
					m.account_id,
					v.article_id,
					CASE WHEN ${mode} = 'view' THEN e.last_revision_id ELSE v.revision_id END,
					CASE WHEN p.ok THEN ${plantId}::uuid ELSE e.plant_context_id END,
					CASE WHEN ${mode} = 'progress'
						THEN GREATEST(COALESCE(e.observed_fraction, 0), ${fraction}::numeric)
						ELSE COALESCE(e.observed_fraction, 0) END,
					clock_timestamp(),
					CASE
						WHEN e.completed_at IS NOT NULL THEN e.completed_at
						WHEN ${mode} = 'progress' AND ${fraction}::numeric > 0.80 THEN clock_timestamp()
						ELSE NULL END,
					CASE
						WHEN e.completed_revision_id IS NOT NULL THEN e.completed_revision_id
						WHEN ${mode} = 'progress' AND ${fraction}::numeric > 0.80 THEN v.revision_id
						ELSE NULL END,
					CASE
						WHEN e.completed_fraction IS NOT NULL THEN e.completed_fraction
						WHEN ${mode} = 'progress' AND ${fraction}::numeric > 0.80 THEN ${fraction}::numeric
						ELSE NULL END,
					COALESCE(e.policy_version, 'wiki-reading-v1'),
					CASE
						WHEN ${mode} <> 'view' AND v.meaningful
							THEN GREATEST(COALESCE(e.last_read_meaningful_sequence, 0), v.meaningful_sequence)
						ELSE COALESCE(e.last_read_meaningful_sequence, 0) END,
					CASE WHEN ${mode} = 'bookmark' THEN ${desired}::boolean ELSE COALESCE(e.bookmarked, false) END,
					COALESCE(e.revision, 0) + 1
				FROM me m
				JOIN visible v ON true
				LEFT JOIN existing e ON true
				CROSS JOIN plant_ok p
				WHERE (e.id IS NULL AND ${input.expectedRevision} = '0') OR e.revision::text = ${input.expectedRevision}
				ON CONFLICT (account_id, article_id) DO UPDATE SET
					last_revision_id = EXCLUDED.last_revision_id,
					plant_context_id = EXCLUDED.plant_context_id,
					observed_fraction = EXCLUDED.observed_fraction,
					last_viewed_at = EXCLUDED.last_viewed_at,
					completed_at = EXCLUDED.completed_at,
					completed_revision_id = EXCLUDED.completed_revision_id,
					completed_fraction = EXCLUDED.completed_fraction,
					policy_version = reading.policy_version,
					last_read_meaningful_sequence = EXCLUDED.last_read_meaningful_sequence,
					bookmarked = EXCLUDED.bookmarked,
					revision = EXCLUDED.revision
				WHERE reading.revision::text = ${input.expectedRevision}
				RETURNING id, revision::text AS revision, observed_fraction::text AS fraction,
					(completed_at IS NOT NULL) AS completed, bookmarked,
					last_read_meaningful_sequence AS last_read
			)
			SELECT
				EXISTS (SELECT FROM me) AS allowed,
				EXISTS (SELECT FROM visible) AS entitled,
				(SELECT id FROM ins) AS written_id,
				(SELECT revision FROM ins) AS written_revision,
				(SELECT fraction FROM ins) AS fraction,
				(SELECT completed FROM ins) AS completed,
				(SELECT bookmarked FROM ins) AS bookmarked,
				(SELECT last_read FROM ins) AS last_read,
				(SELECT meaningful FROM visible) AS meaningful,
				(SELECT meaningful_sequence FROM visible) AS visible_sequence`);
		const row = z
			.object({
				allowed: z.boolean(),
				entitled: z.boolean(),
				written_id: z.uuid().nullable(),
				written_revision: z.string().nullable(),
				fraction: z.string().nullable(),
				completed: z.boolean().nullable(),
				bookmarked: z.boolean().nullable(),
				last_read: z.coerce.number().nullable(),
				meaningful: z.boolean().nullable(),
				visible_sequence: z.coerce.number().nullable(),
			})
			.parse(result.rows[0]);
		if (!row.allowed) deny();
		if (!row.entitled) throw new WikiOutcome(readingValue({ errorCode: "content_access_denied", written: false }));
		if (!row.written_id || !row.written_revision) deny("conflict");
		const completed = row.completed === true;
		return readingValue({
			errorCode: null,
			written: true,
			revision: row.written_revision!,
			completed,
			observedFraction: row.fraction ?? "0",
			bookmarked: row.bookmarked === true,
			meaningfulUpdateLabel: completed && row.meaningful === true && (row.visible_sequence ?? 0) > (row.last_read ?? 0),
			earnedCreditRetained: completed,
		});
	});
}

export function updateProgress(db: Database, authority: RequestActor, raw: unknown) {
	const input = parse(updateProgressRequest, raw);
	return saveReading(db, authority, "wiki.reading.updateProgress", input, "progress");
}
export function recordView(db: Database, authority: RequestActor, raw: unknown) {
	const input = parse(recordViewRequest, raw);
	return saveReading(db, authority, "wiki.reading.recordView", input, "view");
}
export function setBookmark(db: Database, authority: RequestActor, raw: unknown) {
	const input = parse(setBookmarkRequest, raw);
	return saveReading(db, authority, "wiki.bookmarks.set", input, "bookmark");
}

export async function setSourceOrder(
	db: Database,
	authority: RequestActor,
	raw: unknown,
): Promise<WikiReply<OrderValue>> {
	const input = parse(setSourceOrderRequest, raw);
	const context = authority.actor.context;
	const plantAdmin = context.kind === "seat" && context.owner.kind === "plant" && context.role !== "member";
	const listed = { churches: input.input.churches, networks: input.input.networks, revision: input.expectedRevision };
	if (!plantAdmin) return { status: "ok", value: orderValue({ errorCode: "access_denied", ...listed }) };
	if (input.input.churches.length === 0)
		return { status: "ok", value: orderValue({ errorCode: "source_order_required", ...listed }) };
	if (duplicates(input.input.churches) || duplicates(input.input.networks))
		return { status: "ok", value: orderValue({ errorCode: "invalid_source_order", ...listed }) };
	const owner = context.owner;
	return runWrite(
		db,
		authority,
		owner,
		"wiki.setSourceOrder",
		input,
		sourceOrderResult,
		async (tx: Transaction, _command: Command) => {
			const result = await tx.execute(sql`WITH ${meSql(authority, owner, true)},
			active AS (
				SELECT o.id, o.kind
				FROM affiliation f
				JOIN organization o ON o.id = f.organization_id
				WHERE f.plant_id = ${owner.id}::uuid
					AND f.ended_at IS NULL
					AND f.share_wiki
					AND o.kind IN ('sending_church', 'sending_network')
					AND EXISTS (SELECT FROM me)
				FOR UPDATE OF f
			),
			stored AS (
				SELECT COALESCE(result->>'revision', '0') AS revision
				FROM audit_event
				WHERE tenant_id = ${owner.id}::uuid AND action = 'wiki.source_order_changed'
				ORDER BY occurred_at DESC, id DESC
				LIMIT 1
			)
			SELECT
				EXISTS (SELECT FROM me) AS allowed,
				COALESCE((SELECT revision FROM stored), '0') AS stored_revision,
				COALESCE((SELECT json_agg(id) FROM active WHERE kind = 'sending_church'), '[]'::json) AS churches,
				COALESCE((SELECT json_agg(id) FROM active WHERE kind = 'sending_network'), '[]'::json) AS networks`);
			const row = z
				.object({
					allowed: z.boolean(),
					stored_revision: z.string(),
					churches: z.array(z.uuid()),
					networks: z.array(z.uuid()),
				})
				.parse(result.rows[0]);
			const fail = (errorCode: OrderValue["errorCode"]) => {
				throw new WikiOutcome(
					orderValue({
						errorCode,
						churches: input.input.churches,
						networks: input.input.networks,
						revision: row.stored_revision,
					}),
				);
			};
			if (!row.allowed) fail("access_denied");
			const foreign =
				input.input.churches.some((id) => !row.churches.includes(id)) ||
				input.input.networks.some((id) => !row.networks.includes(id));
			if (foreign) fail("access_denied");
			if (input.input.churches.length !== row.churches.length || input.input.networks.length !== row.networks.length)
				fail("invalid_source_order");
			if (row.stored_revision !== input.expectedRevision) fail("revision_conflict");
			const revision = (BigInt(row.stored_revision) + 1n).toString();
			return orderValue({
				errorCode: null,
				historyAdded: 1,
				churches: input.input.churches,
				networks: input.input.networks,
				revision,
				orderUnchanged: false,
			});
		},
	);
}
