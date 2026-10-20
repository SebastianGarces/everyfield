import { claimOperation, executeWrites } from "../operations/writes.ts";
import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Transaction } from "@everyfield/db/client";
import * as t from "@everyfield/db/tables";
import { and, eq, isNull, sql, gt, lte } from "@everyfield/db/query";
import { currentActor, liveOwner, requestWrite, lockWriteAuthority } from "../access/session.ts";
import { receipt, requestIdentity, sessionId, accountId, type Receipt } from "@everyfield/contracts/common";
import { onboardingError } from "@everyfield/contracts/onboarding";
import type {
	OnboardingContext,
	OnboardingWriteContext,
	OnboardingReply,
} from "@everyfield/contracts/onboarding/server";

export type Tx = Transaction;
export type Context = OnboardingContext;
export type WriteContext = OnboardingWriteContext;
export class Refusal extends Error {
	readonly code: z.infer<typeof onboardingError>["code"];
	constructor(code: z.infer<typeof onboardingError>["code"] = "unavailable") {
		super(code);
		this.code = code;
	}
}
export function deny(code?: Refusal["code"]): never {
	throw new Refusal(code);
}
export const now = sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value));
export function stable(value: unknown): string {
	if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
	if (value !== null && typeof value === "object")
		return (
			"{" +
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
				.join(",") +
			"}"
		);
	return JSON.stringify(value);
}
export const hash = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex");
export async function reply<T>(tx: Tx, body: () => Promise<T>): Promise<OnboardingReply<T>> {
	return tx
		.transaction(async (savepoint) => {
			void savepoint;
			return { status: "ok" as const, value: await body() };
		})
		.catch((error) => {
			if (!(error instanceof Refusal)) throw error;
			return {
				status: "refused" as const,
				error: onboardingError.parse({
					code: error.code,
					details: {},
					correlationId: randomUUID(),
					retry: (
						{
							invalid_input: "never",
							access_denied: "never",
							unavailable: "never",
							invalid_subject: "never",
							conflict: "refresh",
							temporary: "same_request",
							unknown: "reconcile",
							active_seat_conflict: "refresh",
							association_resolution_required: "refresh",
							already_declared: "refresh",
							idempotency_conflict: "never",
						} as const
					)[error.code],
				}),
			};
		});
}
// Account is the shared arbiter with first-seat acceptance. Take its row lock
// before currentActor acquires lifecycle/seat share locks.
export async function actor(tx: Tx, ctx: Context, allowPending = false, write = false) {
	const bound = requestWrite(tx);
	if (
		bound &&
		bound.authority.session === ctx.session &&
		bound.selected.id === ctx.selected.id &&
		bound.selected.kind === ctx.selected.kind
	)
		return {
			identity: bound.actor,
			account: bound.account,
			principal: bound.principal,
			plant: bound.plant,
			organization: bound.organization,
			setup: bound.setup,
		};

	if (write) {
		const locked = await lockWriteAuthority(tx, ctx.session, ctx.selected, true);
		if (!locked || (locked.identity.status === "pending_domain" && !allowPending)) deny();
		return locked;
	}
	const raw = await tx.execute(sql`SELECT * FROM invitation_identity(${sessionId.parse(ctx.session)})`);
	const row = z
		.object({ account_id: accountId, display_name: z.string(), verified: z.boolean() })
		.safeParse(raw.rows[0]);
	if (!row.success) deny();
	const [account] = await tx.select().from(t.account).where(eq(t.account.id, row.data.account_id)).for("update");
	if (!account) deny();
	const a = await currentActor(tx, ctx.session, ctx.selected);
	if (a.status === "unavailable" || (a.status === "pending_domain" && !allowPending)) deny();
	if (ctx.selected.kind === "account" && ctx.selected.id !== a.accountId) deny();
	if (a.status === "pending_domain" && (ctx.selected.kind !== "account" || !(await liveOwner(tx, ctx.selected))))
		deny();
	return { account, identity: a, principal: row.data, plant: null, organization: null, setup: null };
}
export async function seatless(tx: Tx, id: string) {
	const seats = await tx
		.select({ id: t.seat.id })
		.from(t.seat)
		.where(and(eq(t.seat.account_id, id), isNull(t.seat.ended_at)))
		.for("update");
	if (seats.length) deny("active_seat_conflict");
}
export async function plantOwner(tx: Tx, ctx: Context, write = true) {
	const a = await actor(tx, ctx, false, write);
	if (
		a.identity.status !== "active" ||
		a.identity.context.kind !== "seat" ||
		a.identity.context.role !== "owner" ||
		ctx.selected.kind !== "plant"
	)
		deny();
	if (write) {
		if (!a.plant || !a.setup || a.setup.account_id !== a.account.id) deny();
		return { ...a, plant: a.plant, setup: a.setup };
	}
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.selected.id},11011))`);
	const [plant] = await tx.select().from(t.plant).where(eq(t.plant.id, ctx.selected.id)).for("update");
	const [setup] = await tx
		.select()
		.from(t.onboarding_setup)
		.where(eq(t.onboarding_setup.plant_id, ctx.selected.id))
		.for("update");
	if (!plant || !setup || setup.account_id !== a.account.id) deny();
	return { ...a, plant, setup };
}
export function revision(expected: string, actual: string) {
	if (expected !== actual) deny("conflict");
}
export type Command = { requestKey: string; expectedRevision: string; input: unknown };
export async function begin(
	tx: Tx,
	ctx: WriteContext,
	actorId: string,
	name:
		| "onboarding.createPlant"
		| "discovery.create"
		| "discovery.convertToPlant"
		| "identity.answerLeadOnboarding"
		| "onboarding.declareJourney"
		| "onboarding.complete",
	input: Command,
) {
	const identity = requestIdentity.parse({
		owner: ctx.selected,
		actorId,
		operation: name,
		requestKey: input.requestKey,
		digest: hash(input),
		origin: ctx.origin,
	});

	const claim = await claimOperation(tx, name, identity);
	if (claim.kind === "unavailable") deny();
	if (claim.kind === "conflict") deny("idempotency_conflict");
	if (claim.kind === "replay") {
		const [old] = await tx
			.select({ value: t.onboarding_result.value })
			.from(t.onboarding_result)
			.innerJoin(t.operation, eq(t.operation.id, t.onboarding_result.operation_id))
			.where(and(eq(t.operation.tenant_id, ctx.selected.id), eq(t.operation.request_key, input.requestKey)));
		if (old) {
			const saved = z.object({ receipt }).parse(old.value);
			if (stable(saved.receipt.request) !== stable(identity)) deny("idempotency_conflict");
			return { kind: "replay" as const, value: old.value };
		}
		deny();
	}
	if (ctx.purpose === "model") {
		if (ctx.origin.kind !== "assistant") deny();
		const o = ctx.origin;
		const review = await tx
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
					eq(t.effect.payload_hash, hash({ name, input })),
					eq(t.effect.arguments, { operation: name, input }),
					sql`${t.effect.state} IN ('unstarted','claimed')`,
				),
			)
			.for("share", { of: [t.review, t.conversation, t.effect] });
		if (!review.length) deny();
	}
	return { kind: "new" as const, id: claim.id, identity, writes: claim.writes, events: claim.events };
}
export type NewCommand = Extract<Awaited<ReturnType<typeof begin>>, { kind: "new" }>;
export async function event(
	_tx: Tx,
	c: NewCommand,
	target: string,
	action: typeof t.event.$inferInsert.action,
	kind: typeof t.event.$inferInsert.kind = "edit",
	tenant = c.identity.owner.id,
) {
	const id = randomUUID();
	const ownedTarget = sql<string>`coalesce((SELECT id FROM ${t.record} WHERE id=${target}::uuid AND tenant_id=${tenant}::uuid),${tenant}::uuid)`;
	c.events.push({
		id,
		tenant_id: tenant,
		target_record_id: ownedTarget,
		operation_id: c.id,
		actor_id: c.identity.actorId,
		kind,
		action,
		occurred_at: now,
		recorded_at: now,
		event_key: c.id + "/" + target + "/" + action,
	});
	return id;
}
export async function finish<T>(
	tx: Tx,
	c: NewCommand,
	events: string[],
	schema: z.ZodType<T>,
	result: (r: Receipt) => unknown,
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
	const value = schema.parse(result(r));
	await executeWrites(tx, [
		...c.writes,
		...(c.events.length ? [tx.insert(t.event).values(c.events)] : []),
		tx
			.update(t.operation)
			.set({ state: "complete", outcome: changed ? "committed" : "no_effect", completed_at: now })
			.where(eq(t.operation.id, c.id)),
		tx.insert(t.onboarding_result).values({ operation_id: c.id, tenant_id: c.identity.owner.id, value }),
	]);
	return value;
}
export async function bump(tx: Tx, id: string) {
	const [plant] = await tx
		.update(t.plant)
		.set({ revision: sql`${t.plant.revision}+1`, material_revision: sql`${t.plant.material_revision}+1` })
		.where(eq(t.plant.id, id))
		.returning();
	return plant!;
}

export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const result = schema.safeParse(raw);
	if (!result.success) deny("invalid_input");
	return result.data;
}
