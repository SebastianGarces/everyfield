import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { ownerLabels, PREFIX } from "../containers.ts";

export const source = resolve(import.meta.dirname, "../../..");

export function tsxRun(args: string[], env: Record<string, string | undefined>) {
	const clean: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: undefined, DATABASE_URL: undefined, ...env };
	for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
	const tsx = join(source, "packages/domain/node_modules/.bin/tsx");
	return spawnSync(tsx, ["--conditions=react-server", ...args], { cwd: source, encoding: "utf8", env: clean });
}
export const MAIL_KEYS = {
	IDENTITY_MAIL_KEY: "1a".repeat(32),
	IDENTITY_ADDRESS_KEY: "2b".repeat(32),
} as const;
export const runSeed = (env: Record<string, string | undefined>) => tsxRun(["tools/qa/qa-seed.ts"], env);

export type QuietDatabase = { container: string; adminUrl: string };

const IMAGE = "pgvector/pgvector:0.8.7-pg18";
const DATABASE = "everyfield_qa_test";

function docker(...args: string[]): string {
	const r = spawnSync("docker", args, { encoding: "utf8" });
	if (r.error) throw new Error(`The QA tests need Docker: ${r.error.message}`);
	if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
	return r.stdout.trim();
}

const live = new Set<string>();
process.on("exit", () => live.forEach((container) => stopQuietDatabase({ container })));

function removeWhenThisProcessEnds(container: string) {
	live.add(container);
	const reap = 'cat >/dev/null; exec docker rm -f -v "$1" >/dev/null 2>&1';
	const watcher = spawn("sh", ["-c", reap, "qa-test-reaper", container], {
		detached: true,
		stdio: ["pipe", "ignore", "ignore"],
	});
	watcher.unref();
	(watcher.stdin as Socket).unref();
}

export function startQuietDatabase(checkout: string, tag: string): QuietDatabase {
	const container = `${PREFIX}${tag}-${randomBytes(3).toString("hex")}`,
		password = randomBytes(18).toString("hex");
	removeWhenThisProcessEnds(container);
	docker(
		"run",
		"-d",
		"--rm",
		...ownerLabels(),
		"--name",
		container,
		"-e",
		"POSTGRES_USER=qa",
		"-e",
		`POSTGRES_PASSWORD=${password}`,
		"-e",
		`POSTGRES_DB=${DATABASE}`,
		"-p",
		"127.0.0.1::5432",
		IMAGE,
	);
	try {
		const ready = () =>
			spawnSync("docker", ["exec", container, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "qa", "-d", DATABASE]);
		for (let waited = 0; ready().status !== 0; waited += 500) {
			if (waited > 60_000) throw new Error("The quiet database did not accept connections within 60 s.");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
		}
		const port = docker("port", container, "5432/tcp").split("\n")[0]!.split(":").pop();
		const adminUrl = `postgres://qa:${password}@127.0.0.1:${port}/${DATABASE}`;
		const migrated = spawnSync("corepack", ["pnpm", "db:migrate"], {
			cwd: checkout,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
				DATABASE_URL: adminUrl,
				DATABASE_URL_UNPOOLED: adminUrl,
			},
		});
		if (migrated.status !== 0)
			throw new Error(`db:migrate failed on the quiet database:\n${(migrated.stderr || migrated.stdout).trim()}`);
		return { container, adminUrl };
	} catch (error) {
		stopQuietDatabase({ container });
		throw error;
	}
}

export function stopQuietDatabase(db: Pick<QuietDatabase, "container">): void {
	spawnSync("docker", ["rm", "-f", "-v", db.container]);
	live.delete(db.container);
}
