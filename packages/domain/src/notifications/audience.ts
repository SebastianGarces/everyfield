import { owner } from "@everyfield/contracts/common";
import {
	associationAudienceResult,
	associationReceiptResult,
	cancelRemindersResult,
	cancelTaskRemindersRequest,
	meetingAudienceResult,
	publishWikiUpstreamRequest,
	readAssociationAudienceRequest,
	readAssociationReceiptRequest,
	readMeetingAudienceRequest,
	wikiPublishResult,
} from "@everyfield/contracts/notifications";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { RequestActor, accountOwner, audit, deny, jsonValue, parse, readReply, runWrite } from "./core.ts";

const idsRow = z.object({ allowed: z.boolean(), ids: z.array(z.uuid()) });
const receiptRow = z.object({
	allowed: z.boolean(),
	recipients: z.array(z.object({ accountId: z.uuid(), state: z.string() })),
});
const cancelRow = z.object({ ids: z.array(z.uuid()) });
const wikiRow = z.object({
	published: z.boolean(),
	rows: z.array(z.object({ id: z.uuid(), recipient: z.uuid() })),
});

function liveAccount(session: string, accountId: string) {
	return sql`EXISTS (SELECT FROM live_session(${session}::uuid) i
		WHERE i.registration_state = 'active' AND i.account_id = ${accountId}::uuid)`;
}

export async function readAssociationAudience(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(readAssociationAudienceRequest, raw);
		const result = await db.execute(sql`WITH allowed AS (
				SELECT ${liveAccount(authority.session, authority.actor.accountId)}
					AND EXISTS (
						SELECT FROM seat mine
						WHERE mine.account_id = ${authority.actor.accountId}::uuid
							AND mine.organization_id = ${input.organizationId}::uuid
							AND mine.role IN ('owner','admin') AND mine.ended_at IS NULL
							AND mine.accepted_at <= clock_timestamp()
					)
					AND EXISTS (
						SELECT FROM affiliation a
						JOIN seat planter ON planter.plant_id = a.plant_id
							AND planter.account_id = ${input.discoveryAccountId}::uuid
							AND planter.ended_at IS NULL AND planter.accepted_at <= clock_timestamp()
						WHERE a.organization_id = ${input.organizationId}::uuid
							AND a.ended_at IS NULL AND a.accepted_at IS NOT NULL
					) AS ok
			)
			SELECT (SELECT ok FROM allowed) AS allowed,
				COALESCE((SELECT json_agg(s.account_id ORDER BY s.account_id) FROM seat s
					WHERE (SELECT ok FROM allowed)
						AND s.organization_id = ${input.organizationId}::uuid AND s.role = 'owner'
						AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()
				), '[]'::json) AS ids`);
		const row = idsRow.parse({ ...result.rows[0], ids: jsonValue(result.rows[0]?.ids) });
		if (!row.allowed) deny("access_denied");
		return associationAudienceResult.parse({ recipientIds: row.ids });
	});
}

export async function readAssociationReceipt(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(readAssociationReceiptRequest, raw);
		const result = await db.execute(sql`SELECT ${liveAccount(authority.session, authority.actor.accountId)}
				AND EXISTS (SELECT FROM seat s WHERE s.account_id = ${authority.actor.accountId}::uuid
					AND s.organization_id = ${input.organizationId}::uuid AND s.role IN ('owner','admin')
					AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()) AS allowed,
				COALESCE((SELECT json_agg(json_build_object('accountId', recipient_account_id, 'state', state) ORDER BY recipient_account_id)
					FROM mail
					WHERE purpose IN ('discovery_receipt','relationship_receipt')
						AND logical_key LIKE ${"association/" + input.operationId + "/%"}
						AND recipient_account_id IS NOT NULL
						AND (
							tenant_id = ${input.organizationId}::uuid
							OR recipient_account_id IN (SELECT account_id FROM seat WHERE organization_id = ${input.organizationId}::uuid
								AND role = 'owner' AND ended_at IS NULL)
						)
				), '[]'::json) AS recipients`);
		const row = receiptRow.parse({ ...result.rows[0], recipients: jsonValue(result.rows[0]?.recipients) });
		if (!row.allowed) deny("access_denied");
		return associationReceiptResult.parse({ recipients: row.recipients });
	});
}

export async function readMeetingAudience(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(readMeetingAudienceRequest, raw);
		const result = await db.execute(sql`WITH seated AS (
				SELECT account_id FROM seat
				WHERE plant_id = ${input.plantId}::uuid AND ended_at IS NULL AND accepted_at <= clock_timestamp()
					AND ${liveAccount(authority.session, authority.actor.accountId)}
					AND EXISTS (SELECT FROM seat mine WHERE mine.account_id = ${authority.actor.accountId}::uuid
						AND mine.plant_id = ${input.plantId}::uuid AND mine.ended_at IS NULL AND mine.accepted_at <= clock_timestamp())
			)
			SELECT EXISTS(SELECT FROM seated) AS allowed,
				COALESCE((SELECT json_agg(a ORDER BY a) FROM (
					SELECT DISTINCT a FROM (
						SELECT p.linked_account_id AS a FROM participation g
						JOIN person p ON p.id = g.person_id
						JOIN meeting m ON m.id = g.meeting_id
						WHERE m.id = ${input.meetingId}::uuid AND m.plant_id = ${input.plantId}::uuid
							AND g.removed_at IS NULL AND p.state = 'live'
						UNION
						SELECT m.creator_id FROM meeting m
						WHERE m.id = ${input.meetingId}::uuid AND m.plant_id = ${input.plantId}::uuid
					) people WHERE a IN (SELECT account_id FROM seated)
				) ids), '[]'::json) AS ids`);
		const row = idsRow.parse({ ...result.rows[0], ids: jsonValue(result.rows[0]?.ids) });
		if (!row.allowed) deny("access_denied");
		return meetingAudienceResult.parse({ recipientIds: row.ids });
	});
}

export function cancelTaskReminders(db: Database, authority: RequestActor, raw: unknown) {
	const parsed = cancelTaskRemindersRequest.safeParse(raw);
	const selected = parsed.success
		? owner.parse({ kind: "plant", id: parsed.data.input.plantId })
		: accountOwner(authority.actor.accountId);
	return runWrite(
		db,
		authority,
		selected,
		raw,
		cancelTaskRemindersRequest,
		"notifications.cancelTaskReminders",
		cancelRemindersResult,
		async (tx, cmd, input) => {
			const result = await tx.execute(sql`UPDATE notice n
				SET cancelled_at = clock_timestamp(), revision = n.revision + 1
				WHERE n.tenant_id = ${input.input.plantId}::uuid AND n.source_record_id = ${input.input.taskId}::uuid
					AND n.cancelled_at IS NULL AND n.eligible_at > clock_timestamp()
					AND split_part(n.logical_key,'/',2) IN ('task_due','task_overdue')
				RETURNING n.id`);
			const ids = z
				.array(z.object({ id: z.uuid() }))
				.parse(result.rows)
				.map((row) => row.id);
			const row = cancelRow.parse({ ids });
			audit(cmd, {
				subjectId: input.input.taskId,
				kind: row.ids.length ? "edit" : "noop",
				fields: row.ids.length ? ["cancelled"] : [],
			});
			return { cancelledIds: row.ids };
		},
	);
}

export function publishWikiUpstream(db: Database, authority: RequestActor, raw: unknown) {
	const parsed = publishWikiUpstreamRequest.safeParse(raw);
	const selected = parsed.success
		? owner.parse({
				kind: "organization",
				id: parsed.data.input.organizationId,
				organizationKind: parsed.data.input.organizationKind,
			})
		: accountOwner(authority.actor.accountId);
	return runWrite(
		db,
		authority,
		selected,
		raw,
		publishWikiUpstreamRequest,
		"notifications.publishWikiUpstream",
		wikiPublishResult,
		async (tx, cmd, input) => {
			const org = input.input.organizationId;
			const result = await tx.execute(sql`WITH seated AS (
					SELECT s.account_id FROM seat s
					WHERE s.organization_id = ${org}::uuid AND s.role IN ('owner','admin')
						AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()
						AND EXISTS (
							SELECT FROM live_session(${authority.session}::uuid) i
							WHERE i.registration_state = 'active' AND i.account_id = ${authority.actor.accountId}::uuid
								AND i.account_id = s.account_id
						)
				),
				published AS (
					SELECT r.id, r.title, r.meaningful_sequence
					FROM article_revision r
					WHERE r.id = ${input.input.sourceId}::uuid
						AND r.published_at IS NOT NULL
						AND r.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
						AND r.meaningful_sequence = ${input.input.sourceRevision}::bigint
						AND EXISTS (
							SELECT FROM article_editor_state e
							WHERE e.organization_id = ${org}::uuid AND e.article_id = r.article_id
								AND e.state <> 'inherited'
						)
						AND EXISTS (SELECT FROM seated)
				),
				inserted AS (
					INSERT INTO notice
						(tenant_id, recipient_id, category, purpose, logical_key, source_record_id, source_revision, title, eligible_at, created_at)
					SELECT ${org}::uuid, s.account_id, 'reference_update', 'reference_update',
						${org}::text || '/wiki_upstream_review/' || p.id::text || '/' || p.meaningful_sequence::text || '/published',
						${org}::uuid, p.meaningful_sequence, p.title, clock_timestamp(), clock_timestamp()
					FROM published p
					JOIN seat s ON s.organization_id = ${org}::uuid AND s.role IN ('owner','admin')
						AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()
					ON CONFLICT (recipient_id, logical_key) DO NOTHING
					RETURNING id, recipient_id AS recipient
				)
				SELECT EXISTS(SELECT FROM published) AS published,
					COALESCE((SELECT json_agg(json_build_object('id', id, 'recipient', recipient)) FROM inserted), '[]'::json) AS rows`);
			const row = wikiRow.parse({
				published: result.rows[0]?.published,
				rows: jsonValue(result.rows[0]?.rows),
			});
			if (!row.published) deny("access_denied");
			audit(cmd, {
				subjectId: org,
				kind: row.rows.length ? "edit" : "noop",
				fields: row.rows.length ? ["wiki_upstream_review"] : [],
			});
			return {
				noticeIds: row.rows.map((item) => item.id),
				recipientIds: row.rows.map((item) => item.recipient),
			};
		},
	);
}
