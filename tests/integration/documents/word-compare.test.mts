// T-82 word marks inside a changed block: the pure word compare beside the block compare. No database.
//   node --test tests/integration/documents/word-compare.test.mts
//   Criterion 10: exact removed, added and kept runs for a reworded sentence, a list with one changed item,
//   whitespace-only and punctuation changes, merge fields as units, formatting-only changes and the fall-back.
//   Criteria 2, 3, 5, 6, 7 through the same table: headings, title and footer, settings, columns, fields.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	compareWithTemplate,
	wordChanges,
	type BlockNode,
	type DocDifference,
	type DocDocument,
	type DocTemplate,
	type InlineNode,
	type WordChanges,
} from "../../../packages/contracts/src/documents/format/index.ts";

const t = (text: string, marks?: unknown[]) => ({ type: "text", text, ...(marks ? { marks } : {}) }) as InlineNode;
const field = (key: string) => ({ type: "field", attrs: { key } }) as InlineNode;
const p = (...content: InlineNode[]) => ({ type: "paragraph", content }) as BlockNode;
const h = (level: 1 | 2 | 3, text: string) => ({ type: "heading", attrs: { level }, content: [t(text)] }) as BlockNode;
const bullets = (...items: string[]) =>
	({ type: "bulletList", content: items.map((text) => ({ type: "listItem", content: [p(t(text))] })) }) as BlockNode;
const columns = (...texts: string[]) =>
	({ type: "columns", content: texts.map((text) => ({ type: "column", content: [p(t(text))] })) }) as BlockNode;
const box = (fill: string, text: string) => ({ type: "box", attrs: { fill }, content: [p(t(text))] }) as BlockNode;
const body = (document: BlockNode, template: BlockNode) =>
	wordChanges({ id: 0, part: "body", kind: "changed", document, template });

/** A side's runs as compact strings: "=kept", "-removed", "+added". */
const read = (side: WordChanges & { show: "words" }, which: "document" | "template") =>
	side[which].map((line) =>
		line.map((run) => `${run.op === "kept" ? "=" : run.op === "removed" ? "-" : "+"}${run.text}`),
	);
const words = (changes: WordChanges | null) => {
	assert.equal(changes?.show, "words", JSON.stringify(changes));
	const w = changes as WordChanges & { show: "words" };
	return { document: read(w, "document"), template: read(w, "template"), notes: w.notes };
};

describe("T-82 the word compare", () => {
	test("criterion 10: a reworded sentence marks the dropped phrase and the new one, and keeps the rest", () => {
		const changes = body(
			p(t("We meet every Sunday at the old school hall for worship and prayer.")),
			p(t("We meet every Sunday at the new community center for worship and prayer.")),
		);
		assert.deepEqual(words(changes), {
			document: [["=We meet every Sunday at the ", "-old school hall", "= for worship and prayer."]],
			template: [["=We meet every Sunday at the ", "+new community center", "= for worship and prayer."]],
			notes: [],
		});
		// Offsets count the line as the editor does, so a mark covers exactly the run.
		const w = changes as WordChanges & { show: "words" };
		assert.deepEqual(
			w.document[0]!.map((run) => [run.from, run.to]),
			[
				[0, 28],
				[28, 43],
				[43, 67],
			],
		);
	});

	test("criterion 10, 2: a list compares item by item; only the changed item's word is marked", () => {
		assert.deepEqual(
			words(
				body(
					bullets("Pray daily", "Read the Gospels", "Serve others"),
					bullets("Pray daily", "Read the Psalms", "Serve others"),
				),
			),
			{
				document: [["=Pray daily"], ["=Read the ", "-Gospels"], ["=Serve others"]],
				template: [["=Pray daily"], ["=Read the ", "+Psalms"], ["=Serve others"]],
				notes: [],
			},
		);
	});

	test("criterion 2, 5: a heading marks its word; a level change alone marks nothing and says the setting changed", () => {
		assert.deepEqual(words(body(h(2, "Our core values"), h(2, "Our shared values"))), {
			document: [["=Our ", "-core", "= values"]],
			template: [["=Our ", "+shared", "= values"]],
			notes: [],
		});
		assert.deepEqual(body(h(2, "Our values"), h(3, "Our values")), { show: "notes", notes: ["settings"] });
		assert.deepEqual(body(box("muted", "Note"), box("accent", "Note")), { show: "notes", notes: ["settings"] });
		// Words and a setting both changed: the words are marked and the note still says so.
		assert.deepEqual(words(body(h(2, "Our values"), h(3, "Your values"))).notes, ["settings"]);
	});

	test("criterion 10: punctuation is its own unit; a spacing-only change marks nothing", () => {
		assert.deepEqual(words(body(p(t("Come, and see.")), p(t("Come and see!")))), {
			document: [["=Come", "-,", "= and see", "-."]],
			template: [["=Come and see", "+!"]],
			notes: [],
		});
		assert.deepEqual(body(p(t("Come  and see.")), p(t("Come and see."))), { show: "notes", notes: ["spacing"] });
	});

	test("criterion 10, 5: formatting only (bold, a link) marks no word and says formatting changed", () => {
		assert.deepEqual(body(p(t("Give generously.")), p(t("Give "), t("generously", [{ type: "bold" }]), t("."))), {
			show: "notes",
			notes: ["formatting"],
		});
		assert.deepEqual(
			body(
				p(t("Visit our site.")),
				p(t("Visit "), t("our site", [{ type: "link", attrs: { href: "https://x.org" } }]), t(".")),
			),
			{ show: "notes", notes: ["formatting"] },
		);
	});

	test("criterion 10, 7: a merge field is one unit by key; the words beside it are marked, the field is not", () => {
		const changes = body(
			p(t("Welcome to "), field("church.name"), t(" this Sunday.")),
			p(t("You are invited to "), field("church.name"), t(" this Sunday.")),
		);
		assert.deepEqual(words(changes), {
			document: [["-Welcome", "= to {church.name} this Sunday."]],
			template: [["+You are invited", "= to {church.name} this Sunday."]],
			notes: [],
		});
		// The field takes one place in the editor's count.
		const w = changes as WordChanges & { show: "words" };
		assert.deepEqual(w.document[0]!.at(-1), { op: "kept", text: " to {church.name} this Sunday.", from: 7, to: 25 });
		// Two different fields: the field is replaced whole, never split.
		assert.deepEqual(words(body(p(t("Led by "), field("pastor.name")), p(t("Led by "), field("church.name")))), {
			document: [["=Led by ", "-{pastor.name}"]],
			template: [["=Led by ", "+{church.name}"]],
			notes: [],
		});
	});

	test("criterion 10, 6: few shared words or a different shape shows both versions whole", () => {
		assert.deepEqual(body(p(t("Our mission is to love the city.")), p(t("Everyone belongs here, always."))), {
			show: "whole",
		});
		assert.deepEqual(body(columns("Left", "Right"), columns("Left", "Middle", "Right")), { show: "whole" });
		assert.deepEqual(body(bullets("One", "Two"), bullets("One", "Two", "Three")), { show: "whole" });
	});

	test("criterion 3: the title and a footer get the same marks", () => {
		assert.deepEqual(
			words(
				wordChanges({
					id: 0,
					part: "title",
					kind: "changed",
					document: "Board meeting policy",
					template: "Board conduct policy",
				}),
			),
			{ document: [["=Board ", "-meeting", "= policy"]], template: [["=Board ", "+conduct", "= policy"]], notes: [] },
		);
		const footer = (text: string) => ({ pages: "all" as const, content: [p(t(text))] });
		assert.deepEqual(
			words(
				wordChanges({
					id: 0,
					part: "footer",
					kind: "changed",
					document: footer("Questions go to the office."),
					template: footer("Questions go to the board chair."),
				}),
			),
			{
				document: [["=Questions go to the ", "-office", "=."]],
				template: [["=Questions go to the ", "+board chair", "=."]],
				notes: [],
			},
		);
	});

	test("criterion 7: a block that only differs by a field's value is still not listed", () => {
		const page = { size: "letter", orientation: "portrait", margin: { top: 72, right: 72, bottom: 72, left: 72 } };
		const tpl = {
			format: "everyfield.doc/1",
			kind: "template",
			id: "x",
			version: 1,
			title: "X",
			class: "operational",
			exports: ["pdf"],
			fields: [{ key: "church.name", label: "Church", type: "text" }],
			page,
			body: { type: "doc", content: [p(t("Welcome to "), field("church.name"))] },
		} as unknown as DocTemplate;
		const doc = { ...tpl, kind: "document", data: { "church.name": "Grace" } } as unknown as DocDocument;
		const listed: DocDifference[] = compareWithTemplate(doc, tpl);
		assert.deepEqual(listed, []);
	});
});
