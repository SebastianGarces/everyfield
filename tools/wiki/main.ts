import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { object, readJson, rows, shape } from "./rows.ts";
import type { ObjectRow } from "./rows.ts";
import { prImages } from "./pr-images.ts";

const root = resolve(import.meta.dirname, "../..");
const help = `Wiki authoring tools (Node 24; install: cd tools/wiki && pnpm install --ignore-workspace)
  wiki lint <draft.json>... | --seed
  wiki render <draft.json | seed-slug> --out <dir>
  wiki shot <draft.json | seed-slug>... --out <dir> [--mobile]
  wiki pr-images <pr-number> <png>... [--update-body]
  wiki promote <draft.json> --approved-by <Sebastian|Bryan> --pr <n> --reviewed-sha <sha>
  wiki check-seed
  wiki roundtrip
Seed commands also accept --seed-dir <dir> for disposable proof copies.
Promotion records human approval given in chat or a PR comment. It does not grant approval.`;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function main() {
	const args = process.argv.slice(2);
	const command = args.shift();
	if (!command || command === "help" || command === "--help") {
		console.log(help);
		return;
	}
	const positionals: string[] = [],
		flags = new Map<string, string | true>();
	const booleans = new Set(["--seed", "--mobile", "--update-body"]);
	const options: Record<string, string[]> = {
		lint: ["--seed", "--seed-dir"],
		render: ["--out", "--seed-dir"],
		shot: ["--out", "--mobile", "--seed-dir"],
		"pr-images": ["--update-body"],
		promote: ["--approved-by", "--pr", "--reviewed-sha", "--seed-dir"],
		"check-seed": ["--seed-dir"],
		roundtrip: ["--seed-dir"],
	};
	if (!options[command]) throw new Error(`Unknown command ${command}; run bin/wiki help`);
	while (args.length) {
		const arg = args.shift()!;
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		if (!options[command].includes(arg) || flags.has(arg)) throw new Error(`Unknown or repeated option ${arg}`);
		if (booleans.has(arg)) flags.set(arg, true);
		else {
			const value = args.shift();
			if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
			flags.set(arg, value);
		}
	}
	const required = (key: string) => {
		const value = flags.get(key);
		if (typeof value !== "string") throw new Error(`${key} is required`);
		return value;
	};
	const seedDir = resolve(String(flags.get("--seed-dir") || resolve(root, "docs/reference/wiki")));
	const python = (cmd: string, extra: string[] = []) =>
		execFileSync(
			"python3",
			[
				"-I",
				resolve(root, "tools/wiki/seed.py"),
				cmd,
				"--seed-dir",
				seedDir,
				"--playbook",
				resolve(root, "docs/reference/playbook.md"),
				"--bootstrap",
				resolve(root, "docs/reference/bootstrap/global-seed-payload.json"),
				...extra,
			],
			{ encoding: "utf8" },
		);
	if (command === "check-seed" || command === "roundtrip") {
		if (positionals.length) throw new Error("This command has no positional arguments");
		console.log(python(command === "check-seed" ? "check" : "roundtrip").trim());
		return;
	}
	if (command === "pr-images") {
		const [number, ...files] = positionals;
		if (!/^[1-9]\d*$/.test(number || "") || !files.length) throw new Error("Use wiki pr-images <pr-number> <png>...");
		await prImages(
			Number(number),
			files.map((f) => resolve(f)),
			flags.has("--update-body"),
			root,
		);
		return;
	}
	const payload = await readJson(resolve(seedDir, "seed.json"));
	const articles = rows(payload, "articles"),
		sections = rows(payload, "sections");
	const known = new Set(articles.map((a) => String(a.slug)));
	async function load(input: string) {
		if (input.endsWith(".json")) {
			const row = await readJson(resolve(input));
			if (!object(row)) throw new Error(`${input}: expected one article object`);
			return { row, seed: false };
		}
		const row = articles.find((a) => a.slug === input);
		if (!row) throw new Error(`Unknown seed article: ${input}`);
		return { row, seed: true };
	}
	async function lint(row: ObjectRow, seed: boolean, label: string) {
		const { inspect } = await import("./mdx.ts");
		const result = await inspect(typeof row.content === "string" ? row.content : "", known, seed);
		result.errors.unshift(...shape(row, articles, sections, seed));
		if (
			typeof row.read_time_minutes === "number" &&
			Math.abs(row.read_time_minutes - Math.round(result.words / 200)) > 1
		)
			result.warnings.push(
				`read_time_minutes ${row.read_time_minutes}; ${result.words} words is about ${Math.round(result.words / 200)} minutes`,
			);
		console.log(`${result.errors.length ? "FAIL" : "PASS"} ${label} (${result.words} words)`);
		for (const message of result.errors) console.log(`  ERROR ${message}`);
		for (const message of result.warnings) console.log(`  WARN ${message}`);
		return result;
	}
	if (command === "lint") {
		if (flags.has("--seed") && positionals.length) throw new Error("Choose --seed or draft files");
		if (!flags.has("--seed") && !positionals.length) throw new Error("Provide draft files or --seed");
		let failed = 0,
			count = 0;
		for (const item of flags.has("--seed")
			? articles.map((row) => ({ row, seed: true }))
			: await Promise.all(positionals.map(load))) {
			if (!flags.has("--seed") && item.seed)
				throw new Error("wiki lint expects JSON drafts; use --seed for the published set");
			const result = await lint(item.row, item.seed, String(item.row.slug));
			count++;
			if (result.errors.length) failed++;
		}
		console.log(`${count - failed}/${count} articles pass the error checks`);
		process.exitCode = failed ? 1 : 0;
		return;
	}
	if (!positionals.length || (command !== "shot" && positionals.length !== 1))
		throw new Error("Provide one article (or several for shot)");
	if (command === "promote") {
		const input = await realpath(positionals[0]);
		const bytes = await readFile(input);
		const row = JSON.parse(bytes.toString("utf8"));
		if (!object(row)) throw new Error("Expected one draft object");
		const result = await lint(row, false, input);
		if (result.errors.length) throw new Error("Promotion requires a passing lint");
		const approver = required("--approved-by"),
			pr = required("--pr"),
			sha = required("--reviewed-sha");
		if (!/^[1-9]\d*$/.test(pr) || !/^[a-f0-9]{40,64}$/.test(sha))
			throw new Error("Use a positive PR number and a full reviewed commit SHA");
		const meta = row.draft;
		if (
			!object(meta) ||
			meta.tier === "C" ||
			meta.approver !== approver ||
			!object(meta.claim_check) ||
			meta.claim_check.status !== "passed" ||
			!meta.claim_check.reviewer
		)
			throw new Error(
				"Promotion needs the named eligible approver and a passed independent claim check; tier C cannot be promoted by this tool",
			);
		const repo = execFileSync("git", ["-C", dirname(input), "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
		}).trim();
		const path = relative(repo, input).split("\\").join("/");
		if (isAbsolute(path) || path !== `docs/reference/wiki/drafts/${row.slug}.json`)
			throw new Error("Promote the tracked draft at docs/reference/wiki/drafts/<slug>.json");
		const reviewed = execFileSync("git", ["-C", repo, "show", `${sha}:${path}`]);
		if (!bytes.equals(reviewed))
			throw new Error("Draft differs from the reviewed PR head; obtain review of the changed draft");
		const lock = resolve(seedDir, ".wiki-promote.lock");
		await mkdir(lock); // One seed writer. A stale lock requires inspection before removal.
		try {
			console.log(
				python("promote", [
					"--draft",
					input,
					"--draft-sha256",
					digest(bytes),
					"--approved-by",
					approver,
					"--pr",
					pr,
				]).trim(),
			);
		} finally {
			await rm(lock, { recursive: true });
		}
		return;
	}
	const out = resolve(required("--out"));
	if (out === root || !relative(root, out).startsWith(".."))
		throw new Error("Render evidence outside the repository, such as the git common directory or /tmp");
	const { render } = await import("./render.ts");
	const pages: string[] = [];
	for (const input of positionals) {
		const { row, seed } = await load(input);
		const result = await lint(row, seed, input);
		if (result.errors.length || !result.code) throw new Error("Fix lint errors before rendering");
		pages.push(await render(row, result.code, String(sections.find((s) => s.id === row.section_id)?.name), root, out));
	}
	if (command === "render") {
		console.log(pages.join("\n"));
		return;
	}
	const { chromium } = await import("playwright");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({
			viewport: { width: flags.has("--mobile") ? 390 : 1280, height: 900 },
			deviceScaleFactor: 1,
		});
		for (const file of pages) {
			await page.goto(pathToFileURL(file).href);
			await page.evaluate(() => document.fonts.ready);
			const target = file.replace(/\.html$/, flags.has("--mobile") ? "-mobile.png" : ".png");
			await page.screenshot({ path: target, fullPage: true });
			console.log(target);
		}
	} finally {
		await browser.close();
	}
}
main().catch((error) => {
	console.error(`wiki: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
