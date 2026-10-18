import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "../../..");
const seedRoot = resolve(root, "docs/reference/wiki");
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const canonical = (row: object) => JSON.stringify(row, Object.keys(row).sort());
function wiki(...args: string[]) {
	const result = spawnSync(process.execPath, [resolve(root, "tools/wiki/main.ts"), ...args], { encoding: "utf8" });
	return { status: result.status, output: result.stdout + result.stderr };
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "wiki-test-"));
	const seed = join(dir, "seed");
	await mkdir(seed);
	for (const file of ["seed.json", "manifest.json"]) await cp(join(seedRoot, file), join(seed, file));
	const payload = JSON.parse(await readFile(join(seed, "seed.json"), "utf8"));
	const row = {
		...payload.articles[0],
		id: "7f96f336-4506-4adc-92d8-00228ffeb9cb",
		slug: "administrative/financial/tooling-fixture",
		title: "Synthetic tooling fixture",
		status: "draft",
		published_at: null,
		content: [
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
	const draft = join(dir, "docs/reference/wiki/drafts", row.slug + ".json");
	await mkdir(dirname(draft), { recursive: true });
	await writeFile(draft, JSON.stringify(row, null, 2) + "\n");
	git(dir, "init", "--initial-branch=proof");
	git(dir, "add", "docs");
	git(
		dir,
		"-c",
		"user.name=Wiki proof",
		"-c",
		"user.email=wiki-proof@example.test",
		"commit",
		"-m",
		"Reviewed synthetic draft",
	);
	return { dir, seed, draft, row, sha: git(dir, "rev-parse", "HEAD") };
}

test("INV-wiki: promotion preserves unrelated seed records and logs exact hashes for insert and replacement", async () => {
	const f = await fixture();
	try {
		const realBytes = await readFile(join(seedRoot, "seed.json"));
		const before = JSON.parse(realBytes.toString());
		const args = ["--seed-dir", f.seed, "--approved-by", "Sebastian", "--pr", "12"];
		const result = wiki("promote", f.draft, ...args, "--reviewed-sha", f.sha);
		assert.equal(result.status, 0, result.output);
		assert.equal(wiki("check-seed", "--seed-dir", f.seed).status, 0);
		const bytes = await readFile(join(f.seed, "seed.json"));
		const payload = JSON.parse(bytes.toString());
		assert.deepEqual(payload.articles.slice(0, -1), before.articles);
		assert.deepEqual(payload.sections, before.sections);
		assert.deepEqual(payload.templates, before.templates);
		const added = payload.articles.at(-1);
		assert.equal(added.content, f.row.content);
		assert.equal(added.status, "published");
		assert.equal(added.draft, undefined);
		assert.match(added.published_at, /^\d{4}-.*Z$/);
		assert.equal(added.published_at, added.updated_at);
		let manifest = JSON.parse(await readFile(join(f.seed, "manifest.json"), "utf8"));
		assert.deepEqual(manifest.releases.at(-1), {
			id: f.row.id,
			slug: f.row.slug,
			previousRecordSHA256: null,
			recordSHA256: hash(canonical(added)),
			approvedBy: "Sebastian",
			pr: 12,
			date: added.updated_at,
		});
		assert.equal(manifest.seedPayloadSHA256, hash(bytes));
		assert.equal(manifest.articles.at(-1).contentSHA256, hash(added.content));
		await assert.rejects(readFile(f.draft), { code: "ENOENT" });
		const edit = {
			...added,
			title: "Revised synthetic fixture",
			status: "draft",
			published_at: null,
			draft: { ...f.row.draft, replaces_id: added.id },
		};
		await writeFile(f.draft, JSON.stringify(edit, null, 2) + "\n");
		git(f.dir, "add", "docs");
		git(
			f.dir,
			"-c",
			"user.name=Wiki proof",
			"-c",
			"user.email=wiki-proof@example.test",
			"commit",
			"-m",
			"Reviewed revised fixture",
		);
		const second = wiki("promote", f.draft, ...args, "--reviewed-sha", git(f.dir, "rev-parse", "HEAD"));
		assert.equal(second.status, 0, second.output);
		assert.equal(wiki("check-seed", "--seed-dir", f.seed).status, 0);
		manifest = JSON.parse(await readFile(join(f.seed, "manifest.json"), "utf8"));
		assert.equal(manifest.releases.at(-1).previousRecordSHA256, manifest.releases.at(-2).recordSHA256);
		const after = JSON.parse(await readFile(join(f.seed, "seed.json"), "utf8"));
		assert.equal(after.articles.length, before.articles.length + 1);
		assert.equal(after.articles.at(-1).title, "Revised synthetic fixture");
		assert.deepEqual(after.articles.slice(0, -1), before.articles);
		assert.deepEqual(await readFile(join(seedRoot, "seed.json")), realBytes);
	} finally {
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("INV-wiki: changed reviewed draft is refused without touching the seed or deleting the draft", async () => {
	const f = await fixture();
	try {
		const before = await readFile(join(f.seed, "seed.json"));
		const manifest = await readFile(join(f.seed, "manifest.json"));
		await writeFile(f.draft, JSON.stringify({ ...f.row, title: "Changed after review" }, null, 2) + "\n");
		const result = wiki(
			"promote",
			f.draft,
			"--seed-dir",
			f.seed,
			"--approved-by",
			"Sebastian",
			"--pr",
			"12",
			"--reviewed-sha",
			f.sha,
		);
		assert.equal(result.status, 1);
		assert.match(result.output, /Draft differs from the reviewed PR head/);
		assert.deepEqual(await readFile(join(f.seed, "seed.json")), before);
		assert.deepEqual(await readFile(join(f.seed, "manifest.json")), manifest);
		assert.equal(JSON.parse(await readFile(f.draft, "utf8")).title, "Changed after review");
		const data = JSON.parse(before.toString());
		data.articles[0].content += "silently changed";
		await writeFile(join(f.seed, "seed.json"), JSON.stringify(data));
		const bad = wiki("check-seed", "--seed-dir", f.seed);
		assert.equal(bad.status, 1);
		assert.match(bad.output, /seedPayloadSHA256 mismatch/);
		assert.match(bad.output, /article content\/section mismatch/);
	} finally {
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("INV-wiki: renderer refuses executable MDX and lint reports malformed article behavior", async () => {
	const f = await fixture();
	try {
		const safe = wiki("lint", f.draft);
		assert.equal(safe.status, 0, safe.output);
		const content =
			'# Wrong heading\n\n## Only section\n\nTODO [missing](/wiki/no-such-article).\n\n<Unknown />\n\n{process.exit(29)}\n\n<Callout type="scripture">Bad quote</Callout>';
		await writeFile(f.draft, JSON.stringify({ ...f.row, content, church_id: "private-tenant" }));
		const bad = wiki("lint", f.draft);
		assert.equal(bad.status, 1);
		for (const text of [
			"H1 in body",
			"JS expression",
			"Only <Callout",
			"Scripture must",
			"Placeholder text",
			"unknown article",
			"H2 headings",
			"words; allowed",
			"church_id must be null",
		])
			assert.ok(bad.output.includes(text), bad.output);
		const rendered = wiki("render", f.draft, "--out", join(f.dir, "render"));
		assert.equal(rendered.status, 1);
		assert.match(rendered.output, /Fix lint errors before rendering/);
		await writeFile(f.draft, JSON.stringify({ ...f.row, content: '## Broken\n\n<Callout type="tip">' }));
		const syntax = wiki("lint", f.draft);
		assert.equal(syntax.status, 1);
		assert.match(syntax.output, /MDX does not compile/);
	} finally {
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("BUG-PR5: draft lint accepts scripture reference forms and quoted speech while requiring the LSB callout format", async (t) => {
	const f = await fixture();
	const cases = [
		["single verse", '*"Synthetic quotation."* — John 3:16 (LSB)', true],
		["multi-word book", '*"Synthetic quotation."* — Song of Solomon 2:1 (LSB)', true],
		["numbered book", '*"Synthetic quotation."* — 1 Thessalonians 5:16-18 (LSB)', true],
		["cross-chapter range", '*"Synthetic quotation."* — John 3:16-4:2 (LSB)', true],
		["verse part", '*"Synthetic quotation."* — Ecclesiastes 3:11a (LSB)', true],
		["verse-part range", '*"Synthetic quotation."* — John 3:16a–4:2b (LSB)', true],
		["quoted speech", '*"He said, "Synthetic speech," to them."* — John 3:16 (LSB)', true],
		["wrapped quotation", '*"Synthetic quotation\ncontinued here."* — John 3:16 (LSB)', true],
		["missing translation", '*"Synthetic quotation."* — John 3:16', false],
		["other translation", '*"Synthetic quotation."* — John 3:16 (ESV)', false],
		["missing emphasis", '"Synthetic quotation." — John 3:16 (LSB)', false],
		["missing outer quotes", "*Synthetic quotation.* — John 3:16 (LSB)", false],
		["empty quote", '*""* — John 3:16 (LSB)', false],
		["missing verse", '*"Synthetic quotation."* — John 3 (LSB)', false],
		["incomplete range", '*"Synthetic quotation."* — John 3:16-4: (LSB)', false],
		["two quotations", '*"First quotation."* — John 3:16 (LSB)\n\n*"Second quotation."* — John 3:17 (LSB)', false],
	] as const;
	try {
		for (const [name, callout, valid] of cases)
			await t.test(name, async () => {
				const content = f.row.content.replace(
					/<Callout type="scripture">[\s\S]*?<\/Callout>/,
					() => `<Callout type="scripture">\n${callout}\n</Callout>`,
				);
				await writeFile(f.draft, JSON.stringify({ ...f.row, content }));
				const result = wiki("lint", f.draft);
				assert.equal(result.status, valid ? 0 : 1, result.output);
				if (valid) assert.match(result.output, /1\/1 articles pass the error checks/);
				else
					assert.match(
						result.output,
						/Scripture must be \*"verse text"\* — Book 1:2 \(LSB\), with one quote per callout/,
					);
			});
	} finally {
		await rm(f.dir, { recursive: true, force: true });
	}
});
