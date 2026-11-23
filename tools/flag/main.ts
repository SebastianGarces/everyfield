import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { closeDatabase, createDatabase, type Transaction } from "../../packages/db/src/client.ts";
import { checkCommand } from "./check.ts";
import { DB_COMMANDS, FlagError, HELP, runFlag, type Evf } from "./flag.ts";
import { sql } from "../../packages/db/src/query.ts";
import { READER_ENV, resolveTarget, type Neon, type Target } from "./target.ts";

const spawn = (command: string) => (args: readonly string[]) => {
	const r = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

type Connected = Exclude<Target, { missing: true }>;
type Handle = Pick<Transaction, "execute">;

export async function withTarget<T>(target: Connected, run: (db: Handle) => Promise<T>): Promise<T> {
	const db = createDatabase({ connectionString: target.url, max: 2 });
	try {
		if (!target.readOnly) return await run(db);
		return await db.transaction(
			async (tx) => {
				const { rows } = await tx.execute(sql`SELECT current_setting('default_transaction_read_only') AS read_only`);
				if ((rows[0] as { read_only?: string } | undefined)?.read_only !== "on")
					throw new FlagError(
						`The ${READER_ENV} login does not default to read-only sessions. Run ALTER ROLE <login> SET default_transaction_read_only = on (docs/runbooks/release.md). Nothing read.`,
					);
				return run(tx);
			},
			{ accessMode: "read only" },
		);
	} finally {
		await closeDatabase(db);
	}
}

export async function main(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>> = process.env,
	tools: { evf: Evf; neon: Neon } = { evf: spawn("evf"), neon: spawn("neonctl") },
): Promise<number> {
	const command = argv[0];
	if (!command || command === "help" || command === "--help") {
		console.log(HELP);
		return 0;
	}
	if (command === "check" && argv.length === 1) return checkCommand(resolve(import.meta.dirname, "../.."));
	if (!DB_COMMANDS.has(command)) {
		console.error(`Unknown command: flag ${argv.join(" ")}\n\n${HELP}`);
		return 2;
	}
	const ci = Boolean(env.CI);
	try {
		const { args, target } = resolveTarget(argv, env, tools.neon);
		if ("missing" in target) {
			if (ci && command === "stale" && !args.includes("--file")) {
				console.log(`bin/flag stale: skipped, ${target.label}. Nothing to list until the cutover gives CI one.`);
				return 0;
			}
			throw new FlagError(`bin/flag needs a database: ${target.label}.`);
		}
		await withTarget(target, (db) =>
			runFlag(args, {
				db,
				target: target.label,
				evf: tools.evf,
				out: (line) => console.log(line),
				err: (line) => console.error(line),
				ci,
			}),
		);
		return 0;
	} catch (error) {
		if ((error as { cause?: { code?: string } }).cause?.code === "42P01") {
			console.error("bin/flag: that database has no feature_flag table yet. Migrate it (corepack pnpm db:migrate).");
			return 1;
		}
		if (!(error instanceof FlagError)) throw error;
		console.error(`bin/flag: ${error.message}`);
		return error.code;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
