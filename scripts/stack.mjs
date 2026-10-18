import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const help = `Local preview commands, Node 24 and managed Portless required:
  corepack pnpm stack:up [--mode development|production]
  corepack pnpm stack:status
  corepack pnpm stack:check
  corepack pnpm stack:down
Optional --project PATH selects another worktree. Production requires a clean commit.
Status and check print JSON. Down preserves the worktree. See apps/web/README.md.`;

function portless(args) {
	const result = spawnSync("portless", ["preview", ...args, "--json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	if (result.error) throw new Error("Cannot run managed Portless. Run portless preview --help to check installation.");
	if (result.status !== 0)
		throw new Error("Portless command failed. Inspect portless preview logs for the preview ID.");
	return JSON.parse(result.stdout);
}

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { project: { type: "string" }, mode: { type: "string" }, help: { type: "boolean" } },
	});
	if (values.help) return console.log(help);
	const [action] = positionals;
	if (positionals.length !== 1 || !["up", "status", "down", "check"].includes(action)) throw new Error(help);
	if (values.mode && action !== "up") throw new Error("--mode is only valid with up.");
	const mode = values.mode ?? "development";
	if (!["development", "production"].includes(mode)) throw new Error("Choose development or production mode.");
	const project = realpathSync(
		resolve(values.project ?? process.env.EVF_WORKTREE ?? join(dirname(fileURLToPath(import.meta.url)), "..")),
	);
	const records = portless(["status"]);
	if (!Array.isArray(records)) throw new Error("Portless status must return an array.");
	const previews = records.filter((p) => p.project === project && !["removed", "failed"].includes(p.state));
	if (previews.length > 1)
		throw new Error("Multiple previews use this worktree. Stop the extra preview IDs with Portless before continuing.");
	let preview = previews[0];
	if (action === "up") {
		if (preview && preview.mode !== mode) throw new Error("Stop this worktree's preview before changing mode.");
		preview = portless(["up", "--project", project, "--mode", mode, "--config", join(project, "scripts/preview.json")]);
	} else if (action === "down" && preview) {
		portless(["down", preview.id]);
		preview = undefined;
	}
	const info = preview
		? Object.fromEntries(["id", "project", "head", "branch", "mode", "state", "url"].map((key) => [key, preview[key]]))
		: { project, state: "stopped" };
	if (process.env.EVF_RUNTIME_DIR) {
		const file = join(process.env.EVF_RUNTIME_DIR, "stack.json");
		if (preview) {
			mkdirSync(process.env.EVF_RUNTIME_DIR, { recursive: true });
			writeFileSync(file, JSON.stringify(info) + "\n", { mode: 0o600 });
		} else rmSync(file, { force: true });
	}
	if (action === "check") {
		if (preview?.state !== "ready") throw new Error("This worktree has no ready preview. Run stack:up first.");
		const git = spawnSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" });
		if (git.status !== 0 || git.stdout.trim() !== preview.head)
			throw new Error("Preview commit differs from HEAD. Stop and recreate the preview.");
		const url = new URL(preview.url);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			!(url.hostname === "localhost" || url.hostname.endsWith(".localhost"))
		)
			throw new Error("Preview must use a local Portless URL.");
		const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
		await response.body?.cancel();
		if (response.status !== 200) throw new Error(`Preview returned HTTP ${response.status}, expected 200.`);
		info.httpStatus = response.status;
	}
	console.log(JSON.stringify(info));
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
