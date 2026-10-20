import { alias, and, asc, eq, isNull, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import "server-only";
import { createHash } from "node:crypto";
import type { Database, Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { boundedBytes, safeBoundary, safeResponse } from "../platform/boundary.ts";
import { transaction } from "../platform/database.ts";
import { verifyCallback } from "../platform/webhook.ts";
const provider_event_e = alias(tables.provider_event, "e");
const mail_m = alias(tables.mail, "m");
const kinds = [
	"accepted",
	"scheduled",
	"sent",
	"delivered",
	"bounced",
	"complained",
	"opened",
	"clicked",
	"cancelled",
] as const;
const wire = z.object({
	type: z.enum(kinds.map((k) => `email.${k}` as const)),
	created_at: z.iso.datetime(),
	data: z.object({ email_id: z.string().min(1).max(128), bounce: z.object({ type: z.string() }).optional() }),
});
const eventSchema = z.object({
	id: z.uuid(),
	message_id: z.string(),
	kind: z.enum(kinds),
	occurred_at: z.date(),
	safe_payload: z.object({ hard_bounce: z.boolean() }),
	processed_at: z.date().nullable(),
});
async function apply(tx: Transaction, eventId: string) {
	const row = await tx.select().from(tables.provider_event).where(eq(tables.provider_event.id, eventId)).for("update");
	const e = eventSchema.parse(row[0]);
	if (e.processed_at) return "duplicate" as const;
	const matches = await tx
		.select({
			id: tables.mail.id,
			tenant_id: tables.mail.tenant_id,
			address_hash: tables.mail.address_hash,
			job_id: tables.mail.job_id,
		})
		.from(tables.mail)
		.where(eq(tables.mail.provider_message_id, e.message_id))
		.for("update");
	// Unknown and ambiguous IDs are retained as pending evidence, never routed by request IDs.
	if (matches.length !== 1) return "unmatched" as const;
	const m = z
		.object({ id: z.uuid(), tenant_id: z.uuid(), address_hash: z.string().nullable(), job_id: z.uuid().nullable() })
		.parse(matches[0]);
	const columns = {
		accepted: "accepted_at",
		scheduled: "accepted_at",
		sent: "sent_at",
		delivered: "delivered_at",
		bounced: "bounced_at",
		complained: "complained_at",
		opened: "opened_at",
		clicked: "clicked_at",
		cancelled: "cancel_confirmed_at",
	} as const;
	const column = columns[e.kind];
	const timestamp = tables.mail[column];
	await tx
		.update(tables.mail)
		.set({
			[column]: sql`CASE WHEN ${timestamp} IS NULL THEN ${e.occurred_at}::timestamptz ELSE least(${timestamp},${e.occurred_at}::timestamptz) END`,
			state: sql`CASE WHEN ${tables.mail.state}='cancelled' THEN ${tables.mail.state}
      WHEN ${e.kind}='cancelled' AND ${tables.mail.sent_at} IS NULL AND ${tables.mail.delivered_at} IS NULL THEN 'cancelled'
      WHEN ${tables.mail.sent_at} IS NOT NULL OR ${tables.mail.delivered_at} IS NOT NULL OR ${e.kind} IN ('sent','delivered') THEN 'sent'
      WHEN ${tables.mail.state} IN ('pending','dispatched','unknown') THEN 'accepted' ELSE ${tables.mail.state} END`,
			provider_message_id: e.message_id,
		})
		.where(eq(tables.mail.id, m.id));
	if (m.address_hash && (e.kind === "complained" || (e.kind === "bounced" && e.safe_payload.hard_bounce))) {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${m.address_hash},31))`);
		await tx.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
      VALUES(${m.address_hash},${e.kind === "complained" ? "complaint" : "hard_bounce"},${e.id},clock_timestamp()) ON CONFLICT(address_hash) DO UPDATE
      SET reason=excluded.reason,source_event_id=excluded.source_event_id,suppressed_at=excluded.suppressed_at,
      cleared_at=NULL,clear_operation_id=NULL,revision=suppression.revision+1`);
	}
	await tx
		.update(tables.provider_event)
		.set({ mail_id: m.id, processed_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)) })
		.where(eq(tables.provider_event.id, e.id));
	await tx
		.update(tables.job)
		.set({
			state: "succeeded",
			error_code: null,
			finished_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
			revision: sql<unknown>`(${tables.job.revision} + 1)`,
		})
		.where(and(eq(tables.job.id, sql`${m.job_id}`), eq(tables.job.state, "reconcile")));
	const action =
		e.kind === "delivered" ? "mail.delivered" : e.kind === "cancelled" ? "mail.cancelled" : "mail.reconciled";
	await tx
		.insert(tables.audit_event)
		.values({
			tenant_id: m.tenant_id,
			subject_id: m.id,
			kind: "outcome",
			occurred_at: sql`${e.occurred_at}`,
			recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
			system_cause: "provider_callback",
			event_key: `provider/${e.id}`,
			action: action,
		})
		.onConflictDoNothing({ target: [tables.audit_event.subject_id, tables.audit_event.event_key] });
	return "applied" as const;
}
export async function receiveMailCallback(db: Database, request: Request, secret: string) {
	const raw = await boundedBytes(request, 16_384);
	const key = verifyCallback(raw, request.headers, secret);
	const v = wire.parse(JSON.parse(new TextDecoder().decode(raw)));
	const kind = z.enum(kinds).parse(v.type.slice(6));
	const hash = createHash("sha256").update(raw).digest("hex");
	// Commit the safe receipt before attempting application, including unknown message IDs.
	const id = await transaction(db, async (tx) => {
		const r = await tx
			.insert(tables.provider_event)
			.values({
				event_key: key,
				message_id: v.data.email_id,
				kind: kind,
				occurred_at: sql`${v.created_at}`,
				received_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				payload_hash: hash,
				safe_payload: { hard_bounce: kind === "bounced" && v.data.bounce?.type === "Permanent" },
			})
			.onConflictDoNothing({ target: [tables.provider_event.event_key] })
			.returning({ id: tables.provider_event.id });
		if (r[0]) return z.uuid().parse(r[0].id);
		const old = await tx
			.select({ id: tables.provider_event.id, payload_hash: tables.provider_event.payload_hash })
			.from(tables.provider_event)
			.where(eq(tables.provider_event.event_key, key));
		if (old[0]?.payload_hash !== hash) throw Error("callback_identity_conflict");
		return z.uuid().parse(old[0].id);
	});
	try {
		return { stored: true, result: await transaction(db, (tx) => apply(tx, id)) };
	} catch {
		return { stored: true, result: "pending" as const };
	}
}
export async function replayStoredCallbacks(db: Database, limit = 100) {
	z.number().int().min(1).max(100).parse(limit);
	const rows = await db
		.select({ id: provider_event_e.id })
		.from(provider_event_e)
		.where(
			and(
				isNull(provider_event_e.processed_at),
				sql<unknown>`exists(SELECT (1)  FROM mail  AS m  WHERE (m .provider_message_id = e .message_id))`,
			),
		)
		.orderBy(asc(provider_event_e.received_at), asc(provider_event_e.id))
		.limit(limit);
	let applied = 0;
	for (const row of rows) {
		try {
			if ((await transaction(db, (tx) => apply(tx, z.uuid().parse(row.id)))) === "applied") applied++;
		} catch {
			/* The durable pending receipt stays visible; another bad row cannot block the scan tail. */
		}
	}
	return applied;
}
export function mailCallbackHandler(db: Database, secret: string) {
	return (request: Request) =>
		safeBoundary(async () => {
			if (request.method !== "POST") return safeResponse({ code: "method_not_allowed" }, 405);
			const result = await receiveMailCallback(db, request, secret);
			return safeResponse(result, result.result === "pending" ? 202 : 200);
		});
}

export async function callbackVisibility(
	db: Database,
	endpoint: "disabled" | "unverified" | "verified" = "unverified",
) {
	const r = await db
		.select({
			pending: sql<number>`count(*) FILTER(WHERE ${provider_event_e.processed_at} IS NULL)::int`,
			unmatched: sql<number>`count(*) FILTER(WHERE ${provider_event_e.processed_at} IS NULL AND NOT EXISTS(SELECT 1 FROM ${tables.mail} WHERE ${tables.mail.provider_message_id}=${provider_event_e.message_id}))::int`,
		})
		.from(provider_event_e);
	return { endpoint, ...z.object({ pending: z.number().int(), unmatched: z.number().int() }).parse(r[0]) };
}
// The operator adapter must establish fresh restricted authority for this exact mail owner.
export async function recoverCallback(
	db: Database,
	eventId: string,
	authorize: (tx: Transaction, tenant: string) => Promise<{ actorId: string; operationId: string } | null>,
) {
	z.uuid().parse(eventId);
	return transaction(db, async (tx) => {
		const found = await tx
			.select({ tenant_id: mail_m.tenant_id, id: mail_m.id })
			.from(provider_event_e)
			.innerJoin(mail_m, eq(mail_m.provider_message_id, provider_event_e.message_id))
			.where(eq(provider_event_e.id, eventId));
		if (found.length !== 1) return "unmatched" as const;
		const m = z.object({ tenant_id: z.uuid(), id: z.uuid() }).parse(found[0]);
		const actor = await authorize(tx, m.tenant_id);
		if (!actor) throw Error("recovery_unavailable");
		const result = await apply(tx, eventId);
		await tx
			.insert(tables.audit_event)
			.values({
				tenant_id: m.tenant_id,
				subject_id: m.id,
				actor_id: actor.actorId,
				command_id: actor.operationId,
				kind: "reconcile",
				occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				event_key: `callback-recovery/${eventId}/${actor.operationId}`,
				action: "mail.reconciled",
			})
			.onConflictDoNothing({ target: [tables.audit_event.subject_id, tables.audit_event.event_key] });
		return result;
	});
}
