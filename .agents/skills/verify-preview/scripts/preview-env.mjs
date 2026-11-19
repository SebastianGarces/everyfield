import { randomBytes } from "node:crypto";
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

export function identityDefaults(present) {
  const key = () => randomBytes(32).toString("hex");
  const unreachable = "postgres://preview-unconfigured@127.0.0.1:1/unconfigured";
  const defaults = {
    IDENTITY_DATABASE_URL: unreachable,
    IDENTITY_AUTH_DATABASE_URL: unreachable,
    IDENTITY_SECRET: key(),
    IDENTITY_MAIL_KEY: key(),
    IDENTITY_ADDRESS_KEY: key(),
    IDENTITY_MAIL_FROM: "preview@example.test",
  };
  return Object.fromEntries(Object.entries(defaults).filter(([name]) => !present[name]));
}

export function composePreviewEnv(env, fixed, configEnv = {}) {
  return { ...identityDefaults(env), ...env, IDENTITY_ORIGIN: "${PREVIEW_URL}", ...fixed, ...configEnv };
}
