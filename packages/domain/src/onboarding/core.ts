import { writeAction } from "../operations/actions.ts";
import { accountId, requestIdentity, sessionId } from "@everyfield/contracts/common";
import { onboardingError } from "@everyfield/contracts/onboarding";
import type {
	OnboardingContext,
	OnboardingReply,
	OnboardingWriteContext,
} from "@everyfield/contracts/onboarding/server";
import type { Database, Transaction } from "@everyfield/db/client";
import { and, eq, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { RequestActor, currentActor, liveOwner, lockWriteAuthority, requestWrite } from "../access/session.ts";
import { WriteUnavailable, auditSavepoint, auditTransaction, finishAudit, prepareWrite } from "../operations/writes.ts";

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
	if (requestWrite(tx)) return { status: "ok", value: await body() };
	return recover(async () => ({ status: "ok", value: await auditSavepoint(tx, async () => body()) }));
}
async function recover<T>(body: () => Promise<OnboardingReply<T>>): Promise<OnboardingReply<T>> {
	return body().catch((error) => {
		if (error instanceof WriteUnavailable) error = new Refusal("unavailable");
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
		const locked = await lockWriteAuthority(tx, ctx.session, ctx.selected);
		if (!locked || (locked.identity.status === "pending_domain" && !allowPending)) deny();
		return locked;
	}
	const raw = await tx.execute(sql`SELECT * FROM invitation_identity(${sessionId.parse(ctx.session)})`);
	const row = z
		.object({ account_id: accountId, email: z.string(), display_name: z.string(), verified: z.boolean() })
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
	});

	const claim = await prepareWrite(tx, identity);
	if (claim.kind === "unavailable") deny();
	if (claim.kind === "conflict") deny("idempotency_conflict");
	if (claim.kind === "replay") {
		return { kind: "replay" as const, value: claim.value };
	}

	return { kind: "new" as const, id: claim.id, identity, writes: claim.writes, events: claim.events };
}
export type NewCommand = Extract<Awaited<ReturnType<typeof begin>>, { kind: "new" }>;
export async function event(
	_tx: Tx,
	c: NewCommand,
	target: string,
	action: typeof t.audit_event.$inferInsert.action | null,
	kind: typeof t.audit_event.$inferInsert.kind = "edit",
	tenant = c.identity.owner.id,
) {
	const id = c.events.length ? randomUUID() : c.id;
	const ownedTarget = sql<string>`coalesce((SELECT id FROM ${t.record} WHERE id=${target}::uuid AND tenant_id=${tenant}::uuid),${tenant}::uuid)`;
	c.events.push({
		id,
		tenant_id: tenant,
		subject_id: ownedTarget,
		command_id: c.id,
		actor_id: c.identity.actorId,
		kind,
		action: action ?? writeAction(c.identity.operation),
		occurred_at: now,
		recorded_at: now,
		event_key: c.id + "/" + target + "/" + action,
	});
	return id;
}
export async function finish<T>(tx: Tx, c: NewCommand, schema: z.ZodType<T>, result: () => unknown) {
	const value = schema.parse(result());
	await finishAudit(tx, c, c.identity, value);
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

/** The request owns rollback; native writes need no nested savepoint. */
export async function withOnboardingWrite<T>(
	db: Database,
	authority: RequestActor | undefined,
	context: WriteContext,
	body: (tx: Tx) => Promise<OnboardingReply<T>>,
): Promise<OnboardingReply<T>> {
	return recover(() =>
		auditTransaction(db, async (tx) => {
			if (authority && !(await authority.bind(tx, context.selected))) deny();
			const result = await body(tx);
			if (result.status === "refused") throw new Refusal(result.error.code);
			return result;
		}),
	);
}
