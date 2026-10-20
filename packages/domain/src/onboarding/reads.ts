import "server-only";
import type { Database, Transaction } from "@everyfield/db/client";
import { and, eq, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { sessionId } from "@everyfield/contracts/common";
import type { SessionResult } from "@everyfield/contracts/identity";
import type { OnboardingContext, OnboardingProducer } from "@everyfield/contracts/onboarding/server";
import type { RequestActor } from "../access/index.ts";
import { OnboardingReadContext } from "./core.ts";

export type RawEntry =
	| { kind: "signed_out" }
	| { kind: "confirm_email" }
	| { kind: "start"; offer: "planter" | "discovery" | "either"; accountRevision: string }
	| { kind: "plant"; plantName: string | null; resume: unknown }
	| { kind: "discovery"; profile: unknown }
	| { kind: "elsewhere"; reason: "member" | "organization" | "unavailable" };

/**
 * Where this account stands, in one transaction that reuses the request actor (D59). Contract values are parsed again
 * in the browser (features/onboarding/port.ts).
 */
export async function readOnboardingEntry(
	db: Database,
	producer: OnboardingProducer<Transaction>,
	s: SessionResult,
	authority: RequestActor | null,
): Promise<RawEntry> {
	if (s.status === "unauthenticated") return { kind: "signed_out" };
	const context = authority?.actor.context;
	if (s.status === "active" && !context) return { kind: "elsewhere", reason: "unavailable" };
	if (authority && context?.kind === "seat") {
		const w = context.owner;
		if (w.kind !== "plant") return { kind: "elsewhere", reason: "organization" };
		if (context.role !== "owner") return { kind: "elsewhere", reason: "member" };
		return db.transaction(async (tx): Promise<RawEntry> => {
			const reply = await producer.getResume(tx, new OnboardingReadContext(authority), {});
			if (reply.status !== "ok" || reply.value.status !== "available") return { kind: "elsewhere", reason: "member" };
			// R3 gap: resume carries no plant name. Read it for the heading only.
			const [plant] = await tx.select({ name: t.plant.name }).from(t.plant).where(eq(t.plant.id, w.id));
			return { kind: "plant", plantName: plant?.name ?? null, resume: reply.value };
		});
	}
	const account: OnboardingContext["selected"] = { kind: "account", id: s.accountId };
	const ctx = authority ? new OnboardingReadContext(authority) : { session: s.sessionId, selected: account };
	const profile = await db.transaction((tx) => producer.getDiscoveryProfile(tx, ctx, {}));
	if (profile.status === "ok" && profile.value.status === "active")
		return { kind: "discovery", profile: profile.value.profile };
	if (profile.status === "ok" && profile.value.status === "converted")
		return { kind: "elsewhere", reason: "unavailable" };
	// R3 gap: no contract read gives the precreation facts. This is the one place that reads them.
	const [row] = await db
		.select({ state: t.account.registration_state, kind: t.account.registration_kind, revision: t.account.revision })
		.from(t.account)
		.where(eq(t.account.id, s.accountId));
	const identity = await db.execute(sql`SELECT verified FROM invitation_identity(${sessionId.parse(s.sessionId)})`);
	if (!row) return { kind: "elsewhere", reason: "unavailable" };
	if (identity.rows[0]?.verified !== true) return { kind: "confirm_email" };
	if (row.state === "active") return { kind: "start", offer: "either", accountRevision: String(row.revision) };
	if (row.kind === "planter") return { kind: "start", offer: "planter", accountRevision: String(row.revision) };
	if (row.kind === "discovery") return { kind: "start", offer: "discovery", accountRevision: String(row.revision) };
	return { kind: "elsewhere", reason: "organization" };
}

export async function readOnboardingNoticeRecipients(
	tx: Transaction,
	operationId: string,
	organizationId: string,
	creatorId?: string,
) {
	const creator =
		creatorId ??
		(await tx.select({ actor: t.audit_event.actor_id }).from(t.audit_event).where(eq(t.audit_event.id, operationId)))[0]
			?.actor;
	const owners = await tx
		.select({ id: t.seat.account_id })
		.from(t.seat)
		.where(and(eq(t.seat.organization_id, organizationId), eq(t.seat.role, "owner"), sql`${t.seat.ended_at} IS NULL`));
	return [creator, ...owners.map((s) => s.id)].filter((v): v is string => Boolean(v));
}
