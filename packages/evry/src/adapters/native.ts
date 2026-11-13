import type { Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { TaskReminders } from "@everyfield/domain/tasks";
import type { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import type {
	EffectResult,
	NativeContext,
	NativePorts,
	ReviewContext,
	ReviewedWrite,
} from "../proposals/types.ts";

// What the Settings, seat, sharing, connection, account and organization tools share. Each review is one SELECT that
// reads its target live and saves the native command's exact arguments with the revision the review showed. On
// approval the executor runs the same native command the Settings screen calls, inside its own transaction, with the
// effect key as the request key; anything that changed since refuses instead of being overwritten.

/** The Owner or Admin of the selected church: who may change its seats, settings, sharing and connections. */
export const plantAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");
/** Any seat in the selected church. */
export const plantSeat = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
/** The Owner or Admin of the selected sending church or network. */
export const organizationAdmin = (actor: EvryActor) =>
	actor.owner.kind === "organization" && (actor.role === "owner" || actor.role === "admin");

/** One reviewed field: its value before and after, both as JSON. */
export const change = (field: string, before: SQL, after: unknown) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before},'after',${JSON.stringify(after ?? null)}::jsonb)`;
export const target = (kind: string, id: SQL, label: SQL) =>
	sql`jsonb_build_object('kind',${kind}::text,'id',${id},'label',${label})`;
export const notes = (lines: readonly string[]) => sql`${JSON.stringify(lines)}::jsonb`;

/**
 * The code of a native refusal: a seat or invitation refusal, a Settings refusal, or the short code a connection or
 * organization command throws. Anything else is not a refusal: the change may have committed, so it stays unknown.
 */
export function refusalOf(error: unknown): string | null {
	if (!(error instanceof Error)) return null;
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string" && /^[a-z_]{3,40}$/.test(code)) return code;
	return /^[a-z_]{3,40}$/.test(error.message) ? error.message : null;
}

/** A native Settings reply: its value, or the refusal its code names. */
export function settled<T>(reply: { status: "ok"; value: T } | { status: "refused"; error: { code: string } }): T {
	if (reply.status === "ok") return reply.value;
	throw Object.assign(new Error(reply.error.code), { code: reply.error.code });
}

/** A connection or organization command's answer: committed, or refused as unavailable. */
export function committed<T extends { status: string }>(result: T): T {
	if (result.status === "unavailable") throw new Error("unavailable");
	return result;
}

type Receipt = { receiptId?: string; revision?: string };
/**
 * One reviewed native write. `review` selects the review and `args`, the native command's request without its request
 * key; `run` calls the native command with that request and its key.
 */
export function nativeWrite<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	allowed(actor: EvryActor): boolean;
	review(actor: EvryActor, input: I, context: ReviewContext): SQL | Promise<SQL | null>;
	run(
		tx: Transaction,
		context: PeopleContext,
		request: Record<string, unknown> & { requestKey: string },
		native: NativeContext & { ports: NativePorts; reminders: TaskReminders },
	): Promise<Receipt | void>;
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: spec.allowed,
		review: spec.review,
		async execute(tx, context, args, effectKey, reminders, native): Promise<EffectResult> {
			const ports = native.ports;
			if (!ports) return { refused: "source_unavailable" };
			try {
				const receipt = await spec.run(
					tx,
					context,
					{ ...(args as Record<string, unknown>), requestKey: effectKey },
					{ ...native, ports, reminders },
				);
				return { ...receipt, revision: receipt?.revision ?? "1" };
			} catch (error) {
				const code = refusalOf(error);
				if (code) return { refused: code };
				throw error;
			}
		},
	};
}
