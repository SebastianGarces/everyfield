// WP-034/ui: lint reports each malformed diagram block at its article line, and the ASCII-art rule holds the seed to a
// shrinking allowlist of fingerprinted blocks. The real seed may be main's, #388's promoted seed or OPS-97's, and an
// article may fail for a reason outside this rule. So expectations come from the seed and the allowlist, and new ASCII
// art goes into articles with no entry, under fixture entries. The render test is in render.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fencedBlocks } from "../../../packages/contracts/src/wiki/diagram.ts";
import { asciiArt, asciiFindings, blockFingerprint } from "../mdx.ts";

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

/** Each ASCII-art finding in the seed, by slug. */
const findings = (seed: Seed) =>
	seed.articles.flatMap((row) => asciiFindings(row.content).map((finding) => ({ ...finding, slug: row.slug })));

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

/** Replace the article's first ASCII block with a valid ```diagram block. An article already migrated stays as it is. */
function migrate(content: string) {
	const finding = asciiArt(content)[0];
	if (!finding) return content;
	const lines = content.split("\n");
	const block = fencedBlocks(content).find((b) => b.start + 1 === finding.line)!;
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

/** The #388 replay: the seed with the six #388 articles migrated to ```diagram blocks. */
const replay = edited(payload, Object.fromEntries(PR388.map((slug) => [slug, migrate])));

const lines = (output: string, prefix: string) =>
	output
		.split("\n")
		.filter((line) => line.startsWith(prefix))
		.map((line) => line.slice(prefix.length));
const errors = (output: string) => lines(output, "  ERROR ");
const asciiWarnings = (output: string) =>
	lines(output, "  WARN ").filter((w) => w.startsWith("ASCII-art") || w.startsWith("Inert"));
const failing = (output: string) => lines(output, "FAIL ").map((line) => line.split(" ")[0]!);
const inertWarning = (entry: Entry) =>
	`Inert ASCII allowlist entry ${entry.slug} ${entry.fingerprint}: no ASCII block matches it, so it permits nothing; delete it`;
const asciiError = (slug: string, line: number) =>
	`ASCII-art at ${slug}:${line}: Code block draws a diagram with box, arrow or connector characters; use a \`\`\`diagram block`;

/** What the seed fails before a test changes it. #388's promoted seed fails one article for a broken related slug. */
const baseline = await lintSeed(payload);
const knownFailures = failing(baseline.output);

/** The run fails only the known articles, so it exits 0 on a seed with none. */
function assertNoNewFailures(result: { status: number | null; output: string }) {
	assert.deepEqual(failing(result.output), knownFailures, result.output);
	assert.equal(result.status, knownFailures.length ? 1 : 0, result.output);
}

/** Each entry shows one warning on a passing article: its matched block, or its own inert line. No other article warns. */
function assertEachEntryReported(result: Awaited<ReturnType<typeof lintSeed>>, seed: Seed) {
	for (const entry of allowlist) {
		const block = result.block(entry.slug);
		assert.match(block, /^PASS /, entry.slug);
		const finding = findings(seed).find((f) => f.slug === entry.slug && f.fingerprint === entry.fingerprint);
		assert.deepEqual(asciiWarnings(block), [finding ? asciiError(entry.slug, finding.line) : inertWarning(entry)]);
	}
	assert.equal(asciiWarnings(result.output).length, allowlist.length, result.output);
}

// Fixture art for articles with no entry and no ASCII block. `pin` permits `art` and nothing else.
const art = "```\nA -> B\n```";
const otherArt = "```\nC -> D\n```";
const pin = blockFingerprint({ info: "", body: "A -> B" });
const plain = payload.articles
	.filter((row) => !asciiArt(row.content).length && !allowlist.some((e) => e.slug === row.slug))
	.map((row) => row.slug);
const append =
	(...parts: string[]) =>
	(content: string) =>
		[content, ...parts, ""].join("\n\n");

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

/** Draft lint with an allowlist that holds `entries`, to show draft lint never reads it. */
async function lintDraft(extra: string, slug?: string, entries: Entry[] = []) {
	const dir = await mkdtemp(join(tmpdir(), "wiki-diagram-"));
	try {
		const file = join(dir, "draft.json");
		await writeFile(file, JSON.stringify(draft(extra, slug)));
		await writeFile(join(dir, "allowlist.json"), JSON.stringify({ entries }));
		return wiki("lint", file, "--allowlist", join(dir, "allowlist.json"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

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
	const slug = ORIGINAL[0]!.slug;
	const drafted = await lintDraft(art, slug, [{ slug, fingerprint: pin }]);
	assert.equal(drafted.status, 1, drafted.output);
	assert.deepEqual(
		errors(drafted.output).filter((line) => line.startsWith("ASCII")),
		[asciiError(slug, 1)],
	);
	assert.ok(!drafted.output.includes("Inert ASCII allowlist entry"), drafted.output);
});

test("WP-034/ui AC:WP-034/ui-1: the seed reports each allowlisted ASCII block as a warning on a passing article", () => {
	assert.deepEqual(
		errors(baseline.output).filter((line) => line.startsWith("ASCII-art")),
		[],
	);
	assert.match(
		baseline.output,
		new RegExp(
			`\\n${payload.articles.length - knownFailures.length}/${payload.articles.length} articles pass the error checks\\n`,
		),
	);
	assertEachEntryReported(baseline, payload);
});

test("WP-034/ui AC:WP-034/ui-2: the #388 replay passes, each migrated article names its inert entry, and lint exits 0", async () => {
	const result = await lintSeed(replay);
	assertNoNewFailures(result);
	assert.ok(!/remove .* from the allowlist/.test(result.output), result.output);
	assertEachEntryReported(result, replay);
	for (const slug of PR388) {
		const block = result.block(slug);
		assert.match(block, /^PASS /, slug);
		assert.deepEqual(asciiWarnings(block), allowlist.filter((e) => e.slug === slug).map(inertWarning));
	}
});

test("WP-034/ui AC:WP-034/ui-4: new ASCII art in an article with a matched or an inert entry fails seed lint", async () => {
	const [second, copied, prose, changed] = plain as [string, string, string, string];
	const seed = edited(payload, {
		// A second ASCII block beside the pinned one.
		[second]: append(art, otherArt),
		// An identical copy of the pinned block: one entry permits one block.
		[copied]: append(art, art),
		// A box-drawing character in prose has no block, so no fingerprint can permit it.
		[prose]: append(art, "A box \u250c\u2500\u2510 in prose"),
		// The pinned block edited, which is also new art beside an inert entry: no block matches the entry.
		[changed]: append(otherArt),
	});
	const entries = [...allowlist, ...[second, copied, prose, changed].map((slug) => ({ slug, fingerprint: pin }))];
	const result = await lintSeed(seed, entries);
	assert.equal(result.status, 1, result.output);
	const at = (slug: string) =>
		findings(seed)
			.filter((f) => f.slug === slug)
			.map((f) => f.line);
	const asciiErrors = (block: string) => errors(block).filter((e) => e.startsWith("ASCII-art"));
	// In each article with a matched entry, the pinned block stays a warning and only the new art fails.
	for (const slug of [second, copied]) {
		const [pinned, extra] = at(slug) as [number, number];
		const block = result.block(slug);
		assert.match(block, /^FAIL /, slug);
		assert.deepEqual(asciiErrors(block), [asciiError(slug, extra)]);
		assert.deepEqual(asciiWarnings(block), [asciiError(slug, pinned)]);
	}
	const [boxed, box] = at(prose) as [number, number];
	assert.match(result.block(prose), /^FAIL /);
	assert.deepEqual(asciiErrors(result.block(prose)), [
		`ASCII-art at ${prose}:${box}: Box-drawing character; use a \`\`\`diagram block`,
	]);
	assert.deepEqual(asciiWarnings(result.block(prose)), [asciiError(prose, boxed)]);
	assert.match(result.block(changed), /^FAIL /);
	assert.deepEqual(asciiErrors(result.block(changed)), [asciiError(changed, at(changed)[0]!)]);
	assert.deepEqual(asciiWarnings(result.block(changed)), [inertWarning({ slug: changed, fingerprint: pin })]);
});

test("WP-034/ui AC:WP-034/ui-5: ASCII art in an article with no allowlist entry fails seed lint", async () => {
	const unlisted = plain[0]!;
	const seed = edited(payload, { [unlisted]: append(art) });
	const result = await lintSeed(seed);
	assert.equal(result.status, 1, result.output);
	assert.match(result.block(unlisted), /^FAIL /);
	assert.deepEqual(
		errors(result.block(unlisted)).filter((e) => e.startsWith("ASCII-art")),
		[asciiError(unlisted, findings(seed).find((f) => f.slug === unlisted)!.line)],
	);
	assert.deepEqual(failing(result.output).sort(), [...knownFailures, unlisted].sort());
});

test("WP-034/ui AC:WP-034/ui-7: the allowlist only shrinks, and an entry for an unknown slug fails seed lint", async () => {
	// The guard: each entry in the file is one of the original 9 pinned above, listed once.
	assert.deepEqual(added(allowlist), []);
	assert.equal(new Set(allowlist.map(key)).size, allowlist.length);
	const forged = { slug: ORIGINAL[0]!.slug, fingerprint: "0123456789abcdef" };
	assert.deepEqual(added([...allowlist, forged]), [forged]);
	const moved = { slug: "frameworks/new-article", fingerprint: ORIGINAL[0]!.fingerprint };
	assert.deepEqual(added([...ORIGINAL.slice(1), moved]), [moved]);
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
	assertNoNewFailures(replayed);
	assert.ok(!replayed.output.includes("Inert ASCII allowlist entry"), replayed.output);
	const migrated = edited(replay, Object.fromEntries(afterReplay.map((e) => [e.slug, migrate])));
	const done = await lintSeed(migrated, []);
	assertNoNewFailures(done);
	assert.ok(!done.output.includes("ASCII"), done.output);
});

test("WP-034/ui AC:WP-034/ui-8: each seed ASCII finding matches an entry, and each entry matches one block or is inert", () => {
	// The seed as it stands: every finding matches, and lint reports each entry with no block as inert.
	const current = audit(payload, allowlist);
	assert.deepEqual(current.unallowed, []);
	for (const entry of current.inert) assert.ok(baseline.output.includes(inertWarning(entry)), key(entry));
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
