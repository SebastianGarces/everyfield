import { spawnSync } from "node:child_process";
import type { Runner } from "./check.ts";
import { LABELS, repositoryOf } from "./containers.ts";
import {
	DatabaseError,
	databaseEnv,
	migrate,
	type PostgresOptions,
	sleepSync,
	startPostgres,
	urlOf,
	watchProcess,
} from "./throwaway-postgres.ts";

export const PG_LABEL = "everyfield.pg";
export const USAGE = "usage: dev pg up [--name <n>] | run [--name <n>] -- <cmd> [args...] | status | down [--name <n>]";

export class PgError extends Error {}

export type Pg = { root: string; run: Runner; database?: Partial<PostgresOptions> };
type Scratch = { id: string; container: string; name: string; state: string };

const docker = ({ root, run }: Pg, ...args: string[]) => {
	const r = run("docker", args, { cwd: root, env: {} });
	if (r.status !== 0) throw new PgError(`docker ${args[0]} failed: ${r.output.trim().split("\n")[0]}`);
	return r.stdout.trim();
};

export function scratches(pg: Pg, name?: string): Scratch[] {
	const { worktree, common } = repositoryOf(pg.root);
	const filters = [
		`label=${LABELS.repository}=${common}`,
		`label=${LABELS.worktree}=${worktree}`,
		`label=${PG_LABEL}${name === undefined ? "" : `=${name}`}`,
	].flatMap((filter) => ["--filter", filter]);
	const format = `{{.ID}}\t{{.Names}}\t{{.Label "${PG_LABEL}"}}\t{{.State}}`;
	return docker(pg, "ps", "-a", "--no-trunc", ...filters, "--format", format)
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [id, container, found, state] = line.split("\t") as [string, string, string, string];
			return { id, container, name: found, state };
		});
}

function running(pg: Pg, name: string): Scratch | undefined {
	return scratches(pg, name).find(({ state }) => state === "running");
}

const portOf = (pg: Pg, id: string) =>
	docker(pg, "port", id, "5432/tcp").split("\n")[0]?.split(":").pop()?.trim() ?? "";

function connection(pg: Pg, id: string): { url: string; password: string } {
	const env = JSON.parse(docker(pg, "inspect", "--format", "{{json .Config.Env}}", id)) as string[];
	const password = env.find((line) => line.startsWith("POSTGRES_PASSWORD="))?.slice("POSTGRES_PASSWORD=".length);
	const port = portOf(pg, id);
	if (!password || !port) throw new PgError("the scratch Postgres reports no port or password");
	return { password, url: urlOf(password, port) };
}

export function up(pg: Pg, name: string): string {
	const found = running(pg, name);
	if (!found) {
		const started = startPostgres({
			root: pg.root,
			env: {},
			run: pg.run,
			readyTimeoutMs: 60_000,
			sleep: sleepSync,
			watch: watchProcess,
			...pg.database,
			scope: `pg-${name}`,
			labels: ["--label", `${PG_LABEL}=${name}`],
		});
		started.keep();
		return `pg up ${name}: ${started.container}, migrated by this head`;
	}
	try {
		const { url, password } = connection(pg, found.id);
		migrate({ root: pg.root, env: {}, run: pg.run, container: found.container, url, password });
	} catch (error) {
		docker(pg, "rm", "-f", "-v", found.id);
		throw error;
	}
	return `pg already up ${name}: ${found.container}, migrated by this head`;
}

export function environment(pg: Pg, name: string): Record<string, string> {
	const found = running(pg, name);
	if (!found) throw new PgError(`no scratch Postgres named ${name} is running here. Start it with bin/dev pg up`);
	return databaseEnv(connection(pg, found.id).url);
}

export function status(pg: Pg): string[] {
	const found = scratches(pg);
	if (!found.length) return ["no scratch Postgres of this worktree"];
	return found.map(({ id, name, container, state }) =>
		state === "running"
			? `${name}: ${container} ${state} on 127.0.0.1:${portOf(pg, id)}`
			: `${name}: ${container} ${state}`,
	);
}

export function down(pg: Pg, name?: string): string[] {
	const found = scratches(pg, name);
	if (!found.length) return ["no scratch Postgres of this worktree to remove"];
	docker(pg, "rm", "-f", "-v", ...found.map(({ id }) => id));
	return found.map((scratch) => `pg down ${scratch.name}: removed ${scratch.container} and its volume`);
}

export function pgCommand(args: string[], root: string, run: Runner): number {
	const sep = args.indexOf("--");
	const [action, ...options] = sep < 0 ? args : args.slice(0, sep);
	const command = sep < 0 ? [] : args.slice(sep + 1);
	const [flag, value] = options;
	const named = options.length === 0 || (options.length === 2 && flag === "--name");
	const takesCommand = action === "run";
	const known = ["up", "run", "status", "down"].includes(action ?? "");
	if (
		!known ||
		!named ||
		takesCommand !== command.length > 0 ||
		(sep >= 0 && !takesCommand) ||
		(action === "status" && flag)
	) {
		console.error(USAGE);
		return 2;
	}
	if (value !== undefined && !/^[a-z0-9][a-z0-9-]{0,30}$/.test(value)) {
		console.error("dev pg: a name is 1 to 31 lowercase letters, digits and dashes.");
		return 2;
	}
	const pg: Pg = { root, run };
	try {
		if (action === "up") console.log(up(pg, value ?? "default"));
		else if (action === "status") console.log(status(pg).join("\n"));
		else if (action === "down") console.log(down(pg, value).join("\n"));
		else {
			const env = { ...process.env, ...environment(pg, value ?? "default") };
			const r = spawnSync(command[0]!, command.slice(1), { env, stdio: "inherit" });
			if (r.error) throw new PgError(`${command[0]} could not run: ${r.error.message}`);
			return r.status ?? 1;
		}
		return 0;
	} catch (error) {
		if (!(error instanceof PgError || error instanceof DatabaseError)) throw error;
		console.error(`dev pg: ${error.message}`);
		return 1;
	}
}
