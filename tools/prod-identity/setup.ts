import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, parseEnv } from "node:util";
import { mailEnv } from "../../apps/web/src/server/mail-env.ts";
import { PROD_ENDPOINT, Redactor, roleUrl } from "../qa/qa-guard.ts";

export const ADMIN_ENV = "PROD_IDENTITY_ADMIN_URL";
export const VERCEL_TARGET = { project: "everyfield", scope: "sebastian-garces-projects-335a0259" } as const;
export const DEFAULT_OUT = join(homedir(), ".everyfield", "prod-identity", "vercel-production.sh");

export const LOGINS = [
	{ name: "everyfield_prod_runtime", group: "everyfield_runtime", setting: "IDENTITY_DATABASE_URL", pooled: false },
	{ name: "everyfield_prod_auth", group: "everyfield_auth", setting: "IDENTITY_AUTH_DATABASE_URL", pooled: true },
	{
		name: "everyfield_prod_cleanup",
		group: "everyfield_cleanup",
		setting: "LIFECYCLE_CLEANUP_DATABASE_URL",
		pooled: false,
	},
] as const;
export type Login = (typeof LOGINS)[number];

const hex32 = () => randomBytes(32).toString("hex");
export const KEYS = {
	IDENTITY_SECRET: hex32,
	IDENTITY_MAIL_KEY: hex32,
	IDENTITY_ADDRESS_KEY: hex32,
	NOTIFICATION_OPT_OUT_KEYS: () => randomBytes(32).toString("base64"),
	CRON_SECRET: hex32,
} as const;
export type KeyName = keyof typeof KEYS;
const KEY_SHAPE: Record<KeyName, string> = {
	IDENTITY_SECRET: "64 hex",
	IDENTITY_MAIL_KEY: "64 hex",
	IDENTITY_ADDRESS_KEY: "64 hex",
	NOTIFICATION_OPT_OUT_KEYS: "one base64 key of 32 bytes",
	CRON_SECRET: "64 hex",
};
export const generateKeys = (): Record<KeyName, string> =>
	Object.fromEntries(Object.entries(KEYS).map(([name, make]) => [name, make()])) as Record<KeyName, string>;

export const BY_HAND: Readonly<Record<string, string>> = {
	DATABASE_URL: "the operator connection, for migrations (Neon's Vercel integration sets it)",
	DATABASE_URL_UNPOOLED: "the operator's direct connection (Neon's Vercel integration sets it)",
	IDENTITY_MAIL_FROM: "the product mail sender address",
	RESEND_API_KEY: "Resend send permission",
	RESEND_WEBHOOK_SECRET: "verifies Resend delivery webhooks",
	EMAIL_FROM: "the early access mail sender",
	EARLY_ACCESS_EMAIL_TO: "the early access inbox",
	EARLY_ACCESS_EMAIL_SUBJECT_PREFIX: "optional early access subject prefix",
	FEEDBACK_OPERATOR_EMAIL: "the operator inbox for product feedback",
	FEEDBACK_GITHUB_REPOSITORY: "public feedback issues: the repository name",
	FEEDBACK_GITHUB_REPOSITORY_ID: "public feedback issues: the repository id",
	FEEDBACK_GITHUB_TOKEN: "public feedback issues: the GitHub token",
	FEEDBACK_GITHUB_API: "optional GitHub API base URL",
	AWS_BUCKET_NAME: 'private file storage: the production bucket "everyfield"',
	AWS_ACCESS_KEY_ID: "private file storage",
	AWS_SECRET_ACCESS_KEY: "private file storage",
	AWS_ENDPOINT_URL_S3: "private file storage",
	AWS_REGION: 'optional, defaults to "auto"',
	EVRY_MODEL: "the approved paid Evry model",
	OPENAI_API_KEY: "the paid Evry model's key",
	EVRY_MONTHLY_CAP_USD: "optional Evry monthly spend cap (default 20)",
	LANGFUSE_PUBLIC_KEY: "optional Evry tracing",
	LANGFUSE_SECRET_KEY: "optional Evry tracing",
	LANGFUSE_BASE_URL: "optional Evry tracing",
	LANGFUSE_TRACING_ENVIRONMENT: "optional Evry tracing",
};
const SHAPES = {
	IDENTITY_MAIL_FROM: { rule: mailEnv.IDENTITY_MAIL_FROM, shape: "a bare address such as mail@example.com" },
} as const;
export type Shape = { name: string; state: "right shape" | "cannot check" | `wrong shape: ${string}` };

function shapes(production: Set<string> | null, values: ReadonlyMap<string, string> | null): Shape[] {
	return Object.entries(SHAPES)
		.filter(([name]) => production?.has(name))
		.map(([name, { rule, shape }]) => {
			const value = values?.get(name);
			if (!value) return { name, state: "cannot check" };
			return { name, state: rule.safeParse(value).success ? "right shape" : `wrong shape: ${shape}` };
		});
}

export const NOT_IN_PRODUCTION = [
	"EMAIL_TEST_RECIPIENTS",
	"PLATFORM_PROOF_SECRET",
	"EVERYFIELD_DEV_OUTBOX",
	"EVRY_SCRIPTED_MODEL",
];

export type Role = {
	name: string;
	canLogin: boolean;
	unsafe: string[];
	groups: string[];
};
export type Observed = {
	roles: Map<string, Role>;
	production: Set<string> | null;
	preview: Set<string> | null;
	shapes: Shape[];
};
export type LoginStep = { login: Login; action: "create" | "keep" | "rotate"; granted: boolean; force: boolean };
export type Plan = {
	logins: LoginStep[];
	keys: { name: KeyName | "IDENTITY_ORIGIN"; generate: boolean }[];
	refusals: string[];
	report: { name: string; state: string }[];
};

export function plan(seen: Observed, rotate: boolean): Plan {
	const refusals: string[] = [];
	if (!seen.production) refusals.push("Vercel Production's setting names could not be read (is `vercel` logged in?).");
	const inProduction = (name: string) => seen.production?.has(name) ?? false;
	const logins = LOGINS.map((login): LoginStep => {
		if (!seen.roles.has(login.group)) refusals.push(`${login.group} does not exist: migrate this database first.`);
		const role = seen.roles.get(login.name);
		const granted = role?.groups.includes(login.group) ?? false;
		const force = inProduction(login.setting);
		if (!role) return { login, action: "create", granted, force };
		if (role.unsafe.length)
			refusals.push(`${login.name} exists with ${role.unsafe.join(", ")}. Fix or drop it by hand, then rerun.`);
		if (!role.canLogin)
			refusals.push(`${login.name} exists but cannot log in. Drop it, or ALTER ROLE ${login.name} LOGIN, then rerun.`);
		if (rotate) return { login, action: "rotate", granted, force };
		if (seen.production && !force)
			refusals.push(
				`${login.name} exists but Vercel Production has no ${login.setting}, and its password cannot be read back. Rerun with --rotate-passwords to give it a new one.`,
			);
		return { login, action: "keep", granted, force };
	});
	for (const s of seen.shapes)
		if (s.state.startsWith("wrong shape"))
			refusals.push(`${s.name} in Vercel Production is the ${s.state}. Set it again with --force, then rerun.`);
	const keys = (["IDENTITY_ORIGIN", ...Object.keys(KEYS)] as (KeyName | "IDENTITY_ORIGIN")[]).map((name) => ({
		name,
		generate: !inProduction(name),
	}));
	const present = (name: string) =>
		seen.production ? (seen.production.has(name) ? "already present" : null) : "unknown";
	const report = [
		...logins.map((s) => ({
			name: s.login.setting,
			state: s.action === "keep" ? "already present" : `generated by this script (${s.action} ${s.login.name})`,
		})),
		...keys.map((k) => ({ name: k.name, state: k.generate ? "generated by this script" : "already present" })),
		...Object.entries(BY_HAND).map(([name, why]) => ({ name, state: present(name) ?? `set by hand: ${why}` })),
		...[...(seen.preview ?? [])]
			.filter((name) => !(name in BY_HAND) && !NOT_IN_PRODUCTION.includes(name) && !reportedByScript(name))
			.sort()
			.map((name) => ({
				name,
				state: present(name) ?? "set by hand: Preview has it; check whether production needs it",
			})),
		...NOT_IN_PRODUCTION.map((name) => ({
			name,
			state: inProduction(name) ? "PRESENT, but production must leave it unset" : "leave unset in production",
		})),
	];
	return { logins, keys, refusals, report };
}

const reportedByScript = (name: string) =>
	name in KEYS || name === "IDENTITY_ORIGIN" || LOGINS.some((l) => l.setting === name);

export function target(adminUrl: string): { direct: string; pooled: string; endpoint: string; database: string } {
	const u = new URL(adminUrl);
	if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error(`${ADMIN_ENV} is not a postgres:// URL.`);
	const [first, ...rest] = u.hostname.split(".");
	const endpoint = first!.replace(/-pooler$/, "");
	const neon = u.hostname.endsWith(".neon.tech");
	const at = (host: string) => Object.assign(new URL(u.href), { hostname: host }).href;
	return {
		direct: neon ? at([endpoint, ...rest].join(".")) : u.href,
		pooled: neon ? at([`${endpoint}-pooler`, ...rest].join(".")) : u.href,
		endpoint: neon ? endpoint : u.hostname,
		database: decodeURIComponent(u.pathname.slice(1)),
	};
}

export function parseOrigin(raw: string | undefined): string | Error {
	if (!raw) return new Error("--origin is required: the production origin, e.g. --origin https://everyfield.app");
	try {
		const u = new URL(raw);
		if (u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash && !u.username) return u.origin;
	} catch {}
	return new Error(`--origin must be an https origin with no path, e.g. https://everyfield.app (got ${raw}).`);
}

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function commandsFile(
	settings: { name: string; value: string; force: boolean }[],
	endpoint: string,
	path: string,
) {
	const lines = settings.map(({ name, value, force }) =>
		[
			`printf '%s' ${shellQuote(value)} |`,
			`vercel env add ${name} --environment production`,
			`--project ${VERCEL_TARGET.project} --scope ${VERCEL_TARGET.scope}`,
			name === "IDENTITY_ORIGIN" ? "--no-sensitive" : "--sensitive",
			"--yes",
			...(force ? ["--force"] : []),
		].join(" "),
	);
	return [
		"#!/bin/sh",
		`# Written by tools/prod-identity/setup.ts on ${new Date().toISOString()} for endpoint ${endpoint}.`,
		"# It holds production secrets: run it once with sh, then delete it. Never copy it into the repository.",
		"set -e",
		...lines,
		`echo "Added ${settings.length} settings to Vercel Production. Now delete this file: rm ${shellQuote(path)}"`,
		"",
	].join("\n");
}

type PgClient = {
	connect(): Promise<unknown>;
	query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
	end(): Promise<void>;
};
const ROOT = resolve(import.meta.dirname, "../..");
const pg = createRequire(join(ROOT, "packages/db/package.json"))("pg") as {
	Client: new (c: { connectionString: string; options?: string; connectionTimeoutMillis?: number }) => PgClient;
};

async function withClient<T>(url: string, options: string | undefined, use: (c: PgClient) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: url, options, connectionTimeoutMillis: 15_000 });
	await client.connect();
	try {
		return await use(client);
	} finally {
		await client.end();
	}
}

const READ_ONLY = "-c default_transaction_read_only=on";

async function observeRoles(direct: string): Promise<Map<string, Role>> {
	const names = LOGINS.flatMap((l) => [l.name, l.group]);
	const rows = await withClient(direct, READ_ONLY, async (c) => {
		return (
			await c.query(
				`SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
				        coalesce(array_agg(g.rolname::text) FILTER (WHERE g.rolname IS NOT NULL), '{}'::text[]) AS groups
				   FROM pg_roles r LEFT JOIN pg_auth_members m ON m.member = r.oid LEFT JOIN pg_roles g ON g.oid = m.roleid
				  WHERE r.rolname = ANY($1) GROUP BY r.oid, r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb,
				        r.rolcreaterole, r.rolbypassrls`,
				[names],
			)
		).rows;
	});
	return new Map(
		rows.map((r) => [
			String(r.rolname),
			{
				name: String(r.rolname),
				canLogin: r.rolcanlogin === true,
				unsafe: (
					[
						["rolsuper", "SUPERUSER"],
						["rolcreatedb", "CREATEDB"],
						["rolcreaterole", "CREATEROLE"],
						["rolbypassrls", "BYPASSRLS"],
					] as const
				).flatMap(([col, label]) => (r[col] === true ? [label] : [])),
				groups: (r.groups as string[]) ?? [],
			},
		]),
	);
}

function vercelNames(environment: "production" | "preview"): Set<string> | null {
	const r = spawnSync(
		"vercel",
		["env", "ls", "--environment", environment, "--project", VERCEL_TARGET.project, "--scope", VERCEL_TARGET.scope],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (r.error || r.status !== 0) return null;
	const names = new Set<string>();
	for (const line of `${r.stdout}\n${r.stderr}`.split("\n")) {
		const m = /^\s*([A-Z][A-Z0-9_]*)\s/.exec(line);
		if (m && m[1]!.includes("_")) names.add(m[1]!);
	}
	return names;
}

function vercelValues(names: readonly string[]): Map<string, string> | null {
	if (!names.length) return new Map();
	const dir = mkdtempSync(join(tmpdir(), "prod-identity-"));
	const file = join(dir, "production.env");
	try {
		if (insideGitTree(file)) return null;
		const r = spawnSync(
			"vercel",
			[
				"env",
				"pull",
				file,
				"--environment",
				"production",
				"--yes",
				"--project",
				VERCEL_TARGET.project,
				"--scope",
				VERCEL_TARGET.scope,
			],
			{ cwd: dir, stdio: "ignore" },
		);
		if (r.error || r.status !== 0 || !existsSync(file)) return null;
		const pulled = parseEnv(readFileSync(file, "utf8"));
		return new Map(names.flatMap((name) => (pulled[name] ? [[name, pulled[name]] as const] : [])));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function insideGitTree(path: string): boolean {
	let dir = dirname(path);
	while (!existsSync(dir)) dir = dirname(dir);
	return (
		spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).stdout.trim() === "true"
	);
}

const HELP = `Usage: bin/prod-identity --origin <https origin> [--apply --confirm <endpoint>] [options]

One-time production identity setup (T-396). Reads the admin (database owner) connection string from the
${ADMIN_ENV} environment variable, never from a flag. Without --apply it is a dry run: a read-only
database session, a read of Vercel's setting names (vercel env ls) and a shape check of the hand-set settings
Vercel Production holds (vercel env pull into a temporary file it deletes), then the plan. It prints no value it reads.

  --origin <url>        Required. The production origin, set as IDENTITY_ORIGIN (e.g. https://everyfield.app).
  --apply               Create the three production logins, generate the missing keys and write the Vercel
                        commands file. Nothing writes without it.
  --confirm <endpoint>  The endpoint id the plan prints (e.g. ep-gentle-dust-...). Without it, --apply asks you to
                        type it, and refuses when it cannot ask.
  --rotate-passwords    Give existing logins new passwords and overwrite their Vercel URLs (--force). Keys are
                        never regenerated: remove a key from Vercel Production first to have it generated again.
  --out <path>          Where --apply writes the Vercel commands file, mode 0600, outside any git tree.
                        Default: ${DEFAULT_OUT}
  --help                Show this help.

Runbook: docs/runbooks/production-identity.md`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const redactor = new Redactor();
	const say = (line: string) => console.log(redactor.clean(line));
	try {
		const { values: opts } = parseArgs({
			args: argv,
			options: {
				origin: { type: "string" },
				apply: { type: "boolean", default: false },
				confirm: { type: "string" },
				"rotate-passwords": { type: "boolean", default: false },
				out: { type: "string" },
				help: { type: "boolean", default: false },
			},
			strict: true,
		});
		if (opts.help) {
			console.log(HELP);
			return 0;
		}
		const origin = parseOrigin(opts.origin);
		if (origin instanceof Error) throw origin;
		const admin = env[ADMIN_ENV]?.trim();
		if (!admin) throw new Error(`Set ${ADMIN_ENV} to the database owner's connection string (see the runbook).`);
		redactor.add(admin);
		const db = target(admin);
		redactor.add(new URL(admin).password, db.direct, db.pooled);
		const prod = db.endpoint.startsWith(PROD_ENDPOINT);
		say(
			`Target: endpoint ${db.endpoint}, database ${db.database}${prod ? " (the PRODUCTION endpoint)" : " (not the production endpoint)"}.`,
		);

		const production = vercelNames("production");
		const values = vercelValues(Object.keys(SHAPES).filter((name) => production?.has(name)));
		redactor.add(...(values?.values() ?? []));
		const seen: Observed = {
			roles: await observeRoles(db.direct),
			production,
			preview: vercelNames("preview"),
			shapes: shapes(production, values),
		};
		const rotate = opts["rotate-passwords"];
		const p = plan(seen, rotate);

		say("\nLogins:");
		for (const s of p.logins)
			say(
				`  ${s.login.name}: ${s.action === "keep" ? "keep (exists; password unchanged)" : s.action === "rotate" ? "new password (exists)" : "create"}, LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS, password ********`,
			);
		say("Grants:");
		for (const s of p.logins)
			say(`  GRANT ${s.login.group} TO ${s.login.name} (${s.granted ? "already granted; re-asserted" : "to grant"})`);
		say("Settings it writes for Vercel Production:");
		for (const s of p.logins)
			if (s.action !== "keep")
				say(
					`  ${s.login.setting}: ********, ${s.login.pooled ? "pooled" : "direct"} endpoint${s.force ? " (overwrites)" : ""}`,
				);
		for (const k of p.keys)
			if (k.generate) say(`  ${k.name}: ${k.name === "IDENTITY_ORIGIN" ? origin : `******** (${KEY_SHAPE[k.name]})`}`);
		say("\nEvery setting production needs:");
		const width = Math.max(...p.report.map((r) => r.name.length));
		for (const r of p.report) say(`  ${r.name.padEnd(width)}  ${r.state}`);
		if (seen.shapes.length) {
			say("\nShape of the hand-set settings Vercel Production has (values are never printed):");
			for (const s of seen.shapes) say(`  ${s.name.padEnd(width)}  ${s.state}`);
		}
		if (p.refusals.length)
			say(`\n${opts.apply ? "Refused" : "Apply would refuse"}:\n${p.refusals.map((r) => `  - ${r}`).join("\n")}`);

		if (!opts.apply) {
			say(`\nDry run: nothing changed. To write, rerun with --apply --confirm ${db.endpoint}.`);
			return 0;
		}
		if (p.refusals.length) return 1;

		const out = resolve(opts.out ?? DEFAULT_OUT);
		if (existsSync(out))
			throw new Error(
				`A commands file from an earlier run is waiting at ${out}. Run it (sh ${out}) or delete it, then rerun.`,
			);
		if (insideGitTree(out)) throw new Error(`--out ${out} is inside a git working tree; choose a path outside it.`);

		let confirmed = opts.confirm;
		if (confirmed === undefined && process.stdin.isTTY) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			confirmed = (await rl.question(`Type the endpoint id (${db.endpoint}) to write to it: `)).trim();
			rl.close();
		}
		if (confirmed !== db.endpoint) {
			say(
				`\nRefused: --apply writes only to the endpoint you confirm. Pass --confirm ${db.endpoint} or type it at the prompt. Nothing changed.`,
			);
			return 1;
		}

		const keys = generateKeys();
		const passwords = new Map(
			p.logins.filter((s) => s.action !== "keep").map((s) => [s.login.name, hex32() + hex32()]),
		);
		redactor.add(...Object.values(keys), ...passwords.values());
		const urlOf = (s: LoginStep) =>
			roleUrl(s.login.pooled ? db.pooled : db.direct, s.login.name, passwords.get(s.login.name)!);
		const settings = [
			...p.logins
				.filter((s) => s.action !== "keep")
				.map((s) => ({ name: s.login.setting, value: urlOf(s), force: s.force })),
			...p.keys
				.filter((k) => k.generate)
				.map((k) => ({ name: k.name, value: k.name === "IDENTITY_ORIGIN" ? origin : keys[k.name], force: false })),
		];

		let wrote = false;
		await withClient(db.direct, undefined, async (c) => {
			await c.query("BEGIN");
			try {
				for (const s of p.logins) {
					const password = passwords.get(s.login.name);
					if (s.action === "create")
						await c.query(
							`CREATE ROLE ${s.login.name} LOGIN INHERIT PASSWORD ${literal(password!)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
						);
					if (s.action === "rotate") await c.query(`ALTER ROLE ${s.login.name} PASSWORD ${literal(password!)}`);
					await c.query(`GRANT ${s.login.group} TO ${s.login.name}`);
				}
				if (settings.length) {
					mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
					writeFileSync(out, commandsFile(settings, db.endpoint, out), { mode: 0o600, flag: "wx" });
					wrote = true;
				}
				await c.query("COMMIT");
			} catch (error) {
				await c.query("ROLLBACK").catch(() => undefined);
				if (wrote) rmSync(out, { force: true });
				throw error;
			}
		});

		say("\nApplied. Logins and grants are in place.");
		for (const s of p.logins.filter((s) => s.action !== "keep")) {
			const options = s.login.pooled ? undefined : "-c statement_timeout=5s";
			const table = s.login.group === "everyfield_auth" ? "auth_user" : "tenant";
			await withClient(urlOf(s), options, (c) => c.query(`SELECT 1 FROM ${table} LIMIT 1`));
			say(`  ${s.login.setting} connects as ${s.login.name} and reads ${table}.`);
		}
		if (!settings.length) {
			say("Vercel Production already has every setting this script makes. No commands file written.");
			return 0;
		}
		say(`\nVercel commands for: ${settings.map((s) => s.name).join(", ")}`);
		say(`Written to ${out} (mode 0600). Run it with: sh ${shellQuote(out)}  Then delete it and redeploy production.`);
		return 0;
	} catch (error) {
		console.error(`prod-identity: ${redactor.clean(error instanceof Error ? error.message : String(error))}`);
		return 1;
	}
}

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
