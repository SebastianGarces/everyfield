import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fail, run, sleep } from "./lib.ts";

/**
 * OPS-52 (P2, D81): timing sets run against a quiet database that only the timing run uses, never the shared
 * development database, whose own latency spikes reached 499 ms (C113, C114). It is CI's Postgres image in Docker on
 * this machine: started, migrated by the head's own `db:migrate`, given login roles for the app, then removed.
 */
export const QUIET_IMAGE = "pgvector/pgvector:0.8.7-pg17";
const DATABASE = "everyfield_timing";
const LABEL = "evf.timing";

export type QuietDatabase = {
	container: string;
	/** Superuser connection: migrations, the probe and the set's own seed. */
	adminUrl: string;
	/** Env for the timing preview: the operator and identity logins on the quiet database, fresh identity keys. */
	previewEnv: Record<string, string>;
};

function docker(...args: string[]): string {
	const r = run("docker", args);
	if (r.code !== 0) fail(`docker ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
	return r.stdout.trim();
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Remove quiet databases whose timing run has ended without stopping them (crash, kill). */
export function removeStaleQuietDatabases(): string[] {
	const stale = docker("ps", "-a", "--filter", `label=${LABEL}`, "--format", `{{.Names}} {{.Label "evf.pid"}}`)
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(" "))
		.filter(([, pid]) => !alive(Number(pid)))
		.map(([name]) => name);
	if (!stale.length) return stale;
	// Every evf run on this machine sweeps, so another run may remove the same container at the same moment. Docker
	// then refuses this removal as already in progress, or the container is already gone: either way it is removed.
	// A failure with no message, or with any other message, is a real failure.
	const r = run("docker", ["rm", "-f", ...stale]);
	const errors = r.stderr.split("\n").filter((line) => line.trim());
	if (r.code !== 0 && (!errors.length || errors.some((line) => !/No such container|is already in progress/.test(line))))
		fail(`docker rm failed (exit ${r.code}): ${(r.stderr || r.stdout).trim() || "no message"}`);
	return stale;
}

function psql(container: string, sql: string): string {
	const r = run("docker", [
		"exec",
		container,
		"psql",
		"-qAt",
		"-v",
		"ON_ERROR_STOP=1",
		"-U",
		"evf",
		"-d",
		DATABASE,
		"-c",
		sql,
	]);
	if (r.code !== 0) fail(`The quiet database refused a setup statement: ${r.stderr.trim()}`);
	return r.stdout.trim();
}

/**
 * Start, migrate and prepare a quiet database for one timing run. `checkout` is the exact head under test, with its
 * dependencies installed. The caller must call stopQuietDatabase, also on failure.
 */
export function startQuietDatabase(checkout: string, tag: string): QuietDatabase {
	if (run("docker", ["info", "--format", "{{.ServerVersion}}"]).code !== 0)
		fail("evf timing needs Docker for its quiet database. Start Docker and retry.");
	removeStaleQuietDatabases();
	const container = `evf-timing-${tag}-${randomBytes(3).toString("hex")}`,
		password = randomBytes(18).toString("hex");
	docker(
		"run",
		"-d",
		"--rm",
		"--name",
		container,
		"--label",
		`${LABEL}=1`,
		"--label",
		`evf.pid=${process.pid}`,
		"-e",
		"POSTGRES_USER=evf",
		"-e",
		`POSTGRES_PASSWORD=${password}`,
		"-e",
		`POSTGRES_DB=${DATABASE}`,
		"-p",
		"127.0.0.1::5432",
		QUIET_IMAGE,
	);
	try {
		// The image's init server listens on its socket only, so a TCP answer means the final server is up.
		for (
			let waited = 0;
			run("docker", ["exec", container, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "evf", "-d", DATABASE]).code !== 0;
			waited += 500
		) {
			if (waited > 60_000) fail("The quiet database did not accept connections within 60 s.");
			sleep(500);
		}
		const port = docker("port", container, "5432/tcp").split("\n")[0].split(":").pop();
		const url = (user: string, secret: string) => `postgres://${user}:${secret}@127.0.0.1:${port}/${DATABASE}`;
		const adminUrl = url("evf", password);
		// The worktree has no apps/web/.env.local, and these values win over any file the script reads.
		const migrated = run("corepack", ["pnpm", "db:migrate"], {
			cwd: checkout,
			env: { ...process.env, DATABASE_URL: adminUrl, DATABASE_URL_UNPOOLED: adminUrl },
		});
		if (migrated.code !== 0)
			fail(`db:migrate failed on the quiet database:\n${(migrated.stderr || migrated.stdout).trim()}`);
		// The app logs in as its two least-privilege roles, as on every deployed database.
		const logins: Record<string, string> = {};
		for (const [name, grant] of [
			["evf_runtime", "everyfield_runtime"],
			["evf_auth", "everyfield_auth"],
		]) {
			const secret = randomBytes(18).toString("hex");
			psql(container, `CREATE ROLE ${name} LOGIN INHERIT PASSWORD '${secret}' IN ROLE ${grant}`);
			logins[name] = url(name, secret);
		}
		const key = () => randomBytes(32).toString("hex");
		return {
			container,
			adminUrl,
			previewEnv: {
				DATABASE_URL: adminUrl,
				DATABASE_URL_UNPOOLED: adminUrl,
				IDENTITY_DATABASE_URL: logins.evf_runtime,
				IDENTITY_AUTH_DATABASE_URL: logins.evf_auth,
				IDENTITY_ORIGIN: "${PREVIEW_URL}",
				IDENTITY_SECRET: key(),
				IDENTITY_MAIL_KEY: key(),
				IDENTITY_ADDRESS_KEY: key(),
				IDENTITY_MAIL_FROM: "timing@example.test",
				EVRY_SCRIPTED_MODEL: "1",
			},
		};
	} catch (error) {
		docker("rm", "-f", container);
		throw error;
	}
}

export function stopQuietDatabase(db: Pick<QuietDatabase, "container">): void {
	run("docker", ["rm", "-f", db.container]);
}

export type TimingPreview = { id: string; url: string; head: string; configDir: string };

/**
 * A production preview of `checkout` whose env is only the quiet database's: no dev env file is copied, so the app
 * cannot reach the shared database or a paid service during timing. Portless fills ${PREVIEW_URL} itself.
 */
export function startTimingPreview(checkout: string, env: Record<string, string>): TimingPreview {
	const next = [process.execPath, "apps/web/node_modules/next/dist/bin/next"];
	// The config holds the quiet logins: a private folder outside every checkout, removed when the preview stops.
	const configDir = mkdtempSync(join(tmpdir(), "evf-timing-preview-")),
		config = join(configDir, "preview.json");
	writeFileSync(
		config,
		JSON.stringify({
			install: ["corepack", "pnpm", "install", "--frozen-lockfile"],
			build: [...next, "build", "apps/web"],
			start: [...next, "start", "apps/web", "--hostname", "127.0.0.1"],
			dev: [...next, "dev", "apps/web", "--hostname", "127.0.0.1"],
			env: {
				...env,
				NEXT_TELEMETRY_DISABLED: "1",
				CI: "true",
				PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
			},
			timeoutSeconds: 600,
		}),
		{ mode: 0o600 },
	);
	const up = run("portless", [
		"preview",
		"up",
		"--project",
		checkout,
		"--mode",
		"production",
		"--config",
		config,
		"--json",
	]);
	if (up.code !== 0) {
		rmSync(configDir, { recursive: true, force: true });
		fail(`The timing preview did not start: ${up.stderr.trim()}`);
	}
	const { id, url, head, state } = JSON.parse(up.stdout) as { id: string; url: string; head: string; state: string };
	const preview = { id, url, head, configDir };
	if (state !== "ready") {
		stopTimingPreview(preview);
		fail(`The timing preview ended ${state}. Read: portless preview logs ${id}`);
	}
	return preview;
}

export function stopTimingPreview(preview: Pick<TimingPreview, "id" | "configDir">): void {
	run("portless", ["preview", "down", preview.id, "--json"]);
	rmSync(preview.configDir, { recursive: true, force: true });
}
