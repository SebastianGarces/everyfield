// The one seed fixture for the DB tests. `fixture(options)` is `testDatabase(options)` (a migrated schema and its login
// roles) plus a tenant plant with an owner, an admin and a member actor, each with a live session. `seeds(admin)` adds
// more plants, organizations and actors for a test that needs a second tenant. `ok` and `refused` read a domain
// result, and `waitingOnLock` is the one wait a race test may use: it polls Postgres lock state, never a clock.
//
// Time in a DB test comes from the data, never from a sleep or the wall clock: set `eligible_at`, `expires_at` or
// `created_at` in the row, or wait on lock state with `waitingOnLock`. Seeds stamp times with the database clock, so a
// host clock that drifts from the database's cannot make a fresh seat or session look early or expired.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../packages/db/src/query.ts";
import { testDatabase, type Database, type TestDatabase } from "./test-database.mts";

/** A domain result: `{ status: "ok", value }` or `{ status: "refused", error }`. */
type Result = { status: string; value?: unknown; error?: { code?: string; details?: unknown } };

/** The value of an ok result; fails with the whole result otherwise. */
export function ok(result: any): any {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
}

/** The error of a refused result with `code`; fails otherwise. */
export function refused(result: any, code = "unavailable"): any {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
}

/**
 * `refused` with more checks on the error: `details` it must equal, and `hidden` strings it must never contain, for a
 * refusal that must not leak what it guards.
 */
export function refusedWith({ details, hidden = [] }: { details?: unknown; hidden?: readonly string[] }) {
	return (result: Result, code = "unavailable"): any => {
		const error = refused(result, code);
		if (details !== undefined) assert.deepEqual(error.details, details);
		const text = JSON.stringify(error);
		for (const secret of hidden) assert.equal(text.includes(secret), false, text);
		return error;
	};
}

/**
 * Resolves true once another session of `pool`'s login role waits for a lock. It polls `pg_stat_activity`, so the
 * wait ends on Postgres state, and fails after a bounded number of polls (not a deadline) if the rival never blocks.
 * An aborted `signal` stops the polling and resolves false, for a test that races a read against a lock wait.
 */
export async function waitingOnLock(pool: Database, { signal }: { signal?: AbortSignal } = {}) {
	for (let poll = 0; poll < 50_000; poll++) {
		if (signal?.aborted) return false;
		const r = await pool.execute(
			sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND pid<>pg_backend_pid()`,
		);
		if ((r.rows[0] as { n: number }).n > 0) return true;
	}
	throw Error("the rival transaction never waited for a lock");
}

export type Workspace =
	| { kind: "plant"; id: string }
	| { kind: "organization"; id: string; organizationKind: "sending_church" | "sending_network" };

export type Actor = {
	/** The account id. */
	id: string;
	user: string;
	/** A live session id. */
	session: string;
	email: string;
	/** The seat's workspace, or the account itself without one. */
	selected: Workspace | { kind: "account"; id: string };
};

type Row = Record<string, unknown>;
const COLUMN = /^[a-z_]+$/;
/** Inserts `row` into `table`; a value may be raw SQL such as the database clock. */
async function insert(admin: Database, table: string, row: Row) {
	const columns = Object.keys(row).filter((c) => row[c] !== undefined);
	for (const c of [table, ...columns]) if (!COLUMN.test(c)) throw Error(`Not a column: ${c}`);
	const values = columns.map((c) => {
		const v = row[c];
		return v && typeof v === "object" && "getSQL" in v ? (v as ReturnType<typeof sql>) : sql`${v}`;
	});
	await admin.execute(
		sql`INSERT INTO ${sql.raw(table)}(${sql.raw(columns.join(","))}) VALUES(${sql.join(values, sql`,`)})`,
	);
}

const now = sql`clock_timestamp()`;

/** Seed helpers bound to an admin pool. */
export function seeds(admin: Database) {
	/** A plant; `columns` overrides any plant column, `id` included. */
	async function plant(columns: Row = {}): Promise<Workspace & { kind: "plant" }> {
		const id = (columns.id as string | undefined) ?? randomUUID();
		await insert(admin, "plant", {
			name: "Synthetic",
			timezone: "America/Chicago",
			warning_days: 7,
			alert_days: 14,
			digest_weekday: 1,
			digest_hour: 8,
			phase: 1,
			material_revision: 1,
			...columns,
			id,
		});
		return { kind: "plant", id };
	}
	/** A sending church or network; `columns` overrides any organization column. */
	async function organization(
		kind: "sending_church" | "sending_network" = "sending_church",
		columns: Row = {},
	): Promise<Workspace & { kind: "organization" }> {
		const id = (columns.id as string | undefined) ?? randomUUID();
		await insert(admin, "organization", {
			kind,
			name: "Synthetic",
			timezone: "UTC",
			material_revision: 1,
			...columns,
			id,
		});
		return { kind: "organization", id, organizationKind: kind };
	}
	/**
	 * An account with a live session, seated on `workspace` as `role` when one is given. `account` and `user` override
	 * the account and auth user rows.
	 */
	async function actor(
		workspace?: Workspace | null,
		role: "owner" | "admin" | "member" = "owner",
		overrides: { id?: string; email?: string; account?: Row; user?: Row } = {},
	): Promise<Actor> {
		const id = overrides.id ?? randomUUID();
		const user = randomUUID();
		const session = randomUUID();
		const email = overrides.email ?? `${id}@example.test`;
		await insert(admin, "auth_user", { id: user, email, email_verified: true, name: "Synthetic", ...overrides.user });
		await insert(admin, "account", {
			id,
			auth_user_id: user,
			registration_state: "active",
			registration_kind: !workspace
				? "discovery"
				: workspace.kind === "plant"
					? "planter"
					: workspace.organizationKind === "sending_church"
						? "sending_church"
						: "network",
			...overrides.account,
		});
		await insert(admin, "auth_session", {
			id: session,
			user_id: user,
			token: randomBytes(32).toString("hex"),
			expires_at: sql`clock_timestamp()+interval '1 day'`,
		});
		if (workspace) await seat({ id }, workspace, role);
		return { id, user, session, email, selected: workspace ?? { kind: "account", id } };
	}
	/** Seats an existing account on `workspace`; returns the seat id. */
	async function seat(account: { id: string }, workspace: Workspace, role: "owner" | "admin" | "member" = "owner") {
		const id = randomUUID();
		await insert(admin, "seat", {
			account_id: account.id,
			plant_id: workspace.kind === "plant" ? workspace.id : null,
			organization_id: workspace.kind === "organization" ? workspace.id : null,
			role,
			accepted_at: now,
			id,
		});
		return id;
	}
	return { plant, organization, actor, seat };
}

type Fixture = TestDatabase<"runtime"> &
	ReturnType<typeof seeds> & {
		/** The tenant plant. */
		tenant: Workspace & { kind: "plant" };
		/** The plant's owner, admin and member, each with a live session. */
		actors: Record<"owner" | "admin" | "member", Actor>;
	};

/**
 * A migrated schema with one tenant plant and its owner, admin and member actors. `plant` overrides the tenant's
 * columns; the other options go to `testDatabase`.
 */
export async function fixture({
	plant: columns,
	...options
}: {
	prefix: string;
	max?: number;
	plant?: Row;
}): Promise<Fixture> {
	const database = await testDatabase(options);
	try {
		const seed = seeds(database.admin);
		const tenant = await seed.plant(columns);
		const actors = {
			owner: await seed.actor(tenant, "owner"),
			admin: await seed.actor(tenant, "admin"),
			member: await seed.actor(tenant, "member"),
		};
		return Object.assign(database, seed, { tenant, actors });
	} catch (error) {
		await database.close();
		throw error;
	}
}
