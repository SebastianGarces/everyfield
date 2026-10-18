import * as tables from "@everyfield/db/tables";
import { and, asc, desc, eq, isNotNull, sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import type { Database, Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { inTransaction } from "./atomic.ts";
export const operatorOperation = z.enum([
	"ops.readiness",
	"jobs.inspectLag",
	"security.inspectAudit",
	"ops.errorCorrelation",
]);
export type OperatorOperation = z.infer<typeof operatorOperation>;
export const operatorScope = z.strictObject({
	principal: z.uuid(),
	tenant: z.uuid(),
	purpose: z.enum(["incident", "recovery_drill", "delivery_reconciliation"]),
	operations: z.array(operatorOperation).min(1).max(4),
	expiresAt: z.date(),
});
export type OperatorScope = z.infer<typeof operatorScope>;
// Trusted host/session adapter, never a request DTO or tenant-role assertion. It must
// lock/recheck its independently established immutable principal and exact grant.
export type AuthenticateOperator = (tx: Transaction) => Promise<OperatorScope | null>;
export function operatorOperations(db: Database, authenticate: AuthenticateOperator) {
	async function run<T>(operation: OperatorOperation, read: (tx: Transaction, scope: OperatorScope) => Promise<T>) {
		return inTransaction(db, async (tx) => {
			const found = await authenticate(tx);
			if (!found) throw Error("unavailable");
			const scope = operatorScope.parse(found);
			const r = await tx.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`);
			const now = z.coerce.date().parse(r.rows[0]?.now);
			if (scope.expiresAt <= now || !scope.operations.includes(operation)) throw Error("unavailable");
			const result = await read(tx, scope);
			await tx.insert(tables.event).values({
				tenant_id: scope.tenant,
				target_record_id: scope.tenant,
				actor_id: scope.principal,
				kind: "read",
				occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
				event_key: randomUUID(),
				action: operation === "security.inspectAudit" ? "security.audit_inspected" : "security.operator_accessed",
			});
			return result;
		});
	}

	return {
		withReadiness<T>(read: () => Promise<T>) {
			return run("ops.readiness", () => read());
		},
		inspectLag() {
			return run("jobs.inspectLag", async (tx, scope) => {
				const r = await tx
					.select({
						kind: tables.job.kind,
						state: tables.job.state,
						count: sql<number>`(count(*))::int`,
						lag_seconds: sql<number>`(greatest(0, extract(epoch FROM (clock_timestamp() - min(${tables.job.eligible_at})))))::float8`,
					})
					.from(tables.job)
					.where(eq(tables.job.tenant_id, scope.tenant))
					.groupBy(tables.job.kind, tables.job.state)
					.orderBy(asc(tables.job.kind), asc(tables.job.state))
					.limit(80);
				return z
					.array(
						z.object({
							kind: z.enum([
								"mail",
								"notification",
								"digest",
								"assessment",
								"reference_generation",
								"feedback_publication",
								"object_cleanup",
								"lifecycle_purge",
								"assistant_turn",
								"document_render",
							]),
							state: z.enum([
								"ready",
								"claimed",
								"retry_wait",
								"reconcile",
								"succeeded",
								"failed",
								"cancelled",
								"superseded",
							]),
							count: z.number().int(),
							lag_seconds: z.number().nonnegative(),
						}),
					)
					.parse(r);
			});
		},
		inspectAudit(input: unknown) {
			const v = z.strictObject({ target: z.uuid(), limit: z.number().int().min(1).max(100).default(25) }).parse(input);
			return run("security.inspectAudit", async (tx, scope) => {
				// No body, diff, reason, contact values, raw error, model usage or care tables.
				const r = await tx
					.select({
						id: tables.event.id,
						action: tables.event.action,
						operation_id: tables.event.operation_id,
						effect_id: tables.event.effect_id,
						occurred_at: tables.event.occurred_at,
						before_revision: sql<string>`(${tables.event.before_revision})::text`,
						after_revision: sql<string>`(${tables.event.after_revision})::text`,
					})
					.from(tables.event)
					.where(
						and(
							and(eq(tables.event.tenant_id, scope.tenant), eq(tables.event.target_record_id, v.target)),
							isNotNull(tables.event.action),
						),
					)
					.orderBy(desc(tables.event.occurred_at), desc(tables.event.id))
					.limit(v.limit);
				return r;
			});
		},
		errorCorrelation(input: unknown) {
			const id = z.uuid().parse(input);
			return run("ops.errorCorrelation", async (tx, scope) => {
				const r = await tx
					.select({
						id: tables.operation.id,
						state: tables.operation.state,
						outcome: tables.operation.outcome,
						completed_at: tables.operation.completed_at,
					})
					.from(tables.operation)
					.where(and(eq(tables.operation.tenant_id, scope.tenant), eq(tables.operation.id, id)));
				return r[0] ?? null;
			});
		},
	};
}
