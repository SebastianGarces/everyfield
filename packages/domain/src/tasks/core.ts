import { owner, requestIdentity, sameOwner, timeZone, type Owner } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/tasks";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { boundWrite, RequestActor } from "../access/session.ts";
import {
	auditSavepoint,
	lockedWrite,
	nativeWrite,
	finishAudit,
	prepareWrite,
	WriteUnavailable,
	type AuditWrite,
} from "../operations/writes.ts";

export type Tx = Transaction;
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
/** A tool or test caller without a bound native request gets its own savepoint, so a refusal rolls back alone. */
export async function reply<T>(tx: Tx, body: () => Promise<T>): Promise<TaskReply<T>> {
	if (boundWrite(tx)) return { status: "ok", value: await body() };
	return readReply(() => auditSavepoint(tx, body));
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const r = schema.safeParse(raw);
	if (!r.success) deny("invalid_input");
	return r.data;
}

/** The native request owns rollback: bind the verified actor once, then run the command in the same transaction. */
export async function withTaskWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: TaskContext) => Promise<TaskReply<T>>,
): Promise<TaskReply<T>> {
	const selected = authority.actor.context.owner;
	return readReply(() =>
		nativeWrite(db, authority, selected, async (tx) => {
			const result = await body(tx, { session: authority.session, selected });
			if (result.status === "refused") throw new TaskRefusal(result.error.code, result.error.details);
			return result.value;
		}),
	);
}

export type Viewer = { accountId: string; plantId: string; role: "owner" | "admin" | "member" };
export type Reader = Viewer & { session: string; seatId: string; owner: Owner };
/** The reader's plant seat as the request's verified actor saw it; reads add no statement for it (D59/D60). */
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
export type Writer = Viewer & { zone: z.infer<typeof timeZone> };
/** Locks the actor's authority for this transaction once; a bound native request reuses its lock. */
export async function writerOf(tx: Tx, context: TaskContext): Promise<Writer> {
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

const stable = (v: unknown): string =>
	Array.isArray(v)
		? "[" + v.map(stable).join(",") + "]"
		: v !== null && typeof v === "object"
			? "{" +
				Object.entries(v)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, x]) => JSON.stringify(k) + ":" + stable(x))
					.join(",") +
				"}"
			: JSON.stringify(v);
export const hash = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex");

export type Command = AuditWrite & { actor: Writer };
/** Any command that may append task changes: a task command, or another domain's command that generates tasks. */
export type AuditCommand = AuditWrite & { actor: { accountId: string; plantId: string } };
/**
 * One retry-safe command (D70): the request key replays the stored answer, the body queues its changes and audit rows
 * on the command, and finishAudit runs them in one statement. `after` runs in the same transaction once the changes
 * are visible, for consequences that read them (reminder sync).
 */
export async function command<T>(
	tx: Tx,
	context: TaskContext,
	operation: string,
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

/** A task audit row. The command's first row carries the request key and stored answer. */
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
	// Generated work appends to another domain's command, whose own row keeps the command ID.
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

/** The fields whose values differ, before and after. */
export function changes(before: Record<string, unknown>, after: Record<string, unknown>) {
	const keys = Object.keys(after).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
	return {
		before: Object.fromEntries(keys.map((k) => [k, before[k] ?? null])),
		after: Object.fromEntries(keys.map((k) => [k, after[k] ?? null])),
	};
}
export const literal = (v: unknown): SQL => sql`${sql.param(v)}`;
