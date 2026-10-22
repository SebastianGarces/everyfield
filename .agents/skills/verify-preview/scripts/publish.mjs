#!/usr/bin/env node
// Upload a verification evidence folder to the dedicated Tigris evidence bucket with public-read links.
// Usage: node publish.mjs <evidence-dir> --task <task-id>
//        node publish.mjs --delete <task-id>[/<prefix>]   delete one task's evidence, or one upload
//        (the "prefix" value in published.json is accepted as it is)
// Key layout: evf-evidence/<task-id>/<random 32-hex prefix>/<file>.
// Bucket: EVF_EVIDENCE_BUCKET (default everyfield-evidence). Objects are public-read; listing is refused,
// so each link needs its random 128-bit prefix. Credentials: only the evidence env file, EVF_EVIDENCE_ENV
// (default ~/.config/everyfield/evidence.env), which holds a key with Editor on the evidence bucket only.
// It never opens .env.prod. Before any upload or delete it proves the key is evidence-only: listing the
// everyfield and everyfield-dev buckets must return 403. Only four AWS_* keys are read; no value is printed.
// Upload refuses a text file that contains any value from the evidence env file or the main checkout's dev env files.
// It runs only as the committed file inside a checkout of this repository, never as a copy or an edited file.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const target = args[args.indexOf("--delete") + 1]?.replace(/^evf-evidence\//, "");
const deleting = args.includes("--delete");
const dir = resolve(args[0] ?? "");
const task = args[args.indexOf("--task") + 1];
if (deleting ? !/^[A-Za-z0-9._-]+(\/[0-9a-f]{32})?$/.test(target ?? "") : !args[0] || !existsSync(dir) || !args.includes("--task") || !/^[A-Za-z0-9._-]+$/.test(task ?? "")) {
  console.error("Usage: node publish.mjs <evidence-dir> --task <task-id> | --delete <task-id>[/<prefix>]");
  process.exit(2);
}
const SELF = ".agents/skills/verify-preview/scripts/publish.mjs";
const self = realpathSync(fileURLToPath(import.meta.url));
const git = (...a) => {
  try {
    return execFileSync("git", ["-C", dirname(self), ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const top = git("rev-parse", "--show-toplevel");
if (!top || relative(realpathSync(top), self) !== SELF || git("status", "--porcelain", "--", `:/${SELF}`) !== "") {
  console.error(`Refused: run ${SELF} unchanged from a checkout of this repository, not ${self}. Commit an edit before you run it.`);
  process.exit(2);
}
const root = dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir"));

const KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION"];
const BUCKET = process.env.EVF_EVIDENCE_BUCKET ?? "everyfield-evidence";
const PROTECTED = ["everyfield", "everyfield-dev"];
const ENV_FILE = resolve(process.env.EVF_EVIDENCE_ENV ?? join(homedir(), ".config/everyfield/evidence.env"));
// Every env file read goes through here, so a path or symlink that resolves to .env.prod is refused unopened.
const envValues = (file) => {
  if (basename(realpathSync(file)).startsWith(".env.prod")) throw new Error(`Refused: ${file} resolves to a production env file. Use the evidence env file and dev env files only.`);
  return Object.fromEntries(readFileSync(file, "utf8").split("\n").flatMap((line) => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    return m ? [[m[1], m[2].replace(/^(['"])(.*)\1$/, "$2")]] : [];
  }));
};
async function credentials() {
  if (!existsSync(ENV_FILE)) throw new Error(`No evidence credentials at ${ENV_FILE}. Create it as .agents/skills/verify-preview/SKILL.md says, or set EVF_EVIDENCE_ENV.`);
  const all = envValues(ENV_FILE);
  const env = Object.fromEntries(KEYS.map((k) => [k, all[k]]));
  const missing = KEYS.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Evidence credentials missing in ${ENV_FILE}: ${missing.join(", ")} (values not shown).`);
  for (const bucket of PROTECTED) {
    const { status } = await s3(env, "GET", "", { bucket, query: "list-type=2&max-keys=1", check: false });
    if (status !== 403) throw new Error(`Refused: listing ${bucket} with the key in ${ENV_FILE} returned HTTP ${status}, not 403. Use the evidence-only key.`);
  }
  return env;
}

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".webm": "video/webm", ".mp4": "video/mp4", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8", ".mjs": "text/plain; charset=utf-8", ".js": "text/plain; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".zip": "application/zip" };
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function s3(env, method, key, { bucket = BUCKET, query = "", body = "", headers: extra = {}, check = true } = {}) {
  const endpoint = new URL(env.AWS_ENDPOINT_URL_S3);
  const path = "/" + [bucket, ...(key ? key.split("/") : [])].map(encode).join("/");
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = now.slice(0, 8);
  const hash = sha256(body);
  const headers = { ...extra, host: endpoint.host, "x-amz-content-sha256": hash, "x-amz-date": now };
  const names = Object.keys(headers).sort();
  const request = [method, path, query, ...names.map((n) => `${n}:${headers[n]}`), "", names.join(";"), hash].join("\n");
  const scope = `${day}/${env.AWS_REGION}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", now, scope, sha256(request)].join("\n");
  let k = hmac("AWS4" + env.AWS_SECRET_ACCESS_KEY, day);
  for (const part of [env.AWS_REGION, "s3", "aws4_request"]) k = hmac(k, part);
  const signature = createHmac("sha256", k).update(toSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  const { host: _host, ...sent } = headers;
  const res = await fetch(endpoint.origin + path + (query ? `?${query}` : ""), { method, headers: { ...sent, authorization }, body: body || undefined });
  if (check && !res.ok) throw new Error(`${method} ${key || bucket} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { status: res.status, text: await res.text(), url: `${endpoint.protocol}//${bucket}.${endpoint.host}${path.slice(bucket.length + 1)}` };
}

const DEV_ENV = [".env.local", ".env.development.local", "apps/web/.env.local"];
console.error(`publish.mjs: key file ${ENV_FILE}. Checks: the key cannot list ${PROTECTED.join(" or ")}, and no text file holds a value from the key file or ${DEV_ENV.join(", ")}.`);
const env = await credentials();

if (deleting) {
  const prefix = `evf-evidence/${target}/`;
  let deleted = 0;
  for (;;) {
    const page = await s3(env, "GET", "", { query: `list-type=2&max-keys=1000&prefix=${encode(prefix)}` });
    const keys = [...page.text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    for (const key of keys) { await s3(env, "DELETE", key); deleted++; }
    if (!keys.length || !/<IsTruncated>true</.test(page.text)) break;
  }
  console.log(`Deleted ${deleted} objects under ${prefix}`);
  process.exit(0);
}

const files = (function walk(d) {
  return readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
})(dir).map((f) => relative(dir, f)).filter((f) => !/^(published\.json|index\.html)$/.test(f) && !f.split("/").some((p) => p.startsWith(".")));

// A gallery page so the PR comment needs one link: before and after side by side, then every file.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const read = (f) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null);
const ui = read("ui-results.json");
const backend = read("backend-results.json");
const results = ui ?? backend;
const rows = (ui?.shots ?? []).map((s) => `<tr><td>${esc(s.engine)} ${s.width}px<br><code>${esc(s.path)}</code><br>diff ${esc(s.diffPercent ?? "n/a")}%<br>${s.after.checks ? `flow ${s.after.checks.filter((c) => c.pass).length}/${s.after.checks.length}<br>` : ""}<b>${esc(s.verdict)}</b> ${esc(s.failures.join("; "))}</td>` +
  ["before", "after"].map((side) => s[side]?.screenshot ? `<td><a href="${esc(s[side].screenshot)}"><img src="${esc(s[side].screenshot)}" loading="lazy"></a></td>` : "<td>none</td>").join("") + "</tr>").join("\n");
const checks = (backend?.checks ?? []).map((c) => `<tr><td>${c.pass ? "pass" : "FAIL"}</td><td>${esc(c.check)}</td><td><code>${esc(c.detail ?? "")}</code></td></tr>`).join("\n");
const videos = files.filter((f) => /\.(webm|mp4)$/.test(f)).map((f) => `<figure><video src="${esc(f)}" controls muted width="480"></video><figcaption>${esc(f)}</figcaption></figure>`).join("\n");
writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><title>${esc(task)} verification evidence</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:6px;vertical-align:top}img{width:420px;height:560px;object-fit:cover;object-position:top}</style>
<h1>${esc(task)} verification evidence</h1>${results ? `<p>Head <code>${esc(results.after?.head)}</code>${ui ? ` versus main <code>${esc(ui.before.head)}</code>` : ""}. UI: <b>${esc(ui?.verdict ?? "not run")}</b>. Backend: <b>${esc(backend?.verdict ?? "not run")}</b>.</p>` : ""}
${checks ? `<table><tr><th>Result</th><th>Check</th><th>Detail</th></tr>${checks}</table>` : ""}
${rows ? `<table><tr><th>Shot</th><th>Before (main)</th><th>After (branch)</th></tr>${rows}</table>` : ""}${videos}
<h2>Files</h2><ul>${files.map((f) => `<li><a href="${esc(f)}">${esc(f)}</a></li>`).join("")}</ul>`);

// Refuse to publish any local env value (credentials, tokens, connection strings) found in a text file.
const secrets = [ENV_FILE, ...DEV_ENV.map((f) => join(root, f))].filter(existsSync)
  .flatMap((f) => Object.values(envValues(f))).filter((v) => v.length >= 12);
const leaks = [...files, "index.html"].filter((f) => !/\.(png|jpg|webm|mp4|zip)$/.test(f)).filter((f) => {
  const text = readFileSync(join(dir, f), "utf8");
  return secrets.some((v) => text.includes(v)) || /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]{8,}@/.test(text);
});
if (leaks.length) throw new Error(`Refused: ${leaks.join(", ")} contain a credential or connection string (value not shown). Remove it and publish again.`);

const prefix = `evf-evidence/${task}/${randomBytes(16).toString("hex")}`;
const links = {};
for (const f of [...files, "index.html"]) {
  const type = TYPES[extname(f)] ?? "application/octet-stream";
  links[f] = (await s3(env, "PUT", `${prefix}/${f}`, { body: readFileSync(join(dir, f)), headers: { "content-type": type, "x-amz-acl": "public-read" } })).url;
}
const probe = await fetch(links["index.html"]);
if (!probe.ok) throw new Error(`Uploaded index is not publicly readable: HTTP ${probe.status}`);
const listing = await fetch(links["index.html"].replace(/\/evf-evidence\/.*$/, "/?list-type=2"));
if (listing.ok) throw new Error("The evidence bucket allows anonymous listing; fix the bucket before sharing links.");
const published = { index: links["index.html"], prefix, files: links };
writeFileSync(join(dir, "published.json"), JSON.stringify(published, null, 2) + "\n");
console.log(JSON.stringify({ index: published.index, files: Object.keys(links).length }, null, 2));
