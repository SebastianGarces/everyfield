import * as C from "@everyfield/contracts/onboarding";
import { z } from "zod";
import {
	begin,
	needsReload,
	reload,
	settle,
	type Command,
	type Entry,
	type Hold,
	type Op,
	type OnboardingError,
	type Reply,
	type Results,
	type Settled,
	type State,
} from "./model.ts";

// The one door from the onboarding screens to the API. The real port calls the server actions; the design preview
// passes a fixture port (preview/fixtures.ts). Every reply is parsed here by the WP-009 contract, so a screen sees a
// contract value or one onboarding error, never raw data.

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

function refusal(code: "unavailable" | "unknown"): OnboardingError {
	return C.onboardingError.parse({
		code,
		details: {},
		correlationId: crypto.randomUUID(),
		retry: code === "unknown" ? "reconcile" : "never",
	});
}

/** A reply that arrived outside the contract reads as unavailable. */
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
	return { status: "refused", error: refusal("unavailable") };
}

/** `offline`: the entry call itself failed (a dropped connection), so nothing is known about where the account stands. */
export type ParsedEntry = { kind: "entry"; entry: Entry } | { kind: "signed_out" };
export type EntryLoad = ParsedEntry | { kind: "offline" };
export function parseEntry(raw: unknown): ParsedEntry {
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
				return { kind: "offline" };
			}
		},
		async command<O extends Op>(op: O, command: Command): Promise<Reply<Results[O]>> {
			let raw: unknown;
			try {
				raw = await transport.command(op, command);
			} catch {
				// No reply arrived, so the write may or may not have happened: keep the request key and reconcile.
				return { status: "refused", error: refusal("unknown") };
			}
			return parseReply<Results[O]>(RESULT[op], raw);
		},
	};
}

/** Where the store keeps its one State. */
export type StateCell = { get(): State; set(next: State): void };

/**
 * The latest entry from the server, or null when none arrived: signed out (the page goes to sign-in) or offline. On
 * null the step, its drafts and the entry it shows stay as they are.
 */
async function freshEntry(port: OnboardingPort, signIn: () => void): Promise<Entry | null> {
	const load = await port.entry();
	if (load.kind === "signed_out") signIn();
	return load.kind === "entry" ? load.entry : null;
}

/**
 * One command as the store runs it: begin, send, reload the entry when the reply asks for it, settle. Resolves to the
 * hold when nothing was sent, else to whether the server accepted it.
 */
export async function runCommand(
	port: OnboardingPort,
	cell: StateCell,
	op: Op,
	input: unknown,
	newKey: () => string,
	signIn: () => void,
): Promise<Hold | "ok" | "refused"> {
	const started = begin(cell.get(), op, input, newKey);
	if ("hold" in started) return started.hold;
	cell.set(started.state);
	const reply = await port.command(op, started.send);
	const settled = { op, reply } as Settled;
	const entry = needsReload(settled) ? await freshEntry(port, signIn) : null;
	cell.set(settle(cell.get(), settled, entry));
	return reply.status;
}

/** Load the latest facts from the server, keeping drafts. Nothing changes when no entry arrived. */
export async function refreshEntry(port: OnboardingPort, cell: StateCell, signIn: () => void): Promise<void> {
	const entry = await freshEntry(port, signIn);
	if (entry) cell.set(reload(cell.get(), entry));
}
