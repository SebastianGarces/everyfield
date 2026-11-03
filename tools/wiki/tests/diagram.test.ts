// WP-034/ui: lint reports each malformed diagram block at its article line, and the ASCII-art rule holds the seed to a
// shrinking allowlist of fingerprinted blocks. The expectations come from the seed and the allowlist, not from pinned
// counts, so a migration that turns a block into a ```diagram block keeps this file green. The render test is in
// render.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fencedBlocks } from "../../../packages/contracts/src/wiki/diagram.ts";
import { asciiArt, blockFingerprint } from "../mdx.ts";

type Entry = { slug: string; fingerprint: string };
type Row = { slug: string; content: string };
type Seed = { articles: Row[] };

const root = resolve(import.meta.dirname, "../../..");
const seedRoot = resolve(root, "docs/reference/wiki");
const allowlist: Entry[] = JSON.parse(await readFile(resolve(root, "tools/wiki/ascii-allowlist.json"), "utf8")).entries;
const payload: Seed = JSON.parse(await readFile(resolve(seedRoot, "seed.json"), "utf8"));

/** The 9 entries the fingerprinted allowlist started with. An entry outside this list is a new allowance. */
const ORIGINAL: Entry[] = [
	{ slug: "administrative/financial/disbursements-and-approvals", fingerprint: "fa93d37d2db18357" },
	{ slug: "core-group/building-your-core-group/the-core-group-funnel", fingerprint: "430e5f7897e63c55" },
	{ slug: "core-group/commitment/the-three-key-documents", fingerprint: "f366e75a56490c6a" },
	{ slug: "discovery/the-worship-walk-work-witness-model", fingerprint: "67fd544a40aa05fd" },
	{ slug: "frameworks/8-critical-success-factors-overview", fingerprint: "b79f2346495ce3a9" },
	{ slug: "frameworks/the-ministry-funnel", fingerprint: "521248153692017b" },
	{ slug: "getting-started/launch-process-goals", fingerprint: "4b6f6de671a896d3" },
	{ slug: "post-launch/the-guest-assimilation-journey", fingerprint: "7f4aefc0d77fc58e" },
	{ slug: "training/boot-camp-overview", fingerprint: "baa5d805038a52a3" },
];

/** The six articles whose ASCII blocks #388's drafts rewrite as ```diagram blocks. */
const PR388 = [
	"core-group/building-your-core-group/the-core-group-funnel",
	"core-group/commitment/the-three-key-documents",
	"discovery/the-worship-walk-work-witness-model",
	"frameworks/8-critical-success-factors-overview",
	"frameworks/the-ministry-funnel",
	"getting-started/launch-process-goals",
];

const key = (entry: Entry) => `${entry.slug} ${entry.fingerprint}`;
/** Allowlist entries that are not one of the original 9: each one is a new allowance and fails the shrink rule. */
const added = (entries: Entry[]) => entries.filter((entry) => !ORIGINAL.some((pin) => key(pin) === key(entry)));

/** Each ASCII-art finding in the seed, with the fingerprint of its fenced block (null for a finding outside a fence). */
function findings(seed: Seed) {
	return seed.articles.flatMap((row) => {
		const opened = new Map(fencedBlocks(row.content).map((block) => [block.start + 1, block]));
		return asciiArt(row.content).map((finding) => {
			const block = opened.get(finding.line);
			return { slug: row.slug, line: finding.line, fingerprint: block ? blockFingerprint(block) : null };
		});
	});
}

/** Each entry permits one finding with its slug and fingerprint. Returns the findings left over and the inert entries. */
function audit(seed: Seed, entries: Entry[]) {
	const unmatched = [...entries];
	const unallowed = findings(seed).filter((finding) => {
		const index = unmatched.findIndex((e) => e.slug === finding.slug && e.fingerprint === finding.fingerprint);
		if (index >= 0) unmatched.splice(index, 1);
		return index < 0;
	});
	return { unallowed, inert: unmatched };
}

function wiki(...args: string[]) {
	const result = spawnSync(process.execPath, [resolve(root, "tools/wiki/main.ts"), ...args], { encoding: "utf8" });
	return { status: result.status, output: result.stdout + result.stderr };
}

/** Seed lint over a disposable copy of the seed, with the given rows and allowlist entries. */
async function lintSeed(seed: Seed, entries: Entry[] = allowlist) {
	const dir = await mkdtemp(join(tmpdir(), "wiki-allow-"));
	try {
		await cp(join(seedRoot, "manifest.json"), join(dir, "manifest.json"));
		await writeFile(join(dir, "seed.json"), JSON.stringify(seed, null, 2) + "\n");
		await writeFile(join(dir, "allowlist.json"), JSON.stringify({ entries }));
		const result = wiki("lint", "--seed", "--seed-dir", dir, "--allowlist", join(dir, "allowlist.json"));
		const block = (slug: string) =>
			result.output.split(/\n(?=PASS|FAIL)/).find((part) => part.includes(` ${slug} (`)) ?? "";
		return { ...result, block };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** A copy of the seed with `edit` applied to the content of each named article. */
function edited(seed: Seed, edits: Record<string, (content: string) => string>): Seed {
	const copy = structuredClone(seed);
	for (const row of copy.articles) if (edits[row.slug]) row.content = edits[row.slug]!(row.content);
	return copy;
}

/** Replace the fenced block that holds the article's first ASCII finding with a valid ```diagram block. */
function migrate(content: string) {
	const lines = content.split("\n");
	const line = asciiArt(content)[0]!.line;
	const block = fencedBlocks(content).find((b) => b.start + 1 === line)!;
	lines.splice(
		block.start,
		block.end - block.start,
		"```diagram flow",
		"title: Migrated",
		"- Start",
		"- Finish",
		"```",
	);
	return lines.join("\n");
}

/** The #388 replay: main's seed with the six #388 articles migrated to ```diagram blocks. */
const replay = edited(payload, Object.fromEntries(PR388.map((slug) => [slug, migrate])));

const lines = (output: string, prefix: string) =>
	output
		.split("\n")
		.filter((line) => line.startsWith(prefix))
		.map((line) => line.slice(prefix.length));
const errors = (output: string) => lines(output, "  ERROR ");
const warnings = (output: string) => lines(output, "  WARN ");
const inertWarning = (entry: Entry) =>
	`Inert ASCII allowlist entry ${entry.slug} ${entry.fingerprint}: no ASCII block matches it, so it permits nothing; delete it`;
const fenceLine = (seed: Seed, entry: Entry) =>
	findings(seed).find((f) => f.slug === entry.slug && f.fingerprint === entry.fingerprint)!.line;

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

const asciiError = (slug: string, line: number) =>
	`ASCII-art at ${slug}:${line}: Code block draws a diagram with box, arrow or connector characters; use a \`\`\`diagram block`;

test("WP-034/ui AC:WP-034/ui-6: draft lint reports each malformed diagram block with its article line", async () => {
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

test("WP-034/ui AC:WP-034/ui-6: a draft with ASCII art fails even when its slug has an allowlist entry", async () => {
	// Draft lint never reads the allowlist, so even the exact pinned block fails in a draft.
	const listed = allowlist[0]!;
	const row = payload.articles.find((r) => r.slug === listed.slug)!;
	const pinned = fencedBlocks(row.content).find((b) => blockFingerprint(b) === listed.fingerprint)!;
	for (const art of ["```\nA -> B\n```", "```" + pinned.info + "\n" + pinned.body + "\n```"]) {
		const drafted = await lintDraft(art, listed.slug);
		assert.equal(drafted.status, 1, art);
		assert.deepEqual(
			errors(drafted.output).filter((line) => line.startsWith("ASCII")),
			[asciiError(listed.slug, 1)],
		);
		assert.ok(!drafted.output.includes("Inert ASCII allowlist entry"), drafted.output);
	}
});

test("WP-034/ui AC:WP-034/ui-1: main's seed reports each allowlisted ASCII block as a warning on a passing article", async () => {
	assert.ok(allowlist.length > 0, "the original allowlist holds entries until OPS-97 removes them");
	const result = await lintSeed(payload);
	assert.equal(result.status, 0, result.output);
	// Every article passes, as it did before the allowlist pinned fingerprints.
	const count = payload.articles.length;
	assert.match(result.output, new RegExp(`\\n${count}/${count} articles pass the error checks\\n`));
	for (const entry of allowlist) {
		const block = result.block(entry.slug);
		assert.match(block, /^PASS /, entry.slug);
		assert.deepEqual(
			warnings(block).filter((w) => w.startsWith("ASCII-art")),
			[asciiError(entry.slug, fenceLine(payload, entry))],
		);
	}
	assert.equal(warnings(result.output).filter((w) => w.startsWith("ASCII-art")).length, allowlist.length);
	assert.ok(!result.output.includes("Inert ASCII allowlist entry"), result.output);
});

test("WP-034/ui AC:WP-034/ui-2: the #388 replay passes, each migrated article names its inert entry, and lint exits 0", async () => {
	const result = await lintSeed(replay);
	assert.equal(result.status, 0, result.output);
	assert.ok(!/remove .* from the allowlist/.test(result.output), result.output);
	for (const slug of PR388) {
		const block = result.block(slug);
		assert.match(block, /^PASS /, slug);
		assert.deepEqual(errors(block), [], slug);
		const entries = allowlist.filter((e) => e.slug === slug);
		assert.deepEqual(
			warnings(block).filter((w) => w.startsWith("ASCII-art") || w.startsWith("Inert")),
			entries.map(inertWarning),
		);
	}
	for (const entry of allowlist.filter((e) => !PR388.includes(e.slug))) {
		const block = result.block(entry.slug);
		assert.match(block, /^PASS /, entry.slug);
		assert.deepEqual(
			warnings(block).filter((w) => w.startsWith("ASCII-art") || w.startsWith("Inert")),
			[asciiError(entry.slug, fenceLine(replay, entry))],
		);
	}
});

test("WP-034/ui AC:WP-034/ui-4: new ASCII art in an article with a matched or an inert entry fails seed lint", async () => {
	// Three matched entries outside #388, and two #388 articles whose entries went inert in the replay.
	const [second, changed, copied] = allowlist.filter((e) => !PR388.includes(e.slug));
	const [inert, proseSlug] = PR388 as [string, string];
	const prose = allowlist.find((e) => e.slug === proseSlug)!;
	const extra = "\n\n```\nA -> B\n```\n";
	const seed = edited(replay, {
		// A second ASCII block beside the pinned one.
		[second!.slug]: (content) => content + extra,
		// The pinned block itself edited: its fingerprint changes, so the entry no longer permits it.
		[changed!.slug]: (content) => {
			const block = fencedBlocks(content).find((b) => blockFingerprint(b) === changed!.fingerprint)!;
			const lines = content.split("\n");
			lines.splice(block.end - 1, 0, "New -> Step");
			return lines.join("\n");
		},
		// An identical copy of the pinned block: one entry permits one block.
		[copied!.slug]: (content) => {
			const block = fencedBlocks(content).find((b) => blockFingerprint(b) === copied!.fingerprint)!;
			return content + "\n\n" + content.split("\n").slice(block.start, block.end).join("\n") + "\n";
		},
		// A box-drawing character in prose has no block, so no fingerprint can permit it.
		[prose!.slug]: (content) => content + "\n\nA box ┌─┐ in prose\n",
		// New ASCII art in an article whose entry went inert in the migration.
		[inert]: (content) => content + extra,
	});
	const result = await lintSeed(seed);
	assert.equal(result.status, 1, result.output);
	const lastLine = (slug: string) =>
		findings(seed)
			.filter((f) => f.slug === slug)
			.at(-1)!.line;
	const fails = (slug: string, expected: string[]) => {
		const block = result.block(slug);
		assert.match(block, /^FAIL /, slug);
		assert.deepEqual(
			errors(block).filter((e) => e.startsWith("ASCII-art")),
			expected,
			slug,
		);
		return block;
	};
	// The pinned block stays a warning; only the second block fails.
	const secondBlock = fails(second!.slug, [asciiError(second!.slug, lastLine(second!.slug))]);
	assert.deepEqual(
		warnings(secondBlock).filter((w) => w.startsWith("ASCII-art")),
		[asciiError(second!.slug, fenceLine(seed, second!))],
	);
	const changedBlock = fails(changed!.slug, [asciiError(changed!.slug, fenceLine(payload, changed!))]);
	assert.ok(warnings(changedBlock).includes(inertWarning(changed!)), changedBlock);
	fails(copied!.slug, [asciiError(copied!.slug, lastLine(copied!.slug))]);
	const proseLine = seed.articles.find((r) => r.slug === prose!.slug)!.content.split("\n").length - 1;
	const proseBlock = result.block(prose!.slug);
	assert.match(proseBlock, /^FAIL /);
	assert.deepEqual(errors(proseBlock), [
		`ASCII-art at ${prose!.slug}:${proseLine}: Box-drawing character; use a \`\`\`diagram block`,
	]);
	const inertBlock = fails(inert, [asciiError(inert, lastLine(inert))]);
	assert.ok(warnings(inertBlock).includes(inertWarning(allowlist.find((e) => e.slug === inert)!)), inertBlock);
});

test("WP-034/ui AC:WP-034/ui-5: ASCII art in an article with no allowlist entry fails seed lint", async () => {
	const unlisted = payload.articles.find((row) => !allowlist.some((e) => e.slug === row.slug))!.slug;
	const seed = edited(payload, { [unlisted]: (content) => content + "\n\n```\nA -> B\n```\n" });
	const result = await lintSeed(seed);
	assert.equal(result.status, 1, result.output);
	const block = result.block(unlisted);
	assert.match(block, /^FAIL /);
	const line = findings(seed).find((f) => f.slug === unlisted)!.line;
	assert.deepEqual(
		errors(block).filter((e) => e.startsWith("ASCII-art")),
		[asciiError(unlisted, line)],
	);
	assert.match(result.output, new RegExp(`\\n${payload.articles.length - 1}/${payload.articles.length} articles pass`));
});

test("WP-034/ui AC:WP-034/ui-7: the allowlist only shrinks, and an entry for an unknown slug fails seed lint", async () => {
	// The guard: each entry in the file is one of the original 9 pinned above.
	assert.deepEqual(added(allowlist), []);
	const forged = { slug: ORIGINAL[0]!.slug, fingerprint: "0123456789abcdef" };
	assert.deepEqual(added([...allowlist, forged]), [forged]);
	assert.deepEqual(
		added([...ORIGINAL.slice(1), { slug: "frameworks/new-article", fingerprint: ORIGINAL[0]!.fingerprint }]),
		[{ slug: "frameworks/new-article", fingerprint: ORIGINAL[0]!.fingerprint }],
	);
	const unknown = { slug: "frameworks/no-such-article", fingerprint: "0123456789abcdef" };
	const result = await lintSeed(payload, [...allowlist, unknown]);
	assert.equal(result.status, 1, result.output);
	assert.match(
		result.output,
		/^FAIL tools\/wiki\/ascii-allowlist\.json\n {2}ERROR remove frameworks\/no-such-article from the allowlist$/m,
	);
	// Removing entries keeps both the guard and seed lint green: the six inert #388 entries after the replay, then
	// OPS-97's last three after it migrates their blocks too.
	const afterReplay = allowlist.filter((e) => !PR388.includes(e.slug));
	assert.deepEqual(added(afterReplay), []);
	const replayed = await lintSeed(replay, afterReplay);
	assert.equal(replayed.status, 0, replayed.output);
	assert.ok(!replayed.output.includes("Inert ASCII allowlist entry"), replayed.output);
	const migrated = edited(replay, Object.fromEntries(afterReplay.map((e) => [e.slug, migrate])));
	assert.deepEqual(audit(migrated, []), { unallowed: [], inert: [] });
	const done = await lintSeed(migrated, []);
	assert.equal(done.status, 0, done.output);
	assert.ok(!done.output.includes("ASCII"), done.output);
});

test("WP-034/ui AC:WP-034/ui-8: each seed ASCII finding matches an entry, and each entry matches one block or is inert", () => {
	// Main's seed: every entry matches its block.
	assert.deepEqual(audit(payload, allowlist), { unallowed: [], inert: [] });
	// The #388 replay: every remaining finding matches, and exactly the six migrated entries are inert.
	const replayed = audit(replay, allowlist);
	assert.deepEqual(replayed.unallowed, []);
	assert.deepEqual(
		replayed.inert,
		allowlist.filter((e) => PR388.includes(e.slug)),
	);
	// The detection patterns: prose arrows outside a fence stay allowed; boxes, arrows and connectors in a fence do not.
	assert.deepEqual(asciiArt("Guests move from visit -> lunch -> class => member."), []);
	assert.deepEqual(asciiArt("A box ┌─┐ in prose"), [
		{ line: 1, message: "Box-drawing character; use a ```diagram block" },
	]);
	for (const body of ["A\n  |\n  v\nB", "A --> B", "A <- B", "Step ▼"])
		assert.equal(asciiArt("```\n" + body + "\n```").length, 1, body);
	// The fingerprint covers the info string and the body.
	assert.notEqual(blockFingerprint({ info: "", body: "A -> B" }), blockFingerprint({ info: "text", body: "A -> B" }));
	assert.notEqual(blockFingerprint({ info: "", body: "A -> B" }), blockFingerprint({ info: "", body: "A -> C" }));
});
