import { createDatabase, closeDatabase } from "../../packages/db/src/client.ts";
import { sql } from "../../packages/db/src/query.ts";
import { migrate as applyMigrations } from "../../packages/db/src/schema/migrate.ts";
import { assertDevelopmentDatabase, developmentHosts } from "../../packages/db/src/development.ts";
import { randomBytes, randomUUID } from "node:crypto";

export type Database = ReturnType<typeof createDatabase>;

export type Capability = "runtime" | "auth" | "cleanup";

export function testDatabaseUrl(): URL {
	const refused = Error("Approved shared development database or disposable CI database required");
	let source: URL;
	try {
		source = assertDevelopmentDatabase(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
	} catch {
		throw refused;
	}
	const ci = !developmentHosts.has(source.hostname);
	if (ci && source.pathname !== "/everyfield_ci") throw refused;
	if (!ci) source.searchParams.set("sslmode", "verify-full");
	return source;
}

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
	await admin.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(7341097)`);
		await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS ${identifier(name)} CASCADE`));
	});
}

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

export function loginUrl(source: URL, name: string, password: string, schema?: string): URL {
	const url = new URL(source);
	url.username = name;
	url.password = password;
	if (schema) url.searchParams.set("options", searchPath(schema));
	return url;
}

export type Login = { name: string; password: string; url: URL };

export type TestDatabase<Role extends string> = {
	schema: string;
	admin: Database;
	pools: Record<Role, Database>;
	logins: Record<Role, Login>;
	connect(role: Role | "admin", settings?: { max?: number; options?: string; schema?: string }): Database;
	createSchema(name: string): Promise<string>;
	close(): Promise<void>;
};

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
