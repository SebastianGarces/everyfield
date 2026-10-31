// WP-034/ui criteria 13 to 15: lint reports each malformed diagram block at its article line, and the ASCII-art rule
// holds the seed to a shrinking allowlist. The render test is in render.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asciiArt, inspect } from "../mdx.ts";

const root = resolve(import.meta.dirname, "../../..");
const seedRoot = resolve(root, "docs/reference/wiki");
const allowlist: string[] = JSON.parse(await readFile(resolve(root, "tools/wiki/ascii-allowlist.json"), "utf8")).slugs;
const payload = JSON.parse(await readFile(resolve(seedRoot, "seed.json"), "utf8"));

function wiki(...args: string[]) {
	const result = spawnSync(process.execPath, [resolve(root, "tools/wiki/main.ts"), ...args], { encoding: "utf8" });
	return { status: result.status, output: result.stdout + result.stderr };
}

/** A draft that passes every other lint check. Its body starts with `extra` (line 1 onward). */
function draft(extra: string, slug = "administrative/financial/diagram-fixture") {
	return {
		...payload.articles[0],
		id: "2f0b5c1e-7c43-4f0e-9a51-6f1d2b9c0a11",
		slug,
		title: "Synthetic diagram fixture",
		status: "draft",
		published_at: null,
		content: [
			extra,
			"## Prepare",
			"This is synthetic tooling evidence. ".repeat(45),
			"## Record",
			"Keep a separate receipt for this check. ".repeat(30),
			"## Check",
			"Compare the files before continuing. ".repeat(35),
			'<Callout type="scripture">\n*"Synthetic fixture quotation."* — Fixture 1:2 (LSB)\n</Callout>',
		].join("\n\n"),
		draft: {
			backlog_id: "fixture",
			tier: "A",
			closes: [],
			approver: "Sebastian",
			replaces_id: null,
			sources: [],
			claim_check: { status: "passed", reviewer: "Independent fixture reviewer", notes: "Synthetic test only" },
			rulings: [],
		},
	};
}

async function lintDraft(extra: string, slug?: string) {
	const dir = await mkdtemp(join(tmpdir(), "wiki-diagram-"));
	try {
		const file = join(dir, "draft.json");
		await writeFile(file, JSON.stringify(draft(extra, slug)));
		return wiki("lint", file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const errors = (output: string) =>
	output
		.split("\n")
		.filter((line) => line.startsWith("  ERROR "))
		.map((line) => line.slice(8));

test("WP-034/ui: draft lint reports each malformed diagram block with its article line", async () => {
	// The fixture body starts on line 1, so the first fence is line 1 and its first body line is line 2.
	const cases: [string, string, string[]][] = [
		[
			"an unknown type",
			"```diagram chart\ntitle: T\n- A\n```",
			[
				'Diagram block at administrative/financial/diagram-fixture:1: Unknown diagram type "chart"; use flow, stages, cycle, hierarchy or timeline',
			],
		],
		[
			"a missing title",
			"```diagram flow\n- A\n```",
			[
				"Diagram block at administrative/financial/diagram-fixture:2: Missing title: the first line must be title: <text>",
			],
		],
		[
			"no nodes",
			"```diagram flow\ntitle: T\n```",
			[
				"Diagram block at administrative/financial/diagram-fixture:2: No nodes: add at least one line - label | detail | note",
			],
		],
		[
			"a bad node line",
			"```diagram flow\ntitle: T\n- A\nB without a dash\n```",
			["Diagram block at administrative/financial/diagram-fixture:4: Expected a node line: - label | detail | note"],
		],
	];
	for (const [name, block, expected] of cases) {
		const result = await lintDraft(block);
		assert.equal(result.status, 1, name);
		assert.deepEqual(errors(result.output), expected, name);
	}
	const valid = await lintDraft(
		"```diagram hierarchy\ntitle: Leaders\n- Pastor\n  - Director\n```\n\n```text\nPlain code\n```",
	);
	assert.equal(valid.status, 0, valid.output);
});

test("WP-034/ui: the ASCII-art rule flags exactly the 9 diagram fences in the seed", () => {
	const flagged = payload.articles.flatMap((row: { slug: string; content: string }) =>
		asciiArt(row.content).map((finding) => ({ slug: row.slug, line: finding.line })),
	);
	const fence = (slug: string) =>
		(payload.articles.find((row: { slug: string }) => row.slug === slug).content as string)
			.split("\n")
			.findIndex((line) => line.startsWith("```")) + 1;
	assert.deepEqual(
		flagged,
		allowlist.map((slug) => ({ slug, line: fence(slug) })).sort((a, b) => (a.slug < b.slug ? -1 : 1)),
	);
	assert.deepEqual(allowlist, [
		"administrative/financial/disbursements-and-approvals",
		"core-group/building-your-core-group/the-core-group-funnel",
		"core-group/commitment/the-three-key-documents",
		"discovery/the-worship-walk-work-witness-model",
		"frameworks/8-critical-success-factors-overview",
		"frameworks/the-ministry-funnel",
		"getting-started/launch-process-goals",
		"post-launch/the-guest-assimilation-journey",
		"training/boot-camp-overview",
	]);
	// 18 fences in all: the other 9 are text, and prose arrows outside a fence stay allowed.
	const fences = payload.articles.reduce(
		(sum: number, row: { content: string }) =>
			sum + row.content.split("\n").filter((l) => l.startsWith("```")).length / 2,
		0,
	);
	assert.equal(fences, 18);
	assert.deepEqual(asciiArt("Guests move from visit -> lunch -> class => member."), []);
	assert.deepEqual(asciiArt("A box ┌─┐ in prose"), [
		{ line: 1, message: "Box-drawing character; use a ```diagram block" },
	]);
	for (const body of ["A\n  |\n  v\nB", "A --> B", "A <- B", "Step ▼"])
		assert.equal(asciiArt("```\n" + body + "\n```").length, 1, body);
});

test("WP-034/ui: the allowlist warns for a listed slug, refuses a stale entry and an unlisted offender, and drafts ignore it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "wiki-allow-"));
	try {
		const seed = join(dir, "seed");
		await mkdir(seed);
		for (const file of ["seed.json", "manifest.json"]) await cp(join(seedRoot, file), join(seed, file));
		const rows = structuredClone(payload);
		const listed = allowlist[0]!;
		const stale = allowlist[1]!;
		const unlisted = rows.articles.find((row: { slug: string }) => !allowlist.includes(row.slug)).slug as string;
		for (const row of rows.articles) {
			// A migrated article: its ASCII fence becomes a diagram block, so it no longer offends.
			if (row.slug === stale)
				row.content = row.content.replace(
					/```\n[\s\S]*?\n```/,
					"```diagram flow\ntitle: Funnel\n- Network\n- Vision meeting\n```",
				);
			if (row.slug === unlisted) row.content += "\n\n```\nA -> B\n```\n";
		}
		await writeFile(join(seed, "seed.json"), JSON.stringify(rows, null, 2) + "\n");
		const result = wiki("lint", "--seed", "--seed-dir", seed);
		assert.equal(result.status, 1);
		const block = (slug: string) =>
			result.output.split(/\n(?=PASS|FAIL)/).find((part) => part.includes(` ${slug} (`)) ?? "";
		assert.match(block(listed), /^PASS /);
		assert.match(block(listed), /WARN ASCII-art at /);
		assert.deepEqual(errors(block(stale)), [`remove ${stale} from the allowlist`]);
		assert.match(
			errors(block(unlisted)).join("\n"),
			new RegExp(`^ASCII-art at ${unlisted.replaceAll("/", "\\/")}:\\d+: Code block draws`),
		);
		// A draft with a listed slug still fails: draft lint never reads the allowlist.
		const drafted = await lintDraft("```\nA -> B\n```", listed);
		assert.equal(drafted.status, 1);
		assert.deepEqual(
			errors(drafted.output).filter((line) => line.startsWith("ASCII")),
			[
				`ASCII-art at ${listed}:1: Code block draws a diagram with box, arrow or connector characters; use a \`\`\`diagram block`,
			],
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
