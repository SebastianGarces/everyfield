import { owner, requestIdentity, sameOwner, timeZone, type Owner } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/tasks";
import type { Database } from "@everyfield/db/client";
import { randomUUID } from "node:crypto";
import { hash } from "../operations/canonical.ts";
import "server-only";
import { z } from "zod";
import { boundWrite, RequestActor, type WriteTx } from "../access/session.ts";
import {
	auditSavepoint,
	declareWrite,
	lockedWrite,
	nativeWrite,
	finishAudit,
	prepareWrite,
	WriteUnavailable,
	type AuditWrite,
} from "../operations/writes.ts";

export type Tx = WriteTx;
export type TaskContext = { session: RequestActor["session"]; selected: Owner };
export type TaskReply<T> = { status: "ok"; value: T } | { status: "refused"; error: c.TaskError };
type Code = c.TaskError["code"];

export class TaskRefusal extends Error {
	readonly code: Code;
	readonly details: Record<string, unknown>;
	constructor(code: Code, details: Record<string, unknown> = {}) {
		super(code);
		this.code = code;
		this.details = details;
	}
}
export function deny(code: Code = "unavailable", details: Record<string, unknown> = {}): never {
	throw new TaskRefusal(code, details);
}
const retry: Record<Code, string> = {
	invalid_input: "never",
	access_denied: "never",
	unavailable: "never",
	invalid_subject: "never",
	conflict: "refresh",
	temporary: "same_request",
	unknown: "reconcile",
	protected_source: "never",
	nonexistent_local_time: "never",
	ambiguous_local_time: "never",
	open_successor: "refresh",
	dependency_cycle: "refresh",
	owner_ineligible: "refresh",
	stale_catalog: "refresh",
	offer_answered: "refresh",
};
function refused(error: TaskRefusal): TaskReply<never> {
	return {
		status: "refused",
		error: c.taskError.parse({
			code: error.code,
			details: error.details,
			correlationId: randomUUID(),
			retry: retry[error.code],
		}),
	};
}
export async function readReply<T>(body: () => Promise<T>): Promise<TaskReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (error instanceof WriteUnavailable) return refused(new TaskRefusal("unavailable"));
		if (!(error instanceof TaskRefusal)) throw error;
		return refused(error);
	}
}
export async function reply<T>(tx: Tx, body: () => Promise<T>): Promise<TaskReply<T>> {
	if (boundWrite(tx)) return { status: "ok", value: await body() };
	return readReply(() => auditSavepoint(tx, body));
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const r = schema.safeParse(raw);
	if (!r.success) deny("invalid_input");
	return r.data;
}

export async function withTaskWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: TaskContext) => Promise<TaskReply<T>>,
): Promise<TaskReply<T>> {
	const selected = authority.actor.context.owner;
	return readReply(() =>
		nativeWrite(db, authority, selected, async (tx) => {
			await declareWrite(tx, "established");
			const result = await body(tx, { session: authority.session, selected });
			if (result.status === "refused") throw new TaskRefusal(result.error.code, result.error.details);
			return result.value;
		}),
	);
}

export type Viewer = { accountId: string; plantId: string; role: "owner" | "admin" | "member" };
export type Reader = Viewer & { session: string; seatId: string; owner: Owner };
export function readerOf(authority: RequestActor): Reader {
	const a = authority.actor;
	if (a.context.kind !== "seat" || a.context.owner.kind !== "plant") deny();
	return {
		accountId: a.accountId,
		plantId: a.context.owner.id,
		role: a.context.role,
		session: authority.session,
		seatId: a.context.seatId,
		owner: a.context.owner,
	};
}
type Writer = Viewer & { zone: z.infer<typeof timeZone> };
async function writerOf(tx: Tx, context: TaskContext): Promise<Writer> {
	const bound = await lockedWrite(tx);
	const write =
		bound && sameOwner(bound.selected, context.selected)
			? bound
			: await RequestActor.claimWrite(tx, context.session, owner.parse(context.selected));
	if (!write || write.actor.context.kind !== "seat" || !write.plant || context.selected.kind !== "plant") deny();
	return {
		accountId: write.actor.accountId,
		plantId: write.plant.id,
		role: write.actor.context.role,
		zone: timeZone.parse(write.plant.timezone),
	};
}
export const administers = (v: Viewer) => v.role !== "member";

export { hash };

export type Command = AuditWrite & { actor: Writer };
export type AuditCommand = AuditWrite & { actor: { accountId: string; plantId: string } };
type TaskWrite =
	| "followups.correctOutcome"
	| "followups.recordOutcome"
	| "tasks.acceptPhaseOffer"
	| "tasks.assignFollowUp"
	| "tasks.bulkComplete"
	| "tasks.bulkReschedule"
	| "tasks.changeStatus"
	| "tasks.complete"
	| "tasks.completeOccurrence"
	| "tasks.configureRecurrence"
	| "tasks.create"
	| "tasks.createFollowUp"
	| "tasks.createSubtask"
	| "tasks.declinePhaseOffer"
	| "tasks.delete"
	| "tasks.edit"
	| "tasks.executeHandoff"
	| "tasks.importTemplate"
	| "tasks.removeSubtask"
	| "tasks.reopen"
	| "tasks.replacePrerequisites"
	| "tasks.setSubtaskCompletion"
	| "tasks.waive";
export async function command<T>(
	tx: Tx,
	context: TaskContext,
	operation: TaskWrite,
	input: { requestKey: string },
	body: (command: Command) => Promise<{ value: T; after?: () => Promise<unknown> }>,
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
	if (claim.kind === "unavailable") deny();
	if (claim.kind === "replay") return claim.value as T;
	const result = await body({ ...claim, actor });
	await finishAudit(tx, claim, identity, result.value);
	await result.after?.();
	return result.value;
}

export function auditRow(
	cmd: AuditCommand,
	entry: {
		taskId: string;
		action: "tasks.changed" | "tasks.completed" | "tasks.waived";
		kind: "create" | "edit" | "complete" | "reopen" | "waive" | "remove" | "noop";
		before: Record<string, unknown> | null;
		after: Record<string, unknown> | null;
		beforeRevision: string | null;
		afterRevision: string;
		source?: z.infer<typeof c.historySource>;
		reason?: string | null;
	},
) {
	const first = entry.source !== "generated" && !cmd.events.some((e) => e.id === cmd.id);
	cmd.events.push({
		id: first ? cmd.id : randomUUID(),
		tenant_id: cmd.actor.plantId,
		actor_id: cmd.actor.accountId,
		actor_token: hash([cmd.actor.plantId, cmd.actor.accountId]),
		action: entry.action,
		kind: entry.kind,
		subject_type: "task",
		subject_id: entry.taskId,
		before_value: entry.before,
		after_value: entry.after,
		before_revision: entry.beforeRevision,
		after_revision: entry.afterRevision,
		reason: entry.reason ?? null,
		metadata: { source: entry.source ?? "person" },
	});
}

export function changes(before: Record<string, unknown>, after: Record<string, unknown>) {
	const keys = Object.keys(after).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
	return {
		before: Object.fromEntries(keys.map((k) => [k, before[k] ?? null])),
		after: Object.fromEntries(keys.map((k) => [k, after[k] ?? null])),
	};
}
