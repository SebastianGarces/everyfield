#!/usr/bin/env node
// Validates approach B documents against format/schema.json and the format's cross-reference rules.
// Usage: node design/doc-format/approach-b/tools/validate.mjs [file.json ...]
// With no file it validates every example in examples/. Exit 0: every file is valid. Exit 1: a file is invalid.
// Exit 2: a file cannot be read or parsed. No install and no network: node built-ins only.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocument } from "../format/validator.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "format/schema.json"), "utf8"));
const args = process.argv.slice(2);
const files = args.length
	? args
	: readdirSync(join(root, "examples"))
			.filter((name) => name.endsWith(".json"))
			.map((name) => join(root, "examples", name));

let status = 0;
for (const file of files) {
	const shown = relative(process.cwd(), file) || file;
	let doc;
	try {
		doc = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		console.log(`FAIL ${shown}: cannot read JSON (${error.message})`);
		status = Math.max(status, 2);
		continue;
	}
	const errors = validateDocument(doc, schema);
	if (errors.length === 0) console.log(`ok   ${shown} (${doc.kind} ${doc.id} v${doc.version})`);
	else {
		console.log(`FAIL ${shown}: ${errors.length} problem${errors.length === 1 ? "" : "s"}`);
		for (const error of errors) console.log(`     ${error}`);
		status = Math.max(status, 1);
	}
}
process.exit(status);
