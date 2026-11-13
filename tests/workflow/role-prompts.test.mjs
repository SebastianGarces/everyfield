// evf reads evf.toml from the base branch and starts each seat with the role's prompt_file. A missing file stops the
// seat from starting, and a dropped owner class lands work Sebastian asked to approve. Neither shows up until a seat runs.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const toml = read("evf.toml");

const ROLES = ["planner", "implementer", "ui", "simplifier", "ideator", "comparer", "prototype-merger", "verifier"];

/** The body of one [role.<name>] table. */
function role(name) {
	const start = toml.indexOf(`[role.${name}]\n`);
	assert.notEqual(start, -1, `evf.toml has [role.${name}]`);
	const rest = toml.slice(start + `[role.${name}]\n`.length);
	const next = rest.search(/^\[/m);
	return next === -1 ? rest : rest.slice(0, next);
}

const promptPath = (name) => /^prompt_file = "([^"]+)"$/m.exec(role(name))?.[1];
const rulesOf = (text) => text.slice(text.indexOf("## This repository's rules"), text.lastIndexOf("\n\n"));

test("every evf role has a prompt file on disk, with this repo's rules and no v1 command", () => {
	const shared = new Set();
	for (const name of ROLES) {
		const path = promptPath(name);
		assert.ok(path, `role ${name} sets prompt_file`);
		assert.ok(existsSync(new URL(path, root)), `${path} exists`);
		const text = read(path);
		assert.match(text, /This repository's rules/, path);
		assert.match(text, /production database/, path);
		assert.match(text, /390 and 1440 px/, path);
		assert.doesNotMatch(text, /bin\/evf/, path);
		shared.add(rulesOf(text));
	}
	assert.equal(shared.size, 1, "the repo rules are the same text in every prompt");
});

test("the prompts keep what evf's built-in prompt tells each seat to do", () => {
	const needs = {
		planner: "evf task spec --file",
		implementer: "evf proof add",
		ui: "evf proof add",
		simplifier: "evf proof add",
		verifier: "evf review submit",
		ideator: "summary file",
		comparer: "summary file",
		"prototype-merger": "evf task handoff --file",
	};
	for (const [name, words] of Object.entries(needs)) assert.ok(read(promptPath(name)).includes(words), name);
});

test("the verifier stays read-only on an Opus model", () => {
	assert.match(role("verifier"), /^read_only = true$/m);
	assert.match(role("verifier"), /^model = "claude-opus-/m);
});

test("the five owner classes stay in evf.toml, each with an owner outcome", () => {
	const classes = toml.split("[[policy.class]]").slice(1);
	const names = classes.map((block) => /^name = "([^"]+)"$/m.exec(block)?.[1]);
	assert.deepEqual(names, ["document-templates", "landing-marketing", "wiki", "brand-prototype", "workflow-gates"]);
	for (const block of classes) assert.match(block, /^outcome = "owner"$/m);
});
