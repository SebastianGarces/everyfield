import { accountId, owner, sessionId } from "@everyfield/contracts/common";
import * as q from "@everyfield/contracts/settings";
import * as n from "@everyfield/contracts/settings/native";
import type {
	DeletionProducer,
	NativeSettingsContext,
	SettingsWriteContext,
} from "@everyfield/contracts/settings/server";
import type { Database } from "@everyfield/db/client";
import { and, eq, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { randomBytes, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { lock as lockSeats } from "../identity/invitation-core.ts";
import {
	appendEvent,
	begin,
	deny,
	finish,
	hash,
	now,
	parse,
	plantAdmin,
	reply,
	revision,
	self,
	type Tx,
} from "./core.ts";
const requestRecord = z.object({ deletion: n.deletionStatus });
export type DeletionSubject = z.infer<typeof n.deletionSubject>;
export type DeletionRequest = { subject: DeletionSubject; requestId: string; revision: string };
export interface DeletionEffects {
	enqueue(tx: Tx, input: DeletionRequest & { witnessId: string; eligibleAt: string }): Promise<void>;
}
export function status(w: typeof t.lifecycle_witness.$inferSelect): n.DeletionStatus {
	if (w.kind !== "account" && w.kind !== "plant") deny();
	if (w.state === "active") return { status: "active" };
	return n.deletionStatus.parse({
		status: w.state,
		subject: { kind: w.kind, id: w.opaque_subject_id },
		requestId: w.request_id,
		revision: w.request_revision,
		requestedAt: w.requested_at?.toISOString(),
		cancelUntil: w.cancel_until?.toISOString(),
		...(w.state === "cancelled" ? { cancelledAt: w.cancelled_at?.toISOString() } : {}),
		...(w.state === "purged"
			? { livePurgedAt: w.live_purged_at?.toISOString(), copyExpiresAt: w.copy_expires_at?.toISOString() }
			: {}),
	});
}
async function root(tx: Tx, subject: DeletionSubject) {
	if (subject.kind === "account") {
		const [a] = await tx.select().from(t.account).where(eq(t.account.id, subject.id)).for("update");
		if (!a) deny();
	} else {
		const [p] = await tx.select().from(t.plant).where(eq(t.plant.id, subject.id)).for("update");
		if (!p) deny();
	}
}
async function witness(tx: Tx, subject: DeletionSubject) {
	const [w] = await tx
		.select()
		.from(t.lifecycle_witness)
		.where(and(eq(t.lifecycle_witness.kind, subject.kind), eq(t.lifecycle_witness.opaque_subject_id, subject.id)))
		.for("update");
	return w;
}
async function restricted(tx: Tx, ctx: n.RestrictedDeletionContext, subject: DeletionSubject, requestId: string) {
	if (ctx.kind !== "restricted_deletion") deny();
	if (subject.kind === "plant") await lockSeats(tx, "workspace-seats/" + subject.id);
	const [proof] = await tx
		.select()
		.from(t.identity_proof)
		.where(and(eq(t.identity_proof.token_hash, hash(ctx.handle)), eq(t.identity_proof.purpose, "deletion_cancel")))
		.for("share");
	if (!proof) deny("proof_invalid");
	// Match the shared order before holding the request witness.
	await tx.select({ id: t.account.id }).from(t.account).where(eq(t.account.id, proof.account_id)).for("update");
	await root(tx, subject);
	const w = await witness(tx, subject);
	const [clock] = await tx.select({ at: now }).from(t.account).where(eq(t.account.id, proof.account_id));
	if (
		!w ||
		w.request_id !== requestId ||
		proof.deletion_subject_id !== w.id ||
		String(proof.request_revision) !== w.request_revision ||
		proof.expires_at <= clock!.at ||
		proof.superseded_at ||
		proof.consumed_at
	)
		deny("proof_invalid");
	if (subject.kind === "account") {
		if (proof.account_id !== subject.id) deny();
	} else {
		if (w.requester_opaque_id !== proof.account_id) deny();
		const [s] = await tx
			.select()
			.from(t.seat)
			.where(
				and(
					eq(t.seat.account_id, proof.account_id),
					eq(t.seat.plant_id, subject.id),
					eq(t.seat.role, "owner"),
					isNull(t.seat.ended_at),
				),
			)
			.for("share");
		if (!s) deny();
		const revoked = await tx
			.select({ id: t.lifecycle_witness.id })
			.from(t.lifecycle_witness)
			.where(and(eq(t.lifecycle_witness.seat_id, s.id), eq(t.lifecycle_witness.state, "revoked")));
		if (revoked.length) deny();
	}
	return { w, clock: clock!.at };
}
export function deletionOperations(effects: DeletionEffects): DeletionProducer<Tx> {
	async function request(
		tx: Tx,
		ctx: SettingsWriteContext | NativeSettingsContext,
		raw: unknown,
		kind: "account" | "plant",
	) {
		const v = kind === "account" ? parse(q.requestAccountDeletion, raw) : parse(q.requestWorkspaceDeletion, raw);

		const subject =
			kind === "account"
				? owner.parse({ kind: "account", id: (await self(tx, ctx)).account.id })
				: parse(q.requestWorkspaceDeletion, raw).input.plant;
		if (subject.kind !== "account" && subject.kind !== "plant") deny();
		const a = subject.kind === "account" ? await self(tx, ctx) : await plantAdmin(tx, ctx, subject, "command");
		if (subject.kind === "plant" && (a.identity.context.kind !== "seat" || a.identity.context.role !== "owner")) deny();
		if (subject.kind === "account") {
			const owners = await tx
				.select()
				.from(t.seat)
				.where(and(eq(t.seat.account_id, a.account.id), eq(t.seat.role, "owner"), isNull(t.seat.ended_at)))
				.for("share");
			if (owners.some((s) => s.organization_id !== null)) deny("manual_owner_exception_required");
			if (owners.length) {
				const hidden = await tx
					.select({ id: t.lifecycle_witness.opaque_subject_id })
					.from(t.lifecycle_witness)
					.where(
						sql`${t.lifecycle_witness.opaque_subject_id}=ANY(${sql.param(owners.map((s) => s.plant_id))}::uuid[]) AND ${t.lifecycle_witness.kind}='plant' AND ${t.lifecycle_witness.state} IN ('pending_deletion','purging','purged')`,
					);
				if (owners.some((s) => !hidden.some((w) => w.id === s.plant_id))) deny("manual_owner_exception_required");
			}
		}
		const wctx: SettingsWriteContext = ctx;
		const c = await begin(
			tx,
			wctx,
			a.account.id,
			subject.kind === "account" ? "account.requestDeletion" : "churches.requestWorkspaceDeletion",
			v,
		);
		if (c.kind === "replay") return requestRecord.parse(c.value).deletion;
		revision(
			v.expectedRevision,
			subject.kind === "account" ? a.account.revision : (await plantAdmin(tx, ctx, subject, "command")).plant.revision,
		);
		await root(tx, subject);
		const old = await witness(tx, subject);
		if (old && old.state !== "active" && old.state !== "cancelled") deny("conflict");
		const [clock] = await tx.select({ at: now }).from(t.account).where(eq(t.account.id, a.account.id));
		const requestedAt = clock!.at,
			cancelUntil = new Date(requestedAt.getTime() + 30 * 86400_000),
			requestId = randomUUID(),
			next = old ? String(BigInt(old.request_revision) + 1n) : "1";
		const values = {
			kind: subject.kind,
			opaque_subject_id: subject.id,
			account_id: subject.kind === "account" ? subject.id : null,
			plant_id: subject.kind === "plant" ? subject.id : null,
			request_id: requestId,
			requester_id: a.account.id,
			requester_opaque_id: a.account.id,
			request_revision: next,
			state: "pending_deletion" as const,
			requested_at: requestedAt,
			cancel_until: cancelUntil,
			cancelled_at: null,
			cleanup_state: "not_started" as const,
			witness_checkpoint: old ? String(BigInt(old.witness_checkpoint) + 1n) : "1",
		};
		const [w] = old
			? await tx.update(t.lifecycle_witness).set(values).where(eq(t.lifecycle_witness.id, old.id)).returning()
			: await tx.insert(t.lifecycle_witness).values(values).returning();
		await tx.execute(sql`SELECT settings_suspend_subject(${w!.id}::uuid,${requestId}::uuid)`);
		await effects.enqueue(tx, {
			subject,
			requestId,
			revision: next,
			witnessId: w!.id,
			eligibleAt: cancelUntil.toISOString(),
		});
		await appendEvent(
			tx,
			c,
			subject.id,
			"hide",
			subject.kind === "account" ? "account.deletion_requested" : "plant.deletion_requested",
			v.expectedRevision,
			v.expectedRevision,
		);
		const result = await finish(tx, c, requestRecord, () => ({ deletion: status(w!) }));
		return result.deletion;
	}
	async function cancel(tx: Tx, ctx: n.RestrictedDeletionContext, raw: unknown, kind: "account" | "plant") {
		const v =
			kind === "account" ? parse(n.cancelAccountDeletionRequest, raw) : parse(n.cancelWorkspaceDeletionRequest, raw);
		const { w, clock } = await restricted(tx, ctx, v.input.subject, v.input.requestId);
		revision(v.expectedRevision, w.request_revision);
		if (w.state === "cancelled") return status(w);
		if (clock >= w.cancel_until! || w.state !== "pending_deletion") deny("deadline_passed");
		const [next] = await tx
			.update(t.lifecycle_witness)
			.set({
				state: "cancelled",
				cancelled_at: clock,
				witness_checkpoint: sql`${t.lifecycle_witness.witness_checkpoint}+1`,
			})
			.where(eq(t.lifecycle_witness.id, w.id))
			.returning();
		// No grant/session/mail restoration. Independent revocations remain authoritative.
		await tx
			.insert(t.audit_event)
			.values({
				tenant_id: v.input.subject.id,
				subject_id: w.id,
				actor_id: w.requester_id,
				system_cause: w.requester_id ? null : "deletion_cancellation",
				kind: "restore",
				action: "deletion.cancelled",
				occurred_at: clock,
				recorded_at: clock,
				event_key: w.request_id + "/cancelled",
			})
			.onConflictDoNothing({ target: [t.audit_event.subject_id, t.audit_event.event_key] });
		return status(next!);
	}
	return {
		requestAccountDeletion: (tx, ctx, v) => reply(tx, (s) => request(s, ctx, v, "account")),
		requestWorkspaceDeletion: (tx, ctx, v) => reply(tx, (s) => request(s, ctx, v, "plant")),
		getAccountDeletionStatus: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const v = parse(n.getAccountDeletionStatusRequest, raw);
				return status((await restricted(s, ctx, v.subject, v.requestId)).w);
			}),
		getWorkspaceDeletionStatus: (tx, ctx, raw) =>
			reply(tx, async (s) => {
				const v = parse(n.getWorkspaceDeletionStatusRequest, raw);
				return status((await restricted(s, ctx, v.subject, v.requestId)).w);
			}),
		cancelAccountDeletion: (tx, ctx, v) => reply(tx, (s) => cancel(s, ctx, v, "account")),
		cancelWorkspaceDeletion: (tx, ctx, v) => reply(tx, (s) => cancel(s, ctx, v, "plant")),
	};
}
// Trusted native identity adapter supplies the original account after fresh proof.
// Do not expose this mint as a domain/Evry operation or accept an account from a body.
export async function issueRestrictedDeletionSession(
	tx: Tx,
	input: { subject: DeletionSubject; requestId: string },
	prove: () => Promise<{ accountId: string; provenAt: Date }>,
) {
	const proof = await prove();
	if (input.subject.kind === "plant") await lockSeats(tx, "workspace-seats/" + input.subject.id);
	const id = accountId.parse(proof.accountId);
	await tx.select({ id: t.account.id }).from(t.account).where(eq(t.account.id, id)).for("update");
	await root(tx, input.subject);
	const w = await witness(tx, input.subject);
	const [clock] = await tx.select({ at: now }).from(t.account).where(eq(t.account.id, id));
	if (
		!w ||
		w.request_id !== input.requestId ||
		!clock ||
		proof.provenAt > clock.at ||
		clock.at.getTime() - proof.provenAt.getTime() > 5 * 60_000 ||
		(input.subject.kind === "account" ? id !== input.subject.id : w.requester_opaque_id !== id)
	)
		deny("proof_invalid");
	const handle = randomBytes(32).toString("base64url");
	await tx
		.update(t.identity_proof)
		.set({ superseded_at: clock.at })
		.where(
			and(
				eq(t.identity_proof.account_id, id),
				eq(t.identity_proof.purpose, "deletion_cancel"),
				isNull(t.identity_proof.superseded_at),
				isNull(t.identity_proof.consumed_at),
			),
		);
	await tx.insert(t.identity_proof).values({
		account_id: id,
		purpose: "deletion_cancel",
		token_hash: hash(handle),
		deletion_subject_id: w.id,
		request_revision: Number(w.request_revision),
		expires_at: new Date(clock.at.getTime() + 10 * 60_000),
	});
	return { kind: "restricted_deletion" as const, handle: sessionId.parse(handle) };
}
export function createLifecycleCleanup(
	db: Database,
	config: {
		authorize(tx: Tx, input: DeletionRequest): Promise<boolean>;
		// Confirm provider removal and derivative/cache cleanup; timeout/unknown is false.
		removeOwnedResources(input: DeletionRequest): Promise<boolean>;
	},
) {
	return async (input: DeletionRequest) => {
		const claimed = await db.transaction(async (tx) => {
			if (!(await config.authorize(tx, input))) deny();
			await root(tx, input.subject);
			const w = await witness(tx, input.subject);
			if (!w || w.request_id !== input.requestId || w.request_revision !== input.revision) deny("conflict");
			if (w.state === "purged") return { complete: true as const, value: status(w) };
			const clock = new Date(
				z.coerce.date().parse((await tx.execute(sql`SELECT clock_timestamp() AS at`)).rows[0]?.at),
			);
			if (clock < w.cancel_until! || !["pending_deletion", "purging"].includes(w.state)) deny("deadline_passed");
			await tx
				.update(t.lifecycle_witness)
				.set({
					state: "purging",
					cleanup_state: "in_progress",
					witness_checkpoint: sql`${t.lifecycle_witness.witness_checkpoint}+1`,
				})
				.where(eq(t.lifecycle_witness.id, w.id));
			return { complete: false as const };
		});
		if (claimed.complete) return claimed.value;
		await db.transaction(async (tx) => {
			if (!(await config.authorize(tx, input))) deny();
			await root(tx, input.subject);
			const w = await witness(tx, input.subject);
			if (!w || w.request_id !== input.requestId || w.request_revision !== input.revision || w.state !== "purging")
				deny("conflict");
			await tx.execute(
				sql`SELECT settings_purge_content(${w.id}::uuid,${input.requestId}::uuid,${input.revision}::bigint)`,
			);
		});
		if (!(await config.removeOwnedResources(input))) return { status: "purging" as const };
		return db.transaction(async (tx) => {
			if (!(await config.authorize(tx, input))) deny();
			await root(tx, input.subject);
			const w = await witness(tx, input.subject);
			if (!w || w.request_id !== input.requestId || w.request_revision !== input.revision || w.state !== "purging")
				deny("conflict");
			await tx.execute(
				sql`SELECT settings_purge_subject(${w.id}::uuid,${input.requestId}::uuid,${input.revision}::bigint)`,
			);
			const [done] = await tx.select().from(t.lifecycle_witness).where(eq(t.lifecycle_witness.id, w.id));
			return status(done!);
		});
	};
}
