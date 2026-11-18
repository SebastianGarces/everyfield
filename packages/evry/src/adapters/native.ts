import type { Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { TaskReminders } from "@everyfield/domain/tasks";
import type { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import type { EffectResult, NativeContext, NativePorts, ReviewContext, ReviewedWrite } from "../proposals/types.ts";

export const plantAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");
export const plantOwner = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role === "owner";
export const accountContext = (actor: EvryActor) => actor.owner.kind === "account" && actor.role === null;
export const plantSeat = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
export const organizationAdmin = (actor: EvryActor) =>
	actor.owner.kind === "organization" && (actor.role === "owner" || actor.role === "admin");
export const organizationSeat = (actor: EvryActor) => actor.owner.kind === "organization" && actor.role !== null;

export const change = (field: string, before: SQL, after: unknown) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before},'after',${JSON.stringify(after ?? null)}::jsonb)`;
export const target = (kind: string, id: SQL, label: SQL) =>
	sql`jsonb_build_object('kind',${kind}::text,'id',${id},'label',${label})`;
export const notes = (lines: readonly string[]) => sql`${JSON.stringify(lines)}::jsonb`;
export function patchChanges(patch: Record<string, unknown>, columns: Record<string, string>, row: SQL) {
	const changes = Object.entries(patch).map(([field, after], n) => ({
		n,
		field,
		col: columns[field],
		after: after ?? null,
	}));
	return sql`(SELECT jsonb_agg(jsonb_build_object('field',k.field,'before',to_jsonb(${row})->k.col,'after',k.after) ORDER BY k.n)
		FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) k(n int,field text,col text,after jsonb))`;
}

export function refusalOf(error: unknown): string | null {
	if (!(error instanceof Error)) return null;
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string" && /^[a-z_]{3,40}$/.test(code)) return code;
	return /^[a-z_]{3,40}$/.test(error.message) ? error.message : null;
}

export function settled<T>(reply: { status: "ok"; value: T } | { status: "refused"; error: { code: string } }): T {
	if (reply.status === "ok") return reply.value;
	throw Object.assign(new Error(reply.error.code), { code: reply.error.code });
}

export function committed<T extends { status: string }>(result: T): T {
	if (result.status === "unavailable") throw new Error("unavailable");
	return result;
}

type Receipt = { receiptId?: string; revision?: string };
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
		async execute(tx, context, args, effectKey, ports, native): Promise<EffectResult> {
			const services = native.ports;
			if (!services) return { refused: "source_unavailable" };
			try {
				const receipt = await spec.run(
					tx,
					context,
					{ ...(args as Record<string, unknown>), requestKey: effectKey },
					{ ...native, ports: services, reminders: ports.reminders },
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
