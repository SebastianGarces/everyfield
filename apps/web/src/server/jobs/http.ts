import { and, eq } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import "server-only";
import type { Database, Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { boundedBytes, safeBoundary, safeResponse, secretMatches } from "../platform/boundary.ts";
import { transaction } from "../platform/database.ts";
import {
	claimDue,
	finishClaim,
	lockClaim,
	recoverLease,
	jobKind,
	type Claim,
	type JobKind,
	type JobResult,
} from "./queue.ts";
export type HandlerResult = JobResult | { state: "recorded" };
export type Handler = (claim: Claim, signal: AbortSignal) => Promise<HandlerResult>;
// WP-050 mounts this adapter in the same app. Request input cannot pick kinds or subjects.
export function executorHandler(config: {
	db: Database;
	secret: string;
	handlers: Partial<Record<JobKind, Handler>>;
	publish: (tx: Transaction, claim: Claim) => Promise<boolean>;
	limit?: number;
	kindBudgets?: Partial<Record<JobKind, number>>;
}) {
	const kinds = z.array(jobKind).min(1).max(10).parse(Object.keys(config.handlers));
	const limit = z
		.number()
		.int()
		.min(1)
		.max(20)
		.parse(config.limit ?? 5);
	return (request: Request) =>
		safeBoundary(async () => {
			if (request.method !== "POST") return safeResponse({ code: "method_not_allowed" }, 405);
			if (
				config.secret.length < 32 ||
				!secretMatches(request.headers.get("authorization"), config.secret ? `Bearer ${config.secret}` : undefined)
			)
				return safeResponse({ code: "unavailable" }, 404);
			const body = await boundedBytes(request, 2);
			if (body.length) return safeResponse({ code: "invalid_input" }, 422);
			const start = performance.now(),
				signal = AbortSignal.timeout(20_000);
			let processed = 0;
			const used = new Map<JobKind, number>();
			const budgets = new Map(
				kinds.map((kind) => [
					kind,
					z
						.number()
						.int()
						.min(1)
						.max(20)
						.parse(config.kindBudgets?.[kind] ?? limit),
				]),
			);
			await recoverLease(config.db);
			// Claim one row at a time so a slow handler never strands a preclaimed batch.
			for (let n = 0; n < limit && performance.now() - start < 15_000; n++) {
				const eligible = kinds.filter((kind) => (used.get(kind) ?? 0) < (budgets.get(kind) ?? 0));
				if (!eligible.length) break;
				const [claim] = await claimDue(config.db, eligible);
				if (!claim) break;
				used.set(claim.kind, (used.get(claim.kind) ?? 0) + 1);
				const handler = config.handlers[claim.kind];
				if (!handler) throw Error("handler_missing");
				let outcome: HandlerResult;
				try {
					let onAbort: () => void = () => {};
					const deadline = new Promise<never>((_, reject) => {
						onAbort = () => reject(Error("handler_deadline"));
						signal.addEventListener("abort", onAbort, { once: true });
						if (signal.aborted) onAbort();
					});
					try {
						outcome = await Promise.race([handler(claim, signal), deadline]);
					} finally {
						signal.removeEventListener("abort", onAbort);
					}
				} catch {
					outcome = { state: "reconcile", code: "handler_unknown" };
				}
				if (outcome.state === "recorded") {
					const current = await config.db
						.select({ state: tables.job.state })
						.from(tables.job)
						.where(and(eq(tables.job.id, claim.id), eq(tables.job.claim_generation, claim.claim_generation)));
					if (current[0] && current[0].state !== "claimed") processed++;
					continue;
				}
				const result = outcome;
				await transaction(config.db, async (tx) => {
					if (!(await lockClaim(tx, claim))) return;
					// Domain callbacks recheck current source, permission and lifecycle in this transaction.
					const finish =
						result.state === "succeeded" && !(await config.publish(tx, claim))
							? { state: "superseded" as const, code: "source_changed" }
							: result;
					if (await finishClaim(tx, claim, finish)) processed++;
				});
			}
			return safeResponse({ processed });
		});
}
