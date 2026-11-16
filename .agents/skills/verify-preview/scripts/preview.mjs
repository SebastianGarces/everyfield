#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { wrapSetupCommands } from "../../../../scripts/setup-step.mjs";
import { assertDevelopmentDatabase, composeEnv, composePreviewEnv } from "./preview-env.mjs";
import { ensurePreviewSlot } from "./preview-slots.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const common = git(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir");
const root = dirname(common);

let sha = null;
if (value("pr")) {
  sha = JSON.parse(execFileSync("gh", ["pr", "view", value("pr"), "--json", "headRefOid"], { encoding: "utf8" })).headRefOid;
  git(root, "fetch", "--quiet", "origin", `pull/${value("pr")}/head`);
} else if (flag("main") || value("ref")) {
  git(root, "fetch", "--quiet", "origin", "main");
  sha = git(root, "rev-parse", `${value("ref") ?? "origin/main"}^{commit}`);
}
let project = sha ? join(root, ".worktrees", `verify-${sha.slice(0, 7)}`) : argv[0] && !argv[0].startsWith("--") ? resolve(argv[0]) : null;
if (sha && !existsSync(project)) git(root, "worktree", "add", "-B", `verify/${sha.slice(0, 7)}`, project, sha);
if (!project) {
  console.error("Usage: node preview.mjs --pr <n> | --main | --ref <sha> | <worktree> [--mode development] [--config file]");
  process.exit(2);
}
const mode = value("mode") ?? "production";
if (mode === "production" && git(project, "status", "--porcelain")) throw new Error(`${project} has uncommitted changes; production previews need a clean commit.`);

const env = composeEnv(join(root, "apps/web/.env.local"), join(project, "apps/web/.env.local"));
git(root, "fetch", "--quiet", "origin", "main");
const resetScript = git(root, "show", "origin/main:packages/db/scripts/reset-dev.ts");
const devHosts = [...(/developmentHosts = new Set\(\[([^\]]+)\]/.exec(resetScript)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
assertDevelopmentDatabase(env, devHosts);

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
const timed = wrapSetupCommands(base, { source: "verify-preview", records: process.env.EVF_SETUP_STEPS_DIR ?? join(common, "evf-setup-steps"), node: node24 });
const composed = { ...timed, env: composePreviewEnv(env, { NEXT_TELEMETRY_DISABLED: "1", CI: "true", PATH: `${dirname(node24)}:${process.env.PATH}` }, base.env) };
mkdirSync(join(common, "evf-evidence"), { recursive: true });
const config = join(common, "evf-evidence", `verify-preview-${basename(project)}.json`);
writeFileSync(config, JSON.stringify(composed, null, 2), { mode: 0o600 });
chmodSync(config, 0o600);

await ensurePreviewSlot({ project });
const up = JSON.parse(execFileSync("portless", ["preview", "up", "--project", project, "--mode", mode, "--config", config, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, PATH: `${dirname(node24)}:${process.env.PATH}` } }));
execFileSync("portless", ["preview", "renew", up.id, "--ttl", "7200"], { stdio: "ignore" });
console.log(JSON.stringify({ id: up.id, url: up.url, head: up.head, mode: up.mode, state: up.state, project }, null, 2));
