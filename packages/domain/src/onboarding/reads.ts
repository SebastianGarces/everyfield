import "server-only";
import type { Database, Transaction } from "@everyfield/db/client";
import { and, eq, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import type { SessionResult } from "@everyfield/contracts/identity";
import type { OnboardingProducer } from "@everyfield/contracts/onboarding/server";
import type { RequestActor } from "../access/index.ts";
import { OnboardingReadContext, readReply } from "./core.ts";
import { plantEntry } from "./setup.ts";

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
	/** The session's email verification, as the authentication layer read it; no second identity read. */
	verified: boolean,
): Promise<RawEntry> {
	if (s.status === "unauthenticated") return { kind: "signed_out" };
	const context = authority?.actor.context;
	if (s.status === "active" && !context) return { kind: "elsewhere", reason: "unavailable" };
	if (authority && context?.kind === "seat") {
		const w = context.owner;
		if (w.kind !== "plant") return { kind: "elsewhere", reason: "organization" };
		if (context.role !== "owner") return { kind: "elsewhere", reason: "member" };
		// One statement gives the resume facts and the plant's name (R3 gap: resume carries no name).
		const entry = await readReply(() => plantEntry(db, new OnboardingReadContext(authority)));
		if (entry.status !== "ok" || entry.value.resume.status !== "available")
			return { kind: "elsewhere", reason: "member" };
		return { kind: "plant", plantName: entry.value.plantName, resume: entry.value.resume };
	}
	// Creating a Discovery profile activates the account, so only an active (seatless) account can hold one.
	if (authority) {
		const profile = await db.transaction((tx) =>
			producer.getDiscoveryProfile(tx, new OnboardingReadContext(authority), {}),
		);
		if (profile.status === "ok" && profile.value.status === "active")
			return { kind: "discovery", profile: profile.value.profile };
		if (profile.status === "ok" && profile.value.status === "converted")
			return { kind: "elsewhere", reason: "unavailable" };
	}
	// R3 gap: no contract read gives the precreation facts. This is the one place that reads them.
	const [row] = await db
		.select({ state: t.account.registration_state, kind: t.account.registration_kind, revision: t.account.revision })
		.from(t.account)
		// The session must still be live for this account when its facts are read (C13). A pending account has no seat
		// or active registration yet, so the check is the session itself.
		.where(
			and(
				eq(t.account.id, s.accountId),
				sql`EXISTS(SELECT FROM live_session(${s.sessionId}::uuid) l WHERE l.account_id=${t.account.id})`,
			),
		);
	if (!row) return { kind: "elsewhere", reason: "unavailable" };
	if (!verified) return { kind: "confirm_email" };
	if (row.state === "active") return { kind: "start", offer: "either", accountRevision: String(row.revision) };
	if (row.kind === "planter") return { kind: "start", offer: "planter", accountRevision: String(row.revision) };
	if (row.kind === "discovery") return { kind: "start", offer: "discovery", accountRevision: String(row.revision) };
	return { kind: "elsewhere", reason: "organization" };
}
