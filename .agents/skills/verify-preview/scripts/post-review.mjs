#!/usr/bin/env node
// Post the one verification comment: the report followed by the exact-head EVF-Review line.
// Usage: node post-review.mjs --pr <n> --report <report.md> --family openai|anthropic
//          --verdict approved|changes_requested --head <40-char sha> [--results <results.json> ...] [--dry-run]
// Refuses a head that is not the PR's current head, a same-family review, and an approval
// when any results file has a failing verdict.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const value = (n) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const all = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const [pr, reportFile, family, verdict, head] = ["pr", "report", "family", "verdict", "head"].map(value);
const refuse = (why) => { console.error(`Refused: ${why}`); process.exit(1); };
if (!pr || !reportFile || !head) refuse("usage: --pr <n> --report <file> --family <f> --verdict <v> --head <sha>");
if (!["openai", "anthropic"].includes(family)) refuse("--family must be openai or anthropic");
if (!["approved", "changes_requested"].includes(verdict)) refuse("--verdict must be approved or changes_requested");
if (!/^[0-9a-f]{40}$/.test(head)) refuse("--head must be the full 40-character SHA you verified");

const view = JSON.parse(execFileSync("gh", ["pr", "view", pr, "--json", "headRefOid,body,url"], { encoding: "utf8" }));
if (view.headRefOid !== head) refuse(`PR head is ${view.headRefOid}, you verified ${head}. Verify the current head.`);
const author = /^EVF-Author:\s*(\w+)\s*$/m.exec(view.body)?.[1];
if (!author) refuse("PR body has no EVF-Author line");
if (author === family) refuse(`author family is ${author}; a verifier of the other family must review`);
for (const file of all("results")) {
  const r = JSON.parse(readFileSync(file, "utf8"));
  if (r.after?.head && r.after.head !== head) refuse(`${file} was captured on ${r.after.head}, not ${head}`);
  if (verdict === "approved" && r.verdict !== "pass") refuse(`${file} verdict is ${r.verdict}; approval needs every check to pass`);
}
const report = readFileSync(reportFile, "utf8").trim();
if (/^EVF-Review:/m.test(report)) refuse("the report already has an EVF-Review line; this script adds it");
if (verdict === "approved" && /\b(FAIL|❌)\b|❌/.test(report)) refuse("the report lists a failure; approve only when everything passes");

const body = `${report}\n\nEVF-Review: ${JSON.stringify({ head, verifierFamily: family, verdict })}\n`;
const file = join(tmpdir(), `evf-review-${pr}-${head.slice(0, 7)}.md`);
writeFileSync(file, body);
if (argv.includes("--dry-run")) { console.log(body); process.exit(0); }
console.log(execFileSync("gh", ["pr", "comment", pr, "--body-file", file], { encoding: "utf8" }).trim());
