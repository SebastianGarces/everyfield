#!/usr/bin/env node
// Upload a verification evidence folder to the dedicated Tigris evidence bucket with public-read links.
// Usage: node publish.mjs <evidence-dir> --task <task-id>
//        node publish.mjs --delete <task-id>[/<prefix>]   delete one task's evidence, or one upload
// Key layout: evf-evidence/<task-id>/<random 32-hex prefix>/<file>.
// Bucket: EVF_EVIDENCE_BUCKET (default everyfield-evidence). Objects are public-read; listing is refused,
// so each link needs its random 128-bit prefix. Credentials: AWS_* from the environment, else from
// EVF_EVIDENCE_ENV or <main checkout>/.env.prod. Only four AWS_* keys are read; no value is printed.
// Upload refuses a text file that contains any value from the main checkout's env files.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const target = args[args.indexOf("--delete") + 1];
const deleting = args.includes("--delete");
const dir = resolve(args[0] ?? "");
const task = args[args.indexOf("--task") + 1];
if (deleting ? !/^[A-Za-z0-9._-]+(\/[0-9a-f]{32})?$/.test(target ?? "") : !args[0] || !existsSync(dir) || !args.includes("--task") || !/^[A-Za-z0-9._-]+$/.test(task ?? "")) {
  console.error("Usage: node publish.mjs <evidence-dir> --task <task-id> | --delete <task-id>[/<prefix>]");
  process.exit(2);
}
const root = dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());

const KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION"];
const BUCKET = process.env.EVF_EVIDENCE_BUCKET ?? "everyfield-evidence";
function credentials() {
  const env = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  if (KEYS.every((k) => env[k])) return env;
  const file = process.env.EVF_EVIDENCE_ENV ?? join(root, ".env.prod");
  if (!existsSync(file)) throw new Error(`No evidence credentials: set AWS_* or EVF_EVIDENCE_ENV (looked at ${file}).`);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && KEYS.includes(m[1]) && !env[m[1]]) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  const missing = KEYS.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Evidence credentials missing: ${missing.join(", ")} (values not shown).`);
  return env;
}

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".webm": "video/webm", ".mp4": "video/mp4", ".json": "application/json; charset=utf-8", ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8", ".mjs": "text/plain; charset=utf-8", ".js": "text/plain; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".zip": "application/zip" };
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function s3(env, method, key, { query = "", body = "", headers: extra = {} } = {}) {
  const endpoint = new URL(env.AWS_ENDPOINT_URL_S3);
  const path = "/" + [BUCKET, ...(key ? key.split("/") : [])].map(encode).join("/");
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
  if (!res.ok) throw new Error(`${method} ${key || BUCKET} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { text: await res.text(), url: `${endpoint.protocol}//${BUCKET}.${endpoint.host}${path.slice(BUCKET.length + 1)}` };
}

if (deleting) {
  const env = credentials();
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
const secrets = [".env.prod", ".env.local", ".env.development.local", "apps/web/.env.local"].map((f) => join(root, f)).filter(existsSync)
  .flatMap((f) => readFileSync(f, "utf8").split("\n").map((l) => /^[A-Z0-9_]+=(.*)$/.exec(l.trim())?.[1]?.replace(/^(['"])(.*)\1$/, "$2") ?? ""))
  .filter((v) => v.length >= 12);
const leaks = [...files, "index.html"].filter((f) => !/\.(png|jpg|webm|mp4|zip)$/.test(f)).filter((f) => {
  const text = readFileSync(join(dir, f), "utf8");
  return secrets.some((v) => text.includes(v)) || /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]{8,}@/.test(text);
});
if (leaks.length) throw new Error(`Refused: ${leaks.join(", ")} contain a credential or connection string (value not shown). Remove it and publish again.`);

const env = credentials();
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
