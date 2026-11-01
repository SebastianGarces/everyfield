// Behavior tests for the approach-C format module. No install: node --test design/doc-format/approach-c/tests/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ENVELOPE, MARKS, NODES, evaluate, fork, formatNumber, noticesOf, resolveField, tablesOf, typesUsed, validate, wipe } from "../format.mjs";

const dir = fileURLToPath(new URL("../examples/", import.meta.url));
const load = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
const examples = readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => load(`examples/${n}`));
const byId = (id) => structuredClone(examples.find((d) => d.id === id));

/** The value of the formula cell with this name. */
function named(doc, name) {
	const results = evaluate(doc);
	for (const table of tablesOf(doc))
		for (const cols of table.grid) for (const entry of cols) if (entry.cell.attrs?.name === name) return results.get(entry.path);
	throw new Error(`no cell ${name}`);
}
/** Set the Monthly amount of a budget line by its label. */
function setMonthly(doc, label, value) {
	const row = doc.body[2].content.find((r) => r.content[0].content[0]?.text === label);
	row.content[1].attrs.value = value;
}

test("the four examples pass and use one envelope", () => {
	assert.equal(examples.length, 4);
	for (const doc of examples) {
		assert.deepEqual(validate(doc), { ok: true, errors: [] }, doc.id);
		assert.deepEqual(Object.keys(doc).sort(), Object.keys(ENVELOPE).sort(), doc.id);
	}
});

test("the broken copy fails with the exact problems", () => {
	const result = validate(load("tests/broken/budget-worksheet-broken.json"));
	assert.equal(result.ok, false);
	assert.deepEqual(result.errors, ['$.body[2].content[3]: row spans 2 columns; the table has 3', '$.body[3]: "spreadsheet" is not a block']);
});

test("budget totals compute from the amounts", () => {
	const doc = byId("budget-worksheet");
	assert.deepEqual(named(doc, "net_annual"), { value: 0 });
	setMonthly(doc, "Tithes and offerings", 4000);
	setMonthly(doc, "Grants", 500);
	setMonthly(doc, "Rent or facility", 1200);
	assert.deepEqual(named(doc, "income_monthly"), { value: 4500 });
	assert.deepEqual(named(doc, "income_annual"), { value: 54000 });
	assert.deepEqual(named(doc, "expenses_monthly"), { value: 1200 });
	assert.deepEqual(named(doc, "net_monthly"), { value: 3300 });
	assert.deepEqual(named(doc, "net_annual"), { value: 39600 });
	assert.equal(formatNumber(39600, "currency"), "$39,600");
	assert.deepEqual(validate(doc), { ok: true, errors: [] });
});

test("a formula error is a validation error", () => {
	const doc = byId("budget-worksheet");
	const net = doc.body[2].content.at(-1).content[1];
	net.attrs.formula = "@income_monthly - @expense_monthly";
	assert.deepEqual(validate(doc).errors, ["$.body[2].content[22].content[1]: formula: no cell is named expense_monthly"]);
	net.attrs.formula = "@net_monthly + 1";
	assert.deepEqual(validate(doc).errors, ["$.body[2].content[22].content[1]: formula: depends on itself"]);
	net.attrs.formula = "sum(below)";
	assert.deepEqual(validate(doc).errors, ["$.body[2].content[22].content[1].attrs.formula: sum takes above or left"]);
});

test("a fork is a copy: editing it leaves the template unchanged", () => {
	const template = byId("conflict-of-interest-policy");
	const before = JSON.stringify(template);
	const copy = fork(template, "doc-1");
	assert.deepEqual(copy.origin, { template: "conflict-of-interest-policy", version: 1 });
	assert.equal(copy.kind, "document");
	copy.body[3].content[0].text = "Changed";
	copy.body.splice(5, 3);
	assert.equal(JSON.stringify(template), before);
	assert.deepEqual(validate(copy), { ok: true, errors: [] });
	assert.throws(() => fork(copy, "doc-2"), /only a template/);
});

test("wipe deletes all content and keeps a valid envelope; the legal notice is derived, not content", () => {
	for (const doc of examples) {
		const empty = wipe(fork(doc, "doc-1"));
		assert.deepEqual(empty.body, []);
		assert.deepEqual(validate(empty), { ok: true, errors: [] }, doc.id);
	}
	assert.deepEqual(noticesOf(wipe(byId("conflict-of-interest-policy"))), ["Template, not legal advice"]);
	assert.deepEqual(noticesOf(byId("guest-sign-in-sheet")), []);
});

test("fields fill from data, fall back to the default, else print blank", () => {
	const card = byId("commitment-card");
	const data = { church: { name: "Grace Hill Church" }, pastor: { name: "Ana Ruiz" } };
	assert.equal(resolveField(card, "church_name", data), "Grace Hill Church");
	assert.equal(resolveField(card, "church_tagline", data), "A new church plant. You are welcome here.");
	assert.equal(resolveField(card, "church_tagline", { church: { tagline: "Love the city." } }), "Love the city.");
	assert.equal(resolveField(card, "full_name", data), null);
	assert.equal(resolveField(card, "full_name", { values: { full_name: "Sam Lee" } }), "Sam Lee");
});

test("one format for all: every node and mark validates in one generic document", () => {
	const text = (s, ...marks) => ({ type: "text", text: s, marks: marks.map((m) => (m === "link" ? { type: "link", attrs: { href: "https://example.org" } } : m === "tone" ? { type: "tone", attrs: { tone: "accent" } } : { type: m })) });
	const p = (...content) => ({ type: "paragraph", content });
	const doc = {
		...structuredClone(byId("guest-sign-in-sheet")),
		body: [
			{ type: "heading", attrs: { level: 1 }, content: [text("All", ...Object.keys(MARKS))] },
			p(text("a"), { type: "hardBreak" }, { type: "field", attrs: { key: "church_name" } }, { type: "checkbox", attrs: { key: "c1" } }),
			{ type: "list", content: [{ type: "listItem", content: [p(text("b")), { type: "list", attrs: { ordered: true }, content: [{ type: "listItem", content: [p(text("c"))] }] }] }] },
			{ type: "quote", content: [p(text("q"))] },
			{ type: "divider" },
			{ type: "pageBreak", attrs: { sheet: "Two" } },
			{ type: "slot", attrs: { id: "faith", label: "Statement of faith" }, content: [] },
			{ type: "box", attrs: { fill: "muted" }, content: [{ type: "logo" }] },
			{ type: "columns", content: [{ type: "column", content: [p(text("l"))] }, { type: "column", content: [] }] },
			{ type: "repeat", content: [{ type: "table", attrs: { columns: [{ key: "a", width: 1 }, { key: "b", width: 1 }] }, content: [{ type: "row", content: [{ type: "cell", content: [text("A")] }, { type: "cell", content: [text("B")] }] }, { type: "row", content: [{ type: "cell", attrs: { kind: "number", value: 2 } }, { type: "cell", attrs: { kind: "formula", formula: "left * 3" } }] }] }] },
		],
	};
	assert.deepEqual(validate(doc), { ok: true, errors: [] });
	const used = typesUsed(doc);
	for (const type of Object.keys(NODES)) assert.ok(used.has(type), `node ${type} is used`);
	for (const mark of Object.keys(MARKS)) assert.ok(used.has(`mark:${mark}`), `mark ${mark} is used`);
});

test("structure rules: page breaks only at the top, no repeat in a repeat, fields must be declared", () => {
	const doc = byId("commitment-card");
	doc.body[0].content.push({ type: "pageBreak" }, { type: "repeat", content: [] }, { type: "paragraph", content: [{ type: "field", attrs: { key: "nope" } }] });
	assert.deepEqual(validate(doc).errors, [
		"$.body[0].content[9]: pageBreak is allowed only at the top level of the body",
		"$.body[0].content[10]: a repeat cannot hold another repeat",
		"$.body[0].content[11].content[0].attrs.key: field nope is not in the envelope's fields",
	]);
});

test("check.mjs reports pass or fail per file and fails on the broken copy", async () => {
	const { spawnSync } = await import("node:child_process");
	const script = fileURLToPath(new URL("../check.mjs", import.meta.url));
	const all = spawnSync(process.execPath, [script], { encoding: "utf8" });
	assert.equal(all.status, 0, all.stdout);
	for (const id of ["budget-worksheet", "commitment-card", "conflict-of-interest-policy", "guest-sign-in-sheet"])
		assert.match(all.stdout, new RegExp(`^PASS  examples/${id}\\.json$`, "m"));
	assert.match(all.stdout, /^FAIL  tests\/broken\/budget-worksheet-broken\.json  \(expected: a broken copy\)$/m);
	const broken = fileURLToPath(new URL("broken/budget-worksheet-broken.json", import.meta.url));
	const one = spawnSync(process.execPath, [script, broken], { encoding: "utf8" });
	assert.equal(one.status, 1);
	assert.match(one.stdout, /^FAIL  .*budget-worksheet-broken\.json$/m);
});
