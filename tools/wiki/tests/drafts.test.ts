import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const seedRoot = resolve(root, "docs/reference/wiki");
const identity = {
	GIT_AUTHOR_NAME: "Wiki proof",
	GIT_AUTHOR_EMAIL: "wiki-proof@example.test",
	GIT_COMMITTER_NAME: "Wiki proof",
	GIT_COMMITTER_EMAIL: "wiki-proof@example.test",
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...identity } }).trim();
const wiki = (cwd: string, ...args: string[]) => {
	const result = spawnSync(resolve(root, "bin/wiki"), args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...identity },
	});
	return { status: result.status, output: result.stdout + result.stderr };
};

/** A repository whose main holds the real seed, and a branch `drafts` that adds one article draft. */
async function fixture(draft: Record<string, unknown> = {}) {
	const dir = realpathSync(await mkdtemp(join(tmpdir(), "wiki-drafts-")));
	const seed = join(dir, "docs/reference/wiki");
	await mkdir(seed, { recursive: true });
	for (const file of ["seed.json", "manifest.json"]) await cp(join(seedRoot, file), join(seed, file));
	git(dir, "init", "--quiet", "--initial-branch=main");
	git(dir, "add", "docs");
	git(dir, "commit", "--quiet", "-m", "main");
	git(dir, "checkout", "--quiet", "-b", "drafts");
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
			claim_check: { status: "pending", reviewer: "", notes: "" },
			rulings: [],
			...draft,
		},
	};
	const path = join(seed, "drafts", `${row.slug}.json`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(row, null, 2) + "\n");
	git(dir, "add", "docs");
	git(dir, "commit", "--quiet", "-m", "draft");
	return { dir, seed, path, row };
}

const claim = (dir: string, ...extra: string[]) =>
	wiki(dir, "claim-check", "--reviewer", "Bryan", "--approval", "these claims hold", "--base", "main", ...extra);

test("wiki claim-check records the named reviewer on pending drafts, in one commit, and pushes it", async () => {
	const f = await fixture();
	const bare = join(f.dir, "..", `${f.dir.split("/").pop()}-origin.git`);
	try {
		execFileSync("git", ["init", "--quiet", "--bare", bare]);
		git(f.dir, "remote", "add", "origin", bare);
		const before = git(f.dir, "rev-parse", "HEAD");
		const result = claim(f.dir);
		assert.equal(result.status, 0, result.output);
		assert.match(
			result.output,
			/claim-check: 1 draft passed by Bryan at [0-9a-f]{10}: docs\/reference\/wiki\/drafts\//,
		);
		const cc = JSON.parse(await readFile(f.path, "utf8")).draft.claim_check;
		assert.equal(cc.status, "passed");
		assert.equal(cc.reviewer, "Bryan");
		assert.match(cc.notes, /^Approved \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z: "these claims hold"$/);
		assert.equal(git(f.dir, "rev-parse", "HEAD~1"), before);
		assert.equal(git(f.dir, "log", "-1", "--format=%s"), "Wiki claim check by Bryan (1 drafts)");
		assert.equal(git(f.dir, "status", "--porcelain"), "");
		assert.equal(git(bare, "rev-parse", "refs/heads/drafts"), git(f.dir, "rev-parse", "HEAD"));

		const again = claim(f.dir);
		assert.equal(again.status, 1);
		assert.match(again.output, /no pending Wiki drafts/);
	} finally {
		await rm(f.dir, { recursive: true, force: true });
		await rm(bare, { recursive: true, force: true });
	}
});

test("wiki claim-check refuses a one-word approval, uncommitted changes and main", async () => {
	const f = await fixture();
	try {
		const head = git(f.dir, "rev-parse", "HEAD");
		const short = wiki(f.dir, "claim-check", "--reviewer", "Bryan", "--approval", "yes", "--base", "main");
		assert.equal(short.status, 1);
		assert.match(short.output, /two words or more/);
		await writeFile(join(f.dir, "stray.txt"), "x");
		const dirty = claim(f.dir);
		assert.equal(dirty.status, 1);
		assert.match(dirty.output, /uncommitted changes/);
		await rm(join(f.dir, "stray.txt"));
		git(f.dir, "checkout", "--quiet", "main");
		const onMain = claim(f.dir);
		assert.equal(onMain.status, 1);
		assert.match(onMain.output, /not on main/);
		git(f.dir, "checkout", "--quiet", "drafts");
		assert.equal(git(f.dir, "rev-parse", "HEAD"), head);
	} finally {
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("wiki promote-all promotes the passed drafts in one local commit and the seed still checks", async () => {
	const f = await fixture();
	try {
		assert.equal(claim(f.dir).status, 0);
		const result = wiki(f.dir, "promote-all", "--pr", "12", "--base", "main");
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /promote-all: 1 promoted at [0-9a-f]{10}, not pushed:/);
		assert.equal(existsSync(f.path), false, "the draft is gone");
		const seed = JSON.parse(await readFile(join(f.seed, "seed.json"), "utf8"));
		const added = seed.articles.find((a: { id: string }) => a.id === f.row.id);
		assert.equal(added.status, "published");
		const manifest = JSON.parse(await readFile(join(f.seed, "manifest.json"), "utf8"));
		assert.equal(manifest.releases.at(-1).approvedBy, "Sebastian");
		assert.equal(manifest.releases.at(-1).pr, 12);
		assert.equal(git(f.dir, "log", "-1", "--format=%s"), "Promote 1 Wiki drafts");
		assert.equal(git(f.dir, "status", "--porcelain"), "");

		const nothing = wiki(f.dir, "promote-all", "--pr", "12", "--base", "main");
		assert.equal(nothing.status, 0, nothing.output);
		assert.match(nothing.output, /no draft on this branch has a passed claim check/);
	} finally {
		await rm(f.dir, { recursive: true, force: true });
	}
});

test("wiki promote-all leaves a pending draft alone, and a refused promotion returns the checkout to its start", async () => {
	const pending = await fixture();
	try {
		const seed = await readFile(join(pending.seed, "seed.json"));
		const result = wiki(pending.dir, "promote-all", "--pr", "12", "--base", "main");
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /no draft on this branch has a passed claim check/);
		assert.deepEqual(await readFile(join(pending.seed, "seed.json")), seed);
		assert.equal(existsSync(pending.path), true);
	} finally {
		await rm(pending.dir, { recursive: true, force: true });
	}
	const tierC = await fixture({ tier: "C" });
	try {
		assert.equal(claim(tierC.dir).status, 0);
		const head = git(tierC.dir, "rev-parse", "HEAD");
		const seed = await readFile(join(tierC.seed, "seed.json"));
		const result = wiki(tierC.dir, "promote-all", "--pr", "12", "--base", "main");
		assert.equal(result.status, 1);
		assert.match(result.output, /bin\/wiki promote \S+ failed: .*tier C cannot be promoted by this tool/s);
		assert.equal(git(tierC.dir, "rev-parse", "HEAD"), head);
		assert.equal(git(tierC.dir, "status", "--porcelain"), "");
		assert.deepEqual(await readFile(join(tierC.seed, "seed.json")), seed);
	} finally {
		await rm(tierC.dir, { recursive: true, force: true });
	}
});
