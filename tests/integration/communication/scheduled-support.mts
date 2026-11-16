import { sql } from "../../../packages/db/src/query.ts";
import type { Database } from "../../../packages/db/src/client.ts";
import {
	addressAad,
	openText,
	type DeliveryKeys,
	type DeliveryTransport,
} from "../../../packages/domain/src/communication/delivery.ts";
import { scheduledMessages } from "../../../apps/web/src/server/jobs/scheduled.ts";

const like = (communicationId: string) => `communication/${communicationId}/%`;

export async function atSendTime(
	admin: Database,
	db: Database,
	communicationId: string,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
) {
	await admin.execute(sql`UPDATE mail SET scheduled_at = clock_timestamp() - interval '1 second'
		WHERE logical_key LIKE ${like(communicationId)} AND state = 'scheduled'`);
	return minuteRunner(db, transport, keys);
}

export async function minuteRunner(db: Database, transport: DeliveryTransport, keys: DeliveryKeys) {
	return scheduledMessages(db, transport, keys)(20, Infinity);
}

export async function heldAtProvider(
	admin: Database,
	communicationId: string,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
) {
	const rows = (
		await admin.execute(sql`SELECT m.id, m.tenant_id, m.frozen_payload, m.recipient_address_encrypted,
			to_char(m.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS held, r.provider_key
			FROM mail m JOIN mail_request_member mem ON mem.mail_id = m.id JOIN mail_request r ON r.id = mem.request_id
			WHERE m.logical_key LIKE ${like(communicationId)} AND m.state = 'scheduled' ORDER BY mem.position`)
	).rows as {
		id: string;
		tenant_id: string;
		frozen_payload: { sealed: string };
		recipient_address_encrypted: string;
		held: string;
		provider_key: string;
	}[];
	const messages = rows.map((row) => {
		const body = JSON.parse(
			openText(keys.encryptionKey, row.frozen_payload.sealed, `${row.tenant_id}/${row.id}/communication`)!,
		);
		const to = openText(keys.encryptionKey, row.recipient_address_encrypted, addressAad(row.tenant_id, row.id))!;
		return {
			to,
			subject: body.subject,
			html: body.html,
			text: body.text,
			...(body.headers ? { headers: body.headers } : {}),
		};
	});
	const batch = await transport
		.send({ key: rows[0]!.provider_key, messages, scheduledAt: rows[0]!.held }, AbortSignal.timeout(10_000))
		.catch(() => ({ outcome: "unknown" as const }));
	const answers = rows.map((row, index) => ({
		id: row.id,
		state:
			batch.outcome === "refused" ? "refused" : batch.outcome === "ids" && batch.ids[index] ? "accepted" : "unknown",
		provider: batch.outcome === "ids" ? (batch.ids[index] ?? null) : null,
	}));
	await admin.execute(sql`UPDATE mail m SET state = x.state, provider_message_id = x.provider,
		accepted_at = CASE WHEN x.state = 'accepted' THEN clock_timestamp() END
		FROM jsonb_to_recordset(${JSON.stringify(answers)}::jsonb) AS x(id uuid, state text, provider text)
		WHERE m.id = x.id`);
	return { accepted: answers.filter((a) => a.state === "accepted").length };
}
