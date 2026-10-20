// The one seeded environment every tests/ui seed shares. A preview reads one apps/web/.env.local, so every seed writes
// into the same isolated schema on the shared development database, with one pair of login roles and one set of identity
// keys. The first seed creates the schema, applies every migration and writes the env file (git-ignored, mode 0600);
// later seeds read it back and add their own data. Each seed writes its own fixture; `dropSeed` deletes that fixture and
// drops the schema, roles and env file once no other seed's fixture still uses the schema. It refuses any database host
// other than the shared development database.
import { createDatabase, closeDatabase, type Database } from "../../packages/db/src/client.ts";
import { sql } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../packages/db/src/schema/migrate.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixturePath } from "./setup.mjs";

const ENV_FILE = fileURLToPath(new URL("../../apps/web/.env.local", import.meta.url));
/** Every seed that writes a fixture. The position gives each seed its own loopback block for admission limits. */
export const SEEDS = ["people", "invitation"] as const;
export type SeedName = (typeof SEEDS)[number];
const SCHEMA = /^ui_[a-f0-9]{16}$/;
const ROLE = /^ui_[a-f0-9]{12}(_auth)?$/;

type Saved = {
	schema: string;
	role: string;
	authRole: string;
	password: string;
	origin: string;
	secret: string;
	mailKey: string;
	addressKey: string;
};

export type SeedEnvironment = Omit<Saved, "mailKey" | "addressKey"> & {
	mailKey: Buffer;
	addressKey: Buffer;
	/** True when this call created the schema. */
	fresh: boolean;
	admin: Database;
	runtime: Database;
	authDb: Database;
	/** The n-th loopback address of this seed's own block, so two seeds never share an admission counter. */
	loopback(name: SeedName, n: number): string;
	close(): Promise<void>;
};

function adminUrl() {
	const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
	if (
		source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech" ||
		process.env.NODE_ENV === "production"
	)
		throw Error("Approved shared development database required");
	source.searchParams.set("sslmode", "verify-full");
	return source;
}

/** The environment a previous seed wrote, or null when there is none. Refuses an env file this module did not write. */
function readSaved(): Saved | null {
	if (!existsSync(ENV_FILE)) return null;
	const vars = Object.fromEntries(
		readFileSync(ENV_FILE, "utf8")
			.split("\n")
			.filter((line) => line.includes("="))
			.map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]),
	);
	const schema = /search_path=([^,]+)/.exec(
		new URL(vars.IDENTITY_DATABASE_URL ?? "about:blank").searchParams.get("options") ?? "",
	)?.[1];
	if (!schema || !SCHEMA.test(schema) || !vars.IDENTITY_SECRET)
		throw Error(`${ENV_FILE} is not a tests/ui seed environment. Move it aside before seeding.`);
	const runtime = new URL(vars.IDENTITY_DATABASE_URL!);
	return {
		schema,
		role: runtime.username,
		authRole: new URL(vars.IDENTITY_AUTH_DATABASE_URL!).username,
		password: runtime.password,
		origin: vars.IDENTITY_ORIGIN!,
		secret: vars.IDENTITY_SECRET,
		mailKey: vars.IDENTITY_MAIL_KEY!,
		addressKey: vars.IDENTITY_ADDRESS_KEY!,
	};
}

/** Opens the shared environment for `origin`, creating the schema, roles and env file on the first call. */
export async function openSeedEnvironment(origin: string): Promise<SeedEnvironment> {
	if (!/^https?:\/\/[a-z0-9.-]+\.localhost(:\d+)?$/.test(origin)) throw Error("Give the local preview URL");
	const source = adminUrl();
	const saved = readSaved();
	if (saved && saved.origin !== origin)
		throw Error(`${ENV_FILE} seeds ${saved.origin}. Run a seed's down first, or seed that preview.`);
	const role = "ui_" + randomBytes(6).toString("hex");
	const env: Saved = saved ?? {
		schema: "ui_" + randomUUID().replaceAll("-", "").slice(0, 16),
		role,
		authRole: role + "_auth",
		password: randomBytes(24).toString("hex"),
		origin,
		secret: randomBytes(32).toString("hex"),
		mailKey: randomBytes(32).toString("hex"),
		addressKey: randomBytes(32).toString("hex"),
	};
	const options = `-c search_path=${env.schema},pg_catalog,pg_temp`;
	const url = (name: string) => {
		const u = new URL(source);
		u.username = name;
		u.password = env.password;
		u.searchParams.set("options", options);
		return u.href;
	};
	if (!saved) {
		// The env file first, so a failed creation still leaves what `dropSeed` needs.
		writeFileSync(
			ENV_FILE,
			[
				`IDENTITY_DATABASE_URL=${url(env.role)}`,
				`IDENTITY_AUTH_DATABASE_URL=${url(env.authRole)}`,
				`IDENTITY_ORIGIN=${origin}`,
				`IDENTITY_SECRET=${env.secret}`,
				`IDENTITY_MAIL_KEY=${env.mailKey}`,
				`IDENTITY_ADDRESS_KEY=${env.addressKey}`,
				`IDENTITY_MAIL_FROM=security@example.test`,
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
	}
	const admin = createDatabase({ connectionString: source.href, max: 4, options });
	if (!saved) {
		await admin.execute(sql.raw(`CREATE SCHEMA ${env.schema}`));
		await migrate(admin, env.schema);
		for (const [name, grant] of [
			[env.role, "everyfield_runtime"],
			[env.authRole, "everyfield_auth"],
		] as const) {
			await admin.execute(
				sql.raw(
					`CREATE ROLE ${name} LOGIN INHERIT PASSWORD '${env.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
				),
			);
			await admin.execute(sql.raw(`GRANT ${grant} TO ${name}`));
		}
	}
	const runtime = createDatabase({ connectionString: url(env.role), max: 4 });
	const authDb = createDatabase({ connectionString: url(env.authRole), max: 4 });
	return {
		...env,
		mailKey: Buffer.from(env.mailKey, "hex"),
		addressKey: Buffer.from(env.addressKey, "hex"),
		fresh: !saved,
		admin,
		runtime,
		authDb,
		loopback: (name, n) => `127.0.${SEEDS.indexOf(name) + 1}.${n}`,
		async close() {
			await closeDatabase(runtime);
			await closeDatabase(authDb);
			await closeDatabase(admin);
		},
	};
}

/** Writes the fixture of seed `name`, stamped with the schema it belongs to. */
export function writeFixture(name: SeedName, schema: string, data: Record<string, unknown>): string {
	const path = fixturePath(name);
	writeFileSync(path, JSON.stringify({ schema, ...data }, null, "\t"), { mode: 0o600 });
	return path;
}

const fixtureSchema = (name: SeedName): string | null =>
	existsSync(fixturePath(name))
		? ((JSON.parse(readFileSync(fixturePath(name), "utf8")) as { schema?: string }).schema ?? null)
		: null;

/**
 * Deletes the fixture of seed `name`. When no other seed's fixture still uses the shared schema, drops the schema and
 * roles and deletes the env file.
 */
export async function dropSeed(name: SeedName): Promise<{ dropped: string | null; kept: string[] }> {
	rmSync(fixturePath(name), { force: true });
	const saved = readSaved();
	if (!saved) return { dropped: null, kept: [] };
	const kept = SEEDS.filter((other) => other !== name && fixtureSchema(other) === saved.schema);
	if (kept.length) return { dropped: null, kept };
	const admin = createDatabase({ connectionString: adminUrl().href, max: 1 });
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${saved.schema} CASCADE`));
		for (const r of [saved.role, saved.authRole])
			if (ROLE.test(r)) await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${r}`));
	} finally {
		await closeDatabase(admin);
	}
	rmSync(ENV_FILE, { force: true });
	return { dropped: saved.schema, kept: [] };
}
