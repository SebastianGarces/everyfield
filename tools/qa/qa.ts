import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	devParent,
	NEON_PROJECT,
	QA_LOGINS,
	QA_ROLES,
	roleUrl,
	type NeonBranch,
	type NeonEndpoint,
} from "./qa-guard.ts";
import { addPreview, driverLogPath, fail, readPreviews, removePreview, setDeployment, setDriver } from "./store.ts";

/**
 * OPS-106: on-demand QA previews. `qa up <branch>` makes a Neon branch off the development branch, migrates and
 * seeds it with the branch's own code, deploys that head to a Vercel preview with per-deployment database and identity
 * settings, and gives it a stable alias, the one origin the deployment trusts. It then starts the preview's
 * scheduled-send driver (cron-driver.ts, T-255), because Vercel runs crons on production only. `qa list` shows open
 * previews; `qa down` stops the driver and removes the alias, the deployment and the Neon branch.
 *
 * Secrets pass from neonctl to child processes in memory only. qa prints, logs and stores names, never a connection
 * string, key or password: child output reaches the screen only on failure, through `redact`.
 */

const VERCEL = { orgId: "team_JKEPRxDWACtp9hugEthW215I", projectId: "prj_N6MhFGqi0UW5Iaa6RBDpusMKxMwu" };
const QA_ID = /^qa-[a-z0-9]+(-[a-z0-9]+)*$/;
const aliasHost = (id: string) => `everyfield-${id}.vercel.app`;
/** The seed runs from the branch's own code. */
const SEED_PATHS = ["tools/qa/qa-seed.ts"];

/** Hides connection strings and Neon passwords in text that leaves a process. */
const redactConnections = (text: string) =>
	text.replace(/\b(postgres(?:ql)?):\/\/[^\s"'<>]+/g, "$1://<redacted>").replace(/\bnpg_[A-Za-z0-9]+/g, "<redacted>");

/** Masks every value qa handed to a child, connection URLs and Neon passwords, in text bound for the screen. */
class Redactor {
	private values: string[] = [];
	add(...values: string[]): void {
		for (const v of values) if (v.length >= 6) this.values.push(v);
	}
	clean(text: string): string {
		let out = text;
		for (const v of this.values) out = out.split(v).join("<redacted>");
		return redactConnections(out);
	}
}

type Result = { code: number; stdout: string; stderr: string };

/**
 * One external command. The environment is process.env plus `env`; a key set to undefined is removed. Arguments can
 * hold secrets (vercel -e), so a failure names the command and its first argument only.
 */
function tool(
	redactor: Redactor,
	cmd: string,
	args: string[],
	opts: { cwd?: string; env?: Record<string, string | undefined>; allow?: RegExp } = {},
): Result {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [k, v] of Object.entries(opts.env ?? {}))
		if (v === undefined) delete env[k];
		else env[k] = v;
	const r = spawnSync(cmd, args, { cwd: opts.cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const result = {
		code: r.error ? 127 : (r.status ?? 1),
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? String(r.error ?? ""),
	};
	if (result.code !== 0 && !(opts.allow && opts.allow.test(result.stdout + result.stderr))) {
		const tail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-15).join("\n");
		fail(`${cmd} ${args[0]} failed (exit ${result.code}):\n${redactor.clean(tail)}`);
	}
	return result;
}

const json = <T>(r: Result): T => JSON.parse(r.stdout) as T;

function neon(redactor: Redactor, ...args: string[]): Result {
	return tool(redactor, "neonctl", [...args, "--project-id", NEON_PROJECT]);
}

function neonBranches(redactor: Redactor): NeonBranch[] {
	return json<NeonBranch[]>(neon(redactor, "branches", "list", "--output", "json"));
}

const slug = (branch: string) =>
	branch
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24)
		.replace(/-+$/, "") || "branch";

/** The commit to deploy: the remote branch after a fetch, else the local branch. */
function resolveHead(root: string, branch: string): string {
	spawnSync("git", ["-C", root, "fetch", "--quiet", "origin", branch], { encoding: "utf8" });
	for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
		const r = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
			encoding: "utf8",
		});
		if (r.status === 0) return r.stdout.trim();
	}
	fail(`No branch ${branch} on origin or in this checkout.`);
}

/** One full mail address, as mailRecipientAllowed compares them: a local part, an @ and a dotted domain, no wildcard. */
const FULL_ADDRESS = /^[^\s@*,]+@[^\s@*,.]+(\.[^\s@*,.]+)+$/;

/**
 * The `--test-recipients` list: one or more full addresses, comma-separated, or what to fix. The value goes only to this
 * one deployment (EMAIL_TEST_RECIPIENTS) and to the seed (QA_TEST_RECIPIENTS); it is never stored.
 */
export function parseTestRecipients(raw: string): string[] | string {
	const entries = raw.split(",").map((entry) => entry.trim());
	if (!raw.trim())
		return "--test-recipients needs one or more full addresses, comma-separated: --test-recipients a@example.com";
	const bad = entries.filter((entry) => !FULL_ADDRESS.test(entry));
	if (bad.length)
		return `--test-recipients takes full addresses only, comma-separated, with no empty entry, bare domain or wildcard. Fix: ${bad.map((b) => JSON.stringify(b)).join(", ")}`;
	return entries;
}

export function qaUp(root: string, branch: string, recipients: string[] = []): number {
	if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) fail(`${branch} is not a branch name.`);
	const redactor = new Redactor();
	const head = resolveHead(root, branch);
	// Refuse before anything exists when the development parent is missing or is production.
	const endpoints = json<{ endpoints: NeonEndpoint[] }>(
		tool(redactor, "neonctl", ["api", `/projects/${NEON_PROJECT}/endpoints`]),
	).endpoints;
	const parent = devParent(endpoints, neonBranches(redactor));
	if (typeof parent === "string") fail(`qa up refused before creating anything. ${parent}`);

	const id = `qa-${slug(branch)}-${randomBytes(2).toString("hex")}`,
		url = `https://${aliasHost(id)}`;
	// The record comes first, so a crash at any later step leaves what `qa down` needs.
	addPreview(root, {
		id,
		branch,
		head,
		neon_branch: id,
		url,
		deployment: null,
		created_at: new Date().toISOString(),
	});
	let cron = "";
	console.error(`qa up: ${id} for ${branch} at ${head.slice(0, 12)}, Neon branch off ${parent.name}.`);
	try {
		const created = json<{ branch: NeonBranch }>(
			neon(redactor, "branches", "create", "--name", id, "--parent", parent.id, "--output", "json"),
		);
		const cs = (...extra: string[]) => {
			const value = neon(
				redactor,
				"connection-string",
				created.branch.id,
				"--role-name",
				"neondb_owner",
				"--database-name",
				"neondb",
				...extra,
			).stdout.trim();
			redactor.add(value, new URL(value).password);
			return value;
		};
		const direct = cs(),
			pooled = cs("--pooled");
		const { deployment, cronSecret } = deployCheckout(root, redactor, { id, head, url, direct, pooled, recipients });
		cron = startDriver(root, id, deployment, cronSecret);
	} catch (error) {
		console.error(`qa up: ${id} failed; removing what it made.`);
		try {
			qaDown(root, id);
		} catch (cleanup) {
			console.error(`qa up: cleanup failed (${(cleanup as Error).message}). Run: bin/qa down ${id}`);
		}
		throw error;
	}
	console.log(`QA preview ${id}\n${url}`);
	console.error(
		`Sign in as ${QA_LOGINS.owner} (also qa-admin, qa-member; Riverside (QA): ${QA_LOGINS.riverside}). Remove it with: bin/qa down ${id}. Runbook: docs/runbooks/qa-preview.md`,
	);
	console.error(
		recipients.length
			? `Real mail on this preview also reaches: ${recipients.join(", ")}. Ana Lee uses ${recipients[0]} in both churches. Other addresses go to /api/dev/outbox.`
			: "Real mail on this preview reaches no extra address: only delivered+...@resend.dev. Other addresses go to /api/dev/outbox.",
	);
	console.error(cron);
	return 0;
}

const DRIVER = join(dirname(fileURLToPath(import.meta.url)), "cron-driver.ts");
/** How long `qa up` waits for the driver's first call of /api/cron/jobs to answer. */
const FIRST_RUN_WAIT_MS = 90_000;

/**
 * Starts the preview's scheduled-send driver, detached so it outlives `qa up`, records its pid and waits for its first
 * call. Returns the line to print: whether scheduled sends run, and where the log is. A failed first call leaves the
 * preview and the driver up, since the next minute may succeed, and says what to check.
 */
function startDriver(root: string, id: string, deployment: string, secret: string): string {
	const log = driverLogPath(root, id);
	writeFileSync(log, "", { mode: 0o600 });
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", DRIVER, root, id, deployment], {
		detached: true,
		stdio: ["ignore", "ignore", openSync(log, "a")],
		env: { ...process.env, QA_CRON_SECRET: secret },
	});
	child.unref();
	if (!child.pid) fail("The scheduled-send driver did not start.");
	setDriver(root, id, child.pid);
	let first = "";
	for (let waited = 0; waited < FIRST_RUN_WAIT_MS && !first; waited += 250) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
		first =
			readFileSync(log, "utf8")
				.split("\n")
				.find((line) => / (ok|failed): /.test(line)) ?? "";
	}
	const where = `/api/cron/jobs runs every minute from this Mac until bin/qa down. Log: ${log}`;
	if (/ ok: /.test(first)) return `Scheduled sends: on. ${where}`;
	if (!first) return `Scheduled sends: the first run has not answered yet. ${where}`;
	return `Scheduled sends: the first run FAILED (${first.split(" failed: ")[1]}). The driver keeps trying. ${where}`;
}

/** Stops a preview's scheduled-send driver: only that process, checked by its command line, then removes its log. */
function stopDriver(root: string, id: string, pid: number | undefined): boolean {
	let stopped = false;
	const command = (p: number) =>
		spawnSync("ps", ["-p", String(p), "-o", "command="], { encoding: "utf8" }).stdout.trim();
	if (pid && command(pid).includes(DRIVER) && command(pid).includes(id)) {
		process.kill(pid, "SIGTERM");
		for (let waited = 0; waited < 5_000 && command(pid); waited += 100)
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		if (command(pid)) process.kill(pid, "SIGKILL");
		stopped = true;
	}
	rmSync(driverLogPath(root, id), { force: true });
	return stopped;
}

function deployCheckout(
	root: string,
	redactor: Redactor,
	p: { id: string; head: string; url: string; direct: string; pooled: string; recipients: string[] },
): { deployment: string; cronSecret: string } {
	const checkout = mkdtempSync(join(tmpdir(), "evf-qa-"));
	tool(redactor, "git", ["-C", root, "worktree", "add", "--quiet", "--detach", checkout, p.head]);
	try {
		const seed = SEED_PATHS.find((path) => existsSync(join(checkout, path)));
		if (!seed) fail(`This branch has no QA seed (${SEED_PATHS[0]}). Merge main into it and push, then retry.`);
		const dbEnv = { DATABASE_URL: p.direct, DATABASE_URL_UNPOOLED: p.direct, NODE_ENV: undefined };
		console.error("qa up: installing the branch's dependencies.");
		tool(redactor, "corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: checkout });
		console.error("qa up: migrating the Neon branch with the branch's db:migrate.");
		tool(redactor, "corepack", ["pnpm", "db:migrate"], { cwd: checkout, env: dbEnv });
		const rolePassword = randomBytes(24).toString("hex");
		const key = () => randomBytes(32).toString("hex");
		// The mail keys come before the seed: its suppression and mail rows hash and seal addresses under them, so the
		// preview must run with the same two values.
		const mailKeys = { IDENTITY_MAIL_KEY: key(), IDENTITY_ADDRESS_KEY: key() };
		redactor.add(rolePassword, ...Object.values(mailKeys));
		console.error("qa up: seeding the test churches.");
		tool(
			redactor,
			"corepack",
			["pnpm", "--filter", "@everyfield/domain", "exec", "tsx", "--conditions=react-server", `../../${seed}`],
			{
				cwd: checkout,
				env: {
					...dbEnv,
					QA_ROLE_PASSWORD: rolePassword,
					...mailKeys,
					QA_TEST_RECIPIENTS: p.recipients.length ? p.recipients.join(",") : undefined,
				},
			},
		);
		// Per-deployment settings: this preview's database, its own identity keys, its own cron secret for the driver
		// (T-255) and, when given, the extra addresses that get real mail. The cleanup login points at this branch too, so
		// the cron's purges stay in it. Shared credentials (mail, storage, Langfuse, Evry) come from the Vercel Preview
		// environment, which qa never changes.
		const cronSecret = key();
		const settings: Record<string, string> = {
			DATABASE_URL: p.pooled,
			DATABASE_URL_UNPOOLED: p.direct,
			IDENTITY_DATABASE_URL: roleUrl(p.pooled, QA_ROLES.runtime, rolePassword),
			IDENTITY_AUTH_DATABASE_URL: roleUrl(p.pooled, QA_ROLES.auth, rolePassword),
			IDENTITY_ORIGIN: p.url,
			IDENTITY_SECRET: key(),
			...mailKeys,
			NOTIFICATION_OPT_OUT_KEYS: randomBytes(32).toString("base64"),
			CRON_SECRET: cronSecret,
			LIFECYCLE_CLEANUP_DATABASE_URL: p.direct,
			...(p.recipients.length ? { EMAIL_TEST_RECIPIENTS: p.recipients.join(",") } : {}),
		};
		const notSecret = new Set(["IDENTITY_ORIGIN", "EMAIL_TEST_RECIPIENTS"]);
		redactor.add(...Object.entries(settings).flatMap(([k, v]) => (notSecret.has(k) ? [] : [v])));
		mkdirSync(join(checkout, ".vercel"));
		writeFileSync(join(checkout, ".vercel/project.json"), JSON.stringify(VERCEL));
		const flags = Object.entries(settings).flatMap(([k, v]) => ["-e", `${k}=${v}`, "-b", `${k}=${v}`]);
		console.error("qa up: deploying to a Vercel preview (several minutes).");
		const deployed = tool(redactor, "vercel", ["deploy", "--yes", "--target", "preview", ...flags], { cwd: checkout });
		const deployment = deployed.stdout
			.trim()
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^https:\/\/\S+\.vercel\.app$/.test(line))
			.pop();
		if (!deployment) fail("vercel deploy printed no deployment URL.");
		setDeployment(root, p.id, deployment);
		tool(redactor, "vercel", ["alias", "set", deployment, aliasHost(p.id), "--scope", VERCEL.orgId], { cwd: checkout });
		return { deployment, cronSecret };
	} finally {
		spawnSync("git", ["-C", root, "worktree", "remove", "--force", checkout], { encoding: "utf8" });
		rmSync(checkout, { recursive: true, force: true });
	}
}

const age = (from: string) => {
	const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(from)) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

export function qaList(root: string): number {
	const open = readPreviews(root);
	if (!open.length) {
		console.log("No open QA previews.");
		return 0;
	}
	for (const r of open)
		console.log(
			[r.id, r.branch, r.url, `neon:${r.neon_branch}`, `age ${age(r.created_at)}`, r.head.slice(0, 12)].join("  "),
		);
	return 0;
}

const NOT_FOUND = /not found|doesn't exist|does not exist|no such|couldn't find|could not find/i;

/** Removes the alias, the deployment and the Neon branch of one QA preview, then its record. A second call is a no-op. */
export function qaDown(root: string, id: string): number {
	if (!QA_ID.test(id)) fail(`${id} is not a QA preview id (qa-...). See bin/qa list.`);
	const redactor = new Redactor();
	const row = readPreviews(root).find((r) => r.id === id);
	const removed: string[] = [];
	if (stopDriver(root, id, row?.driver_pid)) removed.push("scheduled-send driver");
	if (row?.deployment) {
		tool(redactor, "vercel", ["alias", "rm", aliasHost(id), "--yes", "--scope", VERCEL.orgId], { allow: NOT_FOUND });
		tool(redactor, "vercel", ["remove", row.deployment, "--yes", "--scope", VERCEL.orgId], { allow: NOT_FOUND });
		removed.push("alias", "deployment");
	}
	const branch = neonBranches(redactor).find((b) => b.name === id);
	if (branch) {
		neon(redactor, "branches", "delete", branch.id);
		removed.push(`Neon branch ${branch.name}`);
	}
	if (row) removePreview(root, id);
	console.log(
		row || branch
			? `Removed QA preview ${id}: ${removed.join(", ") || "its record"}.`
			: `No QA preview ${id}. Nothing to remove.`,
	);
	return 0;
}
