import { sendOnboardingRelationships } from "../jobs/notifications";
import "server-only";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import type { Database } from "@everyfield/db/client";
import { database } from "../database";
import * as c from "@everyfield/contracts/onboarding";
import type { OnboardingWriteContext } from "@everyfield/contracts/onboarding/server";
import { createOnboardingProducer, withOnboardingWrite, readOnboardingEntry } from "@everyfield/domain/onboarding";
import { getViewer } from "../request-context";
import { createMailService, queueOnlyTransport, runDueMail, type MailPass, type MailTransport } from "../jobs/mail";

// The onboarding mount (WP-009/ui R2). The screens reach it only through the server actions in
// features/onboarding/actions.ts. The session comes from the identity mount, the plant from the seat service, and
// every write goes through the WP-009/api producer in one transaction. Writes queue mail; the scheduled runner sends
// it with onboardingMailPass.

export type Op = "createPlant" | "createDiscovery" | "convertDiscovery" | "declareJourney" | "answerLead" | "complete";
type Reply = { status: "ok"; value: unknown } | { status: "refused"; error: z.infer<typeof c.onboardingError> };

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	...mailEnv,
});

/** Onboarding mail keys: the set-up and Discovery receipts and the relationship receipts after a conversion. */
export const ONBOARDING_MAIL = ["onboarding/"];

function onboardingMail(v: z.infer<typeof env>, transport: MailTransport) {
	return createMailService({
		db: database(v.IDENTITY_DATABASE_URL),
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"),
		from: v.IDENTITY_MAIL_FROM,
		authorize: async (_tx, mail) =>
			new Set(
				mail
					.filter(
						(m) =>
							m.recipient === m.tenant &&
							["notification", "discovery_receipt", "relationship_receipt"].includes(m.purpose),
					)
					.map((m) => m.id),
			),
		transport,
	});
}

/**
 * The scheduled runner's onboarding mail pass: one bounded batch of this mount's due mail through `transport`, each
 * rechecked under the mount's own rule. Null when the deployment has no configuration for this mount.
 */
export function onboardingMailPass(transport: MailTransport): MailPass | null {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	const db = database(v.data.IDENTITY_DATABASE_URL),
		mail = onboardingMail(v.data, transport);
	return (limit, until) => runDueMail(db, mail, ONBOARDING_MAIL, limit, until);
}

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const mail = onboardingMail(v, queueOnlyTransport);
	const producer = createOnboardingProducer({
		relationships: async (tx, inputs) => {
			await sendOnboardingRelationships(tx, inputs, mail);
		},
		async enqueue(tx, input, command) {
			await mail.append(
				tx,
				{
					owner: { kind: "account", id: input.accountId },
					purpose: input.kind === "discovery_created" ? "discovery_receipt" : "notification",
					logicalKey: `onboarding/${input.operationId}/${input.kind}`,
					recipient: input.accountId,
					address: input.address,
					content:
						input.kind === "discovery_created"
							? { subject: "Your Discovery space is ready", text: "You can read the foundations at your own pace." }
							: {
									subject: "Your church is set up",
									text: "Your church is in Everyfield. Setup continues where you left off.",
								},
					operation: input.operationId,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				command.writes,
			);
		},
	});
	return { db, producer, origin: v.IDENTITY_ORIGIN };
}
/** The onboarding producer and its database; null when the deployment has no identity or mail configuration. */
export function onboardingMount() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}

export async function onboardingEntry() {
	const m = onboardingMount();
	if (!m) return { kind: "elsewhere", reason: "unavailable" } as const;
	const session = await getViewer();
	if (!session) return { kind: "elsewhere", reason: "unavailable" } as const;
	return readOnboardingEntry(m.db, m.producer, session, session.authority, session.verified);
}

const refusal = (code: "unavailable" | "invalid_input"): Reply => ({
	status: "refused",
	error: c.onboardingError.parse({ code, details: {}, correlationId: crypto.randomUUID(), retry: "never" }),
});

/** Run one onboarding command for the signed-in account. Input is parsed here; the producer rechecks every authority. */
export async function onboardingCommand(op: Op, input: unknown): Promise<Reply> {
	const m = onboardingMount();
	if (!m) return refusal("unavailable");
	const s = await getViewer();
	if (!s || s.status === "unauthenticated") return refusal("unavailable");
	const write = (selected: OnboardingWriteContext["selected"]): OnboardingWriteContext => ({
		session: s.sessionId,
		selected,
	});
	const account = write({ kind: "account", id: s.accountId });
	const p = m.producer;
	const run = (
		context: OnboardingWriteContext,
		body: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<Reply>,
	) => withOnboardingWrite(m.db, s.authority ?? undefined, context, body);
	switch (op) {
		case "createPlant": {
			const q = c.createPlantRequest.safeParse(input);
			return q.success ? run(account, (tx) => p.createPlant(tx, account, q.data)) : refusal("invalid_input");
		}
		case "createDiscovery": {
			const q = c.createDiscoveryRequest.safeParse(input);
			return q.success ? run(account, (tx) => p.createDiscovery(tx, account, q.data)) : refusal("invalid_input");
		}
		case "convertDiscovery": {
			const q = c.convertDiscoveryRequest.safeParse(input);
			return q.success ? run(account, (tx) => p.convertDiscovery(tx, account, q.data)) : refusal("invalid_input");
		}
	}
	// Setup commands act on the account's own plant seat, never on a plant named by the browser.
	const context = s.authority?.actor.context;
	if (context?.kind !== "seat" || context.owner.kind !== "plant") return refusal("unavailable");
	const plant = write(context.owner);
	switch (op) {
		case "declareJourney": {
			const q = c.declareJourneyRequest.safeParse(input);
			return q.success ? run(plant, (tx) => p.declareJourney(tx, plant, q.data)) : refusal("invalid_input");
		}
		case "answerLead": {
			const q = c.answerLeadRequest.safeParse(input);
			return q.success ? run(plant, (tx) => p.answerLead(tx, plant, q.data)) : refusal("invalid_input");
		}
		case "complete": {
			const q = c.completeOnboardingRequest.safeParse(input);
			return q.success ? run(plant, (tx) => p.complete(tx, plant, q.data)) : refusal("invalid_input");
		}
	}
}
