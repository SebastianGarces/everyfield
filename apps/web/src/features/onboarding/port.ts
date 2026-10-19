import * as C from "@everyfield/contracts/onboarding";
import { z } from "zod";
import type { Command, Entry, Op, OnboardingError, Reply, Results } from "./model";

// The one door from the onboarding screens to the API. The real port calls the server actions; the design preview
// passes a fixture port (preview/fixtures.ts). Every reply is parsed here by the WP-009 contract, so a screen sees a
// contract value or one onboarding error, never raw data.

export type CreatePlantResult = z.infer<typeof C.createPlantResult>;
export type ConvertDiscoveryResult = z.infer<typeof C.convertDiscoveryResult>;
export type CreateDiscoveryResult = z.infer<typeof C.createDiscoveryResult>;
export type JourneyResult = z.infer<typeof C.journeyResult>;
export type LeadAnswerResult = z.infer<typeof C.leadAnswerResult>;
export type CompleteResult = z.infer<typeof C.completeOnboardingResult>;

/** Raw values as they cross the wire. `signed_out` sends the page to sign-in; it never reaches a screen. */
export type RawEntry = { kind: string; [key: string]: unknown };
export interface OnboardingTransport {
	entry(): Promise<unknown>;
	command(op: Op, command: Command): Promise<unknown>;
}

const resume = C.resumeResult.options[1];
const entry = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("confirm_email") }),
	z.strictObject({
		kind: z.literal("start"),
		offer: z.enum(["planter", "discovery", "either"]),
		accountRevision: z.string().regex(/^[1-9][0-9]*$/),
	}),
	z.strictObject({ kind: z.literal("plant"), plantName: z.string().nullable(), resume }),
	z.strictObject({ kind: z.literal("discovery"), profile: C.discoveryProfileResult.options[1].shape.profile }),
	z.strictObject({ kind: z.literal("elsewhere"), reason: z.enum(["member", "organization", "unavailable"]) }),
]);
const RESULT: { [K in Op]: z.ZodType<Results[K]> } = {
	createPlant: C.createPlantResult,
	createDiscovery: C.createDiscoveryResult,
	convertDiscovery: C.convertDiscoveryResult,
	declareJourney: C.journeyResult,
	answerLead: C.leadAnswerResult,
	complete: C.completeOnboardingResult,
};

function unavailable(): OnboardingError {
	return C.onboardingError.parse({
		code: "unavailable",
		details: {},
		correlationId: crypto.randomUUID(),
		retry: "never",
	});
}

/** A reply outside the contract, or a failed call, reads as unavailable. */
export function parseReply<T>(schema: z.ZodType<T>, raw: unknown): Reply<T> {
	const shape = z.object({ status: z.enum(["ok", "refused"]), value: z.unknown(), error: z.unknown() }).partial();
	const r = shape.safeParse(raw);
	if (r.success && r.data.status === "ok") {
		const value = schema.safeParse(r.data.value);
		if (value.success) return { status: "ok", value: value.data };
	}
	if (r.success && r.data.status === "refused") {
		const error = C.onboardingError.safeParse(r.data.error);
		if (error.success) return { status: "refused", error: error.data };
	}
	return { status: "refused", error: unavailable() };
}

export type EntryLoad = { kind: "entry"; entry: Entry } | { kind: "signed_out" };
export function parseEntry(raw: unknown): EntryLoad {
	if (z.object({ kind: z.literal("signed_out") }).safeParse(raw).success) return { kind: "signed_out" };
	const parsed = entry.safeParse(raw);
	return { kind: "entry", entry: parsed.success ? parsed.data : { kind: "elsewhere", reason: "unavailable" } };
}

export type OnboardingPort = {
	entry(): Promise<EntryLoad>;
	command<O extends Op>(op: O, command: Command): Promise<Reply<Results[O]>>;
};

export function createPort(transport: OnboardingTransport): OnboardingPort {
	return {
		async entry() {
			try {
				return parseEntry(await transport.entry());
			} catch {
				return { kind: "entry", entry: { kind: "elsewhere", reason: "unavailable" } };
			}
		},
		async command<O extends Op>(op: O, command: Command): Promise<Reply<Results[O]>> {
			try {
				return parseReply<Results[O]>(RESULT[op], await transport.command(op, command));
			} catch {
				return { status: "refused", error: unavailable() };
			}
		},
	};
}
