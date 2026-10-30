#!/usr/bin/env node
// Start a portless production preview on the shared development database.
// Usage: node preview.mjs --pr <n>              preview the PR's current head in a detached verify worktree
//        node preview.mjs --main                 preview origin/main the same way (the "before")
//        node preview.mjs --ref <sha>            preview another commit the same way (for example a PR's old base)
//        node preview.mjs <worktree>             preview an existing worktree (authors)
//        [--mode development] [--config <file>]  development serves live edits; --config overrides commands (its env wins)
// Prints {id, url, head, mode, project}. Refuses an env whose DATABASE_URL is not the dev branch.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { assertDevelopmentDatabase, composeEnv, composePreviewEnv } from "./preview-env.mjs";
import { ensurePreviewSlot } from "./preview-slots.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const common = git(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir");
const root = dirname(common);

// The verifier previews its own detached worktree of an exact commit, never the author's checkout.
let sha = null;
if (value("pr")) {
  sha = JSON.parse(execFileSync("gh", ["pr", "view", value("pr"), "--json", "headRefOid"], { encoding: "utf8" })).headRefOid;
  git(root, "fetch", "--quiet", "origin", `pull/${value("pr")}/head`);
} else if (flag("main") || value("ref")) {
  git(root, "fetch", "--quiet", "origin", "main");
  sha = git(root, "rev-parse", `${value("ref") ?? "origin/main"}^{commit}`);
}
let project = sha ? join(root, ".worktrees", `verify-${sha.slice(0, 7)}`) : argv[0] && !argv[0].startsWith("--") ? resolve(argv[0]) : null;
if (sha && !existsSync(project)) git(root, "worktree", "add", "--detach", project, sha);
if (!project) {
  console.error("Usage: node preview.mjs --pr <n> | --main | --ref <sha> | <worktree> [--mode development] [--config file]");
  process.exit(2);
}
const mode = value("mode") ?? "production";
if (mode === "production" && git(project, "status", "--porcelain")) throw new Error(`${project} has uncommitted changes; production previews need a clean commit.`);

// The preview's env is the main checkout's apps/web/.env.local with the worktree's own file (a tests/ui seed's
// IDENTITY_* keys, or a full copy) laid over it. The worktree's file is only read, never created, edited or deleted,
// so a seed's own up and down keep working. The composed env goes to a private config outside the repository.
const env = composeEnv(join(root, "apps/web/.env.local"), join(project, "apps/web/.env.local"));
// The dev host allowlist has one source: main's reset script, which only runs on the dev database.
git(root, "fetch", "--quiet", "origin", "main");
const resetScript = git(root, "show", "origin/main:packages/db/scripts/reset-dev.ts");
const devHosts = [...(/developmentHosts = new Set\(\[([^\]]+)\]/.exec(resetScript)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
assertDevelopmentDatabase(env, devHosts);

// Portless needs Node 24+. Pin the newest installed Node 24 so commands do not depend on the caller's PATH.
const nvm = join(homedir(), ".nvm/versions/node");
const node24 = Number(process.versions.node.split(".")[0]) >= 24 ? process.execPath
  : existsSync(nvm) && readdirSync(nvm).filter((v) => /^v2[4-9]\./.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((v) => join(nvm, v, "bin/node")).pop();
if (!node24) throw new Error("Node 24+ is required for portless previews.");
const next = [node24, "apps/web/node_modules/next/dist/bin/next"];
const base = value("config") ? JSON.parse(readFileSync(resolve(value("config")), "utf8")) : {
  install: ["corepack", "pnpm", "install", "--frozen-lockfile"],
  dev: [...next, "dev", "apps/web", "--hostname", "127.0.0.1"],
  build: [...next, "build", "apps/web"],
  start: [...next, "start", "apps/web", "--hostname", "127.0.0.1"],
  timeoutSeconds: 300,
};
// Process env wins over any .env file in the app, so production snapshots and development mode both see it.
const composed = { ...base, env: composePreviewEnv(env, { NEXT_TELEMETRY_DISABLED: "1", CI: "true", PATH: `${dirname(node24)}:${process.env.PATH}` }, base.env) };
mkdirSync(join(common, "evf-evidence"), { recursive: true });
const config = join(common, "evf-evidence", `verify-preview-${basename(project)}.json`);
writeFileSync(config, JSON.stringify(composed, null, 2), { mode: 0o600 });
chmodSync(config, 0o600);

// A full pool makes the seat wait for a slot (and frees orphans first) instead of failing the proof step.
await ensurePreviewSlot({ project, root, common });
const up = JSON.parse(execFileSync("portless", ["preview", "up", "--project", project, "--mode", mode, "--config", config, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, PATH: `${dirname(node24)}:${process.env.PATH}` } }));
execFileSync("portless", ["preview", "renew", up.id, "--ttl", "7200"], { stdio: "ignore" });
console.log(JSON.stringify({ id: up.id, url: up.url, head: up.head, mode: up.mode, state: up.state, project }, null, 2));
