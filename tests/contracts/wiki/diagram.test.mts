// WP-034/ui criteria 2 and 3: the diagram block parser returns the exact typed diagram or the exact error list.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fencedBlocks, parseDiagram } from "../../../packages/contracts/src/wiki/diagram.ts";

const body = (...lines: string[]) => lines.join("\n");
const errors = (info: string, text: string) => {
	const result = parseDiagram(info, text);
	assert.equal(result.ok, false, JSON.stringify(result));
	return result.ok ? [] : result.errors;
};

test("WP-034/ui: a flow parses with its loop, optional detail and note, and blank lines ignored", () => {
	const result = parseDiagram(
		"diagram flow",
		body(
			"title: How a guest becomes a member",
			"loop: Repeat each season",
			"",
			"- First visit | Greeted at the door | Week 1",
			"- Connect card | Follow-up within 48 hours",
			"- Newcomers lunch",
			"- Membership class | | Month 2",
		),
	);
	assert.deepEqual(result, {
		ok: true,
		diagram: {
			type: "flow",
			title: "How a guest becomes a member",
			loop: "Repeat each season",
			nodes: [
				{ label: "First visit", detail: "Greeted at the door", note: "Week 1" },
				{ label: "Connect card", detail: "Follow-up within 48 hours" },
				{ label: "Newcomers lunch" },
				{ label: "Membership class", note: "Month 2" },
			],
		},
	});
});

test("WP-034/ui: stages parse without a loop", () => {
	assert.deepEqual(
		parseDiagram("diagram stages", body("title: Launch phases", "- Discovery | Pray and study", "- Core group")),
		{
			ok: true,
			diagram: {
				type: "stages",
				title: "Launch phases",
				nodes: [{ label: "Discovery", detail: "Pray and study" }, { label: "Core group" }],
			},
		},
	);
});

test("WP-034/ui: a cycle parses with two nodes and a loop", () => {
	assert.deepEqual(
		parseDiagram("diagram cycle", body("title: Weekly rhythm", "loop: Every week", "- Plan", "- Gather | Sunday")),
		{
			ok: true,
			diagram: {
				type: "cycle",
				title: "Weekly rhythm",
				loop: "Every week",
				nodes: [{ label: "Plan" }, { label: "Gather", detail: "Sunday" }],
			},
		},
	);
});

test("WP-034/ui: a hierarchy nests three levels deep under one root", () => {
	const result = parseDiagram(
		"diagram hierarchy",
		body(
			"title: Leadership",
			"- Lead pastor | Vision",
			"  - Ministry director",
			"    - Team leader | | 4 teams",
			"      - Volunteer",
			"  - Small group coach",
		),
	);
	assert.deepEqual(result, {
		ok: true,
		diagram: {
			type: "hierarchy",
			title: "Leadership",
			nodes: [
				{
					label: "Lead pastor",
					detail: "Vision",
					children: [
						{
							label: "Ministry director",
							children: [{ label: "Team leader", note: "4 teams", children: [{ label: "Volunteer", children: [] }] }],
						},
						{ label: "Small group coach", children: [] },
					],
				},
			],
		},
	});
});

test("WP-034/ui: a timeline keeps the note as its time marker", () => {
	assert.deepEqual(
		parseDiagram(
			"diagram timeline",
			body("title: Launch plan", "- Vision meeting | Invite 40 | Week 1", "- Launch Sunday | | Week 12"),
		),
		{
			ok: true,
			diagram: {
				type: "timeline",
				title: "Launch plan",
				nodes: [
					{ label: "Vision meeting", detail: "Invite 40", note: "Week 1" },
					{ label: "Launch Sunday", note: "Week 12" },
				],
			},
		},
	);
});

const TYPES = "flow, stages, cycle, hierarchy or timeline";
const cases: [string, string, string, { line: number; message: string }[]][] = [
	[
		"an unknown type",
		"diagram chart",
		body("title: T", "- A"),
		[{ line: 0, message: `Unknown diagram type "chart"; use ${TYPES}` }],
	],
	[
		"an info string without a type",
		"diagram",
		body("title: T", "- A"),
		[{ line: 0, message: `Missing diagram type; use ${TYPES}` }],
	],
	[
		"a missing title",
		"diagram flow",
		body("- A", "- B"),
		[{ line: 1, message: "Missing title: the first line must be title: <text>" }],
	],
	[
		"a title after a node",
		"diagram flow",
		body("- A", "title: T"),
		[{ line: 2, message: "title must come before the first node" }],
	],
	...(["stages", "hierarchy", "timeline"] as const).map(
		(type): [string, string, string, { line: number; message: string }[]] => [
			`loop on ${type}`,
			`diagram ${type}`,
			body("title: T", "loop: Again", "- A"),
			[{ line: 2, message: "loop is allowed only in flow and cycle diagrams" }],
		],
	),
	[
		"zero nodes",
		"diagram flow",
		body("title: T", ""),
		[{ line: 1, message: "No nodes: add at least one line - label | detail | note" }],
	],
	[
		"13 nodes",
		"diagram stages",
		body("title: T", ...Array.from({ length: 13 }, (_, n) => `- Step ${n + 1}`)),
		[{ line: 14, message: "More than 12 nodes; split the diagram" }],
	],
	[
		"a 1-node cycle",
		"diagram cycle",
		body("title: T", "- A"),
		[{ line: 2, message: "A cycle needs at least 2 nodes" }],
	],
	["an empty label", "diagram flow", body("title: T", "- | detail"), [{ line: 2, message: "Node label is empty" }]],
	[
		"four fields",
		"diagram flow",
		body("title: T", "- A | B | C | D"),
		[{ line: 2, message: "A node has at most three fields: label | detail | note" }],
	],
	[
		"an overlong field",
		"diagram flow",
		body("title: T", `- ${"x".repeat(61)}`),
		[{ line: 2, message: "Label is 61 characters; the limit is 60" }],
	],
	[
		"an unknown key",
		"diagram flow",
		body("title: T", "color: red", "- A"),
		[{ line: 2, message: 'Unknown key "color"; use title or loop' }],
	],
	[
		"an indent outside hierarchy",
		"diagram flow",
		body("title: T", "- A", "  - B"),
		[{ line: 3, message: "Indent is allowed only in hierarchy diagrams" }],
	],
	[
		"a hierarchy jump of two levels",
		"diagram hierarchy",
		body("title: T", "- A", "    - B"),
		[{ line: 3, message: "Indent one level (two spaces) at a time" }],
	],
	[
		"a second root",
		"diagram hierarchy",
		body("title: T", "- A", "- B"),
		[{ line: 3, message: "A hierarchy has one root; indent this node under it" }],
	],
];

for (const [name, info, text, expected] of cases)
	test(`WP-034/ui: ${name} is an error with its line`, () => {
		assert.deepEqual(errors(info, text), expected);
	});

test("WP-034/ui: a block with three faults reports all three in line order", () => {
	assert.deepEqual(errors("diagram stages", body("- | x", "loop: L", "- A | B | C | D")), [
		{ line: 1, message: "Missing title: the first line must be title: <text>" },
		{ line: 1, message: "Node label is empty" },
		{ line: 2, message: "loop must come before the first node" },
		{ line: 3, message: "A node has at most three fields: label | detail | note" },
	]);
	assert.deepEqual(errors("diagram flow", body("title: T", "- | x", "  - A", `- B | ${"d".repeat(161)}`)), [
		{ line: 2, message: "Node label is empty" },
		{ line: 3, message: "Indent is allowed only in hierarchy diagrams" },
		{ line: 4, message: "Detail is 161 characters; the limit is 160" },
	]);
});

test("WP-034/ui: fencedBlocks reads backtick and tilde fences and runs an open fence to the end", () => {
	assert.deepEqual(
		fencedBlocks(body("Intro", "```diagram flow", "title: T", "```", "~~~", "  kept", "~~~", "````", "open")),
		[
			{ info: "diagram flow", body: "title: T", start: 1, end: 4 },
			{ info: "", body: "  kept", start: 4, end: 7 },
			{ info: "", body: "open", start: 7, end: 9 },
		],
	);
});
