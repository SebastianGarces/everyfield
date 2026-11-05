// OPS-139: the new check alarm, the red check alarm and the outside settings event.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pollChecks, runSampledPoll, startPoll } from "../check-alarm.ts";
import { openWorkDb } from "../db.ts";
import { sleep } from "../lib.ts";
import { runSampler, type SamplerProbes } from "../sampler.ts";
import { fakeClock, fixture, source } from "./fixtures.ts";

type Fx = ReturnType<typeof fixture>;
type Pr = { number: number; headRefOid: string; statusCheckRollup: unknown[] };

const MINUTE = 60_000,
	HOUR = 60 * MINUTE,
	DAY = 24 * HOUR,
	WEEK = 7 * DAY;
const NO_SEAT = { EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "", EVF_STAGE: "" };

const checkRun = (name: string, conclusion = "SUCCESS", workflowName = "CI", startedAt = "2026-11-04T10:00:00Z") => ({
	__typename: "CheckRun",
	name,
	status: "COMPLETED",
	conclusion,
	workflowName,
	startedAt,
	completedAt: startedAt,
});
const statusContext = (context: string, state: string) => ({ __typename: "StatusContext", context, state });
const pr = (number: number, ...rollup: unknown[]): Pr => ({
	number,
	headRefOid: String(number).padEnd(40, "a"),
	statusCheckRollup: rollup,
});
const atHead = (p: Pr, head: string): Pr => ({ ...p, headRefOid: head });

/** A fixture whose only required check is `ci`, with a fake Herdr that logs each call. `herdr-fails` makes it fail. */
function setup(): Fx & { herdrCalls: () => string[][]; open: (...prs: Pr[]) => void } {
	const f = fixture();
	const log = join(f.root, "herdr.log"),
		fails = join(f.root, "herdr-fails");
	writeFileSync(
		join(f.root, "fake-bin/herdr"),
		`#!${process.execPath}\nconst fs=require("node:fs");fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+"\\n");process.exit(fs.existsSync(${JSON.stringify(fails)})?1:0);\n`,
	);
	chmodSync(join(f.root, "fake-bin/herdr"), 0o755);
	const state = f.getState();
	state.protection = { required_status_checks: { contexts: ["ci"] } };
	f.setState(state);
	return Object.assign(f, {
		herdrCalls: () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.map((l) => JSON.parse(l) as string[])
				: [],
		open: (...prs: Pr[]) => {
			const s = f.getState();
			s.openPrs = prs;
			f.setState(s);
		},
	});
}

const withStore = <T>(f: Fx, read: (db: ReturnType<typeof openWorkDb>) => T): T => {
	const db = openWorkDb(f.root);
	try {
		return read(db);
	} finally {
		db.close();
	}
};
const eventsOf = (f: Fx, type: string) =>
	withStore(f, (db) =>
		db.prepare("SELECT task_id, run_id, payload FROM events WHERE type = ? ORDER BY id").all(type),
	).map((e: any) => ({ task: e.task_id as number | null, run: e.run_id as number | null, ...JSON.parse(e.payload) }));
const alarmsOf = (f: Fx, type: string) => eventsOf(f, type).map((e) => [e.check, e.prs]);
const NEW = "ci_new_check_alarm",
	RED = "ci_nonrequired_red_alarm",
	SIGHTING = "ci_nonrequired_red";

const cli = (f: Fx, env: Record<string, string>, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd: f.root,
		encoding: "utf8",
		env: { ...process.env, ...NO_SEAT, ...env },
	});
/** The real command in a process whose clock reads `now`. */
const cliAt = (f: Fx, now: number, ...args: string[]) =>
	spawnSync(
		process.execPath,
		[`--import=data:text/javascript,Date.now=()=>${now}`, join(source, "tools/evf/main.ts"), ...args],
		{ cwd: f.root, encoding: "utf8", env: { ...process.env, ...NO_SEAT } },
	);

/**
 * Replace the fixture's gh. While the named file exists, `gh pr list` fails (`gh-list-fails`), hangs (`gh-list-hangs`) or
 * waits for `gh-list-release` (`gh-list-gate`).
 */
function breakableList(f: Fx) {
	const gh = join(f.root, "fake-bin/gh"),
		base = join(f.root, "fake-bin/gh-base");
	renameSync(gh, base);
	writeFileSync(
		gh,
		`#!/bin/sh
if [ "$1 $2" = "pr list" ]; then
  [ -f ${JSON.stringify(join(f.root, "gh-list-fails"))} ] && { echo "HTTP 502 from fixture" >&2; exit 1; }
  [ -f ${JSON.stringify(join(f.root, "gh-list-hangs"))} ] && exec sleep 10
  if [ -f ${JSON.stringify(join(f.root, "gh-list-gate"))} ]; then
    n=0
    while [ ! -f ${JSON.stringify(join(f.root, "gh-list-release"))} ] && [ "$n" -lt 600 ]; do sleep 0.1; n=$((n+1)); done
  fi
fi
exec ${JSON.stringify(base)} "$@"
`,
	);
	chmodSync(gh, 0o755);
}

/** Polls at a moved clock. The first call is the baseline, so `known` names are not new. */
function started(f: ReturnType<typeof setup>, ...known: string[]) {
	const clock = fakeClock();
	f.open(pr(90, ...["ci", ...known].map((n) => checkRun(n))));
	const baseline = pollChecks(f.root, clock);
	assert.equal(baseline.baseline, true);
	return clock;
}

test("a new check name on 2 PRs raises one alarm, on 1 PR none, also when the PRs appear in different polls (AC:OPS-139-1)", () => {
	const f = setup();
	try {
		const clock = started(f);
		clock.sleep(HOUR);
		f.open(pr(1, checkRun("ci"), checkRun("one-pr")));
		let result = pollChecks(f.root, clock);
		assert.deepEqual(result.firstSeen, ["one-pr"]);
		assert.deepEqual(result.alarms, []);
		assert.deepEqual(alarmsOf(f, NEW), []);

		clock.sleep(HOUR);
		f.open(pr(2, checkRun("ci"), checkRun("one-pr")));
		result = pollChecks(f.root, clock);
		assert.deepEqual(result.firstSeen, [], "a name on a second PR is no longer first seen");
		assert.deepEqual(result.alarms, [{ kind: "new", check: "one-pr", prs: [1, 2], notified: true }]);
		assert.deepEqual(alarmsOf(f, NEW), [["one-pr", [1, 2]]]);

		clock.sleep(HOUR);
		f.open(pr(3, checkRun("same-poll")), pr(4, checkRun("same-poll")));
		pollChecks(f.root, clock);
		assert.deepEqual(alarmsOf(f, NEW), [
			["one-pr", [1, 2]],
			["same-poll", [3, 4]],
		]);
		const [event] = eventsOf(f, NEW);
		assert.deepEqual([event.task, event.run], [null, null], "a check belongs to no task");
	} finally {
		f.close();
	}
});

test("a name last seen 7 days ago or less raises no new-check alarm; one last seen more than 7 days ago is new again (AC:OPS-139-2)", () => {
	const f = setup();
	try {
		const clock = started(f, "at-limit", "past-limit");
		clock.sleep(WEEK);
		f.open(pr(1, checkRun("ci"), checkRun("at-limit")), pr(2, checkRun("at-limit")));
		let result = pollChecks(f.root, clock);
		assert.equal(result.baseline, false, "a poll exactly 7 days later is no baseline");
		assert.deepEqual(result.firstSeen, []);
		assert.deepEqual(alarmsOf(f, NEW), [], "last seen exactly 7 days ago");

		clock.sleep(1);
		f.open(pr(1, checkRun("ci"), checkRun("past-limit")), pr(2, checkRun("past-limit")));
		result = pollChecks(f.root, clock);
		assert.deepEqual(result.firstSeen, ["past-limit"]);
		assert.deepEqual(alarmsOf(f, NEW), [["past-limit", [1, 2]]], "last seen 7 days and 1 ms ago");

		// The eligibility ends 7 days after the first sighting, also for a name seen on every poll.
		f.open(pr(3, checkRun("slow")));
		pollChecks(f.root, clock);
		clock.sleep(WEEK);
		pollChecks(f.root, clock);
		f.open(pr(4, checkRun("slow")));
		pollChecks(f.root, clock);
		assert.deepEqual(alarmsOf(f, NEW), [["past-limit", [1, 2]]], "a second PR after 7 days raises nothing");
	} finally {
		f.close();
	}
});

test("one red non-required check on 2 PRs records one event per PR and head and one alarm; on 1 PR no alarm; a red required check nothing (AC:OPS-139-3)", () => {
	const f = setup();
	try {
		const clock = started(f, "vercel", "cancelled", "context", "yellow");
		const at = new Date(clock.now()).toISOString();
		f.open(pr(1, checkRun("ci", "FAILURE"), checkRun("vercel", "FAILURE"), checkRun("cancelled", "CANCELLED")));
		let result = pollChecks(f.root, clock);
		assert.deepEqual(eventsOf(f, SIGHTING), [
			{ task: null, run: null, check: "vercel", pr: 1, head: pr(1).headRefOid, firstSeenAt: at },
			{ task: null, run: null, check: "cancelled", pr: 1, head: pr(1).headRefOid, firstSeenAt: at },
		]);
		assert.deepEqual(alarmsOf(f, RED), [], "red on 1 PR raises no alarm");
		assert.deepEqual(
			result.red.map((r) => r.check),
			["vercel", "cancelled"],
			"the red required check ci is not here",
		);

		f.open(
			pr(1, checkRun("ci", "FAILURE"), checkRun("vercel", "FAILURE"), checkRun("yellow", "SKIPPED")),
			pr(2, checkRun("ci", "FAILURE"), checkRun("vercel", "TIMED_OUT"), checkRun("yellow", "NEUTRAL")),
			pr(3, statusContext("context", "ERROR")),
			pr(4, statusContext("context", "FAILURE")),
		);
		result = pollChecks(f.root, clock);
		assert.deepEqual(alarmsOf(f, RED), [
			["vercel", [1, 2]],
			["context", [3, 4]],
		]);
		assert.deepEqual(
			eventsOf(f, SIGHTING).map((e) => [e.check, e.pr]),
			[
				["vercel", 1],
				["cancelled", 1],
				["vercel", 2],
				["context", 3],
				["context", 4],
			],
		);

		const listed = cli(f, {}, "events", "--type", SIGHTING, "--json");
		assert.equal(listed.status, 0, listed.stderr);
		assert.equal((JSON.parse(listed.stdout) as unknown[]).length, 5);

		// Only the latest run of a name in one workflow counts: a re-run that passed is not red.
		f.open(
			pr(
				5,
				checkRun("rerun", "FAILURE", "W", "2026-11-04T10:00:00Z"),
				checkRun("rerun", "SUCCESS", "W", "2026-11-04T11:00:00Z"),
			),
		);
		assert.deepEqual(pollChecks(f.root, clock).red, []);
	} finally {
		f.close();
	}
});

test("red means the gh fail or cancel bucket, so ACTION_REQUIRED is red and STARTUP_FAILURE is pending (AC:OPS-139-3)", () => {
	const f = setup();
	try {
		const clock = started(f, "asks", "startup");
		f.open(
			pr(1, checkRun("asks", "ACTION_REQUIRED"), checkRun("startup", "STARTUP_FAILURE")),
			pr(2, checkRun("asks", "ACTION_REQUIRED"), checkRun("startup", "STARTUP_FAILURE")),
		);
		pollChecks(f.root, clock);
		assert.deepEqual(alarmsOf(f, RED), [["asks", [1, 2]]]);
	} finally {
		f.close();
	}
});

test("a repeat poll in another process raises nothing new; a new head records an event and no alarm; a poll with no red rearms it (AC:OPS-139-4)", () => {
	const f = setup();
	try {
		f.open(pr(90, checkRun("ci"), checkRun("vercel")));
		assert.equal(cli(f, {}, "check-alarm").status, 0);
		const red = [pr(1, checkRun("vercel", "FAILURE")), pr(2, checkRun("vercel", "FAILURE"))];
		f.open(...red);
		const poll = () => {
			const r = cli(f, {}, "check-alarm", "--json");
			assert.equal(r.status, 0, r.stderr);
			return JSON.parse(r.stdout) as { alarms: unknown[] };
		};
		assert.equal(poll().alarms.length, 1);
		assert.equal(poll().alarms.length, 0, "same data, new process");
		assert.equal(eventsOf(f, SIGHTING).length, 2);
		assert.equal(eventsOf(f, RED).length, 1);
		assert.equal(f.herdrCalls().length, 1);

		f.open(atHead(red[0]!, "b".repeat(40)), red[1]!);
		assert.equal(poll().alarms.length, 0, "a new head raises no alarm");
		assert.deepEqual(
			eventsOf(f, SIGHTING).map((e) => [e.pr, e.head[0]]),
			[
				[1, "1"],
				[2, "2"],
				[1, "b"],
			],
		);

		f.open(pr(1, checkRun("vercel")), pr(2));
		assert.equal(poll().alarms.length, 0);
		f.open(...red);
		assert.equal(poll().alarms.length, 1, "red again on 2 PRs after a poll with no red");
		assert.equal(eventsOf(f, RED).length, 2);
		assert.equal(eventsOf(f, SIGHTING).length, 3, "these PR and head pairs have their events already");
	} finally {
		f.close();
	}
});

test("the coordinator role states the outside settings rule and names the command (AC:OPS-139-5)", () => {
	const role = readFileSync(join(source, ".agents/roles/coordinator.md"), "utf8").replace(/\s+/g, " ");
	assert.match(
		role,
		/no seat or coordinator creates or links a Vercel project, repo setting or integration until Sebastian's words are recorded/,
	);
	assert.ok(role.includes('bin/evf outside-setting approved --what "<what>" --words "<his words>"'));
});

test("outside-setting approved records the words unchanged, and refuses an empty value and a seat (AC:OPS-139-6)", () => {
	const f = setup();
	try {
		const words = '  yes, link it -- but only "preview"\nnot production. ';
		const when = Date.parse("2026-11-04T12:00:00.000Z");
		const ok = cliAt(f, when, "outside-setting", "approved", "--what", "Vercel project", "--words", words);
		assert.equal(ok.status, 0, ok.stderr);
		assert.deepEqual(eventsOf(f, "outside_setting_approved"), [
			{ task: null, run: null, what: "Vercel project", words, at: new Date(when).toISOString() },
		]);

		const refused = [
			cli(f, {}, "outside-setting", "approved", "--what", " ", "--words", "yes"),
			cli(f, {}, "outside-setting", "approved", "--what", "x", "--words", "  "),
			cli(f, {}, "outside-setting", "approved", "--what", "x"),
			cli(f, {}, "outside-setting", "approved", "--words", "yes"),
		];
		for (const r of refused) {
			assert.notEqual(r.status, 0);
			assert.match(r.stderr, /--(what|words)/);
		}
		const seat = cli(f, { EVF_RUN: "7" }, "outside-setting", "approved", "--what", "x", "--words", "yes");
		assert.notEqual(seat.status, 0);
		assert.match(seat.stderr, /A seat cannot record/);
		assert.equal(eventsOf(f, "outside_setting_approved").length, 1);
	} finally {
		f.close();
	}
});

test("a poll writes no task status, run or stage event (AC:OPS-139-7)", () => {
	const f = setup();
	try {
		const snapshot = () =>
			withStore(f, (db) => ({
				tasks: db.prepare("SELECT * FROM tasks").all(),
				runs: db.prepare("SELECT * FROM runs").all(),
				proofs: db.prepare("SELECT * FROM proofs").all(),
			}));
		withStore(f, (db) =>
			db
				.prepare(
					"INSERT INTO tasks (slug, mode, ref, status, created_at, updated_at) VALUES ('ops-1', 'implement', 'OPS-1', 'pr_open', 'x', 'x')",
				)
				.run(),
		);
		const before = snapshot();
		const clock = started(f, "vercel");
		f.open(pr(1, checkRun("ci"), checkRun("vercel", "FAILURE")), pr(2, checkRun("ci"), checkRun("vercel", "FAILURE")));
		assert.equal(pollChecks(f.root, clock).alarms.length, 1);
		assert.deepEqual(snapshot(), before);
		const types = withStore(f, (db) => db.prepare("SELECT DISTINCT type FROM events ORDER BY type").all()).map(
			(e: any) => e.type,
		);
		assert.deepEqual(types, [SIGHTING, RED]);
	} finally {
		f.close();
	}
});

test("evf check-alarm prints what it found, an alarm calls Herdr once, and a failed send is recorded and does not fail the poll (AC:OPS-139-8)", () => {
	const f = setup();
	try {
		f.open(pr(90, checkRun("ci")));
		assert.equal(cli(f, {}, "check-alarm").status, 0);

		f.open(pr(1, checkRun("stray", "FAILURE")), pr(2, checkRun("stray", "FAILURE")));
		const text = cli(f, {}, "check-alarm");
		assert.equal(text.status, 0, text.stderr);
		assert.match(text.stdout, /First seen: stray\./);
		assert.match(text.stdout, /Red non-required check: stray on #1, #2\./);
		assert.match(text.stdout, /Alarm \(new\): stray on #1, #2\. Notification sent\./);
		assert.match(text.stdout, /Alarm \(red\): stray on #1, #2\. Notification sent\./, "new and red: one of each kind");
		const calls = f.herdrCalls();
		assert.equal(calls.length, 2);
		for (const call of calls) {
			assert.deepEqual(call.slice(0, 2), ["notification", "show"]);
			assert.deepEqual(call.slice(3, 4), ["--body"]);
			assert.deepEqual(call.slice(5), ["--sound", "request"]);
			assert.match(call[4]!, /#1, #2/);
		}
		assert.equal(eventsOf(f, NEW)[0].notified, true);
		assert.equal(eventsOf(f, RED)[0].notified, true);

		writeFileSync(join(f.root, "herdr-fails"), "");
		f.open(pr(3, checkRun("second")), pr(4, checkRun("second")));
		const json = cli(f, {}, "check-alarm", "--json");
		assert.equal(json.status, 0, "a failed send does not fail the poll");
		assert.deepEqual(JSON.parse(json.stdout), {
			baseline: false,
			firstSeen: ["second"],
			red: [],
			alarms: [{ kind: "new", check: "second", prs: [3, 4], notified: false }],
		});
		assert.equal(eventsOf(f, NEW).at(-1).notified, false);
		assert.equal(f.herdrCalls().length, 3, "one send per alarm, no retry");
		assert.equal(cli(f, {}, "check-alarm").status, 0);
		assert.equal(f.herdrCalls().length, 3, "a repeat poll sends nothing");
	} finally {
		f.close();
	}
});

function probesAt(now: () => number, sleepFor: (ms: number) => void, startCheckPoll: () => void): SamplerProbes {
	return {
		now,
		sleep: sleepFor,
		load: () => [1, 1],
		swapUsedGb: () => 0,
		freeMemPct: () => 50,
		previews: () => 0,
		processes: () => [],
		fullChecks: () => 0,
		startCheckPoll,
	};
}

test("a sampler starts one poll when the last is 5 min old, in a process with a timeout that the tick does not wait for (AC:OPS-139-9)", () => {
	const f = setup();
	const saved = process.env.EVF_NO_CHECK_POLL;
	try {
		// Fake clock: 11 ticks one minute apart start polls at minutes 0, 5 and 10.
		const clock = fakeClock(),
			starts: number[] = [];
		const startMs = clock.now();
		runSampler(
			f.root,
			probesAt(
				() => clock.now(),
				(ms) => clock.sleep(ms),
				() => starts.push(Math.round((clock.now() - startMs) / MINUTE)),
			),
			{ ticks: 11 },
		);
		assert.deepEqual(starts, [0, 5, 10]);

		// The stamp is in the store: a sampler that starts soon after the last poll waits for the rest of the 5 min.
		const later: number[] = [];
		runSampler(
			f.root,
			probesAt(
				() => clock.now(),
				(ms) => clock.sleep(ms),
				() => later.push(clock.now()),
			),
			{ ticks: 3 },
		);
		assert.deepEqual(later, [], "the last poll started at minute 10, and these ticks are at minutes 11, 12 and 13");

		// The timeout: a hung read ends at the limit, and that poll records nothing.
		breakableList(f);
		f.open(pr(1, checkRun("ci")));
		const lastOk = () =>
			withStore(
				f,
				(db) => (db.prepare("SELECT last_ok_at FROM check_poll").get() as { last_ok_at: string | null }).last_ok_at,
			);
		writeFileSync(join(f.root, "gh-list-hangs"), "");
		assert.notEqual(runSampledPoll(f.root, 1000), 0);
		assert.equal(lastOk(), null);
		rmSync(join(f.root, "gh-list-hangs"));

		// The real start returns while the GitHub read waits, and the poll it leaves running finishes alone.
		writeFileSync(join(f.root, "gh-list-gate"), "");
		delete process.env.EVF_NO_CHECK_POLL;
		startPoll(f.root, 10_000);
		process.env.EVF_NO_CHECK_POLL = "1";
		assert.equal(lastOk(), null, "the start did not wait for the poll");
		writeFileSync(join(f.root, "gh-list-release"), "");
		for (const deadline = Date.now() + 60_000; lastOk() === null && Date.now() < deadline;) sleep(50);
		assert.ok(lastOk(), "the detached poll finished");
	} finally {
		process.env.EVF_NO_CHECK_POLL = saved;
		f.close();
	}
});

test("a first poll and a poll after more than 7 days without a successful poll record names and raise no alarm (AC:OPS-139-10)", () => {
	const f = setup();
	try {
		const clock = fakeClock();
		const none = pollChecks(f.root, clock);
		assert.equal(none.baseline, true, "a poll that reads no name leaves the store empty");
		const stale = [pr(1, checkRun("old")), pr(2, checkRun("old", "FAILURE")), pr(3, checkRun("old", "FAILURE"))];
		f.open(...stale);
		const first = pollChecks(f.root, clock);
		assert.equal(first.baseline, true);
		assert.deepEqual(first.firstSeen, ["old"]);
		assert.deepEqual(first.alarms, []);
		assert.deepEqual([eventsOf(f, NEW).length, eventsOf(f, RED).length], [0, 0]);
		assert.equal(eventsOf(f, SIGHTING).length, 2, "red events are facts, so a baseline records them");

		clock.sleep(MINUTE);
		f.open(...stale, pr(4, checkRun("old")));
		const second = pollChecks(f.root, clock);
		assert.equal(second.baseline, false);
		assert.deepEqual(eventsOf(f, NEW), [], "a baseline name that reaches another PR is not new");
		assert.deepEqual(
			alarmsOf(f, RED),
			[["old", [2, 3]]],
			"a check still red on 2 PRs raises its alarm on the next poll",
		);

		// 7 days and 1 ms without a successful poll, through the real command.
		const later = clock.now() + WEEK + 1;
		f.open(pr(5, checkRun("gap")), pr(6, checkRun("gap")));
		const gap = cliAt(f, later, "check-alarm");
		assert.equal(gap.status, 0, gap.stderr);
		assert.match(gap.stdout, /Baseline poll/);
		assert.match(gap.stdout, /Alarms raised: none\./);
		assert.deepEqual(eventsOf(f, NEW), []);

		// Exactly 7 days: an ordinary poll.
		f.open(pr(5, checkRun("gap")), pr(7, checkRun("exact")), pr(8, checkRun("exact")));
		const exact = cliAt(f, later + WEEK, "check-alarm", "--json");
		assert.equal((JSON.parse(exact.stdout) as { baseline: boolean }).baseline, false);
		assert.deepEqual(alarmsOf(f, NEW), [["exact", [7, 8]]]);
	} finally {
		f.close();
	}
});

test("a failed GitHub read ends the poll with a message and records nothing (AC:OPS-139-11)", () => {
	const f = setup();
	try {
		breakableList(f);
		f.open(pr(1, checkRun("ci")), pr(2, checkRun("stray", "FAILURE")), pr(3, checkRun("stray", "FAILURE")));
		const facts = () =>
			withStore(f, (db) => ({
				names: db.prepare("SELECT * FROM check_names ORDER BY name").all(),
				lastOk:
					(db.prepare("SELECT last_ok_at FROM check_poll").get() as { last_ok_at: string | null } | undefined)
						?.last_ok_at ?? null,
				events: db.prepare("SELECT COUNT(*) AS n FROM events").get(),
			}));
		const expectFailure = (message: RegExp) => {
			const before = facts();
			const r = cli(f, {}, "check-alarm");
			assert.equal(r.status, 1, r.stdout);
			assert.match(r.stderr, /recorded nothing/);
			assert.match(r.stderr, message);
			assert.deepEqual(facts().names, before.names);
			assert.deepEqual(facts().events, before.events);
			assert.equal(facts().lastOk, before.lastOk);
			assert.equal(f.herdrCalls().length, 0);
		};
		const file = join(f.root, "gh-list-fails");
		writeFileSync(file, "");
		expectFailure(/HTTP 502/);
		rmSync(file);
		const state = f.getState();
		state.openPrs = { not: "a list" };
		f.setState(state);
		expectFailure(/is not a function/);
		state.openPrs = [{ number: 1 }];
		f.setState(state);
		expectFailure(/no number or head/);
		state.openPrs = [pr(1, { conclusion: "FAILURE" })];
		f.setState(state);
		expectFailure(/no check name/);
		state.openPrs = [pr(1, checkRun("ci")), pr(2, checkRun("stray", "FAILURE")), pr(3, checkRun("stray", "FAILURE"))];
		const path = "repos/test/private/branches/main/protection";
		state.apiExit = { [path]: 1 };
		state.api = { [path]: { message: "HTTP 500" } };
		f.setState(state);
		expectFailure(/Branch protection of main is unreadable/);
		delete state.apiExit;
		delete state.api;
		state.rules = { not: "a list" };
		f.setState(state);
		expectFailure(/rulesets of main are unreadable/);

		// The first good read is still the baseline: no failed poll counted.
		delete state.rules;
		f.setState(state);
		const good = cli(f, {}, "check-alarm", "--json");
		assert.equal(good.status, 0, good.stderr);
		assert.equal((JSON.parse(good.stdout) as { baseline: boolean }).baseline, true);

		// A failure after a good poll leaves the last successful poll where it was.
		const okBefore = facts().lastOk;
		assert.ok(okBefore);
		writeFileSync(file, "");
		expectFailure(/HTTP 502/);
		assert.equal(facts().lastOk, okBefore);
	} finally {
		f.close();
	}
});

test("owner-queue shows a new-check alarm for 24 h, apart from the items; the red alarm is not in it (AC:OPS-139-12)", () => {
	const f = setup();
	try {
		const polled = Date.parse("2026-11-04T10:00:00.000Z");
		f.open(pr(90, checkRun("ci")));
		assert.equal(cliAt(f, polled - HOUR, "check-alarm").status, 0);
		f.open(pr(1, checkRun("stray", "FAILURE")), pr(2, checkRun("stray", "FAILURE")));
		assert.equal(cliAt(f, polled, "check-alarm").status, 0);
		assert.equal(eventsOf(f, RED).length, 1);
		const raised = Date.parse(
			withStore(f, (db) => db.prepare("SELECT ts FROM events WHERE type = ?").get(NEW) as { ts: string }).ts,
		);

		const at = (now: number) => {
			const text = cliAt(f, now, "owner-queue"),
				json = cliAt(f, now, "owner-queue", "--json");
			assert.equal(text.status, 0, text.stderr);
			return { text: text.stdout, lines: text.stdout.trim().split("\n"), json: JSON.parse(json.stdout) };
		};
		const soon = at(raised + 90 * MINUTE);
		assert.equal(soon.lines[0], "Nothing waits for Sebastian.");
		assert.ok(soon.lines.includes("stray | PRs #1, #2 | age 1h 30m"), soon.text);
		assert.deepEqual(soon.json.items, []);
		assert.deepEqual(soon.json.newCheckAlarms, [{ check: "stray", prs: [1, 2], ageMinutes: 90 }]);
		assert.ok(!soon.text.includes("Non-required"), "the red alarm is not in the digest");
		assert.equal(soon.lines.filter((l) => l.includes("stray")).length, 1);

		const last = at(raised + DAY);
		assert.deepEqual(
			last.json.newCheckAlarms.map((a: { ageMinutes: number }) => a.ageMinutes),
			[1440],
		);
		const gone = at(raised + DAY + 1);
		assert.deepEqual(gone.json.newCheckAlarms, []);
		assert.ok(!gone.text.includes("stray"));

		// An open item keeps its count, and the alarm still prints apart from it.
		withStore(f, (db) => {
			const { lastInsertRowid: id } = db
				.prepare(
					"INSERT INTO tasks (slug, mode, ref, status, created_at, updated_at) VALUES ('ops-1', 'implement', 'OPS-1', 'pr_open', 'x', 'x')",
				)
				.run();
			db.prepare("INSERT INTO events (task_id, ts, type, payload) VALUES (?, ?, 'owner_ask', ?)").run(
				id,
				new Date(raised).toISOString(),
				JSON.stringify({
					task: "OPS-1",
					pr: 7,
					head: "c".repeat(40),
					kind: "parked",
					digestId: null,
					askedAt: new Date(raised).toISOString(),
				}),
			);
		});
		const withItem = at(raised + HOUR);
		assert.equal(withItem.lines[0], "1 waiting for Sebastian.");
		assert.equal(withItem.json.items.length, 1);
		assert.equal(withItem.json.newCheckAlarms.length, 1);
		const heading = withItem.lines.findIndex((l) => l.startsWith("New check alarms"));
		assert.ok(heading > 1, "the alarms print after the items");
		assert.match(withItem.lines[heading]!, /not waiting items/);
	} finally {
		f.close();
	}
});

test("the README and help describe check-alarm, outside-setting, both alarms and the sampler limit (AC:OPS-139-13)", () => {
	const readme = readFileSync(join(source, "tools/evf/README.md"), "utf8"),
		section = readme.split(/^## /m).find((s) => s.startsWith("Check alarm"));
	assert.ok(section, "the README has the section");
	for (const needed of [
		"evf check-alarm [--json]",
		"evf outside-setting approved",
		"ci_new_check_alarm",
		"ci_nonrequired_red_alarm",
		"polls run only while the sampler runs",
		"`evf sampler stop` stops the polls",
	])
		assert.ok(section.includes(needed), needed);
	const help = spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "help"], { encoding: "utf8" }).stdout;
	for (const needed of [
		"evf check-alarm [--json]",
		"evf outside-setting approved",
		"a new check name on 2 PRs",
		"one non-required check red on 2 PRs",
		"evf sampler stop stops the polls",
	])
		assert.ok(help.includes(needed), needed);
});
