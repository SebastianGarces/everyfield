import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../packages/db/src/query.ts";
import { testDatabase, type Capability, type Database, type TestDatabase } from "./test-database.mts";

type Result = { status: string; value?: unknown; error?: { code?: string; details?: unknown } };

export function ok(result: any): any {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
}

export function refused(result: any, code = "unavailable"): any {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
}

export function refusedWith({ details, hidden = [] }: { details?: unknown; hidden?: readonly string[] }) {
	return (result: Result, code = "unavailable"): any => {
		const error = refused(result, code);
		if (details !== undefined) assert.deepEqual(error.details, details);
		const text = JSON.stringify(error);
		for (const secret of hidden) assert.equal(text.includes(secret), false, text);
		return error;
	};
}

export async function waitingOnLock(
	pool: Database,
	{
		pids,
		blockedBy,
		count = 1,
		signal,
	}: { pids?: readonly (number | undefined)[]; blockedBy?: number; count?: number; signal?: AbortSignal } = {},
) {
	for (let poll = 0; poll < 50_000; poll++) {
		if (signal?.aborted) return false;
		const watched = pids
			? sql`a.pid=ANY(${`{${pids.filter((pid) => pid !== undefined).join(",")}}`}::int[])`
			: blockedBy === undefined
				? sql`a.usename=current_user`
				: sql`true`;
		const waiting =
			blockedBy === undefined ? sql`a.wait_event_type='Lock'` : sql`${blockedBy}::int=ANY(pg_blocking_pids(a.pid))`;
		const r = await pool.execute(
			sql`SELECT count(*)::int AS n FROM pg_stat_activity a WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() AND ${watched} AND ${waiting}`,
		);
		if ((r.rows[0] as { n: number }).n >= count) return true;
	}
	throw Error("the rival transaction never waited for a lock");
}

export type Workspace =
	| { kind: "plant"; id: string }
	| { kind: "organization"; id: string; organizationKind: "sending_church" | "sending_network" };

export type Actor = {
	id: string;
	user: string;
	session: string;
	email: string;
	selected: Workspace | { kind: "account"; id: string };
};

type Row = Record<string, unknown>;
const COLUMN = /^[a-z_]+$/;
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

export function seeds(admin: Database) {
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
		tenant: Workspace & { kind: "plant" };
		actors: Record<"owner" | "admin" | "member", Actor>;
	};

export async function fixture({
	plant: columns,
	...options
}: {
	prefix: string;
	max?: number;
	plant?: Row;
	roles?: { runtime: readonly Capability[] } & Record<string, readonly Capability[]>;
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
