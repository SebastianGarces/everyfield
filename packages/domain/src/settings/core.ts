import { claimOperation, executeWrites } from "../operations/writes.ts";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Transaction } from "@everyfield/db/client";
import * as t from "@everyfield/db/tables";
import { and, eq, gt, isNull, lte, sql } from "@everyfield/db/query";
import { lock as lockSeats } from "../identity/invitation-core.ts";
import { currentActor, liveOwner, requestWrite, lockWriteAuthority, currentWriteAllowed } from "../access/session.ts";
import { canonical, appendEvent } from "../organizations/core.ts";
import {
	receipt,
	tenantId,
	requestIdentity,
	sameOwner,
	sessionId,
	accountId,
	type Owner,
	type Receipt,
} from "@everyfield/contracts/common";
import { settingsError } from "@everyfield/contracts/settings";
import type { SettingsContext, SettingsWriteContext, SettingsReply } from "@everyfield/contracts/settings/server";
export { canonical, appendEvent, sameOwner };
export type Tx = Transaction;
export type Context = SettingsContext;
export type WriteContext = SettingsWriteContext;
export const now = sql<Date>`clock_timestamp()`.mapWith((v: string) => new Date(v));
export const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
export class Refusal extends Error {
	constructor(readonly code: z.infer<typeof settingsError>["code"] = "unavailable") {
		super(code);
	}
}
export function deny(code?: Refusal["code"]): never {
	throw new Refusal(code);
}
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
	const r = schema.safeParse(input);
	if (!r.success) deny("invalid_input");
	return r.data;
}
export function revision(expected: string, actual: string) {
	if (expected !== actual) deny("conflict");
}
export async function reply<T>(tx: Tx, body: (tx: Tx) => Promise<T>): Promise<SettingsReply<T>> {
	try {
		return { status: "ok", value: await tx.transaction(body) };
	} catch (e) {
		if (!(e instanceof Refusal)) throw e;
		const retry =
			e.code === "conflict" || e.code === "stale_preview"
				? "refresh"
				: e.code === "temporary"
					? "same_request"
					: e.code === "unknown"
						? "reconcile"
						: "never";
		return {
			status: "refused",
			error: settingsError.parse({ code: e.code, details: {}, correlationId: randomUUID(), retry }),
		};
	}
}
export async function actor(tx: Tx, ctx: Context, use: "read" | "command" | "preview" = "read") {
	const bound = requestWrite(tx);
	if (
		bound &&
		bound.authority.session === ctx.session &&
		bound.selected.id === ctx.selected.id &&
		bound.selected.kind === ctx.selected.kind
	) {
		if (use !== "command" && !(await currentWriteAllowed(tx, bound.actor.accountId, ctx.selected))) deny();
		return {
			identity: bound.actor,
			account: bound.account,
			principal: bound.principal,
			plant: bound.plant,
			organization: bound.organization,
			setup: bound.setup,
		};
	}

	if (ctx.selected.kind === "plant") await lockSeats(tx, "workspace-seats/" + ctx.selected.id);
	if (use !== "read") {
		const locked = await lockWriteAuthority(tx, ctx.session, ctx.selected, true);
		if (!locked || locked.identity.status !== "active") deny();
		if (use === "preview" && !(await currentWriteAllowed(tx, locked.identity.accountId, ctx.selected))) deny();
		return { ...locked, identity: locked.identity };
	}

	// This capability takes the account write lock before session and user share locks.
	const raw = await tx.execute(sql`SELECT * FROM invitation_identity(${sessionId.parse(ctx.session)})`);
	const p = z
		.object({ account_id: accountId, display_name: z.string(), email: z.string(), verified: z.boolean() })
		.safeParse(raw.rows[0]);
	if (!p.success || !p.data.verified) deny();

	const a = await currentActor(tx, ctx.session, ctx.selected);
	if (a.status !== "active") deny();
	const [account] = await tx.select().from(t.account).where(eq(t.account.id, a.accountId));
	if (!account) deny();
	return { identity: a, account, principal: p.data, plant: null, organization: null, setup: null };
}
export async function self(tx: Tx, ctx: Context, use: "read" | "command" | "preview" = "command") {
	const a = await actor(tx, ctx, use);
	if (ctx.selected.kind !== "account" || ctx.selected.id !== a.account.id) deny();
	return a;
}
export function native(ctx: Context) {
	if (ctx.purpose !== "native") deny();
}
export async function plantAdmin(tx: Tx, ctx: Context, plant: Owner, use: "read" | "command" | "preview" = "read") {
	const a = await actor(tx, ctx, use);
	if (
		!sameOwner(ctx.selected, plant) ||
		ctx.selected.kind !== "plant" ||
		a.identity.context.kind !== "seat" ||
		a.identity.context.role === "member"
	)
		deny();
	if (a.plant) return { ...a, plant: a.plant };
	const [row] = await tx.select().from(t.plant).where(eq(t.plant.id, plant.id));
	if (!row) deny();
	return { ...a, plant: row };
}
export type Command = { requestKey: string; expectedRevision: string; input: unknown };
export async function begin(
	tx: Tx,
	ctx: WriteContext,
	actorId: string,
	name: typeof t.effect.$inferInsert.kind,
	q: Command,
) {
	const identity = requestIdentity.parse({
		owner: ctx.selected,
		actorId,
		operation: name,
		requestKey: q.requestKey,
		digest: hash(q),
		origin: ctx.origin,
	});
	const claim = await claimOperation(tx, name, identity);
	if (claim.kind === "unavailable") deny();
	if (claim.kind === "conflict") deny("conflict");
	if (ctx.purpose === "model") {
		if (ctx.origin.kind !== "assistant") deny();
		const o = ctx.origin;
		const rows = await tx
			.select({ id: t.review.id })
			.from(t.review)
			.innerJoin(
				t.conversation,
				and(eq(t.conversation.id, t.review.conversation_id), eq(t.conversation.tenant_id, t.review.tenant_id)),
			)
			.innerJoin(t.effect, and(eq(t.effect.review_id, t.review.id), eq(t.effect.tenant_id, t.review.tenant_id)))
			.where(
				and(
					eq(t.review.id, o.reviewId),
					eq(t.review.tenant_id, ctx.selected.id),
					eq(t.review.conversation_id, o.conversationId),
					eq(t.review.digest, o.planDigest),
					eq(t.review.approved_by_id, actorId),
					isNull(t.review.cancelled_at),
					isNull(t.review.superseded_at),
					lte(t.review.approved_at, now),
					gt(t.review.approved_at, sql`clock_timestamp()-interval '15 minutes'`),
					eq(t.conversation.owner_id, actorId),
					eq(t.conversation.state, "open"),
					eq(t.effect.kind, name),
					eq(t.effect.payload_hash, hash({ name, input: q })),
					eq(t.effect.arguments, { operation: name, input: q }),
					sql`${t.effect.state} IN ('unstarted','claimed')`,
				),
			)
			.for("share", { of: [t.review, t.conversation, t.effect] });
		if (!rows.length) deny();
	}
	if (claim.kind === "replay") {
		const [old] = await tx
			.select({ value: t.settings_result.value })
			.from(t.settings_result)
			.innerJoin(t.operation, eq(t.operation.id, t.settings_result.operation_id))
			.where(and(eq(t.operation.tenant_id, ctx.selected.id), eq(t.operation.request_key, q.requestKey)));
		if (old) {
			const r = z.object({ receipt }).parse(old.value);
			if (canonical(r.receipt.request) !== canonical(identity)) deny("conflict");
			return { kind: "replay" as const, value: old.value };
		}
		deny();
	}
	return { kind: "new" as const, id: claim.id, identity, writes: claim.writes, events: claim.events };
}
export type NewCommand = Extract<Awaited<ReturnType<typeof begin>>, { kind: "new" }>;
export async function finish<T>(
	tx: Tx,
	c: NewCommand,
	schema: z.ZodType<T>,
	events: string[],
	body: (r: Receipt) => unknown,
	changed = true,
) {
	const r = receipt.parse({
		id: c.id,
		request: c.identity,
		completedAt: new Date().toISOString(),
		outcome: changed ? "changed" : "noop",
		subjects: [{ kind: "operation", id: c.id, owner: c.identity.owner }],
		eventIds: events,
		effectIds: [],
	});
	const value = schema.parse(body(r));
	await executeWrites(tx, [
		...c.writes,
		...(c.events.length ? [tx.insert(t.event).values(c.events)] : []),
		tx
			.update(t.operation)
			.set({ state: "complete", outcome: changed ? "committed" : "no_effect", completed_at: now })
			.where(eq(t.operation.id, c.id)),
		tx.insert(t.settings_result).values({ operation_id: c.id, tenant_id: c.identity.owner.id, value }),
	]);
	return value;
}
export const preference = (a: typeof t.account.$inferSelect) =>
	a.personal_timezone === null
		? { status: "unconfirmed" as const }
		: { status: "confirmed" as const, timeZone: a.personal_timezone, revision: a.personal_timezone_revision };
export async function calendarEligible(tx: Tx, id: string) {
	const [s] = await tx
		.select()
		.from(t.seat)
		.where(
			and(
				eq(t.seat.account_id, id),
				isNull(t.seat.ended_at),
				sql`${t.seat.role} IN ('owner','admin')`,
				sql`${t.seat.plant_id} IS NOT NULL`,
				sql`NOT EXISTS (SELECT FROM ${t.lifecycle_witness} w WHERE w.seat_id=${t.seat.id} AND w.state NOT IN ('active','cancelled'))`,
			),
		);
	return !!s && (await liveOwner(tx, { kind: "plant", id: tenantId.parse(s.plant_id) }));
}
