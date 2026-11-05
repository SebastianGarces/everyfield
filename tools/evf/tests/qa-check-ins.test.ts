import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { runSeed, source, tsxRun } from "./fixtures.ts";
import { startQuietDatabase, stopQuietDatabase, type QuietDatabase } from "../timing-stack.ts";

// OPS-125: the QA seed gives the QA owner 13 answered past check-in weeks. Each test reads the seeded quiet database
// through the private-care writer as the owner (qa-care-probe.ts), the way the check-in screen reads it.

const ZONE = "America/New_York";
const OWNER = "delivered+qa-owner@resend.dev";
const PASSWORD = "qa-role-password-0123";

type Levels = { spiritual: string; family: string; financial: string; pace: string };
type Week = {
	id: string | null;
	ordinal: number;
	startsOn: string;
	endsOn: string;
	current: boolean;
	answer: { answers: Levels; note: string | null; revision: number; answeredAt: string } | null;
	revisions: { revision: number; kind: string; answers: Levels; note: string | null; recordedAt: string }[];
};
type Page = { zone: string; revision: string; page: number; pageCount: number; weeks: Week[] };

/** The local date of `at` in the owner's zone. */
const localDay = (at: Date | string) =>
	new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(at),
	);
const addDays = (day: string, n: number) =>
	new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Monday of this week in the owner's zone. */
function thisMonday() {
	const today = localDay(new Date());
	const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
	return addDays(today, -weekday);
}

type Shared = {
	db: QuietDatabase;
	firstSeed: string;
	query: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;
};
let shared: Promise<Shared> | undefined;
/** One quiet database for this file, seeded once. Started by the first test that needs it. */
function seeded(): Promise<Shared> {
	shared ??= (async () => {
		const db = startQuietDatabase(source, "qa-check-ins");
		const pg = createRequire(join(source, "packages/db/package.json"))("pg");
		const query = async (text: string, values: unknown[] = []) => {
			const client = new pg.Client({ connectionString: db.adminUrl });
			await client.connect();
			try {
				return (await client.query(text, values)).rows as Record<string, unknown>[];
			} finally {
				await client.end();
			}
		};
		const first = runSeed({ DATABASE_URL: db.adminUrl, QA_ROLE_PASSWORD: PASSWORD });
		assert.equal(first.status, 0, first.stderr);
		return { db, firstSeed: first.stdout.trim(), query };
	})();
	return shared;
}
after(async () => {
	if (shared) stopQuietDatabase((await shared).db);
});

async function probe(call: unknown) {
	const { db } = await seeded();
	const r = tsxRun(["tools/evf/tests/qa-care-probe.ts", JSON.stringify(call)], { DATABASE_URL: db.adminUrl });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout) as { status: string; value: unknown };
}
async function history(page: number): Promise<Page> {
	const reply = await probe({ op: "history", page });
	assert.equal(reply.status, "ok", JSON.stringify(reply));
	return reply.value as Page;
}
/** Every week, newest first: both history pages. */
async function allWeeks() {
	const [first, second] = [await history(1), await history(2)];
	return { first, second, weeks: [...first.weeks, ...second.weeks] };
}
const nonSteady = (level: string) => level === "strained" || level === "struggling";

test("OPS-125: the QA owner has a confirmed zone and 13 answered past weeks before an open week OPS-125-1", async () => {
	const { query, firstSeed } = await seeded();
	assert.match(firstSeed, /owner timezone, 13 check-in weeks\.$/);
	assert.deepEqual(
		await query("SELECT a.personal_timezone FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email=$1", [
			OWNER,
		]),
		[{ personal_timezone: ZONE }],
	);
	const { first, weeks } = await allWeeks();
	assert.equal(first.zone, ZONE);
	assert.equal(weeks.length, 14);
	const monday = thisMonday();
	const [open, ...past] = weeks;
	assert.equal(open!.startsOn, monday);
	assert.equal(open!.current, true);
	assert.equal(open!.answer, null);
	// One week for each Monday from 13 weeks ago to last week, newest first, with no gap.
	assert.deepEqual(
		past.map((w) => w.startsOn),
		Array.from({ length: 13 }, (_, i) => addDays(monday, -7 * (i + 1))),
	);
	for (const w of past) {
		assert.ok(w.answer, `${w.startsOn} is answered`);
		assert.equal(w.current, false);
	}
	assert.deepEqual(
		weeks.map((w) => w.ordinal),
		Array.from({ length: 14 }, (_, i) => 14 - i),
	);
});

test("OPS-125: the Pace run of 3 Strained or Struggling weeks ends last week, after a Steady week OPS-125-2", async () => {
	const { weeks } = await allWeeks();
	const past = weeks.slice(1).reverse(); // oldest first
	const pace = past.map((w) => w.answer!.answers.pace);
	const run = pace.slice(-3);
	assert.ok(run.every(nonSteady), `last three Pace answers: ${run}`);
	assert.ok(run.includes("strained") && run.includes("struggling"), `last three Pace answers: ${run}`);
	assert.equal(pace.at(-4), "steady");
	for (const dimension of ["spiritual", "family", "financial", "pace"] as const) {
		const levels = past.map((w) => w.answer!.answers[dimension]);
		const runs = levels.map((_, i) => i >= 2 && levels.slice(i - 2, i + 1).every(nonSteady)).filter(Boolean).length;
		assert.equal(runs, dimension === "pace" ? 1 : 0, `${dimension}: ${levels}`);
	}
});

test("OPS-125: each seeded week is a planter's own save, across two history pages of 12 OPS-125-3", async () => {
	const { first, second, weeks } = await allWeeks();
	assert.equal(first.pageCount, 2);
	assert.equal(first.weeks.length, 12);
	assert.equal(second.weeks.length, 2);
	const monday = thisMonday();
	assert.deepEqual(
		second.weeks.map((w) => w.startsOn),
		[addDays(monday, -7 * 12), addDays(monday, -7 * 13)],
	);
	const past = weeks.slice(1);
	for (const w of past) {
		const a = w.answer!;
		assert.deepEqual(Object.keys(a.answers).sort(), ["family", "financial", "pace", "spiritual"]);
		assert.equal(a.revision, 1);
		assert.deepEqual(
			w.revisions.map((r) => [r.revision, r.kind, r.answers, r.note]),
			[[1, "save", a.answers, a.note]],
		);
		const day = localDay(a.answeredAt);
		assert.ok(day >= w.startsOn && day <= w.endsOn, `${w.startsOn}: answered on ${day}`);
	}
	assert.ok(past.filter((w) => w.answer!.note).length >= 2);
});

test("OPS-125: the owner corrects one seeded past week, and no other week changes OPS-125-4", async () => {
	const before = await allWeeks();
	const target = before.weeks[5]!;
	const answers = { spiritual: "struggling", family: "steady", financial: "steady", pace: "steady" };
	const reply = await probe({
		op: "correct",
		request: {
			requestKey: "ops-125-correction",
			expectedRevision: before.first.revision,
			input: { weekId: target.id, answers, note: "Corrected in QA." },
		},
	});
	assert.equal(reply.status, "ok", JSON.stringify(reply));
	assert.equal((reply.value as { outcome: string }).outcome, "saved");
	const after = await allWeeks();
	const changed = after.weeks.find((w) => w.id === target.id)!;
	assert.deepEqual(changed.answer!.answers, answers);
	assert.equal(changed.answer!.note, "Corrected in QA.");
	assert.deepEqual(
		changed.revisions.map((r) => [r.kind, r.answers]),
		[
			["save", target.answer!.answers],
			["correction", answers],
		],
	);
	assert.deepEqual(
		after.weeks.filter((w) => w.id !== target.id),
		before.weeks.filter((w) => w.id !== target.id),
	);
});

test("OPS-125: the QA admin and member get no check-in rows and no seeded zone OPS-125-5", async () => {
	const { query } = await seeded();
	for (const email of ["delivered+qa-admin@resend.dev", "delivered+qa-member@resend.dev"]) {
		const [row] = await query(
			`SELECT a.personal_timezone,
				(SELECT count(*)::int FROM private_week WHERE author_id=a.id) AS weeks,
				(SELECT count(*)::int FROM private_week_revision WHERE author_id=a.id) AS revisions,
				(SELECT count(*)::int FROM private_calendar WHERE author_id=a.id) AS calendars
			FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email=$1`,
			[email],
		);
		assert.deepEqual(row, { personal_timezone: null, weeks: 0, revisions: 0, calendars: 0 }, email);
	}
});

test("OPS-125: a rerun writes nothing, and a branch without the history gets it once OPS-125-6", async () => {
	const { db, query } = await seeded();
	const env = { DATABASE_URL: db.adminUrl, QA_ROLE_PASSWORD: PASSWORD };
	const counts = async () =>
		(
			await query(`SELECT (SELECT count(*)::int FROM private_week) AS weeks,
				(SELECT count(*)::int FROM private_week_revision) AS revisions,
				(SELECT count(*)::int FROM private_calendar) AS calendars,
				(SELECT count(*)::int FROM auth_session) AS sessions`)
		)[0];
	const complete = await counts();
	const again = runSeed(env);
	assert.equal(again.status, 0, again.stderr);
	assert.equal(again.stdout.trim(), "QA seed: the branch is already complete.");
	assert.deepEqual(await counts(), complete);

	// The rest of the QA data stays; the check-in history goes.
	await query("DELETE FROM private_week_revision");
	await query("DELETE FROM private_week");
	await query("DELETE FROM private_calendar");
	const refill = runSeed(env);
	assert.equal(refill.status, 0, refill.stderr);
	assert.equal(refill.stdout.trim(), "QA seed wrote: 13 check-in weeks.");
	const filled = await counts();
	assert.deepEqual(filled, { ...complete, weeks: 13, revisions: 13, calendars: 1 });
	const third = runSeed(env);
	assert.equal(third.stdout.trim(), "QA seed: the branch is already complete.");
	assert.deepEqual(await counts(), filled);
});

/** The task branch whose own diff is the OPS-125 change before it merges. */
const OPS_BRANCH = "task/ops-125";
/** No app or package file in `repo` imports tools/evf/. */
function checkNoToolingImports(repo: string) {
	const importers: string[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.(c|m)?[jt]sx?$/.test(entry.name) && /tools\/evf\//.test(readFileSync(path, "utf8")))
				importers.push(relative(repo, path));
		}
	};
	walk(join(repo, "apps"));
	walk(join(repo, "packages"));
	assert.deepEqual(importers, [], `app or package files import the QA tooling: ${importers.join(", ")}`);
}

/**
 * The OPS-125 change check on a fixture `repo`: the import scan, and outside a shallow checkout at least one non-merge
 * `OPS-125:` commit exists and none of them, each against its first parent, edits apps/ or packages/. On task/ops-125 the
 * branch diff counts too. Another task branch's own app diff is not part of the change.
 */
function checkOps125Change(repo: string, diagnostic: (message: string) => void = () => {}) {
	checkNoToolingImports(repo);
	const git = (...args: string[]) => {
		const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
		assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.split("\n").filter(Boolean);
	};
	// CI checks out the PR merge commit at depth 1, with no main ref and no parents to diff against.
	if (git("rev-parse", "--is-shallow-repository")[0] === "true") {
		diagnostic("shallow checkout: no main history, so only the import scan runs");
		return { shallow: true, commits: [] };
	}
	// A merge commit's first-parent diff is the other side's work; the branch diff covers task/ops-125 merges.
	const commits = git("log", "--no-merges", "--format=%H %s", "HEAD")
		.filter((line) => line.slice(41).startsWith("OPS-125:"))
		.map((line) => line.slice(0, 40));
	assert.ok(commits.length > 0, "no OPS-125: commit in the history of HEAD");
	const changed = commits.flatMap((c) => git("diff", "--name-only", `${c}^1`, c));
	if (git("rev-parse", "--abbrev-ref", "HEAD")[0] === OPS_BRANCH) {
		const base = ["origin/main", "main"]
			.map((ref) => spawnSync("git", ["merge-base", "HEAD", ref], { cwd: repo, encoding: "utf8" }))
			.find((r) => r.status === 0);
		assert.ok(base, "no main ref to compare with");
		changed.push(...git("diff", "--name-only", base.stdout.trim(), "HEAD"));
	}
	const edits = [...new Set(changed.filter((path) => path.startsWith("apps/") || path.startsWith("packages/")))].sort();
	assert.deepEqual(edits, [], `the OPS-125 change edits app or package files: ${edits.join(", ")}`);
	return { shallow: false, commits };
}

/** A temporary git repository. `run` runs git in it and returns trimmed stdout. */
function gitRepo(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "ops-125-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const run = (...args: string[]) => {
		const r = spawnSync(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@t", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args],
			{ cwd: dir, encoding: "utf8" },
		);
		assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.trim();
	};
	const commit = (subject: string, files: Record<string, string>) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), text);
		}
		run("add", "-A");
		run("commit", "-q", "-m", subject);
	};
	run("init", "-q", "-b", "main");
	commit("WP-001: the app", { "apps/web/page.ts": "export const page = 1;\n" });
	return { dir, run, commit };
}

test("OPS-125: an app task branch on top of the OPS-125 change passes the check AC:OPS-125-1", (t) => {
	const repo = gitRepo(t);
	repo.commit("OPS-125: QA check-in tooling", { "tools/evf/qa-seed.ts": "export {};\n" });
	repo.run("checkout", "-q", "-b", "task/wp-036");
	repo.commit("WP-036: the app change", {
		"apps/web/new.ts": "export const x = 1;\n",
		"packages/db/new.ts": "export {};\n",
	});
	assert.equal(checkOps125Change(repo.dir).commits.length, 1);
	// task/ops-125 takes in a main that gained an app change through an `OPS-125:` merge commit.
	repo.run("checkout", "-q", "main");
	repo.run("checkout", "-q", "-b", OPS_BRANCH);
	repo.commit("OPS-125: follow-up", { "tools/evf/tests/qa.test.ts": "export {};\n" });
	repo.run("checkout", "-q", "main");
	repo.commit("WP-028: email", { "apps/web/mail.ts": "export {};\n", "packages/db/mail.ts": "export {};\n" });
	repo.run("checkout", "-q", OPS_BRANCH);
	repo.run("merge", "-q", "--no-ff", "-m", "OPS-125: include current main", "main");
	assert.equal(checkOps125Change(repo.dir).commits.length, 2);
});

// The history half stays in the fixture tests: the real checkout's history changes with each branch (OPS-136).
test("OPS-125: nothing in the real worktree's apps or packages imports the tooling AC:OPS-125-2", () => {
	checkNoToolingImports(source);
});

test("OPS-125: an OPS-125 commit, or the task/ops-125 branch, that edits apps/x.ts fails the check AC:OPS-125-2", (t) => {
	const merged = gitRepo(t);
	merged.commit("OPS-125: QA check-in tooling", {
		"tools/evf/qa-seed.ts": "export {};\n",
		"apps/x.ts": "export {};\n",
	});
	assert.throws(() => checkOps125Change(merged.dir), /apps\/x\.ts/);
	const branch = gitRepo(t);
	branch.commit("OPS-125: QA check-in tooling", { "tools/evf/qa-seed.ts": "export {};\n" });
	branch.run("checkout", "-q", "-b", OPS_BRANCH);
	branch.commit("follow-up", { "apps/x.ts": "export {};\n" });
	assert.throws(() => checkOps125Change(branch.dir), /apps\/x\.ts/);
	const none = gitRepo(t);
	assert.throws(() => checkOps125Change(none.dir), /no OPS-125: commit/);
});

test("OPS-125: a depth-1 clone skips the history half and still runs the import scan AC:OPS-125-3", (t) => {
	const repo = gitRepo(t);
	repo.commit("OPS-125: QA check-in tooling", { "tools/evf/qa-seed.ts": "export {};\n", "apps/x.ts": "export {};\n" });
	repo.commit("WP-002: more", { "apps/y.ts": "export {};\n" });
	const clone = mkdtempSync(join(tmpdir(), "ops-125-shallow-"));
	t.after(() => rmSync(clone, { recursive: true, force: true }));
	const r = spawnSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(repo.dir).href, clone], {
		encoding: "utf8",
	});
	assert.equal(r.status, 0, r.stderr);
	const notes: string[] = [];
	assert.deepEqual(
		checkOps125Change(clone, (m) => notes.push(m)),
		{ shallow: true, commits: [] },
	);
	assert.deepEqual(notes, ["shallow checkout: no main history, so only the import scan runs"]);
	writeFileSync(join(clone, "apps/z.ts"), 'import "../tools/evf/qa-seed.ts";\n');
	assert.throws(() => checkOps125Change(clone), /apps\/z\.ts/);
});
