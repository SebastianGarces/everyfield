import { owner, requestIdentity, sameOwner, type Owner } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/communication";
import type { Database } from "@everyfield/db/client";
import "server-only";
import { z } from "zod";
import { boundWrite, RequestActor, type WriteTx } from "../access/session.ts";
import { hash } from "../operations/canonical.ts";
import {
	auditSavepoint,
	declareWrite,
	finishAudit,
	lockedWrite,
	nativeWrite,
	prepareWrite,
	type AuditWrite,
} from "../operations/writes.ts";
import { writeAction } from "../operations/actions.ts";
import { defineRefusals, type Deny } from "../operations/refusals.ts";

export type Tx = WriteTx;
export type CommunicationContext = { session: RequestActor["session"]; selected: Owner };
export type CommunicationReply<T> = { status: "ok"; value: T } | { status: "refused"; error: c.CommunicationError };
const refusals = defineRefusals(c.communicationError, { writeUnavailable: "unavailable" });
export const CommunicationRefusal = refusals.Refusal;
export const deny: Deny<typeof c.communicationError> = refusals.deny;
export const { settle: readReply } = refusals;
export async function reply<T>(tx: Tx, body: () => Promise<T>): Promise<CommunicationReply<T>> {
	if (boundWrite(tx)) return { status: "ok", value: await body() };
	return readReply(() => auditSavepoint(tx, body));
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const parsed = schema.safeParse(raw);
	if (!parsed.success) deny("invalid_input");
	return parsed.data;
}

export async function withCommunicationWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: CommunicationContext) => Promise<CommunicationReply<T>>,
): Promise<CommunicationReply<T>> {
	const selected = authority.actor.context.owner;
	return readReply(() =>
		nativeWrite(db, authority, selected, async (tx) => {
			await declareWrite(tx, "established");
			const result = await body(tx, { session: authority.session, selected });
			if (result.status === "refused") throw new CommunicationRefusal(result.error.code, result.error.details);
			return result.value;
		}),
	);
}

export type Viewer = { accountId: string; plantId: string; role: "owner" | "admin" | "member" };
export function readerOf(authority: RequestActor): Viewer & { session: string; seatId: string; owner: Owner } {
	const actor = authority.actor;
	if (actor.context.kind !== "seat" || actor.context.owner.kind !== "plant") deny("unavailable");
	return {
		accountId: actor.accountId,
		plantId: actor.context.owner.id,
		role: actor.context.role,
		session: authority.session,
		seatId: actor.context.seatId,
		owner: actor.context.owner,
	};
}
async function writerOf(tx: Tx, context: CommunicationContext) {
	const bound = await lockedWrite(tx);
	const write =
		bound && sameOwner(bound.selected, context.selected)
			? bound
			: await RequestActor.claimWrite(tx, context.session, owner.parse(context.selected));
	if (!write || write.actor.context.kind !== "seat" || !write.plant || context.selected.kind !== "plant")
		deny("unavailable");
	return {
		accountId: write.actor.accountId,
		plantId: write.plant.id,
		role: write.actor.context.role,
		seatId: write.actor.context.seatId,
	};
}
export const administers = (viewer: Viewer) => viewer.role !== "member";

export type Command = AuditWrite & {
	actor: { accountId: string; plantId: string; role: Viewer["role"]; seatId: string };
};
export async function command<T>(
	tx: Tx,
	context: CommunicationContext,
	operation: string,
	input: { requestKey: string },
	body: (command: Command) => Promise<T>,
): Promise<T> {
	const actor = await writerOf(tx, context);
	const identity = requestIdentity.parse({
		owner: context.selected,
		actorId: actor.accountId,
		operation,
		requestKey: input.requestKey,
		digest: hash({ operation, input }),
	});
	const claim = await prepareWrite(tx, identity);
	if (claim.kind === "conflict") deny("conflict");
	if (claim.kind === "unavailable") deny("unavailable");
	if (claim.kind === "replay") return claim.value as T;
	const value = await body({ ...claim, actor });
	await finishAudit(tx, claim, identity, value);
	return value;
}

export function audit(
	cmd: Command,
	entry: {
		subjectId: string;
		subjectType: "communication" | "message_template";
		kind: "create" | "edit" | "remove";
		before: Record<string, unknown> | null;
		after: Record<string, unknown> | null;
		beforeRevision: string | null;
		afterRevision: string;
		operation: string;
	},
) {
	cmd.events.push({
		id: cmd.id,
		tenant_id: cmd.actor.plantId,
		actor_id: cmd.actor.accountId,
		actor_token: hash([cmd.actor.plantId, cmd.actor.accountId]),
		action: writeAction(entry.operation),
		kind: entry.kind,
		subject_type: entry.subjectType,
		subject_id: entry.subjectId,
		before_value: entry.before,
		after_value: entry.after,
		before_revision: entry.beforeRevision,
		after_revision: entry.afterRevision,
	});
}

export { hash };
