import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { evfDataDir, git, hasRemote, isClean, loadConfig, loadDag, run } from "./lib.ts";
import { principlesStatus } from "./principles.ts";

type Level = "PASS" | "WARN" | "FAIL";

export function doctor(root: string): number {
  const results: Array<[Level, string]> = [];
  const check = (ok: boolean, pass: string, problem: string, level: Level = "FAIL") => results.push(ok ? ["PASS", pass] : [level, problem]);

  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 24, `node ${process.versions.node}`, `node ${process.versions.node}; evf and Portless need Node 24+`);

  const cfg = loadConfig(root);
  check(Array.isArray(cfg.checks) && cfg.checks.length > 0, `evf.config.json has ${cfg.checks.length} checks`, "evf.config.json has no checks");

  const agents = join(root, "AGENTS.md");
  if (existsSync(agents)) {
    const text = readFileSync(agents, "utf8");
    const lines = text.split("\n").length;
    check(lines <= cfg.maxAgentsMdLines, `AGENTS.md is ${lines} lines (budget ${cfg.maxAgentsMdLines})`, `AGENTS.md is ${lines} lines; budget is ${cfg.maxAgentsMdLines}. Move detail into a skill.`);
    const refs = [...text.matchAll(/`((?:docs|\.agents|tools|bin)\/[^`\s*<>]+|evf\.config\.json)`/g)].map((m) => m[1]);
    const dead = [...new Set(refs)].filter((r) => !/NNN/.test(r) && !existsSync(join(root, r)));
    check(dead.length === 0, `AGENTS.md links resolve (${refs.length})`, `AGENTS.md has dead paths: ${dead.join(", ")}`);
  } else check(false, "", "AGENTS.md is missing");

  const link = join(root, ".claude/skills");
  const isLink = existsSync(link) && lstatSync(link).isSymbolicLink();
  check(isLink && readlinkSync(link) === "../.agents/skills", ".claude/skills -> ../.agents/skills", ".claude/skills must be a symlink to ../.agents/skills");

  const ignore = existsSync(join(root, ".gitignore")) ? readFileSync(join(root, ".gitignore"), "utf8") : "";
  check(/^\/?\.worktrees\/?$/m.test(ignore), ".gitignore excludes .worktrees/", ".gitignore must contain .worktrees/ (Intent auto-commit would pick up task worktrees)");

  const skillsDir = join(root, ".agents/skills");
  const bad: string[] = [];
  let count = 0;
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    const f = join(skillsDir, name, "SKILL.md");
    if (!existsSync(f)) continue;
    count++;
    const head = readFileSync(f, "utf8").split("\n---")[0];
    if (!new RegExp(`^name:\\s*["']?${name}["']?\\s*$`, "m").test(head) || !/^description:/m.test(head)) bad.push(name);
  }
  check(count > 0 && bad.length === 0, `${count} skills have valid frontmatter`, `skills with missing or mismatched name/description: ${bad.join(", ") || "(no skills found)"}`);

  const lockPath = join(root, "skills-lock.json");
  const lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as { skills: Record<string, { sha256?: string }> }).skills : {};
  const pinned = Object.entries(lock).filter(([, v]) => v.sha256);
  const edited = pinned.filter(([name, v]) => {
    const f = join(skillsDir, name, "SKILL.md");
    return !existsSync(f) || createHash("sha256").update(readFileSync(f)).digest("hex") !== v.sha256;
  });
  check(pinned.length > 0 && edited.length === 0, `${pinned.length} verbatim skills match skills-lock.json`, `verbatim skills changed or missing (put adaptations in .agents/roles/ instead): ${edited.map(([n]) => n).join(", ") || "(none pinned)"}`);

  const principleDirs = (existsSync(skillsDir) ? readdirSync(skillsDir) : []).filter((n) => n.startsWith("principle-")).map((n) => n.slice("principle-".length));
  const agentsText = existsSync(agents) ? readFileSync(agents, "utf8") : "";
  const unlisted = principleDirs.filter((p) => !agentsText.includes(`- \`${p}\`:`));
  check(unlisted.length === 0, `AGENTS.md lists all ${principleDirs.length} principles`, `AGENTS.md principle list is missing: ${unlisted.join(", ")}`);

  const upstream = principlesStatus(root);
  results.push([upstream.level, upstream.message]);

  const roleNames = ["coordinator", "implementor", "ui-designer", "verifier"];
  const roles = roleNames.filter((r) => !existsSync(join(root, ".agents/roles", `${r}.md`)));
  check(roles.length === 0, "role additions present", `missing role files: ${roles.join(", ")}`);
  const badRefs = roleNames
    .filter((r) => !roles.includes(r))
    .flatMap((r) => [...readFileSync(join(root, ".agents/roles", `${r}.md`), "utf8").matchAll(/principle-([a-z-]+[a-z])/g)].map((m) => `${r}:${m[1]}`))
    .filter((ref) => !principleDirs.includes(ref.split(":")[1]));
  check(badRefs.length === 0, "role files name existing principles", `role files name unknown principles: ${badRefs.join(", ")}`);

  const dag = loadDag(root);
  const ids = new Set(dag.packages.map((p) => p.id));
  const missing = dag.packages.flatMap((p) => p.depends_on.filter((d) => !ids.has(d)));
  check(missing.length === 0, `dag.json: ${ids.size} packages, prerequisites resolve`, `dag.json has unknown prerequisites: ${missing.join(", ")}`);

  check(run("gh", ["--version"]).code === 0, "gh installed", "gh is not installed");
  check(run("portless", ["preview", "--help"]).code === 0, "portless preview available", "portless preview is not available", "WARN");
  check(hasRemote(root, cfg), `remote "${cfg.remote}" configured`, `no "${cfg.remote}" remote yet; pr/ship/github commands are unavailable`, "WARN");
  check(isClean(root), "workspace root is clean", "workspace root has uncommitted changes", "WARN");

  const wtRoot = join(root, cfg.worktreeDir);
  const open = existsSync(wtRoot) ? readdirSync(wtRoot) : [];
  results.push(["PASS", `${open.length} task worktree(s) open${open.length ? `: ${open.join(", ")}` : ""}`]);
  results.push(["PASS", `evf data: ${evfDataDir(root)} (git ${git(root, "rev-parse", "--short", "HEAD")})`]);

  for (const [lvl, msg] of results) console.log(`${lvl.padEnd(4)}  ${msg}`);
  return results.some(([l]) => l === "FAIL") ? 1 : 0;
}

export function gc(root: string, apply: boolean): number {
  const cfg = loadConfig(root);
  const wtRoot = join(root, cfg.worktreeDir);
  const shipped = join(evfDataDir(root), "shipped");
  for (const slug of existsSync(wtRoot) ? readdirSync(wtRoot) : []) {
    const wt = join(wtRoot, slug);
    const done = existsSync(join(shipped, `${slug}.json`));
    const clean = isClean(wt);
    const verdict = done && clean ? "remove (shipped, clean)" : done ? "keep (shipped but dirty)" : "keep (not shipped)";
    console.log(`${slug}: ${verdict}`);
    if (apply && done && clean) {
      const r = run("git", ["worktree", "remove", wt], { cwd: root });
      console.log(r.code === 0 ? `  removed. Call ws.git.unregisterRoot(${JSON.stringify(wt)}).` : `  failed: ${r.stderr.trim()}`);
    }
  }
  run("git", ["worktree", "prune"], { cwd: root });
  console.log(apply ? "Run `portless preview gc --apply` to stop expired previews." : "Dry run. Add --apply to remove. Also see `portless preview gc`.");
  return 0;
}
