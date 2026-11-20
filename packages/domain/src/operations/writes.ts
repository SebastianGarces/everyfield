import { writeAction } from "./actions.ts";
import { requestIdentity, sameOwner, type Owner, type RequestIdentity } from "@everyfield/contracts/common";
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
	liveRead,
	requestWrite,
	writeAuthority,
	writeTx,
	writeVisibility,
	type RequestActor,
	type WriteTx,
} from "../access/session.ts";

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
export async function prepareWrite(tx: WriteTx, request: RequestIdentity) {
	const native = tx.write.native;
	if (native?.kind === "first") {
		native.session.keyed = true;
		return newWrite();
	}
	const stored = native?.kind === "stored" ? native.run : undefined;
	const row =
		(native?.kind === "retry" ? native.known.get(request.requestKey) : undefined) ??
		storedKey.parse(
			(
				await tx.execute(sql`${sql.raw(stored ? STORED : "")}SELECT ${stored ? stored.allowed : writeVisibility(request.actorId, request.owner)} AS allowed,
 a.id,a.subject_id,a.request_identity,a.result FROM (SELECT 1) seed LEFT JOIN audit_event a
 ON a.tenant_id=${request.owner.id}::uuid AND a.request_key=${request.requestKey}`)
			).rows[0],
		);
	if (!row.allowed) return { kind: "unavailable" as const };
	stored?.known.set(request.requestKey, row);
	if (row.id) {
		if (row.request_identity === null || row.result === null) return { kind: "unavailable" as const };
		const prior = requestIdentity.parse(row.request_identity);
		if (prior.actorId !== request.actorId || prior.operation !== request.operation || prior.digest !== request.digest)
			return { kind: "conflict" as const, id: row.id };
		return { kind: "replay" as const, id: row.id, subject: row.subject_id, value: row.result };
	}
	stored?.miss(true);
	return newWrite();
}
const storedKey = z.object({
	allowed: z.boolean(),
	id: z.uuid().nullable(),
	subject_id: z.uuid().nullable(),
	request_identity: z.unknown(),
	result: z.unknown(),
});
type StoredKey = z.infer<typeof storedKey>;

export async function finishAudit(tx: WriteTx, command: AuditWrite, request: RequestIdentity, result: unknown) {
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
	const closesOwner = ["account.requestDeletion", "churches.requestWorkspaceDeletion"].includes(request.operation);
	const writes = [...command.writes, tx.insert(t.audit_event).values(rows)];
	const native = tx.write.native;
	if (native?.kind === "first") return native.session.finish(writes, closesOwner ? undefined : request);
	await executeWrites(tx, writes, closesOwner ? undefined : request);
}

export const lastWrite = (command: AuditWrite) => sql.identifier(`write_${command.writes.length - 1}`);

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
function isAuditRetry(error: unknown): boolean {
	const found = z
		.object({ cause: z.object({ code: z.literal("23505"), constraint: z.literal("audit_request_key") }) })
		.safeParse(error);
	return found.success;
}
export const gatedTransaction = <T>(db: Database | Transaction, body: (tx: WriteTx) => Promise<T>): Promise<T> =>
	db.transaction((tx) => body(writeTx(tx)));
export async function auditTransaction<T>(
	db: Database | Transaction,
	body: (tx: WriteTx) => Promise<T>,
	native?: () => NativeRun | undefined,
): Promise<T> {
	const attempt = (tx: Transaction) => body(writeTx(tx, native?.()));
	try {
		return await db.transaction(attempt);
	} catch (error) {
		if (!isAuditRetry(error)) throw error;
		return db.transaction(attempt);
	}
}

export function setAuditDetails(command: AuditWrite, id: string, metadata: unknown, reason: string | null = null) {
	const entry = command.events.find((entry) => entry.id === id);
	if (!entry) throw new Error("missing_audit_entry");
	entry.metadata = metadata;
	entry.reason = reason;
}

export async function auditSavepoint<T>(tx: WriteTx, body: (tx: WriteTx) => Promise<T>): Promise<T> {
	if (boundWrite(tx)) return body(tx);
	const savepoint = (inner: Transaction) => body(writeTx(inner));
	try {
		try {
			return await tx.transaction(savepoint);
		} catch (error) {
			if (!isAuditRetry(error)) throw error;
			clearRequestWrite(tx);
			return tx.transaction(savepoint);
		}
	} finally {
		clearRequestWrite(tx);
	}
}

export type WritePath = "single" | "established";

export async function declareWrite(tx: WriteTx, path: WritePath) {
	const native = tx.write.native;
	const session = native?.kind === "first" ? native.session : undefined;
	if (!session || session.path === "established") return session?.lock();
	session.path = path;
	if (path === "established") await session.lock();
}

export async function nativeWrite<T>(
	db: Database,
	authority: RequestActor,
	selected: Owner,
	body: (tx: WriteTx) => Promise<T>,
): Promise<T> {
	const first = await firstAttempt(db, authority, selected, body);
	if (first.done) return first.value;
	if (first.next === "answer") throw first.error;
	let known: ReadonlyMap<string, StoredKey> | undefined;
	if (first.next !== "rerun") {
		const stored = await storedAnswer(db, authority, selected, body);
		if (stored.done) return stored.value;
		if (stored.absent && first.next === "refusal") throw first.error;
		known = stored.known;
	}
	const { client, db: bound } = await checkoutClient(db);
	const own = Object.getOwnPropertyDescriptor(client, "query");
	const send = client.query.bind(client) as (config: unknown, values?: unknown) => Promise<unknown>;
	const retry = (config: string | { text: string }, values?: unknown) =>
		send(/^\s*begin\s*$/i.test(typeof config === "string" ? config : config.text) ? RETRY : config, values);
	Object.defineProperty(client, "query", { value: retry, configurable: true, writable: true });
	try {
		return await auditTransaction(
			bound,
			async (tx) => {
				if (!(await authority.bind(tx, selected))) throw new WriteUnavailable();
				return body(tx);
			},
			() => {
				const retry: NativeRun | undefined = known && { kind: "retry", known };
				known = undefined;
				return retry;
			},
		);
	} finally {
		if (own) Object.defineProperty(client, "query", own);
		else delete (client as { query?: unknown }).query;
		client.release();
	}
}
const RETRY = "BEGIN /* evf:retry */";

class WriteOrderError extends Error {}

type Next = "replay" | "answer" | "refusal" | "check" | "rerun";

async function firstAttempt<T>(
	db: Database,
	authority: RequestActor,
	selected: Owner,
	body: (tx: WriteTx) => Promise<T>,
): Promise<{ done: true; value: T } | { done: false; error: unknown; next: Next }> {
	const { client, db: bound } = await checkoutClient(db);
	const session = new WriteSession(client, authority, selected);
	let deferred = false;
	try {
		const value = await bound.transaction(async (raw) => {
			const tx = writeTx(raw, { kind: "first", session });
			if (!deferWrite(tx, authority, selected)) throw new WriteUnavailable();
			deferred = true;
			session.tx = tx;
			return body(tx);
		});
		return { done: true, value };
	} catch (error) {
		if (error instanceof WriteOrderError) throw error;
		const next: Next = isAuditRetry(error)
			? "replay"
			: !deferred || session.failed || (session.unlocked && !session.keyed)
				? "rerun"
				: session.unlocked
					? "check"
					: session.keyed
						? "refusal"
						: "answer";
		return { done: false, error, next };
	} finally {
		session.close();
		client.release();
	}
}

class StoredMiss extends Error {}
const STORED = "/* evf:stored */ ";
export type NativeRun =
	| { kind: "first"; session: WriteSession }
	| { kind: "stored"; run: StoredRun }
	| { kind: "retry"; known: ReadonlyMap<string, StoredKey> };

async function storedAnswer<T>(
	db: Database,
	authority: RequestActor,
	selected: Owner,
	body: (tx: WriteTx) => Promise<T>,
): Promise<{ done: true; value: T } | { done: false; absent: boolean; known: ReadonlyMap<string, StoredKey> }> {
	const { client, db: bound } = await checkoutClient(db);
	const run = new StoredRun(client, authority, selected);
	try {
		const value = await bound.transaction(async (raw) => {
			const tx = writeTx(raw, { kind: "stored", run });
			if (!deferWrite(tx, authority, selected)) run.miss(false);
			return body(tx);
		});
		if (run.missed === undefined && !run.failed) return { done: true, value };
	} catch (error) {
		if (run.missed === undefined && !run.failed) throw error;
	} finally {
		run.close();
		client.release();
	}
	const absent = run.missed === true && ![...run.known.values()].some((key) => key.id);
	return { done: false, absent, known: run.known };
}

class StoredRun {
	missed: boolean | undefined;
	failed = false;
	readonly known = new Map<string, StoredKey>();
	readonly allowed: SQL;
	private readonly client: PoolClient;
	private readonly own: PropertyDescriptor | undefined;
	constructor(client: PoolClient, authority: RequestActor, selected: Owner) {
		this.client = client;
		const seat = authority.actor.context;
		this.allowed = liveRead(
			seat.kind === "seat" && sameOwner(seat.owner, selected)
				? { session: authority.session, owner: selected, seatId: seat.seatId, role: seat.role }
				: { session: authority.session, owner: selected },
		);
		this.own = Object.getOwnPropertyDescriptor(client, "query");
		const send = client.query.bind(client) as (c: unknown, v?: unknown) => Promise<unknown>;
		const route = async (config: string | { text: string }, values?: unknown) => {
			const text = typeof config === "string" ? config : config.text;
			const control = /^\s*(begin|commit|rollback)\s*$/i.exec(text)?.[1]?.toUpperCase();
			if (control) return skipped(control);
			if (!text.startsWith(STORED)) this.miss(false);
			try {
				return await send(config, values);
			} catch (error) {
				this.failed = true;
				throw error;
			}
		};
		Object.defineProperty(client, "query", { value: route, configurable: true, writable: true });
	}
	miss(absent: boolean): never {
		this.missed ??= absent;
		throw new StoredMiss();
	}
	close() {
		if (this.own) Object.defineProperty(this.client, "query", this.own);
		else delete (this.client as { query?: unknown }).query;
	}
}

type Check = { read: SQL; lock: SQL; digest: string };
const gating = new AsyncLocalStorage<true>();
const FINAL = "/* evf:final */ ",
	READ = "/* evf:read */ ";
const skipped = (command: string) => ({ command, rowCount: 0, rows: [], fields: [], oid: 0 });
const digestOf = (read: SQL) =>
	sql`(SELECT md5(coalesce(jsonb_agg(r.v ORDER BY r.v::text)::text,'')) FROM (SELECT to_jsonb(q) AS v FROM (${read}) q) r)`;

class WriteSession {
	tx: WriteTx | undefined;
	private begun = false;
	path: WritePath | undefined;
	private done = false;
	keyed = false;
	failed = false;
	unlocked = false;
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
	private get transaction(): WriteTx {
		if (!this.tx) throw new WriteOrderError("The native write ran a statement before its transaction began");
		return this.tx;
	}

	private async route(text: string, run: () => Promise<unknown>) {
		const control = /^\s*(begin|commit|rollback)\s*$/i.exec(text)?.[1]?.toUpperCase();
		if (control) return this.begun ? this.sent(run) : skipped(control);
		if (this.done) throw new WriteOrderError("A statement ran after the native write committed: " + text.slice(0, 80));
		if (!this.begun && !gating.getStore()) {
			if (text.startsWith(FINAL) || text.startsWith(READ)) this.unlocked = true;
			else await this.lock();
		}
		return this.sent(run);
	}
	private async sent<R>(run: () => Promise<R>) {
		try {
			return await run();
		} catch (error) {
			this.failed = true;
			throw error;
		}
	}

	lock(): Promise<void> {
		this.locking ??= gating.run(true, async () => {
			await this.sent(() => (this.send as (c: string) => Promise<unknown>)("BEGIN"));
			this.begun = true;
			if (!(await this.authority.bind(this.transaction, this.selected))) throw new WriteUnavailable();
		});
		return this.locking;
	}

	async check(read: SQL, lock: SQL): Promise<Record<string, unknown>[] | null> {
		if (this.begun || this.path !== "single") return null;
		const result = await this.transaction.execute(
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
		const authority = this.begun ? null : boundWrite(this.transaction);
		const allowed = authority
			? sql`(SELECT allowed FROM evf_auth)`
			: request
				? writeVisibility(request.actorId, request.owner)
				: sql`true`;
		const current = this.checks.length
			? sql.join(
					this.checks.map((c) => sql`${digestOf(sql`${c.read} ${c.lock} NOWAIT`)}=${c.digest}`),
					sql` AND `,
				)
			: sql`true`;
		const entries = [...(authority ? [writeAuthority(authority)] : []), writeEntries(writes)];
		await this.transaction.execute(
			sql`${sql.raw(FINAL)}WITH ${sql.join(entries, sql`, `)} SELECT (CASE WHEN ${allowed} IS NOT TRUE THEN 'evf_refused'
 WHEN ${current} THEN 'true' ELSE 'evf_stale' END)::boolean AS allowed`,
		);
		if (!this.begun) this.done = true;
	}
}

export function checkedRead(tx: WriteTx, read: SQL, lock: SQL) {
	const native = tx.write.native;
	return native?.kind === "first" ? native.session.check(read, lock) : Promise.resolve(null);
}

export async function lockedWrite(tx: WriteTx) {
	const native = tx.write.native;
	if (native?.kind === "stored") native.run.miss(false);
	if (native?.kind === "first") await native.session.lock();
	return requestWrite(tx);
}
