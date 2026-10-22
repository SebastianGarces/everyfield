import { accountId, requestIdentity, sameOwner, sessionId, tenantId, type Owner } from "@everyfield/contracts/common";
import { settingsError } from "@everyfield/contracts/settings";
import type { SettingsContext, SettingsReply, SettingsWriteContext } from "@everyfield/contracts/settings/server";
import type { Database, Transaction } from "@everyfield/db/client";
import { and, eq, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { boundWrite, currentActor, currentWriteAllowed, liveOwner, RequestActor } from "../access/session.ts";
import {
	auditSavepoint,
	auditTransaction,
	declareWrite,
	finishAudit,
	lockedWrite,
	nativeWrite,
	prepareWrite,
	WriteUnavailable,
} from "../operations/writes.ts";
import { appendEvent, canonical } from "../organizations/core.ts";
export { appendEvent, canonical, sameOwner };
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
	if (boundWrite(tx)) return { status: "ok", value: await body(tx) };
	return recover(async () => ({ status: "ok", value: await auditSavepoint(tx, body) }));
}
export async function recover<T>(body: () => Promise<SettingsReply<T>>): Promise<SettingsReply<T>> {
	try {
		return await body();
	} catch (e) {
		if (e instanceof WriteUnavailable) e = new Refusal("unavailable");
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
	const bound = await lockedWrite(tx);
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

	if (use !== "read") {
		const locked = await RequestActor.claimWrite(tx, ctx.session, ctx.selected);
		if (!locked) deny();
		if (use === "preview" && !(await currentWriteAllowed(tx, locked.actor.accountId, ctx.selected))) deny();
		return { ...locked, identity: locked.actor };
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
/** Every settings write name. The wrapper declares each write established (C88), so one declaration decides the path. */
export type SettingsWrite =
	| "account.finalizeAvatar"
	| "account.removeAvatar"
	| "account.requestDeletion"
	| "account.setPersonalTimezone"
	| "churches.requestWorkspaceDeletion"
	| "plant.setDigestSchedule"
	| "plant.setTimezone"
	| "plant.updateProfile"
	| "settings.saveChurch"
	| "settings.saveSection";
export async function begin(tx: Tx, ctx: WriteContext, actorId: string, name: SettingsWrite, q: Command) {
	const identity = requestIdentity.parse({
		owner: ctx.selected,
		actorId,
		operation: name,
		requestKey: q.requestKey,
		digest: hash(q),
	});
	const claim = await prepareWrite(tx, identity);
	if (claim.kind === "unavailable") deny();
	if (claim.kind === "conflict") deny("conflict");

	if (claim.kind === "replay") {
		return { kind: "replay" as const, value: claim.value };
	}
	return { kind: "new" as const, id: claim.id, identity, writes: claim.writes, events: claim.events };
}
export type NewCommand = Extract<Awaited<ReturnType<typeof begin>>, { kind: "new" }>;
export async function finish<T>(tx: Tx, c: NewCommand, schema: z.ZodType<T>, body: () => unknown) {
	const value = schema.parse(body());
	await finishAudit(tx, c, c.identity, value);
	return value;
}
/**
 * The audit projection of one settings change (docs/architecture/audit.md, coordinator ruling 2026-10-20): the
 * section and, in the bounded metadata.diff, the name of each changed field. Revisions stay on the row. No before or
 * after value is kept: personal settings permit field names only.
 */
export function auditChange(
	c: NewCommand,
	id: string,
	section: string,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
) {
	const entry = c.events.find((e) => e.id === id);
	if (!entry) throw Error("missing_audit_entry");
	const changed = Object.keys(after).filter((k) => canonical(before[k] ?? null) !== canonical(after[k] ?? null));
	entry.metadata = { section, diff: Object.fromEntries(changed.map((k) => [k, true])) };
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

/** The request owns rollback; native writes need no nested savepoint. */
export async function withSettingsWrite<T>(
	db: Database,
	authority: RequestActor | undefined,
	context: WriteContext,
	body: (tx: Tx) => Promise<SettingsReply<T>>,
): Promise<SettingsReply<T>> {
	const run = async (tx: Tx) => {
		// Every settings write reads the gate's account, church and setup rows (C88).
		await declareWrite(tx, "established");
		const result = await body(tx);
		if (result.status === "refused") throw new Refusal(result.error.code);
		return result;
	};
	return recover(() => (authority ? nativeWrite(db, authority, context.selected, run) : auditTransaction(db, run)));
}
