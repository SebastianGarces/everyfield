import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import type { digestSchedule } from "@everyfield/contracts/settings";
import { localDate, localDateTime, owner } from "@everyfield/contracts/common";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import type { EffectResult, NativeContext, NativePorts, ReviewContext, ReviewedWrite } from "../proposals/types.ts";
import type { RequestActor, WriteTx } from "@everyfield/domain/access";
import { DomainRefusal } from "@everyfield/domain/operations";

export const plantAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");
export const plantOwner = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role === "owner";
export const accountContext = (actor: EvryActor) => actor.owner.kind === "account" && actor.role === null;
export const plantSeat = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
export const organizationAdmin = (actor: EvryActor) =>
	actor.owner.kind === "organization" && (actor.role === "owner" || actor.role === "admin");
export const dayInput = z.string().refine((v) => localDate.safeParse(v).success, "not a YYYY-MM-DD day");
export const localTimeInput = z
	.string()
	.refine((v) => localDateTime.safeParse(v).success, "not a YYYY-MM-DDTHH:MM:SS local time");
export const networkSeat = (actor: EvryActor) => actor.contextKind === "sending_network" && actor.role !== null;
export const organizationSeat = (actor: EvryActor) => actor.owner.kind === "organization" && actor.role !== null;
export const rowId = z.string().refine((value) => z.uuid().safeParse(value).success, "an id from an earlier result");

export const anySeat = (actor: EvryActor) => plantSeat(actor) || organizationSeat(actor) || accountContext(actor);

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const hourText = (hour: number) => `${hour % 12 || 12}:00 ${hour < 12 ? "AM" : "PM"}`;
export const scheduleText = (s: z.infer<typeof digestSchedule>) =>
	s.cadence === "off"
		? "Off"
		: s.cadence === "daily"
			? `Daily at ${hourText(s.hour)}`
			: `Weekly on ${WEEKDAYS[s.weekday]} at ${hourText(s.hour)}`;

export const ownContext = (context: PeopleContext, accountId: string) => ({
	session: context.session,
	selected: owner.parse({ kind: "account", id: accountId }),
});

export const change = (field: string, before: SQL, after: unknown) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before},'after',${JSON.stringify(after ?? null)}::jsonb)`;
export const target = (kind: string, id: SQL, label: SQL) =>
	sql`jsonb_build_object('kind',${kind}::text,'id',${id},'label',${label})`;
export const notes = (lines: readonly string[]) => sql`${JSON.stringify(lines)}::jsonb`;
export const reviewed = (review: object, args: object) =>
	sql`SELECT ${JSON.stringify(review)}::jsonb AS review, ${JSON.stringify(args)}::jsonb AS args`;
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

export function settled<T>(reply: { status: "ok"; value: T } | { status: "refused"; error: { code: string } }): T {
	if (reply.status === "ok") return reply.value;
	throw new DomainRefusal(reply.error.code);
}

export function committed<T extends { status: string }>(result: T): T {
	if (result.status === "unavailable") throw new DomainRefusal("unavailable");
	return result;
}

export function approvedNow<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	allowed?: (actor: EvryActor) => boolean;
	review: ReviewedWrite<I>["review"];
	reason: boolean;
	run(
		db: Database,
		authority: RequestActor,
		args: Record<string, unknown>,
		reason: string | null,
	): Promise<EffectResult>;
	current?(p: SQL): SQL;
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: spec.allowed ?? organizationAdmin,
		review: spec.review,
		execute: async () => ({ refused: "review_closed" }),
		approveNow: {
			reason: spec.reason,
			run: (db, authority, args, reason) => spec.run(db, authority, args as Record<string, unknown>, reason),
		},
		...(spec.current && { current: spec.current }),
	};
}

type Receipt = { receiptId?: string; revision?: string };
export function nativeWrite<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	allowed(actor: EvryActor): boolean;
	review(actor: EvryActor, input: I, context: ReviewContext): SQL | Promise<SQL | null>;
	run(
		tx: WriteTx,
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
				if (error instanceof DomainRefusal) return { refused: error.code };
				throw error;
			}
		},
	};
}
