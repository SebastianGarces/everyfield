import { accountId, sessionId } from "@everyfield/contracts/common";
import { allows, deletionMachine, fromStates, holds } from "@everyfield/contracts/machines";
import * as q from "@everyfield/contracts/settings";
import * as n from "@everyfield/contracts/settings/native";
import type { DeletionProducer, SettingsContext } from "@everyfield/contracts/settings/server";
import type { Database } from "@everyfield/db/client";
import { alias, and, eq, getTableColumns, inArray, isNull, sql, type SQL, type SQLWrapper } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { randomBytes, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { lock as lockSeats } from "../identity/invitation-core.ts";
import { executeWrites, gatedTransaction } from "../operations/writes.ts";
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
const mintRow = z.object({
	account: z.uuid().nullable(),
	witness: z
		.object({
			id: z.uuid(),
			request_id: z.uuid().nullable(),
			request_revision: z.coerce.string(),
			requester_opaque_id: z.uuid().nullable(),
		})
		.nullable(),
	at: z.coerce.date(),
});
const currentWitness = z.object({
	rooted: z.boolean(),
	blocked: z.boolean(),
	witness: z
		.object({
			id: z.uuid(),
			state: z.enum(deletionMachine.states),
			request_revision: z.coerce.string(),
			witness_checkpoint: z.coerce.string(),
		})
		.nullable(),
});
export type DeletionSubject = z.infer<typeof n.deletionSubject>;
export type DeletionRequest = { subject: DeletionSubject; requestId: string; revision: string };
export type WorkspaceDeletionNotice = {
	kind: "requested" | "cancelled";
	plant: { name: string; timeZone: string };
	requestId: string;
	requester: { accountId: string; name: string };
	cancelUntil: string;
	recipients: { accountId: string; address: string; timeZone: string | null }[];
};
export interface DeletionEffects {
	queue(tx: Tx, input: DeletionRequest & { witnessId: string; eligibleAt: string }): SQLWrapper;
	workspaceNotice(tx: Tx, input: WorkspaceDeletionNotice, writes: SQLWrapper[]): Promise<void>;
}
const audience = z.object({
	account_id: z.uuid(),
	email: z.string(),
	personal_timezone: z.string().nullable(),
	plant_name: z.string(),
	plant_timezone: z.string(),
	requester_name: z.string().nullable(),
});
async function seated(
	tx: Tx,
	kind: WorkspaceDeletionNotice["kind"],
	w: { plant_id: string | null; request_id: string | null; requester_id: string | null; cancel_until: Date | null },
): Promise<WorkspaceDeletionNotice> {
	const read = await tx.execute(
		sql`SELECT DISTINCT ON (s.account_id) s.account_id, c.email, a.personal_timezone, p.name AS plant_name, p.timezone AS plant_timezone,
 (SELECT i.display_name FROM seat_identity(${w.requester_id}::uuid) i) AS requester_name
 FROM seat s JOIN account a ON a.id=s.account_id JOIN plant p ON p.id=s.plant_id CROSS JOIN LATERAL access_account_contact(s.account_id) c
 WHERE s.plant_id=${w.plant_id}::uuid AND s.ended_at IS NULL ORDER BY s.account_id`,
	);
	const rows = read.rows.map((r) => audience.parse(r));
	const first = rows[0];
	if (!first || !w.request_id || !w.requester_id || !w.cancel_until) deny("unavailable");
	return {
		kind,
		plant: { name: first.plant_name, timeZone: first.plant_timezone },
		requestId: w.request_id,
		requester: { accountId: w.requester_id, name: first.requester_name ?? "The Owner" },
		cancelUntil: w.cancel_until.toISOString(),
		recipients: rows.map((r) => ({ accountId: r.account_id, address: r.email, timeZone: r.personal_timezone })),
	};
}
function status(w: typeof t.lifecycle_witness.$inferSelect): n.DeletionStatus {
	if (w.kind !== "account" && w.kind !== "plant") deny("unavailable");
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
		if (!a) deny("unavailable");
	} else {
		const [p] = await tx.select().from(t.plant).where(eq(t.plant.id, subject.id)).for("update");
		if (!p) deny("unavailable");
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
async function proven(tx: Tx, handle: string, subject: DeletionSubject) {
	const proof = tx.$with("restricted_proof").as(
		tx
			.select(getTableColumns(t.identity_proof))
			.from(t.identity_proof)
			.where(and(eq(t.identity_proof.token_hash, hash(handle)), eq(t.identity_proof.purpose, "deletion_cancel")))
			.for("share"),
	);
	const account = tx
		.$with("restricted_account")
		.as(
			tx
				.select({ id: t.account.id })
				.from(t.account)
				.innerJoin(proof, eq(t.account.id, proof.account_id))
				.for("update", { of: t.account }),
		);
	const root = tx.$with("restricted_root").as(
		tx
			.select({ id: t.plant.id })
			.from(t.plant)
			.where(and(sql`${subject.kind}='plant'`, eq(t.plant.id, subject.id), sql`EXISTS(SELECT FROM ${account})`))
			.for("update"),
	);
	const witness = tx.$with("restricted_witness").as(
		tx
			.select(getTableColumns(t.lifecycle_witness))
			.from(t.lifecycle_witness)
			.where(
				and(
					eq(t.lifecycle_witness.kind, subject.kind),
					eq(t.lifecycle_witness.opaque_subject_id, subject.id),
					sql`EXISTS(SELECT FROM ${account}) AND (${subject.kind}<>'plant' OR EXISTS(SELECT FROM ${root}))`,
				),
			)
			.for("update"),
	);
	const p = alias(t.identity_proof, "restricted_proof"),
		w = alias(t.lifecycle_witness, "restricted_witness");
	const seat = tx.$with("restricted_seat").as(
		tx
			.select({
				id: t.seat.id,
				revoked: sql<boolean>`EXISTS(SELECT FROM lifecycle_witness r WHERE r.seat_id=seat.id AND r.state='revoked')`.as(
					"revoked",
				),
			})
			.from(t.seat)
			.where(
				and(
					sql`${subject.kind}='plant'`,
					eq(t.seat.plant_id, subject.id),
					eq(t.seat.role, "owner"),
					isNull(t.seat.ended_at),
					sql`${t.seat.account_id}=(SELECT ${p.account_id} FROM ${proof} JOIN ${witness} ON ${w.requester_opaque_id}=${p.account_id})`,
				),
			)
			.for("share"),
	);
	const [row] = await tx
		.with(proof, account, root, witness, seat)
		.select({ proof: p, witness: w, seat: { id: seat.id, revoked: seat.revoked }, at: now })
		.from(proof)
		.leftJoin(witness, sql`true`)
		.leftJoin(seat, sql`true`);
	return row;
}
async function restricted(tx: Tx, ctx: n.RestrictedDeletionContext, subject: DeletionSubject, requestId: string) {
	if (ctx.kind !== "restricted_deletion") deny("unavailable");
	if (subject.kind === "plant") await lockSeats(tx, "workspace-seats/" + subject.id);
	const row = await proven(tx, ctx.handle, subject);
	if (!row) deny("proof_invalid");
	const { proof, witness: w, seat, at: clock } = row;
	if (
		!w ||
		w.request_id !== requestId ||
		proof.deletion_subject_id !== w.id ||
		String(proof.request_revision) !== w.request_revision ||
		proof.expires_at <= clock ||
		proof.superseded_at ||
		proof.consumed_at
	)
		deny("proof_invalid");
	if (subject.kind === "account") {
		if (proof.account_id !== subject.id) deny("unavailable");
	} else {
		if (w.requester_opaque_id !== proof.account_id || !seat || seat.revoked) deny("unavailable");
	}
	return { w, clock };
}
export function deletionOperations(effects: DeletionEffects): DeletionProducer<Tx> {
	async function request(tx: Tx, ctx: SettingsContext, raw: unknown, kind: "account" | "plant") {
		const plantRequest = kind === "plant" ? parse(q.requestWorkspaceDeletion, raw) : null;
		const v = plantRequest ?? parse(q.requestAccountDeletion, raw);
		const workspace = plantRequest?.input.plant ?? null;
		const a = workspace ? await plantAdmin(tx, ctx, workspace, "command") : await self(tx, ctx);
		const subject: DeletionSubject = workspace ?? { kind: "account", id: accountId.parse(a.account.id) };
		if (subject.kind === "plant" && (a.identity.context.kind !== "seat" || a.identity.context.role !== "owner"))
			deny("unavailable");
		const event = subject.kind === "account" ? "account.requestDeletion" : "churches.requestWorkspaceDeletion";
		const c = await begin(tx, ctx, a.account.id, event, v);
		if (c.kind === "replay") return requestRecord.parse(c.value).deletion;
		const blocked =
			subject.kind === "account"
				? sql`EXISTS(SELECT FROM seat s WHERE s.account_id=${a.account.id}::uuid AND s.role='owner' AND s.ended_at IS NULL AND (s.organization_id IS NOT NULL OR NOT EXISTS(SELECT FROM lifecycle_witness h WHERE h.kind='plant' AND h.opaque_subject_id=s.plant_id AND h.state IN ('pending_deletion','purging','purged'))))`
				: sql`false`;
		const plant =
			subject.kind === "plant" ? sql`WITH r AS (SELECT id FROM plant WHERE id=${subject.id}::uuid FOR UPDATE) ` : sql``;
		const rooted = subject.kind === "plant" ? sql`EXISTS(SELECT FROM r)` : sql`true`;
		const read = await tx.execute(
			sql`${plant}SELECT ${rooted} AS rooted, ${blocked} AS blocked, (SELECT to_jsonb(w) FROM (SELECT id,state,request_revision,witness_checkpoint FROM lifecycle_witness WHERE kind=${subject.kind} AND opaque_subject_id=${subject.id}::uuid AND ${rooted} FOR UPDATE) w) AS witness`,
		);
		const found = currentWitness.parse(read.rows[0]);
		if (!found.rooted) deny("unavailable");
		if (found.blocked) deny("manual_owner_exception_required");
		revision(v.expectedRevision, subject.kind === "account" ? a.account.revision : a.plant!.revision);
		const old = found.witness;
		if (old && !allows(deletionMachine, event, old.state, "pending_deletion", { kind: subject.kind })) deny("conflict");
		const requestedAt = new Date(),
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
			requested_at: requestedAt,
			cancel_until: cancelUntil,
			cancelled_at: null,
			cleanup_state: "not_started" as const,
			witness_checkpoint: old ? String(BigInt(old.witness_checkpoint) + 1n) : "1",
		};
		const [w] = old
			? await tx
					.update(t.lifecycle_witness)
					.set({ ...values, state: "pending_deletion" })
					.where(
						and(
							eq(t.lifecycle_witness.id, old.id),
							inArray(
								t.lifecycle_witness.state,
								fromStates(deletionMachine, event, "pending_deletion", { kind: subject.kind }),
							),
						),
					)
					.returning()
			: await tx
					.insert(t.lifecycle_witness)
					.values({ ...values, state: "pending_deletion" })
					.returning();
		await tx.execute(sql`SELECT settings_suspend_subject(${w!.id}::uuid,${requestId}::uuid)`);
		if (subject.kind === "plant") await effects.workspaceNotice(tx, await seated(tx, "requested", w!), c.writes);
		c.writes.push(
			effects.queue(tx, {
				subject,
				requestId,
				revision: next,
				witnessId: w!.id,
				eligibleAt: cancelUntil.toISOString(),
			}),
		);
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
		const event = kind === "account" ? "account.cancelDeletion" : "churches.cancelWorkspaceDeletion";
		const witnessed = { kind, beforeDeadline: clock < w.cancel_until! };
		if (holds(deletionMachine, event, w.state, witnessed)) return status(w);
		if (!allows(deletionMachine, event, w.state, "cancelled", witnessed)) deny("deadline_passed");
		const writes: SQLWrapper[] = [];
		if (kind === "plant") await effects.workspaceNotice(tx, await seated(tx, "cancelled", w), writes);
		await executeWrites(tx, [
			tx
				.update(t.lifecycle_witness)
				.set({
					state: "cancelled",
					cancelled_at: clock,
					witness_checkpoint: sql`${t.lifecycle_witness.witness_checkpoint}+1`,
				})
				.where(
					and(
						eq(t.lifecycle_witness.id, w.id),
						inArray(t.lifecycle_witness.state, fromStates(deletionMachine, event, "cancelled", witnessed)),
					),
				),
			tx
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
				.onConflictDoNothing({ target: [t.audit_event.subject_id, t.audit_event.event_key] }),
			...writes,
		]);
		return status({ ...w, state: "cancelled", cancelled_at: clock });
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
async function mintable(tx: Tx, account: SQL, subject: { kind: DeletionSubject["kind"]; id: SQL }) {
	const read = await tx.execute(
		sql`WITH a AS (SELECT id FROM account WHERE ${account} FOR UPDATE),
 r AS (SELECT id FROM plant WHERE ${subject.kind}='plant' AND id=${subject.id} AND EXISTS(SELECT FROM a) FOR UPDATE),
 w AS (SELECT id,request_id,request_revision,requester_opaque_id FROM lifecycle_witness WHERE kind=${subject.kind} AND opaque_subject_id=${subject.id} AND EXISTS(SELECT FROM a) AND (${subject.kind}<>'plant' OR EXISTS(SELECT FROM r)) FOR UPDATE)
 SELECT (SELECT id FROM a) AS account, (SELECT to_jsonb(w) FROM w) AS witness, clock_timestamp() AS at`,
	);
	return mintRow.parse(read.rows[0]);
}
async function mint(tx: Tx, id: string, w: NonNullable<z.infer<typeof mintRow>["witness"]>, at: Date, provenAt: Date) {
	if (provenAt > at || at.getTime() - provenAt.getTime() > 5 * 60_000) deny("proof_invalid");
	const handle = randomBytes(32).toString("base64url");
	await tx
		.update(t.identity_proof)
		.set({ superseded_at: at })
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
		expires_at: new Date(at.getTime() + 10 * 60_000),
	});
	return { kind: "restricted_deletion" as const, handle: sessionId.parse(handle) };
}
export async function issueRestrictedDeletionSession(
	tx: Tx,
	input: { subject: DeletionSubject; requestId: string },
	prove: () => Promise<{ accountId: string; provenAt: Date }>,
) {
	const proof = await prove();
	if (input.subject.kind === "plant") await lockSeats(tx, "workspace-seats/" + input.subject.id);
	const id = accountId.parse(proof.accountId),
		subject = input.subject;
	const { witness: w, at } = await mintable(tx, sql`id=${id}::uuid`, {
		kind: subject.kind,
		id: sql`${subject.id}::uuid`,
	});
	if (
		!w ||
		w.request_id !== input.requestId ||
		(subject.kind === "account" ? id !== subject.id : w.requester_opaque_id !== id)
	)
		deny("proof_invalid");
	return mint(tx, id, w, at, proof.provenAt);
}
export async function issueAccountDeletionSession(tx: Tx, authUserId: string, provenAt: Date) {
	const row = await mintable(tx, sql`auth_user_id=${authUserId}::uuid`, {
		kind: "account",
		id: sql`(SELECT id FROM a)`,
	});
	const w = row.witness;
	if (!row.account || !w?.request_id) deny("proof_invalid");
	const subject = n.deletionSubject.parse({ kind: "account", id: row.account });
	return { session: await mint(tx, row.account, w, row.at, provenAt), subject, requestId: w.request_id };
}
export function createLifecycleCleanup(
	db: Database,
	config: {
		authorize(tx: Tx, input: DeletionRequest): Promise<boolean>;
		removeOwnedResources(input: DeletionRequest): Promise<boolean>;
	},
) {
	return async (input: DeletionRequest) => {
		const claimed = await gatedTransaction(db, async (tx) => {
			if (!(await config.authorize(tx, input))) deny("unavailable");
			await root(tx, input.subject);
			const w = await witness(tx, input.subject);
			if (!w || w.request_id !== input.requestId || w.request_revision !== input.revision) deny("conflict");
			if (holds(deletionMachine, "lifecycle.purge", w.state, { kind: input.subject.kind }))
				return { complete: true as const, value: status(w) };
			const clock = new Date(
				z.coerce.date().parse((await tx.execute(sql`SELECT clock_timestamp() AS at`)).rows[0]?.at),
			);
			const witnessed = { kind: input.subject.kind, beforeDeadline: clock < w.cancel_until! };
			if (!allows(deletionMachine, "lifecycle.purge", w.state, "purging", witnessed)) deny("deadline_passed");
			await tx
				.update(t.lifecycle_witness)
				.set({
					state: "purging",
					cleanup_state: "in_progress",
					witness_checkpoint: sql`${t.lifecycle_witness.witness_checkpoint}+1`,
				})
				.where(
					and(
						eq(t.lifecycle_witness.id, w.id),
						inArray(t.lifecycle_witness.state, fromStates(deletionMachine, "lifecycle.purge", "purging", witnessed)),
					),
				);
			return { complete: false as const };
		});
		if (claimed.complete) return claimed.value;
		await gatedTransaction(db, async (tx) => {
			if (!(await config.authorize(tx, input))) deny("unavailable");
			await root(tx, input.subject);
			const w = await witness(tx, input.subject);
			if (!w || w.request_id !== input.requestId || w.request_revision !== input.revision || w.state !== "purging")
				deny("conflict");
			await tx.execute(
				sql`SELECT settings_purge_content(${w.id}::uuid,${input.requestId}::uuid,${input.revision}::bigint)`,
			);
		});
		if (!(await config.removeOwnedResources(input))) return { status: "purging" as const };
		return gatedTransaction(db, async (tx) => {
			if (!(await config.authorize(tx, input))) deny("unavailable");
			await root(tx, input.subject);
			const w = await witness(tx, input.subject);
			if (
				!w ||
				w.request_id !== input.requestId ||
				w.request_revision !== input.revision ||
				!allows(deletionMachine, "lifecycle.purge", w.state, "purged", { kind: input.subject.kind, cleaned: true })
			)
				deny("conflict");
			await tx.execute(
				sql`SELECT settings_purge_subject(${w.id}::uuid,${input.requestId}::uuid,${input.revision}::bigint)`,
			);
			const [done] = await tx.select().from(t.lifecycle_witness).where(eq(t.lifecycle_witness.id, w.id));
			return status(done!);
		});
	};
}
