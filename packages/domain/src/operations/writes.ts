import { writeAction } from "./actions.ts";
import { requestIdentity, type RequestIdentity } from "@everyfield/contracts/common";
import type { Database, Transaction } from "@everyfield/db/client";
import type { PgInsertValue } from "@everyfield/db/columns";
import { sql, type SQL, type SQLWrapper } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { checkoutClient, type PoolClient } from "@everyfield/db/client";
import {
	boundWrite,
	clearRequestWrite,
	deferWrite,
	requestWrite,
	writeAuthority,
	writeVisibility,
	type RequestActor,
} from "../access/session.ts";
import type { Owner } from "@everyfield/contracts/common";

export class WriteUnavailable extends Error {
	constructor() {
		super("unavailable");
	}
}

export type AuditWrite = {
	id: string;
	writes: SQLWrapper[];
	events: PgInsertValue<typeof t.audit_event>[];
};

const newWrite = () => ({
	kind: "new" as const,
	id: randomUUID(),
	writes: new Array<SQLWrapper>(),
	events: new Array<PgInsertValue<typeof t.audit_event>>(),
});
/**
 * Read a committed exact-request reply. A unique audit key arbitrates absent-key races at commit. A native write's
 * first attempt skips the read: a refusal or a key conflict reruns the command, which then reads the key first.
 */
export async function prepareWrite(tx: Transaction, request: RequestIdentity) {
	if (sessions.has(tx)) return newWrite();
	const result = await tx.execute(sql`SELECT ${writeVisibility(request.actorId, request.owner)} AS allowed,
 a.id,a.subject_id,a.request_identity,a.result FROM (SELECT 1) seed LEFT JOIN audit_event a
 ON a.tenant_id=${request.owner.id}::uuid AND a.request_key=${request.requestKey}`);
	const row = z
		.object({
			allowed: z.boolean(),
			id: z.uuid().nullable(),
			subject_id: z.uuid().nullable(),
			request_identity: z.unknown(),
			result: z.unknown(),
		})
		.parse(result.rows[0]);
	if (!row.allowed) return { kind: "unavailable" as const };
	if (row.id) {
		if (row.request_identity === null || row.result === null) return { kind: "unavailable" as const };
		const prior = requestIdentity.parse(row.request_identity);
		if (prior.actorId !== request.actorId || prior.operation !== request.operation || prior.digest !== request.digest)
			return { kind: "conflict" as const, id: row.id };
		return { kind: "replay" as const, id: row.id, subject: row.subject_id, value: row.result };
	}
	return newWrite();
}

export async function finishAudit(tx: Transaction, command: AuditWrite, request: RequestIdentity, result: unknown) {
	const entries = command.events;
	if (!entries.some((entry) => entry.id === command.id))
		entries.unshift({
			id: command.id,
			tenant_id: request.owner.id,
			actor_id: request.actorId,
			action: writeAction(request.operation),
			kind: "edit",
			subject_type: "command",
			subject_id: request.owner.id,
		});
	const rows = entries.map((entry) => ({
		...entry,
		command_id: command.id,
		...(entry.id === command.id ? { request_key: request.requestKey, request_identity: request, result } : {}),
	}));
	// A deletion request deliberately hides its own locked root before its final audit.
	const closesOwner = ["account.requestDeletion", "churches.requestWorkspaceDeletion"].includes(request.operation);
	const writes = [...command.writes, tx.insert(t.audit_event).values(rows)];
	const session = sessions.get(tx);
	if (session) return session.finish(writes, closesOwner ? undefined : request);
	await executeWrites(tx, writes, closesOwner ? undefined : request);
}

/**
 * The name executeWrites gives the write most recently queued on `command`. A later write that reads it runs after
 * it inside the one statement, for example an insert that must follow the update freeing a unique slot.
 */
export const lastWrite = (command: AuditWrite) => sql.identifier(`write_${command.writes.length - 1}`);

/** Independent changes and their audit entries execute in one statement, on a transaction or alone on the pool. */
export async function executeWrites(
	tx: Pick<Transaction, "execute">,
	writes: readonly SQLWrapper[],
	request?: RequestIdentity,
): Promise<void> {
	if (!writes.length) return;
	const result = await tx.execute(
		sql`WITH ${writeEntries(writes)} SELECT ${request ? writeVisibility(request.actorId, request.owner) : sql`true`} AS allowed`,
	);
	if (!z.boolean().parse(result.rows[0]?.allowed)) throw new WriteUnavailable();
}
const writeEntries = (writes: readonly SQLWrapper[]) =>
	sql.join(
		writes.map((q, i) => sql`${sql.identifier("write_" + i)} AS (${q.getSQL()} RETURNING 1)`),
		sql`, `,
	);
export function isAuditRetry(error: unknown): boolean {
	const found = z
		.object({ cause: z.object({ code: z.literal("23505"), constraint: z.literal("audit_request_key") }) })
		.safeParse(error);
	return found.success;
}
/** A lost concurrent request may win the audit key after this transaction's first snapshot. */
export async function auditTransaction<T>(db: Database, body: (tx: Transaction) => Promise<T>): Promise<T> {
	try {
		return await db.transaction(body);
	} catch (error) {
		if (!isAuditRetry(error)) throw error;
		return db.transaction(body);
	}
}

export function setAuditDetails(command: AuditWrite, id: string, metadata: unknown, reason: string | null = null) {
	const entry = command.events.find((entry) => entry.id === id);
	if (!entry) throw new Error("missing_audit_entry");
	entry.metadata = metadata;
	entry.reason = reason;
}

export async function auditSavepoint<T>(tx: Transaction, body: (tx: Transaction) => Promise<T>): Promise<T> {
	if (boundWrite(tx)) return body(tx);
	try {
		try {
			return await tx.transaction(body);
		} catch (error) {
			if (!isAuditRetry(error)) throw error;
			clearRequestWrite(tx);
			return tx.transaction(body);
		}
	} finally {
		clearRequestWrite(tx);
	}
}

/**
 * Which way a native write runs (C88). "single": every check the write makes is on rows its final statement locks
 * again, or on a database constraint, so it may run as one statement without a transaction. "established": the write
 * depends on another row's value (a time zone, a setting, a parent's state), a count or limit, or uniqueness without
 * a constraint, so it runs in the gate's transaction. A statement's snapshot predates its locks, and a lock refreshes
 * only the rows it locks. Every write is established unless it declares "single".
 */
export type WritePath = "single" | "established";

/** Declares the running command's path. An established command starts its transaction and runs the gate now. */
export async function declareWrite(tx: Transaction, path: WritePath) {
	const session = sessions.get(tx);
	if (!session) return;
	session.path = path;
	if (path === "established") await session.lock();
}

/**
 * A native write (RT-3, D70). The first attempt sends no BEGIN, no gate and no request-key read. A "single" command
 * reads its rows without a lock (checkedRead); its final statement checks the request actor's authority with the
 * gate's locks, repeats each read with its lock and makes the changes with their audit, so it needs no transaction. A
 * failed check raises inside that statement, which then changes nothing. Any other command, and any other statement
 * before the final one, starts a transaction and runs the gate first, as before. A refusal, a failed check or a
 * request-key conflict reruns the command the established way: BEGIN, gate, request-key read, command, COMMIT. That
 * run answers replays and refusals exactly as before.
 */
export async function nativeWrite<T>(
	db: Database,
	authority: RequestActor,
	selected: Owner,
	body: (tx: Transaction) => Promise<T>,
): Promise<T> {
	const first = await firstAttempt(db, authority, selected, body);
	if (first.done) return first.value;
	// The established run names itself a retry on the wire, so statement budgets count it with the first attempt.
	const { client, db: bound } = await checkoutClient(db);
	const own = Object.getOwnPropertyDescriptor(client, "query");
	const send = client.query.bind(client) as (config: unknown, values?: unknown) => Promise<unknown>;
	const retry = (config: string | { text: string }, values?: unknown) =>
		send(/^\s*begin\s*$/i.test(typeof config === "string" ? config : config.text) ? RETRY : config, values);
	Object.defineProperty(client, "query", { value: retry, configurable: true, writable: true });
	try {
		return await auditTransaction(bound, async (tx) => {
			if (!(await authority.bind(tx, selected))) throw new WriteUnavailable();
			return body(tx);
		});
	} finally {
		if (own) Object.defineProperty(client, "query", own);
		else delete (client as { query?: unknown }).query;
		client.release();
	}
}
/** The BEGIN of a native write's established run, after its first attempt changed nothing. */
const RETRY = "BEGIN /* evf:retry */";

/** A statement after a native write committed on its own: a "single" command must end with its final write. */
export class WriteOrderError extends Error {}

async function firstAttempt<T>(
	db: Database,
	authority: RequestActor,
	selected: Owner,
	body: (tx: Transaction) => Promise<T>,
): Promise<{ done: true; value: T } | { done: false }> {
	const { client, db: bound } = await checkoutClient(db);
	const session = new WriteSession(client, authority, selected);
	try {
		const value = await bound.transaction(async (tx) => {
			if (!deferWrite(tx, authority, selected)) throw new WriteUnavailable();
			session.tx = tx;
			sessions.set(tx, session);
			return body(tx);
		});
		return { done: true, value };
	} catch (error) {
		if (error instanceof WriteOrderError) throw error;
		return { done: false };
	} finally {
		session.close();
		client.release();
	}
}

/** A read the final statement repeats with `lock`: the same rows, or the write fails. */
type Check = { read: SQL; lock: SQL; digest: string };
const sessions = new WeakMap<Transaction, WriteSession>();
const gating = new AsyncLocalStorage<true>();
const FINAL = "/* evf:final */ ",
	READ = "/* evf:read */ ";
const skipped = (command: string) => ({ command, rowCount: 0, rows: [], fields: [], oid: 0 });
/** The rows of `read` as one comparable value. */
const digestOf = (read: SQL) =>
	sql`(SELECT md5(coalesce(jsonb_agg(r.v ORDER BY r.v::text)::text,'')) FROM (SELECT to_jsonb(q) AS v FROM (${read}) q) r)`;

class WriteSession {
	tx: Transaction | undefined;
	/** BEGIN was sent: the gate holds its locks until COMMIT. */
	private begun = false;
	path: WritePath = "established";
	/** The final statement committed on its own. */
	private done = false;
	private locking: Promise<void> | undefined;
	private readonly checks: Check[] = [];
	private readonly send: PoolClient["query"];
	private readonly own: PropertyDescriptor | undefined;
	private readonly client: PoolClient;
	private readonly authority: RequestActor;
	private readonly selected: Owner;
	constructor(client: PoolClient, authority: RequestActor, selected: Owner) {
		this.client = client;
		this.authority = authority;
		this.selected = selected;
		this.own = Object.getOwnPropertyDescriptor(client, "query");
		this.send = client.query.bind(client);
		const route = (config: string | { text: string }, values?: unknown) =>
			this.route(typeof config === "string" ? config : config.text, () =>
				(this.send as (c: unknown, v?: unknown) => Promise<unknown>)(config, values),
			);
		Object.defineProperty(client, "query", { value: route, configurable: true, writable: true });
	}
	close() {
		if (this.own) Object.defineProperty(this.client, "query", this.own);
		else delete (this.client as { query?: unknown }).query;
	}

	private async route(text: string, run: () => Promise<unknown>) {
		const control = /^\s*(begin|commit|rollback)\s*$/i.exec(text)?.[1]?.toUpperCase();
		if (control) return this.begun ? run() : skipped(control);
		if (this.done) throw new WriteOrderError("A statement ran after the native write committed: " + text.slice(0, 80));
		if (this.begun || text.startsWith(FINAL) || text.startsWith(READ) || gating.getStore()) return run();
		await this.lock();
		return run();
	}

	/** Start the transaction and run the gate once: a statement the final write cannot check needs the gate's locks. */
	lock(): Promise<void> {
		this.locking ??= gating.run(true, async () => {
			await (this.send as (c: string) => Promise<unknown>)("BEGIN");
			this.begun = true;
			if (!(await this.authority.bind(this.tx!, this.selected))) throw new WriteUnavailable();
		});
		return this.locking;
	}

	/** Run `read` without its lock; the final statement repeats it with the lock. Null once the gate holds its locks. */
	async check(read: SQL, lock: SQL): Promise<Record<string, unknown>[] | null> {
		if (this.begun || this.path !== "single") return null;
		const result = await this.tx!.execute(
			sql`${sql.raw(READ)}SELECT d.evf_digest, q.* FROM (SELECT ${digestOf(read)} AS evf_digest) d
 LEFT JOIN LATERAL (SELECT x.*, row_number() OVER () AS evf_row FROM (${read}) x) q ON true ORDER BY q.evf_row`,
		);
		this.checks.push({ read, lock, digest: String(result.rows[0]?.evf_digest) });
		return result.rows
			.filter((row) => row.evf_row !== null)
			.map((row) => {
				const read = { ...row };
				delete read.evf_digest;
				delete read.evf_row;
				return read;
			});
	}

	async finish(writes: readonly SQLWrapper[], request: RequestIdentity | undefined) {
		if (this.path !== "single") await this.lock();
		const authority = this.begun ? null : boundWrite(this.tx!);
		const allowed = authority
			? sql`(SELECT allowed FROM evf_auth)`
			: request
				? writeVisibility(request.actorId, request.owner)
				: sql`true`;
		// Each check runs after the authority's locks and takes its own locks without waiting.
		const current = this.checks.length
			? sql.join(
					this.checks.map((c) => sql`${digestOf(sql`${c.read} ${c.lock} NOWAIT`)}=${c.digest}`),
					sql` AND `,
				)
			: sql`true`;
		const entries = [...(authority ? [writeAuthority(authority)] : []), writeEntries(writes)];
		// The CASE result depends on the rows, so the planner cannot fold the failing cast; the error aborts the statement.
		await this.tx!.execute(
			sql`${sql.raw(FINAL)}WITH ${sql.join(entries, sql`, `)} SELECT (CASE WHEN ${allowed} IS NOT TRUE THEN 'evf_refused'
 WHEN ${current} THEN 'true' ELSE 'evf_stale' END)::boolean AS allowed`,
		);
		if (!this.begun) this.done = true;
	}
}

/**
 * A "single" command's read of rows its final statement locks again: `read` is the query, `lock` the locking clause
 * the established way adds (FOR UPDATE OF t). The first attempt runs `read` without the lock; the final statement runs
 * it again with `lock` NOWAIT and requires the same rows. Null for an established command or once the gate holds its
 * locks: run the read with its lock as usual.
 */
export function checkedRead(tx: Transaction, read: SQL, lock: SQL) {
	return sessions.get(tx)?.check(read, lock) ?? Promise.resolve(null);
}

/** The gate's locked rows. A native write's first attempt starts its transaction and runs the gate here. */
export async function lockedWrite(tx: Transaction) {
	await sessions.get(tx)?.lock();
	return requestWrite(tx);
}
