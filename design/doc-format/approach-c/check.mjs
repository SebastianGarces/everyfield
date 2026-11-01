#!/usr/bin/env node
// Validates documents against the approach-C format. No install: node check.mjs [file.json ...]
//
// With no arguments it checks every examples/*.json (each must pass) and every tests/broken/*.json (each must fail,
// which proves the check rejects a bad copy). With file arguments it checks just those files.
// Exit code 0 only when every result is the expected one.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./format.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const list = (dir) =>
	readdirSync(join(here, dir))
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => join(here, dir, name));

function check(file) {
	let doc;
	try {
		doc = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		return { ok: false, errors: [`$: not JSON (${e.message})`] };
	}
	return validate(doc);
}

const args = process.argv.slice(2);
const jobs = args.length
	? args.map((file) => ({ file, expect: "pass" }))
	: [...list("examples").map((file) => ({ file, expect: "pass" })), ...list("tests/broken").map((file) => ({ file, expect: "fail" }))];

let wrong = 0;
for (const { file, expect } of jobs) {
	const result = check(file);
	const got = result.ok ? "pass" : "fail";
	const name = args.length ? file : relative(here, file);
	const note = args.length ? "" : got === expect ? (expect === "fail" ? "  (expected: a broken copy)" : "") : `  (UNEXPECTED: should ${expect})`;
	console.log(`${got === "pass" ? "PASS" : "FAIL"}  ${name}${note}`);
	if (!result.ok) for (const error of result.errors.slice(0, 8)) console.log(`        ${error}`);
	if (!result.ok && result.errors.length > 8) console.log(`        ... ${result.errors.length - 8} more`);
	if (args.length ? !result.ok : got !== expect) wrong += 1;
}
console.log(wrong ? `\n${wrong} unexpected result(s).` : `\nAll ${jobs.length} result(s) as expected.`);
process.exit(wrong ? 1 : 0);
