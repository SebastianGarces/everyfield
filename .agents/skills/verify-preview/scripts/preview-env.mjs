// Compose a preview's env. Pure functions: no file writes, no values printed.
import { existsSync, readFileSync } from "node:fs";

/** Parse a dotenv file: KEY=VALUE lines, optional `export`, optional quotes, `#` comment lines. */
export function parseEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

/** The main checkout's file is the base; the worktree's own file, a seed's IDENTITY_* keys or a full copy, overrides it. */
export function composeEnv(mainFile, worktreeFile) {
  const read = (f) => (existsSync(f) ? parseEnv(readFileSync(f, "utf8")) : {});
  return { ...read(mainFile), ...read(worktreeFile) };
}

/** Throw unless DATABASE_URL points at a shared development host. The message never holds a value. */
export function assertDevelopmentDatabase(env, devHosts) {
  let host = "";
  try { host = new URL(env.DATABASE_URL).hostname; } catch { /* refused below */ }
  if (!devHosts.length || !devHosts.includes(host))
    throw new Error("Refused: the composed preview env DATABASE_URL is not the shared development database (value not shown).");
}
