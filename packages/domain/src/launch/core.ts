import { requestIdentity, type RequestIdentity } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/launch";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer, type PlantViewer } from "../documents/access.ts";
import { hash } from "../operations/canonical.ts";

type Code = c.LaunchError["code"];
class Refusal extends Error {
	readonly code: Code;
	readonly details: object;
	constructor(code: Code, details: object = {}) {
		super(code);
		this.code = code;
		this.details = details;
	}
}
export function deny(code: Code, details: object = {}): never {
	throw new Refusal(code, details);
}
const RETRY: Record<Code, c.LaunchError["retry"]> = {
	invalid_input: "never",
	invalid_reason: "never",
	access_denied: "never",
	idempotency_conflict: "never",
	conflict: "refresh",
	stale_review: "refresh",
	invalid_outcome: "never",
	invalid_debrief: "never",
	invalid_summary: "never",
	not_ready: "refresh",
	derived_evidence_only: "never",
};
export async function settle<T>(body: () => Promise<T>): Promise<c.LaunchReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return {
			status: "refused",
			error: c.launchError.parse({
				code: error.code,
				details: error.details,
				correlationId: randomUUID(),
				retry: RETRY[error.code],
			}),
		};
	}
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	if (!found.success) deny("invalid_input");
	return found.data;
}

/**
 * The church plant of the request. `live` is the C13 condition that the session and exact seat still hold, any role;
 * `admin` adds Owner or Admin. Launch administration is Owner and Admin (launch.md); a Member reads the plan only, so
 * their `admin` is false and every administration statement reads and writes nothing.
 */
export type Scope = PlantViewer & { live: SQL; admin: SQL };
export function scopeOf(authority: RequestActor): Scope {
	const viewer = plantViewer(authority);
	if (!viewer) deny("access_denied");
	return {
		...viewer,
		live: liveRead(viewer.access),
		admin: viewer.access.role === "member" ? sql`false` : liveRead(viewer.access, true),
	};
}

export type Operation =
	| "launch.schedule"
	| "launch.postpone"
	| "launch.completeMilestone"
	| "launch.reopenMilestone"
	| "launch.recordOutcome"
	| "launch.correctOutcome"
	| "launch.addGuestAttendance"
	| "launch.saveDebriefDraft"
	| "launch.submitDebrief"
	| "launch.saveDebriefSummaryDraft"
	| "launch.publishDebriefSummary";
export const priorRow = z.object({ request_identity: z.unknown(), result: z.unknown() }).nullable();
/** The stored answer of an earlier request with this key, as a CTE named `prior`. */
export const priorKey = (scope: Scope, key: string) =>
	sql`prior AS (SELECT a.request_identity,a.result FROM audit_event a WHERE a.tenant_id=${scope.plantId}::uuid AND a.request_key=${key})`;
export function identityOf(
	scope: Scope,
	operation: Operation,
	q: { requestKey: string; expectedRevision: string; input: unknown },
) {
	return requestIdentity.parse({
		owner: { kind: "plant", id: scope.plantId },
		actorId: scope.accountId,
		operation,
		requestKey: q.requestKey,
		digest: hash({ operation, expectedRevision: q.expectedRevision, input: q.input }),
	});
}
/** The same request replays its stored answer; another request with the key is refused. */
export function replay(prior: NonNullable<z.infer<typeof priorRow>>, identity: RequestIdentity) {
	const stored = requestIdentity.safeParse(prior.request_identity);
	if (
		!stored.success ||
		stored.data.actorId !== identity.actorId ||
		stored.data.operation !== identity.operation ||
		stored.data.digest !== identity.digest
	)
		deny("idempotency_conflict");
	return prior.result;
}
/** The command's own audit columns: the request key, its identity and the stored answer. */
export const keyed = (identity: RequestIdentity, result: unknown) =>
	sql`${identity.requestKey},${JSON.stringify(identity)}::jsonb,${JSON.stringify(result)}::jsonb`;
