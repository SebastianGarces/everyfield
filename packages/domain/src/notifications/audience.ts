import { owner } from "@everyfield/contracts/common";
import {
	associationAudienceResult,
	associationReceiptResult,
	cancelRemindersResult,
	cancelTaskRemindersRequest,
	excludedNotificationHelpers,
	meetingAudienceResult,
	notificationProducers,
	producerResult,
	publishWikiUpstreamRequest,
	readAssociationAudienceRequest,
	readAssociationReceiptRequest,
	readMeetingAudienceRequest,
	readProducersRequest,
	wikiPublishResult,
} from "@everyfield/contracts/notifications";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { RequestActor, accountOwner, audit, deny, jsonValue, parse, readReply, refusal, runWrite } from "./core.ts";

const idsRow = z.object({ allowed: z.boolean(), ids: z.array(z.uuid()) });
const receiptRow = z.object({
	allowed: z.boolean(),
	recipients: z.array(z.object({ accountId: z.uuid(), state: z.string() })),
});
const cancelRow = z.object({ ids: z.array(z.uuid()) });
const wikiRow = z.object({
	rows: z.array(z.object({ id: z.uuid(), recipient: z.uuid() })),
});

function liveAccount(session: string, accountId: string) {
	return sql`EXISTS (SELECT FROM live_session(${session}::uuid) i
		WHERE i.registration_state = 'active' AND i.account_id = ${accountId}::uuid)`;
}

export async function readAssociationAudience(db: Database, authority: RequestActor, raw: unknown) {
	return readReply(async () => {
		const input = parse(readAssociationAudienceRequest, raw);
		const result = await db.execute(sql`SELECT ${liveAccount(authority.session, authority.actor.accountId)}
				AND (
					${authority.actor.accountId}::uuid = ${input.discoveryAccountId}::uuid
					OR EXISTS (SELECT FROM seat s WHERE s.account_id = ${authority.actor.accountId}::uuid
						AND s.organization_id = ${input.organizationId}::uuid AND s.role IN ('owner','admin')
						AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp())
				) AS allowed,
				COALESCE((SELECT json_agg(id ORDER BY id) FROM (
					SELECT ${input.discoveryAccountId}::uuid AS id
					UNION
					SELECT s.account_id FROM seat s
					WHERE s.organization_id = ${input.organizationId}::uuid AND s.role = 'owner'
						AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()
				) people), '[]'::json) AS ids`);
		const row = idsRow.parse({ ...result.rows[0], ids: jsonValue(result.rows[0]?.ids) });
		if (!row.allowed) deny("access_denied");
		return associationAudienceResult.parse({ recipientIds: [...new Set(row.ids)], phantomPlantCreated: false });
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
			const key = `${input.input.organizationId}/wiki_upstream_review/${input.input.sourceId}/${input.input.sourceRevision}/published`;
			const result = await tx.execute(sql`INSERT INTO notice
					(tenant_id, recipient_id, category, purpose, logical_key, source_record_id, source_revision, title, eligible_at, created_at)
				SELECT ${input.input.organizationId}::uuid, s.account_id, 'reference_update', 'reference_update', ${key},
					${input.input.organizationId}::uuid, ${input.input.sourceRevision}::bigint, ${input.input.title},
					clock_timestamp(), clock_timestamp()
				FROM seat s
				WHERE s.organization_id = ${input.input.organizationId}::uuid AND s.role IN ('owner','admin')
					AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()
				ON CONFLICT (recipient_id, logical_key) DO NOTHING
				RETURNING id, recipient_id AS recipient`);
			const row = wikiRow.parse({ rows: result.rows });
			audit(cmd, {
				subjectId: input.input.organizationId,
				action: "wiki.published",
				kind: "publish",
				fields: ["wiki_upstream_review"],
			});
			return {
				noticeIds: row.rows.map((item) => item.id),
				recipientIds: row.rows.map((item) => item.recipient),
				emailIntents: 0,
				autoAdoptions: 0,
			};
		},
	);
}

export function readProducers(raw: unknown) {
	try {
		parse(readProducersRequest, raw);
		return {
			status: "ok" as const,
			value: producerResult.parse({
				implementedNewProducer: "Wiki_upstream",
				genericRulesEngine: false,
				unusedHelpersEnabled: false,
				producers: [...notificationProducers],
				excluded: [...excludedNotificationHelpers],
			}),
		};
	} catch (error) {
		return refusal(error);
	}
}
