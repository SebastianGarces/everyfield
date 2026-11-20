import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { Runner } from "./check.ts";

export const IMAGE = "pgvector/pgvector:0.8.7-pg18";
const DATABASE = "everyfield_ci";
const USER = "ci";
export const LABEL = "everyfield.check.checkout";

export type ThrowawayPostgres = { container: string; image: string; url: string; password: string };
export type PostgresOptions = {
	root: string;
	env: Record<string, string>;
	run: Runner;
	readyTimeoutMs: number;
	sleep: (ms: number) => void;
	watch: (container: string) => () => void;
	scope?: string;
};

export class DatabaseError extends Error {}

export const checkoutLabel = (root: string) => createHash("sha256").update(root).digest("hex").slice(0, 16);

export const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function watchProcess(container: string): () => void {
	const child = spawn(
		"sh",
		["-c", `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; docker rm -f -v ${container} >/dev/null 2>&1`],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
	return () => {
		try {
			process.kill(-child.pid!, "SIGTERM");
		} catch {}
	};
}

export const databaseEnv = (url: string) => ({
	DATABASE_URL: url,
	DATABASE_URL_UNPOOLED: url,
	EARLY_ACCESS_TEST_DATABASE: "1",
	CI: "true",
});

export function startPostgres(options: PostgresOptions): ThrowawayPostgres & { stop: () => void } {
	const { root, env, run, readyTimeoutMs, sleep, scope } = options;
	const docker = (...args: string[]) => run("docker", args, { cwd: root, env });
	const label = `${LABEL}=${checkoutLabel(scope ? `${root}#${scope}` : root)}`;
	const left = docker("ps", "-aq", "--filter", `label=${label}`);
	if (left.status !== 0) throw new DatabaseError(`Docker cannot be reached: ${firstLine(left.output)}`);
	const stale = left.stdout.split("\n").filter(Boolean);
	if (stale.length) docker("rm", "-f", "-v", ...stale);

	const slug = basename(root)
		.replace(/[^a-zA-Z0-9_.-]/g, "-")
		.slice(0, 40);
	const container = `evf-${scope ?? "check"}-db-${slug}-${randomBytes(3).toString("hex")}`;
	const password = randomBytes(18).toString("hex");
	const started = docker(
		...["run", "-d", "--rm", "--name", container, "--label", label],
		...["-e", `POSTGRES_USER=${USER}`, "-e", `POSTGRES_PASSWORD=${password}`, "-e", `POSTGRES_DB=${DATABASE}`],
		...["-p", "127.0.0.1::5432", IMAGE],
	);
	const unwatch = options.watch(container);
	const stop = () => {
		docker("rm", "-f", "-v", container);
		unwatch();
	};
	try {
		if (started.status !== 0) throw new DatabaseError(`Docker could not start ${IMAGE}: ${firstLine(started.output)}`);
		const ready = () =>
			docker("exec", container, "pg_isready", "-q", "-h", "127.0.0.1", "-U", USER, "-d", DATABASE).status === 0;
		const deadline = Date.now() + readyTimeoutMs;
		while (!ready()) {
			if (Date.now() >= deadline)
				throw new DatabaseError(`the database was not ready within ${Math.round(readyTimeoutMs / 1000)} s`);
			sleep(500);
		}
		const port = docker("port", container, "5432/tcp").stdout.split("\n")[0]?.split(":").pop()?.trim();
		if (!port || !/^\d+$/.test(port)) throw new DatabaseError("Docker reported no port for the database");
		const url = `postgres://${USER}:${password}@127.0.0.1:${port}/${DATABASE}`;
		console.error(`check test:db: corepack pnpm db:migrate on ${container}`);
		const migrated = run("corepack", ["pnpm", "db:migrate"], { cwd: root, env: { ...env, ...databaseEnv(url) } });
		process.stderr.write(migrated.output.replaceAll(password, "***"));
		if (migrated.status !== 0) throw new DatabaseError("pnpm db:migrate failed on the throwaway database");
		return { container, image: IMAGE, url, password, stop };
	} catch (error) {
		stop();
		throw error;
	}
}

const firstLine = (text: string) => text.trim().split("\n")[0] || "no output";
