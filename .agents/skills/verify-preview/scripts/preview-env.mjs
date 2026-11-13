// Compose a preview's env. Pure functions: no file writes, no values printed.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

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

/** The env of a composed preview config. Portless replaces ${PREVIEW_URL} with the preview's own URL, so sign-in
 *  trusts the preview whatever IDENTITY_ORIGIN the env files hold. `configEnv` (an explicit --config's env) wins. */
export function composePreviewEnv(env, fixed, configEnv = {}) {
  return { ...env, IDENTITY_ORIGIN: "${PREVIEW_URL}", ...fixed, ...configEnv };
}
