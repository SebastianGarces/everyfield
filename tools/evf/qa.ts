import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkDb } from "./db.ts";
import { fail } from "./lib.ts";
import { devParent, NEON_PROJECT, QA_LOGINS, roleUrl, type NeonBranch, type NeonEndpoint } from "./qa-guard.ts";

/**
 * OPS-106: on-demand QA previews. `evf qa up <branch>` makes a Neon branch off the development branch, migrates and
 * seeds it with the branch's own code, deploys that head to a Vercel preview with per-deployment database and identity
 * settings, and gives it a stable alias, the one origin the deployment trusts. `qa list` shows open previews; `qa down`
 * removes the alias, the deployment and the Neon branch.
 *
 * Secrets pass from neonctl to child processes in memory only. evf prints, logs and stores names, never a connection
 * string, key or password: child output reaches the screen only on failure, through `redact`.
 */

const VERCEL = { orgId: "team_JKEPRxDWACtp9hugEthW215I", projectId: "prj_N6MhFGqi0UW5Iaa6RBDpusMKxMwu" };
const QA_ID = /^qa-[a-z0-9]+(-[a-z0-9]+)*$/;
const aliasHost = (id: string) => `everyfield-${id}.vercel.app`;

/** Masks every value evf handed to a child, connection URLs and Neon passwords, in text bound for the screen. */
class Redactor {
	private values: string[] = [];
	add(...values: string[]): void {
		for (const v of values) if (v.length >= 6) this.values.push(v);
	}
	clean(text: string): string {
		let out = text;
		for (const v of this.values) out = out.split(v).join("<redacted>");
		return out
			.replace(/\b(postgres(?:ql)?):\/\/[^\s"'<>]+/g, "$1://<redacted>")
			.replace(/\bnpg_[A-Za-z0-9]+/g, "<redacted>");
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

type QaPreview = {
	id: string;
	branch: string;
	head: string;
	neon_branch: string;
	url: string;
	deployment: string | null;
	created_at: string;
};

function rows(root: string): QaPreview[] {
	const db = openWorkDb(root);
	try {
		return db.prepare("SELECT * FROM qa_previews ORDER BY created_at").all() as QaPreview[];
	} finally {
		db.close();
	}
}

function store(root: string, sql: string, ...params: Array<string | null>): void {
	const db = openWorkDb(root);
	try {
		db.prepare(sql).run(...params);
	} finally {
		db.close();
	}
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

export function qaUp(root: string, branch: string): number {
	if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) fail(`${branch} is not a branch name.`);
	const redactor = new Redactor();
	const head = resolveHead(root, branch);
	// Refuse before anything exists when the development parent is missing or is production.
	const endpoints = json<{ endpoints: NeonEndpoint[] }>(
		tool(redactor, "neonctl", ["api", `/projects/${NEON_PROJECT}/endpoints`]),
	).endpoints;
	const parent = devParent(endpoints, neonBranches(redactor));
	if (typeof parent === "string") fail(`evf qa up refused before creating anything. ${parent}`);

	const id = `qa-${slug(branch)}-${randomBytes(2).toString("hex")}`,
		url = `https://${aliasHost(id)}`;
	// The row comes first, so a crash at any later step leaves what `qa down` needs.
	store(
		root,
		"INSERT INTO qa_previews (id, branch, head, neon_branch, url, deployment, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
		id,
		branch,
		head,
		id,
		url,
		new Date().toISOString(),
	);
	console.error(`evf qa up: ${id} for ${branch} at ${head.slice(0, 12)}, Neon branch off ${parent.name}.`);
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
		deployCheckout(root, redactor, { id, head, url, direct, pooled });
	} catch (error) {
		console.error(`evf qa up: ${id} failed; removing what it made.`);
		try {
			qaDown(root, id);
		} catch (cleanup) {
			console.error(`evf qa up: cleanup failed (${(cleanup as Error).message}). Run: bin/evf qa down ${id}`);
		}
		throw error;
	}
	console.log(`QA preview ${id}\n${url}`);
	console.error(
		`Sign in as ${QA_LOGINS.owner} (also qa-admin, qa-member). Remove it with: bin/evf qa down ${id}. Runbook: docs/runbooks/qa-preview.md`,
	);
	return 0;
}

function deployCheckout(
	root: string,
	redactor: Redactor,
	p: { id: string; head: string; url: string; direct: string; pooled: string },
): void {
	const checkout = mkdtempSync(join(tmpdir(), "evf-qa-"));
	tool(redactor, "git", ["-C", root, "worktree", "add", "--quiet", "--detach", checkout, p.head]);
	try {
		if (!existsSync(join(checkout, "tools/evf/qa-seed.ts")))
			fail("This branch has no QA seed (tools/evf/qa-seed.ts). Merge main into it and push, then retry.");
		const dbEnv = { DATABASE_URL: p.direct, DATABASE_URL_UNPOOLED: p.direct, NODE_ENV: undefined };
		console.error("evf qa up: installing the branch's dependencies.");
		tool(redactor, "corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: checkout });
		console.error("evf qa up: migrating the Neon branch with the branch's db:migrate.");
		tool(redactor, "corepack", ["pnpm", "db:migrate"], { cwd: checkout, env: dbEnv });
		const rolePassword = randomBytes(24).toString("hex");
		redactor.add(rolePassword);
		console.error("evf qa up: seeding the test church.");
		tool(
			redactor,
			"corepack",
			[
				"pnpm",
				"--filter",
				"@everyfield/domain",
				"exec",
				"tsx",
				"--conditions=react-server",
				"../../tools/evf/qa-seed.ts",
			],
			{ cwd: checkout, env: { ...dbEnv, QA_ROLE_PASSWORD: rolePassword } },
		);
		const key = () => randomBytes(32).toString("hex");
		// Per-deployment settings: this preview's database and its own identity keys. Shared credentials (mail,
		// storage, cron, Langfuse, Evry) come from the Vercel Preview environment.
		const settings: Record<string, string> = {
			DATABASE_URL: p.pooled,
			DATABASE_URL_UNPOOLED: p.direct,
			IDENTITY_DATABASE_URL: roleUrl(p.pooled, "evf_qa_runtime", rolePassword),
			IDENTITY_AUTH_DATABASE_URL: roleUrl(p.pooled, "evf_qa_auth", rolePassword),
			IDENTITY_ORIGIN: p.url,
			IDENTITY_SECRET: key(),
			IDENTITY_MAIL_KEY: key(),
			IDENTITY_ADDRESS_KEY: key(),
			NOTIFICATION_OPT_OUT_KEYS: randomBytes(32).toString("base64"),
		};
		redactor.add(...Object.entries(settings).flatMap(([k, v]) => (k === "IDENTITY_ORIGIN" ? [] : [v])));
		mkdirSync(join(checkout, ".vercel"));
		writeFileSync(join(checkout, ".vercel/project.json"), JSON.stringify(VERCEL));
		const flags = Object.entries(settings).flatMap(([k, v]) => ["-e", `${k}=${v}`, "-b", `${k}=${v}`]);
		console.error("evf qa up: deploying to a Vercel preview (several minutes).");
		const deployed = tool(redactor, "vercel", ["deploy", "--yes", "--target", "preview", ...flags], { cwd: checkout });
		const deployment = deployed.stdout
			.trim()
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^https:\/\/\S+\.vercel\.app$/.test(line))
			.pop();
		if (!deployment) fail("vercel deploy printed no deployment URL.");
		store(root, "UPDATE qa_previews SET deployment = ? WHERE id = ?", deployment, p.id);
		tool(redactor, "vercel", ["alias", "set", deployment, aliasHost(p.id), "--scope", VERCEL.orgId], { cwd: checkout });
	} finally {
		spawnSync("git", ["-C", root, "worktree", "remove", "--force", checkout], { encoding: "utf8" });
		rmSync(checkout, { recursive: true, force: true });
	}
}

const age = (from: string, now = Date.now()) => {
	const minutes = Math.max(0, Math.floor((now - Date.parse(from)) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

export function qaList(root: string): number {
	const open = rows(root);
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

/** Removes the alias, the deployment and the Neon branch of one QA preview, then its row. A second call is a no-op. */
export function qaDown(root: string, id: string): number {
	if (!QA_ID.test(id)) fail(`${id} is not a QA preview id (qa-...). See bin/evf qa list.`);
	const redactor = new Redactor();
	const row = rows(root).find((r) => r.id === id);
	const removed: string[] = [];
	if (row?.deployment) {
		tool(redactor, "vercel", ["alias", "rm", aliasHost(id), "--yes", "--scope", VERCEL.orgId], { allow: NOT_FOUND });
		tool(redactor, "vercel", ["remove", row.deployment, "--yes", "--scope", VERCEL.orgId], { allow: NOT_FOUND });
		removed.push("alias", "deployment");
	}
	const branch = neonBranches(redactor).find((b) => b.name === (row?.neon_branch ?? id));
	if (branch) {
		neon(redactor, "branches", "delete", branch.id);
		removed.push(`Neon branch ${branch.name}`);
	}
	if (row) store(root, "DELETE FROM qa_previews WHERE id = ?", id);
	console.log(
		row || branch
			? `Removed QA preview ${id}: ${removed.join(", ") || "its record"}.`
			: `No QA preview ${id}. Nothing to remove.`,
	);
	return 0;
}
