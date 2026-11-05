import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openWorkDb } from "./db.ts";
import { evfDataDir, loadConfig } from "./lib.ts";
import { loadLimit } from "./load.ts";
import { parseOwnerQueue, splitWait } from "./owner-queue.ts";
import { LOAD_FILE } from "./sampler.ts";

/**
 * `evf metrics --week` (OPS-142): the standing weekly dashboard, read from evf's own records. It opens the store
 * read-only and reads the load file, so it writes nothing. The "Weekly metrics" section of tools/evf/README.md defines
 * each number.
 */

const MINUTE = 60_000,
	HOUR = 60 * MINUTE,
	DAY = 24 * HOUR,
	WEEK = 7 * DAY;
/** Two sampler ticks further apart than this are not one straight run: one missed tick is allowed. */
const MAX_TICK_GAP = 2 * MINUTE;
/** The alarm level the ask names, apart from the load gate's limit, which is a setting. */
const LOAD_ALARM = 72;
const DIGEST_SPAN = 14 * DAY;
const SIGNALS = [
	"turn_end",
	"check_start",
	"check_end",
	"check_suite_end",
	"test_failed",
	"merged",
	"round",
	"round_start",
	"owner_ask",
	"owner_answer",
	"owner_approval_wait",
	"queue_tick",
	"load_wait",
	"stage_start",
	"drive_heartbeat",
	"drive_restart",
	"drive_death_alert",
	"drive_restart_refused",
	"escalation",
	"ship_refused",
];

type Level = "target" | "alarm";
type Breach = { level: Level; text: string };
type Metric = {
	key: string;
	name: string;
	target: string | null;
	/** Null means no signal, which the text gives as "no data". A number in here is never a stand-in for a missing one. */
	value: Record<string, unknown> | null;
	text: string;
	breaches: Breach[];
};
type WeekReport = {
	from: string;
	to: string;
	metrics: Metric[];
	lines: Metric[];
	alarms: Array<{ metric: string; level: Level; text: string }>;
};

type Payload = Record<string, any>;
type Event = { id: number; task: number | null; at: number; type: string; p: Payload };
type Run = { id: number; task: number; ref: string; stage: string; role: string; start: number; end: number | null };
type LoadLine = { at: number; load1: unknown };

const round = (n: number, digits = 1) => Number(n.toFixed(digits));
const share = (part: number, whole: number) => round((100 * part) / whole);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** Nearest rank: the value at or below which p% of the sample falls. */
function percentile(values: number[], p: number): number {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
const noData = (reason?: string) => (reason ? `no data (${reason})` : "no data");

function metric(
	key: string,
	name: string,
	target: string | null,
	value: Record<string, unknown> | null,
	text: string,
	breaches: Breach[] = [],
): Metric {
	return { key, name, target, value, text, breaches };
}
const missing = (key: string, name: string, target: string | null, reason?: string, breaches: Breach[] = []) =>
	metric(key, name, target, null, noData(reason), breaches);

/** The most ticks in a row that pass `test`, each within MAX_TICK_GAP of the one before. One tick is one minute. */
function longestRun<T extends { at: number }>(points: T[], test: (point: T) => boolean): number {
	let best = 0,
		current = 0,
		last: number | null = null;
	for (const point of points.toSorted((a, b) => a.at - b.at)) {
		const joined = last !== null && point.at - last <= MAX_TICK_GAP;
		current = test(point) ? (joined ? current + 1 : 1) : 0;
		best = Math.max(best, current);
		last = point.at;
	}
	return best;
}

function readLoadLines(root: string): LoadLine[] {
	const path = join(evfDataDir(root), LOAD_FILE);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.flatMap((line): LoadLine[] => {
			if (!line.trim()) return [];
			try {
				const { at, load1 } = JSON.parse(line) as { at: string; load1: unknown };
				const ms = Date.parse(at);
				return Number.isFinite(ms) ? [{ at: ms, load1 }] : [];
			} catch {
				return []; // The sampler may be part way through a line.
			}
		});
}

type Wait = { task: number; asked: number; end: number; open: boolean };

/**
 * Each ask with the answer that closed it, or the present for a task still open. An ask on a new head restarts the age,
 * as it does in the owner queue, so only a task's latest ask before an answer counts.
 */
function ownerWaits(events: Event[], closedTasks: Set<number>, now: number): Wait[] {
	const open = new Map<number, number>(),
		waits: Wait[] = [];
	for (const e of events) {
		if (e.task === null) continue;
		if (e.type === "owner_ask") open.set(e.task, Date.parse(e.p.askedAt));
		if (e.type !== "owner_answer") continue;
		const asked = open.get(e.task);
		if (asked === undefined) continue;
		waits.push({ task: e.task, asked, end: Date.parse(e.p.answeredAt), open: false });
		open.delete(e.task);
	}
	for (const [task, asked] of open) if (!closedTasks.has(task)) waits.push({ task, asked, end: now, open: true });
	return waits;
}

function weekReport(root: string): WeekReport {
	const now = Date.now(),
		db = openWorkDb(root, { readOnly: true });
	let events: Event[], runs: Run[], closedTasks: Set<number>;
	try {
		const rows = db
			.prepare(
				`SELECT id, task_id, ts, type, payload FROM events WHERE type IN (${SIGNALS.map(() => "?").join(", ")}) ORDER BY id`,
			)
			.all(...SIGNALS) as Array<{ id: number; task_id: number | null; ts: string; type: string; payload: string }>;
		events = rows.map((e) => ({
			id: e.id,
			task: e.task_id,
			at: Date.parse(e.ts),
			type: e.type,
			p: JSON.parse(e.payload) as Payload,
		}));
		const runRows = db
			.prepare(
				"SELECT r.id, r.task_id, COALESCE(t.ref, t.slug) AS ref, r.stage, r.role, r.started_at, r.ended_at FROM runs r JOIN tasks t ON t.id = r.task_id ORDER BY r.id",
			)
			.all() as Array<{
			id: number;
			task_id: number;
			ref: string;
			stage: string;
			role: string;
			started_at: string;
			ended_at: string | null;
		}>;
		runs = runRows.map((r) => ({
			id: r.id,
			task: r.task_id,
			ref: r.ref,
			stage: r.stage,
			role: r.role,
			start: Date.parse(r.started_at),
			end: r.ended_at ? Date.parse(r.ended_at) : null,
		}));
		closedTasks = new Set(
			(db.prepare("SELECT id FROM tasks WHERE status IN ('merged', 'abandoned')").all() as Array<{ id: number }>).map(
				(t) => t.id,
			),
		);
	} finally {
		db.close();
	}
	const from = now - WEEK,
		inWeek = (at: number) => at > from && at <= now,
		all = (type: string) => events.filter((e) => e.type === type),
		week = (type: string) => all(type).filter((e) => inWeek(e.at));
	const merges = week("merged"),
		checkEnds = week("check_end"),
		loadLines = readLoadLines(root).filter((l) => inWeek(l.at));
	const queue = parseOwnerQueue(loadConfig(root).ownerQueue);
	const insideHours = (w: { asked: number; end: number }) =>
		splitWait(new Date(w.asked), new Date(w.end), queue.ownerHours!, queue.timeZone).inside / 60;
	const waits = ownerWaits(
		events.filter((e) => e.type === "owner_ask" || e.type === "owner_answer"),
		closedTasks,
		now,
	);

	const seatSplit = (): Metric => {
		const name = "Seat time split",
			target = "checks under 35%, alarm over 50%",
			turns = week("turn_end");
		const totals = ["modelMs", "checkMs", "waitMs", "toolMs"].map((f) => sum(turns.map((t) => Number(t.p[f]) || 0))),
			total = sum(totals);
		if (!total) return missing("seatSplit", name, target);
		const [model, checks, waits, other] = totals.map((ms) => share(ms, total)) as [number, number, number, number];
		const breaches: Breach[] =
			checks > 50
				? [{ level: "alarm", text: `checks ${checks}% is over 50%` }]
				: checks >= 35
					? [{ level: "target", text: `checks ${checks}% is not under 35%` }]
					: [];
		const hours = round(total / HOUR);
		return metric(
			"seatSplit",
			name,
			target,
			{ modelPct: model, checksPct: checks, waitsPct: waits, otherPct: other, hours },
			`model ${model}%, checks ${checks}%, waits ${waits}%, other ${other}% of ${hours} h`,
			breaches,
		);
	};

	const fullRunsPerMerge = (): Metric => {
		const name = "Full check runs per merge",
			target = "4 or fewer",
			runsStarted = week("check_start").filter((e) => e.p.mode === "full").length,
			// A merge from before the first check_start has runs nothing counted, so it would shrink the ratio.
			signalStart = all("check_start")[0]?.at ?? Infinity,
			counted = merges.filter((e) => e.at >= signalStart);
		if (!counted.length || !runsStarted) return missing("fullRunsPerMerge", name, target);
		const perMerge = round(runsStarted / counted.length);
		return metric(
			"fullRunsPerMerge",
			name,
			target,
			{ perMerge, runs: runsStarted, merges: counted.length },
			`${perMerge} (${runsStarted} runs, ${counted.length} merges)`,
			perMerge > 4 ? [{ level: "target", text: `${perMerge} is over 4` }] : [],
		);
	};

	const roundsPerMerge = (): Metric => {
		const name = "Rounds per merge and non-code share",
			target = "under 1.0 and under 20%",
			counted = week("round_start").filter((e) => typeof e.p.nonMergeCommits === "number"),
			nonCode = counted.filter((e) => e.p.nonMergeCommits === 0).length,
			nonCodePct = counted.length ? share(nonCode, counted.length) : null,
			nonCodeText = nonCodePct === null ? `non-code ${noData()}` : `non-code ${nonCodePct}%`;
		const nonCodeBreach: Breach[] =
			nonCodePct !== null && nonCodePct >= 20
				? [{ level: "target", text: `non-code share ${nonCodePct}% is not under 20%` }]
				: [];
		if (!merges.length) {
			if (nonCodePct === null) return missing("roundsPerMerge", name, target);
			return metric(
				"roundsPerMerge",
				name,
				target,
				{ perMerge: null, rounds: week("round").length, merges: 0, nonCodePct },
				`rounds per merge ${noData()}, ${nonCodeText}`,
				nonCodeBreach,
			);
		}
		const rounds = week("round").length,
			perMerge = round(rounds / merges.length, 2);
		return metric(
			"roundsPerMerge",
			name,
			target,
			{ perMerge, rounds, merges: merges.length, nonCodePct },
			`${perMerge} rounds per merge (${rounds} rounds, ${merges.length} merges), ${nonCodeText}`,
			[
				...(perMerge >= 1 ? [{ level: "target" as const, text: `${perMerge} is not under 1.0` }] : []),
				...nonCodeBreach,
			],
		);
	};

	const ownerWait = (): Metric => {
		const name = "Owner wait inside ownerHours",
			target = "p90 under 4 h, alarm at an ask older than 24 h",
			sample = waits.filter((w) => w.open || inWeek(w.end)),
			open = sample.filter((w) => w.open),
			oldest = open.length ? Math.max(...open.map((w) => now - w.asked)) : 0,
			late = open.filter((w) => now - w.asked > DAY).length;
		const alarm: Breach[] = late
			? [{ level: "alarm", text: `${late} open ask(s) older than 24 h, the oldest ${round(oldest / HOUR)} h` }]
			: [];
		if (!sample.length) return missing("ownerWait", name, target);
		const facts = {
			asks: sample.length,
			open: open.length,
			oldestOpenHours: open.length ? round(oldest / HOUR) : null,
		};
		if (!queue.ownerHours)
			return metric(
				"ownerWait",
				name,
				target,
				{ p90InsideHours: null, ...facts },
				`${noData("ownerHours is not set")}, ${open.length} open of ${sample.length} asks`,
				alarm,
			);
		const p90 = round(percentile(sample.map(insideHours), 90));
		return metric(
			"ownerWait",
			name,
			target,
			{ p90InsideHours: p90, ...facts },
			`p90 ${p90} h inside (${sample.length} asks, ${open.length} open)`,
			[...(p90 >= 4 ? [{ level: "target" as const, text: `p90 ${p90} h is not under 4 h` }] : []), ...alarm],
		);
	};

	const queueIdle = (): Metric => {
		const name = "Queue idle time",
			target = "under 5%, alarm at 10 straight min",
			ticks = week("queue_tick").map((e) => ({ at: e.at, p: e.p }));
		if (!ticks.length) return missing("queueIdle", name, target);
		const limit = loadLimit(root).limit,
			idle = (t: { p: Payload }) =>
				t.p.runnable > 0 && t.p.slotsFree > 0 && typeof t.p.load === "number" && t.p.load < limit;
		const idleTicks = ticks.filter(idle).length,
			idlePct = share(idleTicks, ticks.length),
			straight = longestRun(ticks, idle);
		return metric(
			"queueIdle",
			name,
			target,
			{ idlePct, idleMinutes: idleTicks, minutes: ticks.length, longestStraightMinutes: straight },
			`${idlePct}% (${idleTicks} of ${ticks.length} min, longest ${straight} straight)`,
			[
				...(idlePct >= 5 ? [{ level: "target" as const, text: `${idlePct}% is not under 5%` }] : []),
				...(straight >= 10 ? [{ level: "alarm" as const, text: `${straight} straight idle min` }] : []),
			],
		);
	};

	const flakeInvalid = (): Metric => {
		const name = "Flake and invalidation rate",
			target = "flake under 1%, invalid under 2%, alarm at invalid 5% or one test failing on 3 tasks in 24 h";
		const failures = new Map<string, Array<{ at: number; task: unknown }>>();
		for (const e of week("test_failed")) {
			const seen = failures.get(e.p.test) ?? [];
			seen.push({ at: e.at, task: e.p.task });
			failures.set(e.p.test, seen);
		}
		const spread: Breach[] = [...failures].flatMap(([test, seen]) =>
			seen.some((a) => new Set(seen.filter((b) => b.at >= a.at && b.at - a.at <= DAY).map((b) => b.task)).size >= 3)
				? [{ level: "alarm" as const, text: `test failed on 3 tasks in 24 h: ${test}` }]
				: [],
		);
		if (!checkEnds.length) return missing("flakeInvalid", name, target, undefined, spread);
		const invalid = checkEnds.filter((e) => e.p.result === "invalidated").length,
			invalidPct = share(invalid, checkEnds.length),
			decided = checkEnds.filter((e) => e.p.result === "passed" || e.p.result === "failed");
		const passedLater = (e: Event) =>
			all("check_end").some(
				(o) =>
					o.id > e.id &&
					o.at <= now &&
					o.p.result === "passed" &&
					o.task === e.task &&
					o.p.treeHash === e.p.treeHash &&
					o.p.mode === e.p.mode,
			);
		const flaky = decided.filter((e) => e.p.result === "failed" && passedLater(e)).length,
			flakePct = decided.length ? share(flaky, decided.length) : null;
		return metric(
			"flakeInvalid",
			name,
			target,
			{
				flakePct,
				flakyRuns: flaky,
				decidedRuns: decided.length,
				invalidPct,
				invalidRuns: invalid,
				runs: checkEnds.length,
			},
			`flake ${flakePct === null ? noData() : `${flakePct}% (${flaky} of ${decided.length})`}, invalid ${invalidPct}% (${invalid} of ${checkEnds.length})`,
			[
				...(flakePct !== null && flakePct >= 1
					? [{ level: "target" as const, text: `flake ${flakePct}% is not under 1%` }]
					: []),
				...(invalidPct >= 5
					? [{ level: "alarm" as const, text: `invalid ${invalidPct}% is at or over 5%` }]
					: invalidPct >= 2
						? [{ level: "target" as const, text: `invalid ${invalidPct}% is not under 2%` }]
						: []),
				...spread,
			],
		);
	};

	const loadThrottled = (): Metric => {
		const name = "Load-throttled minutes",
			target = "under 60 per day, alarm at load above 72 for 5 min",
			waitEvents = week("load_wait"),
			straight = longestRun(loadLines, (l) => typeof l.load1 === "number" && l.load1 > LOAD_ALARM);
		const alarm: Breach[] =
			straight >= 5 ? [{ level: "alarm", text: `load above ${LOAD_ALARM} for ${straight} straight min` }] : [];
		// A check run passes the load gate, so a week with runs and no wait is a true zero. With neither, nothing shows it.
		if (!waitEvents.length && !week("check_start").length)
			return missing("loadThrottled", name, target, undefined, alarm);
		const days = new Map<number, number>();
		for (const e of waitEvents) {
			const end = Date.parse(e.p.endAt),
				day = Math.floor((now - end) / DAY);
			days.set(day, (days.get(day) ?? 0) + (end - Date.parse(e.p.startAt)) / MINUTE);
		}
		const minutes = round(sum([...days.values()])),
			worstDay = round(Math.max(0, ...days.values()));
		return metric(
			"loadThrottled",
			name,
			target,
			{ minutes, worstDayMinutes: worstDay, longestAboveAlarmMinutes: straight },
			`${minutes} min in the week, ${worstDay} on the worst day`,
			[
				...(worstDay >= 60
					? [{ level: "target" as const, text: `${worstDay} min on the worst day is not under 60` }]
					: []),
				...alarm,
			],
		);
	};

	const startToMerge = (): Metric => {
		const name = "Start to merge",
			target = "p90 under 10 h",
			starts = new Map<number, number>();
		for (const e of all("stage_start")) if (e.task !== null && !starts.has(e.task)) starts.set(e.task, e.at);
		const hours = merges.flatMap((e) => {
			const start = e.task === null ? undefined : starts.get(e.task);
			return start === undefined ? [] : [(e.at - start) / HOUR];
		});
		if (!hours.length) return missing("startToMerge", name, target);
		const p50 = round(percentile(hours, 50)),
			p90 = round(percentile(hours, 90));
		return metric(
			"startToMerge",
			name,
			target,
			{ p50Hours: p50, p90Hours: p90, merges: hours.length },
			`p50 ${p50} h, p90 ${p90} h (${hours.length} merges)`,
			p90 >= 10 ? [{ level: "target", text: `p90 ${p90} h is not under 10 h` }] : [],
		);
	};

	const fullRunP90 = (): Metric => {
		const name = "Full run p90",
			target = "under 15 min",
			passed = checkEnds.filter((e) => e.p.mode === "full" && e.p.result === "passed");
		if (!passed.length) return missing("fullRunP90", name, target);
		const p90 = round(
			percentile(
				passed.map((e) => e.p.durationMs / MINUTE),
				90,
			),
		);
		return metric(
			"fullRunP90",
			name,
			target,
			{ p90Minutes: p90, runs: passed.length },
			`${p90} min (${passed.length} passed runs)`,
			p90 >= 15 ? [{ level: "target", text: `${p90} min is not under 15 min` }] : [],
		);
	};

	const suiteRise = (): Metric => {
		const name = "Suite p90 week on week",
			target = "alarm at up 50%",
			durations = (lo: number, hi: number) => {
				const out = new Map<string, number[]>();
				for (const e of all("check_suite_end"))
					if (e.at > lo && e.at <= hi) out.set(e.p.suite, [...(out.get(e.p.suite) ?? []), e.p.durationMs]);
				return out;
			};
		const before = durations(from - WEEK, from),
			rises = [...durations(from, now)].flatMap(([suite, values]) => {
				const earlier = before.get(suite);
				if (!earlier) return [];
				const was = percentile(earlier, 90);
				return was > 0 ? [{ suite, risePct: round((100 * (percentile(values, 90) - was)) / was) }] : [];
			});
		if (!rises.length) return missing("suiteRise", name, target);
		rises.sort((a, b) => b.risePct - a.risePct);
		const worst = rises[0]!;
		return metric(
			"suiteRise",
			name,
			target,
			{ suites: rises },
			`largest change ${worst.suite} ${worst.risePct}% (${rises.length} suites)`,
			rises.flatMap((r) =>
				r.risePct >= 50 ? [{ level: "alarm" as const, text: `${r.suite} p90 is up ${r.risePct}%` }] : [],
			),
		);
	};

	const deadDrive = (): Metric => {
		const name = "Dead-drive minutes",
			target = "alarm at 5 min",
			beats = all("drive_heartbeat"),
			deaths = [...week("drive_restart"), ...week("drive_death_alert"), ...week("drive_restart_refused")];
		if (!deaths.length && !beats.some((e) => inWeek(e.at))) return missing("deadDrive", name, target);
		const spells = new Map<number, number>();
		for (const death of deaths) {
			const own = beats.filter((b) => b.task === death.task),
				before = own.findLast((b) => b.at <= death.at),
				after = own.find((b) => b.at > death.at);
			if (before) spells.set(before.id, ((after?.at ?? now) - before.at) / MINUTE);
		}
		const minutes = round(sum([...spells.values()]));
		return metric(
			"deadDrive",
			name,
			target,
			{ minutes, deaths: spells.size },
			`${minutes} min (${spells.size} deaths)`,
			minutes >= 5 ? [{ level: "alarm", text: `${minutes} dead min` }] : [],
		);
	};

	const bodyHandoff = (): Metric => {
		const name = "Body handoff p50",
			target = "under 5 min";
		const gaps = runs
			.filter((r) => r.stage === "body" && inWeek(r.start))
			.flatMap((r) => {
				const ended = runs.filter((o) => o.task === r.task && o.id !== r.id && o.end !== null && o.end <= r.start);
				return ended.length ? [(r.start - Math.max(...ended.map((o) => o.end!))) / MINUTE] : [];
			});
		if (!gaps.length) return missing("bodyHandoff", name, target);
		// Two digits: the real gap is seconds, and one digit would print a measured gap as 0.
		const p50 = round(percentile(gaps, 50), 2);
		return metric(
			"bodyHandoff",
			name,
			target,
			{ p50Minutes: p50, runs: gaps.length },
			`${p50} min (${gaps.length} body runs)`,
			p50 >= 5 ? [{ level: "target", text: `${p50} min is not under 5 min` }] : [],
		);
	};

	const escalations = (): Metric => {
		const name = "Escalations per 10 merges",
			target = "alarm over 1",
			count = week("escalation").length;
		if (!merges.length) return missing("escalations", name, target);
		const per10 = round((10 * count) / merges.length);
		return metric(
			"escalations",
			name,
			target,
			{ per10Merges: per10, escalations: count, merges: merges.length },
			`${per10} (${count} escalations, ${merges.length} merges)`,
			per10 > 1 ? [{ level: "alarm", text: `${per10} is over 1` }] : [],
		);
	};

	const refusals = (): Metric => {
		const name = "Refusals per path",
			target = "alarm at 3 in a week",
			refused = week("ship_refused");
		// A week with merges reached the ship code, so no refusal there is a true zero.
		if (!merges.length && !refused.length) return missing("refusals", name, target);
		const byPath = new Map<string, number>();
		for (const e of refused)
			for (const path of (e.p.overlapPaths ?? []) as string[]) byPath.set(path, (byPath.get(path) ?? 0) + 1);
		const paths = [...byPath]
			.map(([path, count]) => ({ path, count }))
			.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
		return metric(
			"refusals",
			name,
			target,
			{ refusals: refused.length, paths },
			`${refused.length} refused${paths.length ? `: ${paths.map((p) => `${p.path} ${p.count}`).join(", ")}` : ""}`,
			paths.flatMap((p) =>
				p.count >= 3 ? [{ level: "alarm" as const, text: `${p.path} caused ${p.count} refusals` }] : [],
			),
		);
	};

	const closedRuns = runs.filter((r) => r.end !== null && inWeek(r.start));
	const registration = (): Metric => {
		const name = "Registration per OPS task",
			target = "under 15 min",
			perTask = new Map<string, number>();
		for (const r of closedRuns)
			if (r.role === "registration" && r.ref.startsWith("OPS-"))
				perTask.set(r.ref, (perTask.get(r.ref) ?? 0) + (r.end! - r.start) / MINUTE);
		if (!perTask.size) return missing("registration", name, target);
		const worst = round(Math.max(...perTask.values())),
			p50 = round(percentile([...perTask.values()], 50));
		return metric(
			"registration",
			name,
			target,
			{ p50Minutes: p50, worstMinutes: worst, tasks: perTask.size },
			`p50 ${p50} min, worst ${worst} min (${perTask.size} tasks)`,
			worst >= 15 ? [{ level: "target", text: `worst ${worst} min is not under 15 min` }] : [],
		);
	};

	const coordinator = (): Metric => {
		const name = "Coordinator share of seat time",
			target = "under 10%",
			hours = (rows: Run[]) => sum(rows.map((r) => r.end! - r.start)),
			own = closedRuns.filter((r) => r.role === "coordinator");
		if (!own.length) return missing("coordinator", name, target);
		// Seat time counts from the first coordinator run, so a week that began before those rows does not shrink the share.
		const signalStart = Math.min(...own.map((r) => r.start)),
			seats = closedRuns.filter((r) => r.role !== "evf" && r.start >= signalStart);
		const pct = share(hours(own), hours(seats));
		return metric(
			"coordinator",
			name,
			target,
			{ pct, coordinatorHours: round(hours(own) / HOUR), seatHours: round(hours(seats) / HOUR) },
			`${pct}% (${round(hours(own) / HOUR)} of ${round(hours(seats) / HOUR)} h)`,
			pct >= 10 ? [{ level: "target", text: `${pct}% is not under 10%` }] : [],
		);
	};

	const overlap = (): Metric => {
		const name = "Median run time by overlap",
			span = (e: Event) => ({ id: e.id, from: e.at - Number(e.p.durationMs), to: e.at }),
			spans = all("check_end")
				.filter((e) => typeof e.p.durationMs === "number")
				.map(span);
		const passed = checkEnds.filter((e) => e.p.mode === "full" && e.p.result === "passed");
		if (!passed.length) return missing("overlap", name, null);
		const groups = new Map<number, number[]>();
		for (const e of passed) {
			const self = span(e),
				count = spans.filter((o) => o.id !== self.id && o.from < self.to && o.to > self.from).length;
			groups.set(count, [...(groups.get(count) ?? []), e.p.durationMs / MINUTE]);
		}
		const rows = [...groups]
			.sort(([a], [b]) => a - b)
			.map(([overlaps, values]) => ({ overlaps, medianMinutes: round(percentile(values, 50)), runs: values.length }));
		return metric(
			"overlap",
			name,
			null,
			{ groups: rows },
			rows.map((r) => `${r.overlaps} overlapping ${r.medianMinutes} min (${r.runs} runs)`).join(", "),
		);
	};

	const digest = (): Metric => {
		const name = "Digest before and after",
			target = "keep digests at a cut of 20% or more";
		if (!queue.ownerHours) return missing("digest", name, target, "ownerHours is not set");
		const firstDigest = all("owner_ask").find((e) => e.p.digestId);
		if (!firstDigest) return missing("digest", name, target, "no digest ask yet");
		const start = Date.parse(firstDigest.p.askedAt),
			answered = waits.filter((w) => !w.open);
		const before = new Map(
			answered
				.filter((w) => w.asked < start && w.asked >= start - DIGEST_SPAN)
				.map((w) => [`${w.task}:${w.asked}`, w] as const),
		);
		// Before the owner queue, an approval wait was the only record of an ask. Its merge ended the wait.
		for (const wait of all("owner_approval_wait")) {
			if (wait.task === null || wait.at >= start || wait.at < start - DIGEST_SPAN) continue;
			const closed = events.find(
				(e) => e.id > wait.id && e.task === wait.task && (e.type === "merged" || e.type === "owner_answer"),
			);
			if (closed)
				before.set(`${wait.task}:${wait.at}`, { task: wait.task, asked: wait.at, end: closed.at, open: false });
		}
		const after = answered.filter((w) => w.asked >= start && w.asked < start + DIGEST_SPAN);
		if (!before.size || !after.length)
			return missing("digest", name, target, `${before.size} asks before, ${after.length} after`);
		const was = round(percentile([...before.values()].map(insideHours), 90)),
			is = round(percentile(after.map(insideHours), 90)),
			cutPct = was > 0 ? round((100 * (was - is)) / was) : null;
		return metric(
			"digest",
			name,
			target,
			{ beforeP90Hours: was, afterP90Hours: is, cutPct, before: before.size, after: after.length },
			`inside-hours p90 ${was} h before (${before.size} asks), ${is} h after (${after.length} asks), cut ${cutPct === null ? noData() : `${cutPct}%`}`,
		);
	};

	const metrics = [
		seatSplit(),
		fullRunsPerMerge(),
		roundsPerMerge(),
		ownerWait(),
		queueIdle(),
		flakeInvalid(),
		loadThrottled(),
		startToMerge(),
	];
	const lines = [
		fullRunP90(),
		suiteRise(),
		deadDrive(),
		bodyHandoff(),
		escalations(),
		refusals(),
		registration(),
		coordinator(),
		overlap(),
		digest(),
	];
	return {
		from: new Date(from).toISOString(),
		to: new Date(now).toISOString(),
		metrics,
		lines,
		alarms: [...metrics, ...lines].flatMap((m) => m.breaches.map((b) => ({ metric: m.name, ...b }))),
	};
}

function renderWeek(report: WeekReport): string {
	const out = [`Week ${report.from} to ${report.to}`];
	report.metrics.forEach((m, i) => out.push(`${i + 1}. ${m.name}: ${m.text}${m.target ? ` [${m.target}]` : ""}`));
	out.push("");
	// The five lines of the ask, each with two parts.
	for (let i = 0; i < report.lines.length; i += 2)
		out.push(
			`- ${report.lines
				.slice(i, i + 2)
				.map((m) => `${m.name}: ${m.text}${m.target ? ` [${m.target}]` : ""}`)
				.join("; ")}`,
		);
	if (report.alarms.length) out.push("");
	for (const a of report.alarms)
		out.push(`ALARM ${a.metric}${a.level === "target" ? " (target missed)" : ""}: ${a.text}`);
	return out.join("\n");
}

export function metricsWeek(root: string, opts: { json: boolean }): number {
	const report = weekReport(root);
	console.log(opts.json ? JSON.stringify(report, null, 2) : renderWeek(report));
	return 0;
}
