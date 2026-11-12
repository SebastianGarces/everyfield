import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tool = resolve(import.meta.dirname, "../ci-timing.ts");

// A fake gh that serves fixtures by API path, records every call and refuses anything but a GET read.
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.FAKE_GH, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const refuse = (why) => { process.stderr.write('WRITE REFUSED: ' + why + '\\n'); process.exit(99); };
if (args[0] !== 'api') refuse('not an api read');
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--method' || a === '-X') { if (args[i + 1] !== 'GET') refuse('method ' + args[i + 1]); i++; continue; }
  if (/^(--method|-X)=?/.test(a) && !/^(--method=|-X)GET$/.test(a)) refuse('method ' + a);
  if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a) || /^(-f|-F|--field=|--raw-field=|--input=)/.test(a)) refuse('field ' + a);
}
const route = args.filter((a) => !a.startsWith('-') && a !== 'api' && a !== 'GET').pop();
const fixture = JSON.parse(fs.readFileSync(path.join(process.env.FAKE_GH, 'routes.json'), 'utf8'))[route];
if (!fixture) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
if (fixture.status) { process.stderr.write('gh: ' + fixture.status + ' (HTTP ' + fixture.status + ')\\n'); process.exit(1); }
// Like gh 2.103, refuse to print terminal escape sequences unless allowed.
if (typeof fixture.body === 'string' && fixture.body.includes('\\x1b') && !args.includes('--allow-escape-sequences')) {
  process.stderr.write('the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway\\n');
  process.exit(1);
}
process.stdout.write(typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body));
`;

const t = (s: number) => new Date(Date.UTC(2026, 10, 4, 12, 0, s)).toISOString();
const step = (name: string, from: number, to: number | null, conclusion = "success") => ({
	name,
	conclusion,
	started_at: t(from),
	completed_at: to === null ? null : t(to),
});
const R = "repos/{owner}/{repo}/actions";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ci-timing-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), fakeGh);
	chmodSync(join(bin, "gh"), 0o755);
	const routes = {
		[`${R}/workflows/ci.yml/runs?status=completed&per_page=2`]: {
			body: {
				workflow_runs: [
					{ id: 1, created_at: t(0) },
					{ id: 2, created_at: t(0) },
				],
			},
		},
		[`${R}/runs/1/jobs?per_page=100`]: {
			body: {
				jobs: [
					{
						id: 11,
						name: "app",
						created_at: t(0),
						started_at: t(2),
						steps: [
							// Every listed setup pattern, 1 s each: 11 s of setup.
							step("Set up job", 2, 3),
							step("Run actions/checkout@v7", 3, 4),
							step("Run pnpm/action-setup@v6", 4, 5),
							step("Run actions/setup-node@v7", 5, 6),
							step("pnpm in the corepack cache (retries registry errors)", 6, 7),
							step("Run pnpm install --frozen-lockfile", 7, 8),
							step("Run actions/cache@v6", 8, 9),
							step("Run actions/cache/restore@v6", 9, 10),
							step("Chromium for render tests", 10, 11),
							// Unlisted steps are run time: 30 s + 20 s. The skipped one did not run.
							step("Types", 11, 41),
							step("Install the world", 41, 61),
							step("Statement census part", 61, 61, "skipped"),
							step("Post Run actions/checkout@v7", 61, 62),
							step("Complete job", 62, 63),
						],
					},
					{
						id: 12,
						name: "docs",
						created_at: t(0),
						started_at: t(5),
						// A run step without completed_at: run time is no data, setup still counts.
						steps: [step("Set up job", 5, 7), step("Documentation checks", 7, null)],
					},
				],
			},
		},
		[`${R}/jobs/11/logs`]: {
			body: [
				"2026-11-04T12:00:05Z Cache restored from key: node-cache-Linux-x64-pnpm-abc",
				"2026-11-04T12:00:08Z Cache not found for input keys: next-Linux-abc, next-Linux-",
				"2026-11-04T12:00:09Z Cache restored from key: next-Linux-abc",
				"2026-11-04T12:00:10Z \x1b[36;1munrelated coloured line\x1b[0m",
			].join("\n"),
		},
		// Expired log.
		[`${R}/jobs/12/logs`]: { status: 410 },
		[`${R}/runs/2/jobs?per_page=100`]: {
			body: {
				jobs: [
					{
						id: 21,
						name: "app",
						created_at: t(0),
						started_at: t(4),
						// The step names since T-251: corepack's pnpm and the pnpm store cache are setup.
						steps: [
							step("Set up job", 4, 6),
							step("pnpm from corepack (retries registry errors)", 6, 7),
							step("pnpm store cache", 7, 8),
							step("Types", 8, 18),
						],
					},
					{
						id: 22,
						name: "docs",
						created_at: t(0),
						started_at: t(1),
						steps: [step("Set up job", 1, 2), step("Documentation checks", 2, 5)],
					},
				],
			},
		},
		[`${R}/jobs/21/logs`]: { body: "Cache not found for input keys: x\npnpm cache is not found\n" },
		// Job 22 has no log route: HTTP 404.
	};
	writeFileSync(join(root, "routes.json"), JSON.stringify(routes));
	const run = (...args: string[]) =>
		spawnSync(process.execPath, [tool, ...args], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH: root },
		});
	const calls = () =>
		readFileSync(join(root, "calls.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as string[]);
	return { root, gh: join(bin, "gh"), run, calls, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("INV-ci-timing: ci-timing splits queue, setup and run per job, counts cache lines and totals per job name", () => {
	const f = fixture();
	try {
		const r = f.run("--last", "2", "--json");
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), {
			runs: [
				{
					id: 1,
					createdAt: t(0),
					jobs: [
						{ id: 11, name: "app", queueMs: 2000, setupMs: 11_000, runMs: 50_000, cacheHits: 2, cacheMisses: 1 },
						{ id: 12, name: "docs", queueMs: 5000, setupMs: 2000, runMs: null, cacheHits: null, cacheMisses: null },
					],
				},
				{
					id: 2,
					createdAt: t(0),
					jobs: [
						{ id: 21, name: "app", queueMs: 4000, setupMs: 4000, runMs: 10_000, cacheHits: 0, cacheMisses: 2 },
						{ id: 22, name: "docs", queueMs: 1000, setupMs: 1000, runMs: 3000, cacheHits: null, cacheMisses: null },
					],
				},
			],
			totals: [
				{ name: "app", jobs: 2, queueMs: 6000, setupMs: 15_000, runMs: 60_000, cacheHits: 2, cacheMisses: 3 },
				// The missing run time and both missing logs are left out of the totals, never counted as 0.
				{ name: "docs", jobs: 2, queueMs: 6000, setupMs: 3000, runMs: 3000, cacheHits: null, cacheMisses: null },
			],
		});
	} finally {
		f.close();
	}
});

test("INV-ci-timing: ci-timing prints no data for a missing signal, never 0", () => {
	const f = fixture();
	try {
		const r = f.run("--last", "2");
		assert.equal(r.status, 0, r.stderr);
		const lines = r.stdout.split("\n");
		const docs = lines.find((l) => l.trimStart().startsWith("docs ") && l.includes("run   no data"));
		assert.ok(docs, r.stdout);
		assert.match(docs, /cache hits no data misses no data$/);
		assert.match(
			lines.find((l) => l.includes("app (2)")) ?? "",
			/queue +6\.0 s +setup +15\.0 s +run +1\.0 min +cache hits 2 misses 3$/,
		);
		assert.match(lines.find((l) => l.includes("docs (2)")) ?? "", /run +3\.0 s +cache hits no data misses no data$/);
	} finally {
		f.close();
	}
});

test("INV-ci-timing: ci-timing sends only GET reads to GitHub", () => {
	const f = fixture();
	try {
		assert.equal(f.run("--last", "2").status, 0);
		const calls = f.calls();
		assert.equal(calls.length, 7);
		for (const call of calls) {
			assert.deepEqual(call.slice(0, 3), ["api", "--method", "GET"]);
			// A job log read also allows the log's colour codes; nothing else is added.
			const isLog = call.at(-1)?.endsWith("/logs");
			assert.deepEqual(call.slice(3, -1), isLog ? ["--allow-escape-sequences"] : []);
		}
		// The fake really refuses writes, so a write attempt cannot pass unnoticed.
		for (const write of [
			["--method", "POST"],
			["-X", "PATCH"],
			["-f", "a=b"],
			["-F", "a=b"],
			["--input", "x"],
		]) {
			const r = spawnSync(f.gh, ["api", ...write, "repos/x"], {
				encoding: "utf8",
				env: { ...process.env, FAKE_GH: f.root },
			});
			assert.equal(r.status, 99, write.join(" "));
		}
	} finally {
		f.close();
	}
});
