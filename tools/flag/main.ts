import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { closeDatabase, createDatabase } from "../../packages/db/src/client.ts";
import { checkCommand } from "./check.ts";
import { DB_COMMANDS, FlagError, HELP, runFlag, type Evf } from "./flag.ts";
import { resolveTarget, type Neon } from "./target.ts";

const spawn = (command: string) => (args: readonly string[]) => {
	const r = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

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
		const db = createDatabase({ connectionString: target.url, max: 2 });
		try {
			await runFlag(args, {
				db,
				target: target.label,
				evf: tools.evf,
				out: (line) => console.log(line),
				err: (line) => console.error(line),
				ci,
			});
		} finally {
			await closeDatabase(db);
		}
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
