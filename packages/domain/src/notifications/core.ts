import { owner, requestIdentity, type Owner } from "@everyfield/contracts/common";
import { notificationError, type NotificationError, type NotificationReply } from "@everyfield/contracts/notifications";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { RequestActor } from "../access/session.ts";
import { hash } from "../operations/canonical.ts";
import {
	declareWrite,
	finishAudit,
	lockedWrite,
	nativeWrite,
	prepareWrite,
	WriteUnavailable,
	type AuditWrite,
} from "../operations/writes.ts";

export type Tx = Transaction;
export const PAGE = 50;
export class NotificationRefusal extends Error {
	readonly code: NotificationError["code"];
	constructor(code: NotificationError["code"]) {
		super(code);
		this.code = code;
	}
}
export function deny(code: NotificationError["code"] = "unavailable"): never {
	throw new NotificationRefusal(code);
}
const retry: Record<NotificationError["code"], NotificationError["retry"]> = {
	invalid_input: "never",
	access_denied: "never",
	unavailable: "never",
	invalid_subject: "never",
	conflict: "refresh",
	temporary: "same_request",
	unknown: "reconcile",
};
function refused(error: NotificationRefusal): NotificationReply<never> {
	return {
		status: "refused",
		error: notificationError.parse({
			code: error.code,
			details: {},
			correlationId: randomUUID(),
			retry: retry[error.code],
		}),
	};
}
export function refusal(error: unknown): NotificationReply<never> {
	if (error instanceof WriteUnavailable) return refused(new NotificationRefusal("unavailable"));
	if (error instanceof NotificationRefusal) return refused(error);
	throw error;
}
export async function readReply<T>(body: () => Promise<T>): Promise<NotificationReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		return refusal(error);
	}
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const result = schema.safeParse(raw);
	if (!result.success) deny("invalid_input");
	return result.data;
}
export async function withNotificationWrite<T>(
	db: Database,
	authority: RequestActor,
	selected: Owner,
	body: (tx: Tx) => Promise<T>,
): Promise<NotificationReply<T>> {
	return readReply(() =>
		nativeWrite(db, authority, selected, async (tx) => {
			await declareWrite(tx, "established");
			return body(tx);
		}),
	);
}
export type Command = AuditWrite & { actorId: string; selected: Owner };
export async function command<T>(
	tx: Tx,
	authority: RequestActor,
	selected: Owner,
	operation: string,
	input: { requestKey: string },
	schema: z.ZodType<T>,
	body: (command: Command) => Promise<T>,
): Promise<T> {
	const bound = await lockedWrite(tx);
	if (!bound || bound.actor.accountId !== authority.actor.accountId) deny();
	const identity = requestIdentity.parse({
		owner: selected,
		actorId: bound.actor.accountId,
		operation,
		requestKey: input.requestKey,
		digest: hash({ operation, input }),
	});
	const claim = await prepareWrite(tx, identity);
	if (claim.kind === "conflict") deny("conflict");
	if (claim.kind === "unavailable") deny();
	if (claim.kind === "replay") return schema.parse(claim.value);
	const value = schema.parse(await body({ ...claim, actorId: bound.actor.accountId, selected }));
	await finishAudit(tx, claim, identity, value);
	return value;
}
export function audit(
	cmd: Command,
	entry: {
		subjectId: string;
		kind: "preference" | "read" | "edit" | "publish" | "noop";
		action?: string;
		fields: string[];
	},
) {
	cmd.events.push({
		id: cmd.id,
		tenant_id: cmd.selected.id,
		actor_id: cmd.actorId,
		action: entry.action ?? "settings.changed",
		kind: entry.kind,
		subject_type: "record",
		subject_id: entry.subjectId,
		metadata: { section: "notifications", diff: Object.fromEntries(entry.fields.map((field) => [field, true])) },
	});
}
export function accountOwner(accountId: string): Owner {
	return owner.parse({ kind: "account", id: accountId });
}
export function selfSql(session: string, accountId: string): SQL {
	return sql`me AS (
		SELECT i.account_id FROM live_session(${session}::uuid) i
		WHERE i.registration_state = 'active' AND i.account_id = ${accountId}::uuid
		 AND NOT EXISTS (SELECT FROM lifecycle_witness w WHERE w.state NOT IN ('active','cancelled')
		   AND w.kind = 'account' AND w.opaque_subject_id = i.account_id)
	)`;
}
const categories =
	"'task_due','task_overdue','meeting_announcement','meeting_reminder','planter_digest','oversight_digest','relationship_milestone','sharing_milestone','phase_milestone','launch_milestone','wiki_upstream_review'";
/** Rows the signed-in recipient may see in the feed, the bell, and mark. */
export function noticeVisible(eligible: SQL = sql`n.eligible_at <= clock_timestamp()`): SQL {
	return sql`n.cancelled_at IS NULL AND n.archived_at IS NULL AND ${eligible}
		AND n.recipient_id = (SELECT account_id FROM me)
		AND split_part(n.logical_key,'/',2) IN (${sql.raw(categories)})
		AND coalesce((SELECT p.enabled FROM notification_preference p
			WHERE p.account_id = n.recipient_id AND p.category = split_part(n.logical_key,'/',2) AND p.channel = 'in_app'),
			split_part(n.logical_key,'/',2) <> 'planter_digest')
		AND EXISTS (SELECT FROM seat s WHERE s.account_id = n.recipient_id AND s.ended_at IS NULL
			AND s.accepted_at <= clock_timestamp() AND (s.plant_id = n.tenant_id OR s.organization_id = n.tenant_id)
			AND NOT EXISTS (SELECT FROM lifecycle_witness w WHERE w.state NOT IN ('active','cancelled') AND (
				w.seat_id = s.id OR (w.kind = 'account' AND w.opaque_subject_id = s.account_id)
				OR (w.kind IN ('plant','organization') AND w.opaque_subject_id = n.tenant_id))))`;
}
export function overdueSql(asOf: string): SQL {
	return sql`(split_part(n.logical_key,'/',2) = 'task_overdue' OR (
		n.schedule_date IS NOT NULL AND split_part(n.logical_key,'/',2) = 'task_due'
		AND n.schedule_date < (${asOf}::timestamptz AT TIME ZONE COALESCE(n.timezone,'UTC'))::date))`;
}
export function jsonValue(value: unknown): unknown {
	return typeof value === "string" ? JSON.parse(value) : value;
}
export async function runWrite<S extends z.ZodType<{ requestKey: string }>, T>(
	db: Database,
	authority: RequestActor,
	selected: Owner,
	raw: unknown,
	schema: S,
	operation: string,
	result: z.ZodType<T>,
	body: (tx: Tx, cmd: Command, input: z.output<S>) => Promise<T>,
): Promise<NotificationReply<T>> {
	try {
		const input = parse(schema, raw);
		return await withNotificationWrite(db, authority, selected, (tx) =>
			command(tx, authority, selected, operation, input, result, (cmd) => body(tx, cmd, input)),
		);
	} catch (error) {
		return refusal(error);
	}
}
export { hash, RequestActor };
