import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export function composeEnv(mainFile, worktreeFile) {
  const read = (f) => (existsSync(f) ? parseEnv(readFileSync(f, "utf8")) : {});
  return { ...read(mainFile), ...read(worktreeFile) };
}

export function assertDevelopmentDatabase(env, devHosts) {
  let host = "";
  try { host = new URL(env.DATABASE_URL).hostname; } catch { }
  if (!devHosts.length || !devHosts.includes(host))
    throw new Error("Refused: the composed preview env DATABASE_URL is not the shared development database (value not shown).");
}

export function composePreviewEnv(env, fixed, configEnv = {}) {
  return { ...env, IDENTITY_ORIGIN: "${PREVIEW_URL}", ...fixed, ...configEnv };
}
