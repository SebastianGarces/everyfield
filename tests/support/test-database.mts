// The one place a test creates its throwaway database schema. `testDatabase({ prefix })` refuses any endpoint but the
// approved shared development database (direct endpoint, verify-full TLS) or CI's disposable local `everyfield_ci`
// (CI=true and EARLY_ACCESS_TEST_DATABASE=1), and never runs with NODE_ENV=production. It creates a random schema named
// from `prefix`, an admin pool pinned to it, one random login role per entry of `roles` (granted the named
// `everyfield_*` capabilities) with a pool each, applies every migration, and `close()` drops all of it.
import { createDatabase, closeDatabase } from "../../packages/db/src/client.ts";
import { sql } from "../../packages/db/src/query.ts";
import { migrate as applyMigrations } from "../../packages/db/src/schema/migrate.ts";
import { assertDevelopmentDatabase, developmentHosts } from "../../packages/db/src/development.ts";
import { randomBytes, randomUUID } from "node:crypto";

/** A pool as createDatabase returns it, with its client to close. */
export type Database = ReturnType<typeof createDatabase>;

/** The capabilities a test login role can hold, each the `everyfield_<name>` group role. */
export type Capability = "runtime" | "auth" | "cleanup";

/**
 * The guarded admin URL: the shared development database, or CI's `everyfield_ci` on localhost with CI=true and
 * EARLY_ACCESS_TEST_DATABASE=1. Throws for every other endpoint and under NODE_ENV=production.
 */
export function testDatabaseUrl(): URL {
	const refused = Error("Approved shared development database or disposable CI database required");
	let source: URL;
	try {
		source = assertDevelopmentDatabase(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
	} catch {
		throw refused;
	}
	// The guard accepts a localhost URL only under CI's flags; this helper also wants CI's own database by name.
	const ci = !developmentHosts.has(source.hostname);
	if (ci && source.pathname !== "/everyfield_ci") throw refused;
	if (!ci) source.searchParams.set("sslmode", "verify-full");
	return source;
}

/** The connection option that pins a pool to `schema`. */
export const searchPath = (schema: string) => `-c search_path=${schema},pg_catalog,pg_temp`;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const identifier = (name: string) => {
	if (!IDENTIFIER.test(name)) throw Error(`Not a test identifier: ${name}`);
	return name;
};

export async function createSchema(admin: Database, name: string) {
	await admin.execute(sql.raw(`CREATE SCHEMA ${identifier(name)}`));
}

export async function dropSchema(admin: Database, name: string) {
	await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${identifier(name)} CASCADE`));
}

/**
 * Moves the database clock that `schema`'s queries read to `at`'s frame, still advancing: schema-local `now()`,
 * `transaction_timestamp()`, `statement_timestamp()` and `clock_timestamp()` add a fixed shift to pg_catalog's, and
 * shadow them because every pool's search_path puts the schema ahead of pg_catalog. Installed before the migrations,
 * so column defaults and `SET search_path FROM CURRENT` functions read it too. The SQL keywords (CURRENT_TIMESTAMP,
 * CURRENT_DATE, LOCALTIMESTAMP) and `pg_catalog.`-qualified calls still read the real clock.
 */
export async function pinSchemaClock(admin: Database, schema: string, at: Date) {
	const name = identifier(schema);
	const { rows } = await admin.execute<{ shift: string }>(
		sql`SELECT (${at.toISOString()}::timestamptz - pg_catalog.clock_timestamp())::text AS shift`,
	);
	const shift = rows[0]!.shift;
	for (const [fn, volatility] of [
		["clock_timestamp", "VOLATILE"],
		["statement_timestamp", "STABLE"],
		["transaction_timestamp", "STABLE"],
		["now", "STABLE"],
	])
		await admin.execute(
			sql.raw(`CREATE FUNCTION ${name}.${fn}() RETURNS timestamptz LANGUAGE sql ${volatility} PARALLEL SAFE
				AS $$ SELECT pg_catalog.${fn}() + '${shift}'::interval $$`),
		);
}

/** A login role with no privileges of its own, granted the given `everyfield_*` capabilities. */
export async function createLoginRole(
	admin: Database,
	name: string,
	password: string,
	capabilities: readonly Capability[],
) {
	if (!/^[a-f0-9]+$/.test(password)) throw Error("A test role password is hex");
	await admin.execute(
		sql.raw(
			`CREATE ROLE ${identifier(name)} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
		),
	);
	for (const capability of capabilities) await admin.execute(sql.raw(`GRANT everyfield_${capability} TO ${name}`));
}

export async function dropRole(admin: Database, name: string) {
	await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${identifier(name)}`));
}

/** `source` signed in as `name`. With `schema`, the URL itself carries the search_path, as an app env file needs. */
export function loginUrl(source: URL, name: string, password: string, schema?: string): URL {
	const url = new URL(source);
	url.username = name;
	url.password = password;
	if (schema) url.searchParams.set("options", searchPath(schema));
	return url;
}

export type Login = { name: string; password: string; /** Carries the search_path, for an app's env. */ url: URL };

export type TestDatabase<Role extends string> = {
	schema: string;
	/** The admin (owner) pool, pinned to `schema`. */
	admin: Database;
	/** One pool per role, pinned to `schema`. */
	pools: Record<Role, Database>;
	logins: Record<Role, Login>;
	/** Another pool for `role` (or the admin with "admin"), closed with the database. `options` adds to the search_path. */
	connect(role: Role | "admin", settings?: { max?: number; options?: string; schema?: string }): Database;
	/** Creates another schema, dropped with the database. */
	createSchema(name: string): Promise<string>;
	close(): Promise<void>;
};

/**
 * A fresh, migrated schema with its login roles. `roles` maps a name to its capabilities (default: one `runtime`
 * role); `migrate: false` leaves the schema empty for a suite that applies migrations itself. `schema` names the schema
 * instead of `prefix`, for a command that accepts only one shape of name. `clock` pins the schema's database clock to
 * that instant's frame (`pinSchemaClock`).
 */
export async function testDatabase<Role extends string = "runtime">({
	prefix,
	roles = { runtime: ["runtime"] } as unknown as Record<Role, readonly Capability[]>,
	migrate = true,
	max = 4,
	schema: name,
	clock,
}: {
	prefix: string;
	roles?: Record<Role, readonly Capability[]>;
	migrate?: boolean;
	max?: number;
	schema?: string;
	clock?: Date;
}): Promise<TestDatabase<Role>> {
	const source = testDatabaseUrl();
	const schema = identifier(name ?? `${prefix}_${randomUUID().replaceAll("-", "")}`);
	const admin = createDatabase({ connectionString: source.href, max, options: searchPath(schema) });
	const schemas = [schema];
	const roleNames: string[] = [];
	const extra: Database[] = [];
	const logins = {} as Record<Role, Login>;
	const pools = {} as Record<Role, Database>;
	const connect: TestDatabase<Role>["connect"] = (role, settings = {}) => {
		const options = [searchPath(settings.schema ?? schema), settings.options].filter(Boolean).join(" ");
		const connectionString =
			role === "admin" ? source.href : loginUrl(source, logins[role].name, logins[role].password).href;
		const pool = createDatabase({ connectionString, max: settings.max ?? max, options });
		extra.push(pool);
		return pool;
	};
	async function close() {
		await Promise.all([...Object.values<Database>(pools), ...extra].map((pool) => closeDatabase(pool)));
		try {
			for (const name of schemas) await dropSchema(admin, name);
			for (const name of roleNames) await dropRole(admin, name);
		} finally {
			await closeDatabase(admin);
		}
	}
	try {
		await createSchema(admin, schema);
		if (clock) await pinSchemaClock(admin, schema, clock);
		if (migrate) await applyMigrations(admin, schema);
		for (const [role, capabilities] of Object.entries(roles) as [Role, readonly Capability[]][]) {
			const name = identifier(`${prefix}_${randomBytes(8).toString("hex")}`);
			const password = randomBytes(32).toString("hex");
			roleNames.push(name);
			await createLoginRole(admin, name, password, capabilities);
			logins[role] = { name, password, url: loginUrl(source, name, password, schema) };
			pools[role] = createDatabase({
				connectionString: loginUrl(source, name, password).href,
				max,
				options: searchPath(schema),
			});
		}
	} catch (error) {
		await close();
		throw error;
	}
	return {
		schema,
		admin,
		pools,
		logins,
		connect,
		async createSchema(name) {
			schemas.push(identifier(name));
			await createSchema(admin, name);
			return name;
		},
		close,
	};
}
