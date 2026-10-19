import "server-only";
import type { Database, Transaction } from "@everyfield/db/client";
import { and, eq, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { sessionId } from "@everyfield/contracts/common";
import type { SessionResult } from "@everyfield/contracts/identity";
import type { OnboardingContext, OnboardingProducer } from "@everyfield/contracts/onboarding/server";
import { createSeatService } from "../identity/index.ts";

export type RawEntry =
	| { kind: "signed_out" }
	| { kind: "confirm_email" }
	| { kind: "start"; offer: "planter" | "discovery" | "either"; accountRevision: string }
	| { kind: "plant"; plantName: string | null; resume: unknown }
	| { kind: "discovery"; profile: unknown }
	| { kind: "elsewhere"; reason: "member" | "organization" | "unavailable" };

/** Where this account stands. Contract values are parsed again in the browser (features/onboarding/port.ts). */
export async function readOnboardingEntry(
	db: Database,
	producer: OnboardingProducer<Transaction>,
	s: SessionResult,
): Promise<RawEntry> {
	if (s.status === "unauthenticated") return { kind: "signed_out" };
	const read = (selected: OnboardingContext["selected"]): OnboardingContext => ({
		session: s.sessionId,
		selected,
		purpose: "native",
	});
	const membership = s.status === "active" ? await createSeatService(db).readCurrentMembership(s.sessionId) : null;
	if (membership?.status === "unavailable") return { kind: "elsewhere", reason: "unavailable" };
	if (membership?.status === "active") {
		const w = membership.workspace;
		if (w.kind !== "plant") return { kind: "elsewhere", reason: "organization" };
		if (membership.role !== "owner") return { kind: "elsewhere", reason: "member" };
		const reply = await db.transaction((tx) => producer.getResume(tx, read(w), {}));
		if (reply.status !== "ok" || reply.value.status !== "available") return { kind: "elsewhere", reason: "member" };
		// R3 gap: resume carries no plant name. Read it for the heading only.
		const [plant] = await db.select({ name: t.plant.name }).from(t.plant).where(eq(t.plant.id, w.id));
		return { kind: "plant", plantName: plant?.name ?? null, resume: reply.value };
	}
	const account = { kind: "account" as const, id: s.accountId };
	const profile = await db.transaction((tx) => producer.getDiscoveryProfile(tx, read(account), {}));
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

export async function readOnboardingNoticeRecipients(tx: Transaction, operationId: string, organizationId: string) {
	const [operation] = await tx.select().from(t.operation).where(eq(t.operation.id, operationId));
	const owners = await tx
		.select({ id: t.seat.account_id })
		.from(t.seat)
		.where(and(eq(t.seat.organization_id, organizationId), eq(t.seat.role, "owner"), sql`${t.seat.ended_at} IS NULL`));
	return [operation?.actor_id, ...owners.map((s) => s.id)].filter((v): v is string => Boolean(v));
}
