#!/usr/bin/env node
// Validate everyfield.doc/1 files. No install step: Node 22+ standard library only.
//   node validate.mjs                 check every example (must pass) and every invalid sample (must fail as expected)
//   node validate.mjs <file> [...]    check the given files; exit 1 when any file is invalid
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./format.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, "schema.json"), "utf8"));

function check(file) {
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		return { ok: false, errors: [`(file): not readable JSON: ${e.message}`] };
	}
	return validate(doc, schema);
}

const rel = (file) => path.relative(process.cwd(), file) || file;
const files = process.argv.slice(2);
let failed = 0;

if (files.length) {
	for (const file of files) {
		const result = check(file);
		console.log(`${result.ok ? "VALID  " : "INVALID"} ${rel(file)}`);
		for (const e of result.errors) console.log(`        ${e}`);
		if (!result.ok) failed += 1;
	}
} else {
	const dir = (name) => path.join(here, name);
	for (const name of fs.readdirSync(dir("examples")).filter((n) => n.endsWith(".json")).sort()) {
		const result = check(path.join(dir("examples"), name));
		console.log(`${result.ok ? "pass" : "FAIL"}  examples/${name} is valid`);
		for (const e of result.errors) console.log(`        ${e}`);
		if (!result.ok) failed += 1;
	}
	const expected = JSON.parse(fs.readFileSync(path.join(dir("invalid"), "expected.json"), "utf8"));
	for (const [name, message] of Object.entries(expected)) {
		const result = check(path.join(dir("invalid"), name));
		const named = result.errors.some((e) => e.includes(message));
		const ok = !result.ok && named;
		console.log(`${ok ? "pass" : "FAIL"}  invalid/${name} is rejected`);
		for (const e of result.errors) console.log(`        ${e}`);
		if (!ok) {
			console.log(`        expected a message that contains: ${message}`);
			failed += 1;
		}
	}
}
if (failed) {
	console.log(`\n${failed} check${failed === 1 ? "" : "s"} failed.`);
	process.exit(1);
}
console.log("\nAll checks passed.");
