#!/usr/bin/env node
// Post the one verification comment: the report followed by the exact-head EVF-Review line.
// Usage: node post-review.mjs --pr <n> --report <report.md> --session <your Claude Code session UUID> --model <model id>
//          [--role verifier] --verdict approved|changes_requested --head <40-char sha>
//          --experience-verdict approved|changes_requested --budget met|exceeded|not_applicable
//          [--experience-exception reports|analytics]
//          --quality-verdict approved|changes_requested --principles <comma-separated names> [--results <results.json> ...] [--dry-run]
// Refuses a head that is not the PR's current head, a verifier ship refuses (D82: the author's own session,
// a non-verifier seat or a non-Opus model), and an approval when any results file has a failing verdict.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const value = (n) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const all = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const [pr, reportFile, verdict, head] = ["pr", "report", "verdict", "head"].map(value);
const verifier = { session: value("session"), model: value("model"), role: value("role") ?? "verifier" };
const quality = { verdict: value("quality-verdict"), principles: value("principles")?.split(",").map((name) => name.trim()) };
const experience = { verdict: value("experience-verdict"), budget: value("budget"), ...(value("experience-exception") ? { exception: value("experience-exception") } : {}) };
const refuse = (why) => { console.error(`Refused: ${why}`); process.exit(1); };
if (!pr || !reportFile || !head) refuse("usage: --pr <n> --report <file> --session <uuid> --model <id> --verdict <v> --head <sha>");
// Same shapes as readParty and independentReview in tools/evf/lib.ts.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (!verifier.session || !SESSION_ID.test(verifier.session)) refuse("--session must be your Claude Code session UUID in lowercase (herdr agent get <you> shows it as agent_session.value)");
if (!verifier.model || !/^[a-z][a-z0-9.-]*$/.test(verifier.model)) refuse("--model must be the model id, such as claude-opus-5-5");
if (!/^[a-z][a-z0-9-]*$/.test(verifier.role)) refuse("--role must be the seat role");
if (!["approved", "changes_requested"].includes(verdict)) refuse("--verdict must be approved or changes_requested");
if (!["approved", "changes_requested"].includes(quality.verdict)) refuse("--quality-verdict must be approved or changes_requested");
if (!quality.principles?.length || quality.principles.some((name) => !name)) refuse("--principles must name the principles checked, separated by commas");
const requiredPrinciples = ["laziness-protocol", "minimize-reader-load", "subtract-before-you-add", "test-behavior-not-implementation"];
const missingPrinciples = requiredPrinciples.filter((name) => !quality.principles.includes(name));
if (missingPrinciples.length) refuse(`--principles is missing required names: ${missingPrinciples.join(", ")}`);
if (verdict === "approved" && quality.verdict !== "approved") refuse("approval needs an approved code quality review");
if (!["approved", "changes_requested"].includes(experience.verdict)) refuse("--experience-verdict must be approved or changes_requested");
if (!["met", "exceeded", "not_applicable"].includes(experience.budget)) refuse("--budget must be met, exceeded or not_applicable");
if (experience.exception && !["reports", "analytics"].includes(experience.exception)) refuse("--experience-exception must be reports or analytics");
if (verdict === "approved" && experience.verdict !== "approved") refuse("approval needs an approved experience review");
if (!/^[0-9a-f]{40}$/.test(head)) refuse("--head must be the full 40-character SHA you verified");

const view = JSON.parse(execFileSync("gh", ["pr", "view", pr, "--json", "headRefOid,body,url"], { encoding: "utf8" }));
if (view.headRefOid !== head) refuse(`PR head is ${view.headRefOid}, you verified ${head}. Verify the current head.`);
if (verdict === "approved" && experience.budget === "exceeded" && (!experience.exception || !view.body.split(/\r?\n/).includes(`EVF-Experience-Exception: ${experience.exception}`))) refuse("exceeded budget needs the matching approved reports or analytics exception in the PR body");
const authorLine = /^EVF-Author:(.*)$/m.exec(view.body)?.[1];
if (!authorLine) refuse("PR body has no EVF-Author line");
let author;
try { author = JSON.parse(authorLine); } catch { author = null; }
if (!author || typeof author !== "object" || !SESSION_ID.test(String(author.session)) || typeof author.model !== "string" || typeof author.role !== "string")
	refuse('EVF-Author must be {"session":"<Claude Code session UUID>","model":"<model id>","role":"<seat role>"}');
if (author.session === verifier.session) refuse("you are the author session; an independent session must review");
if (verifier.role !== "verifier") refuse(`your role is ${verifier.role}; only the verifier seat reviews`);
if (author.role === "verifier") refuse("the author role is verifier; a verifier seat does not author work");
if (!/^claude-opus-/.test(verifier.model)) refuse(`your model is ${verifier.model}; only an Opus model reviews`);
for (const file of all("results")) {
  const r = JSON.parse(readFileSync(file, "utf8"));
  if (r.after?.head && r.after.head !== head) refuse(`${file} was captured on ${r.after.head}, not ${head}`);
  if (verdict === "approved" && r.verdict !== "pass") refuse(`${file} verdict is ${r.verdict}; approval needs every check to pass`);
}
const report = readFileSync(reportFile, "utf8").trim();
if (!/^## Code quality\s*$/m.test(report)) refuse("the report needs a Code quality section with concrete simplifications and a verdict");
if (!/^## Experience\s*$/m.test(report)) refuse("the report needs an Experience section with timings, optimistic updates and request counts, or a reason they do not apply");
if (/^EVF-Review:/m.test(report)) refuse("the report already has an EVF-Review line; this script adds it");
if (verdict === "approved" && /\b(FAIL|❌)\b|❌/.test(report)) refuse("the report lists a failure; approve only when everything passes");

const body = `${report}\n\nEVF-Review: ${JSON.stringify({ head, verifier, verdict, quality, experience })}\n`;
const file = join(tmpdir(), `evf-review-${pr}-${head.slice(0, 7)}.md`);
writeFileSync(file, body);
if (argv.includes("--dry-run")) { console.log(body); process.exit(0); }
console.log(execFileSync("gh", ["pr", "comment", pr, "--body-file", file], { encoding: "utf8" }).trim());
