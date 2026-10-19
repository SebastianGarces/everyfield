import "server-only";
import { z } from "zod";
import { createDatabase, type Database } from "@everyfield/db/client";
import { and, eq, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { sessionResult } from "@everyfield/contracts/identity";
import { sessionId } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/onboarding";
import type { OnboardingContext, OnboardingWriteContext } from "@everyfield/contracts/onboarding/server";
import { createSeatService } from "@everyfield/domain/identity";
import { createOnboardingProducer } from "@everyfield/domain/onboarding";
import { identityHandler } from "../identity";
import { createMailService } from "../jobs/mail";
import { enqueueJob } from "../jobs/queue";

// The onboarding mount (WP-009/ui R2). The screens reach it only through the server actions in
// features/onboarding/actions.ts. The session comes from the identity mount, the plant from the seat service, and
// every write goes through the WP-009/api producer in one transaction. Mail is enqueued only; WP-031 dispatches.

export type Op = "createPlant" | "createDiscovery" | "convertDiscovery" | "declareJourney" | "answerLead" | "complete";
type Reply = { status: "ok"; value: unknown } | { status: "refused"; error: z.infer<typeof c.onboardingError> };

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_MAIL_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_ADDRESS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_MAIL_FROM: z.email(),
});
const contact = z.object({ email: z.email() });

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const db: Database = createDatabase({ connectionString: v.IDENTITY_DATABASE_URL, max: 3 });
	const mail = createMailService({
		db,
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"),
		from: v.IDENTITY_MAIL_FROM,
		authorize: async (_tx, m) =>
			m.recipient === m.tenant && ["notification", "discovery_receipt", "relationship_receipt"].includes(m.purpose),
		transport: {
			async send() {
				return { kind: "refused", retryable: true };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const address = async (tx: Parameters<typeof mail.enqueue>[0], account: string) =>
		contact.parse((await tx.execute(sql`SELECT * FROM access_account_contact(${account})`)).rows[0]).email;
	const producer = createOnboardingProducer({
		async invalidate(tx, input) {
			await enqueueJob(tx, {
				tenant: input.owner.id,
				kind: "assessment",
				subject: input.sourceId,
				key: "onboarding/" + input.sourceId + "/" + input.revision,
				revision: input.revision,
				eligibleAt: new Date().toISOString(),
			});
		},
		async notice(tx, input) {
			const [operation] = await tx.select().from(t.operation).where(eq(t.operation.id, input.operationId));
			const owners = await tx
				.select({ id: t.seat.account_id })
				.from(t.seat)
				.where(
					and(
						eq(t.seat.organization_id, input.pair.organization.id),
						eq(t.seat.role, "owner"),
						sql`${t.seat.ended_at} IS NULL`,
					),
				);
			const recipients = [operation?.actor_id, ...owners.map((s) => s.id)].filter((v): v is string => Boolean(v));
			for (const recipient of new Set(recipients))
				await mail.enqueue(tx, {
					owner: { kind: "account", id: recipient },
					purpose: input.pair.kind === "discovery" ? "discovery_receipt" : "relationship_receipt",
					logicalKey: "relationship/" + input.eventId + "/" + recipient,
					recipient,
					address: await address(tx, recipient),
					content: { subject: "Relationship updated", text: "A church relationship you are part of changed." },
					operation: null,
					notice: null,
					eligibleAt: new Date().toISOString(),
				});
		},
		async enqueue(tx, input) {
			await mail.enqueue(tx, {
				owner: { kind: "account", id: input.accountId },
				purpose: input.kind === "discovery_created" ? "discovery_receipt" : "notification",
				logicalKey: `onboarding/${input.operationId}/${input.kind}`,
				recipient: input.accountId,
				address: await address(tx, input.accountId),
				content:
					input.kind === "discovery_created"
						? { subject: "Your Discovery space is ready", text: "You can read the foundations at your own pace." }
						: {
								subject: "Your church is set up",
								text: "Your church is in EveryField. Setup continues where you left off.",
							},
				operation: input.operationId,
				notice: null,
				eligibleAt: new Date().toISOString(),
			});
		},
	});
	return { db, producer, seats: createSeatService(db), origin: v.IDENTITY_ORIGIN };
}
function current() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}

/** The validated session, read through the identity mount exactly as the browser would. */
async function session(m: NonNullable<ReturnType<typeof current>>, headers: Headers) {
	const h = new Headers({ host: new URL(m.origin).host });
	const cookie = headers.get("cookie");
	if (cookie) h.set("cookie", cookie);
	const response = await identityHandler(new Request(`${m.origin}/api/auth/get-session`, { headers: h }));
	if (!response.ok) return null;
	const parsed = sessionResult.safeParse(await response.json().catch(() => null));
	return parsed.success ? parsed.data : null;
}

export type RawEntry =
	| { kind: "signed_out" }
	| { kind: "confirm_email" }
	| { kind: "start"; offer: "planter" | "discovery" | "either"; accountRevision: string }
	| { kind: "plant"; plantName: string | null; resume: unknown }
	| { kind: "discovery"; profile: unknown }
	| { kind: "elsewhere"; reason: "member" | "organization" | "unavailable" };

/** Where this account stands. Contract values are parsed again in the browser (features/onboarding/port.ts). */
export async function onboardingEntry(headers: Headers): Promise<RawEntry> {
	const m = current();
	if (!m) return { kind: "elsewhere", reason: "unavailable" };
	const s = await session(m, headers);
	if (!s) return { kind: "elsewhere", reason: "unavailable" };
	if (s.status === "unauthenticated") return { kind: "signed_out" };
	const read = (selected: OnboardingContext["selected"]): OnboardingContext => ({
		session: s.sessionId,
		selected,
		purpose: "native",
	});
	const membership = s.status === "active" ? await m.seats.readCurrentMembership(s.sessionId) : null;
	if (membership?.status === "unavailable") return { kind: "elsewhere", reason: "unavailable" };
	if (membership?.status === "active") {
		const w = membership.workspace;
		if (w.kind !== "plant") return { kind: "elsewhere", reason: "organization" };
		if (membership.role !== "owner") return { kind: "elsewhere", reason: "member" };
		const reply = await m.db.transaction((tx) => m.producer.getResume(tx, read(w), {}));
		if (reply.status !== "ok" || reply.value.status !== "available") return { kind: "elsewhere", reason: "member" };
		// R3 gap: resume carries no plant name. Read it for the heading only.
		const [plant] = await m.db.select({ name: t.plant.name }).from(t.plant).where(eq(t.plant.id, w.id));
		return { kind: "plant", plantName: plant?.name ?? null, resume: reply.value };
	}
	const account = { kind: "account" as const, id: s.accountId };
	const profile = await m.db.transaction((tx) => m.producer.getDiscoveryProfile(tx, read(account), {}));
	if (profile.status === "ok" && profile.value.status === "active")
		return { kind: "discovery", profile: profile.value.profile };
	if (profile.status === "ok" && profile.value.status === "converted")
		return { kind: "elsewhere", reason: "unavailable" };
	// R3 gap: no contract read gives the precreation facts. This is the one place that reads them.
	const [row] = await m.db
		.select({ state: t.account.registration_state, kind: t.account.registration_kind, revision: t.account.revision })
		.from(t.account)
		.where(eq(t.account.id, s.accountId));
	const identity = await m.db.execute(sql`SELECT verified FROM invitation_identity(${sessionId.parse(s.sessionId)})`);
	if (!row) return { kind: "elsewhere", reason: "unavailable" };
	if (identity.rows[0]?.verified !== true) return { kind: "confirm_email" };
	if (row.state === "active") return { kind: "start", offer: "either", accountRevision: String(row.revision) };
	if (row.kind === "planter") return { kind: "start", offer: "planter", accountRevision: String(row.revision) };
	if (row.kind === "discovery") return { kind: "start", offer: "discovery", accountRevision: String(row.revision) };
	return { kind: "elsewhere", reason: "organization" };
}

const refusal = (code: "unavailable" | "invalid_input"): Reply => ({
	status: "refused",
	error: c.onboardingError.parse({ code, details: {}, correlationId: crypto.randomUUID(), retry: "never" }),
});

/** Run one onboarding command for the signed-in account. Input is parsed here; the producer rechecks every authority. */
export async function onboardingCommand(headers: Headers, op: Op, input: unknown): Promise<Reply> {
	const m = current();
	if (!m) return refusal("unavailable");
	const s = await session(m, headers);
	if (!s || s.status === "unauthenticated") return refusal("unavailable");
	const write = (selected: OnboardingWriteContext["selected"]): OnboardingWriteContext => ({
		session: s.sessionId,
		selected,
		purpose: "native",
		origin: { kind: "native" },
	});
	const account = write({ kind: "account", id: s.accountId });
	const p = m.producer;
	const run = (body: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<Reply>) =>
		m.db.transaction(body);
	switch (op) {
		case "createPlant": {
			const q = c.createPlantRequest.safeParse(input);
			return q.success ? run((tx) => p.createPlant(tx, account, q.data)) : refusal("invalid_input");
		}
		case "createDiscovery": {
			const q = c.createDiscoveryRequest.safeParse(input);
			return q.success ? run((tx) => p.createDiscovery(tx, account, q.data)) : refusal("invalid_input");
		}
		case "convertDiscovery": {
			const q = c.convertDiscoveryRequest.safeParse(input);
			return q.success ? run((tx) => p.convertDiscovery(tx, account, q.data)) : refusal("invalid_input");
		}
	}
	// Setup commands act on the account's own plant seat, never on a plant named by the browser.
	const membership = await m.seats.readCurrentMembership(s.sessionId);
	if (membership.status !== "active" || membership.workspace.kind !== "plant") return refusal("unavailable");
	const plant = write(membership.workspace);
	switch (op) {
		case "declareJourney": {
			const q = c.declareJourneyRequest.safeParse(input);
			return q.success ? run((tx) => p.declareJourney(tx, plant, q.data)) : refusal("invalid_input");
		}
		case "answerLead": {
			const q = c.answerLeadRequest.safeParse(input);
			return q.success ? run((tx) => p.answerLead(tx, plant, q.data)) : refusal("invalid_input");
		}
		case "complete": {
			const q = c.completeOnboardingRequest.safeParse(input);
			return q.success ? run((tx) => p.complete(tx, plant, q.data)) : refusal("invalid_input");
		}
	}
}
