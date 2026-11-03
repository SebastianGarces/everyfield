import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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

test("OPS-125: the QA owner has a confirmed zone and 13 answered past weeks before an open week AC:OPS-125-1", async () => {
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

test("OPS-125: the Pace run of 3 Strained or Struggling weeks ends last week, after a Steady week AC:OPS-125-2", async () => {
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

test("OPS-125: each seeded week is a planter's own save, across two history pages of 12 AC:OPS-125-3", async () => {
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

test("OPS-125: the owner corrects one seeded past week, and no other week changes AC:OPS-125-4", async () => {
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

test("OPS-125: the QA admin and member get no check-in rows and no seeded zone AC:OPS-125-5", async () => {
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

test("OPS-125: a rerun writes nothing, and a branch without the history gets it once AC:OPS-125-6", async () => {
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

test("OPS-125: no app or package imports the QA tooling AC:OPS-125-8", () => {
	const importers: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.(c|m)?[jt]sx?$/.test(entry.name) && /tools\/evf\//.test(readFileSync(path, "utf8")))
				importers.push(relative(source, path));
		}
	};
	walk(join(source, "apps"));
	walk(join(source, "packages"));
	assert.deepEqual(importers, []);
});
