import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openWorkDb, record } from "./db.ts";
import { fail, loadConfig, REAL_CLOCK, run, type Clock } from "./lib.ts";
import { nameWithOwner, requiredCheckNames } from "./ship.ts";

/**
 * The check alarm (OPS-139): a poll of the open PRs that tells the coordinator when a new check name reaches 2 PRs, or
 * when one non-required check is red on 2 PRs. An alarm blocks nothing and closes nothing. A poll writes check_names,
 * check_poll and its own events, and no task, run or stage row. The rules are in "Check alarm" in tools/evf/README.md.
 */

const MINUTE = 60_000,
	WEEK = 7 * 24 * 60 * MINUTE;
const NEW_ALARM_PRS = 2,
	RED_ALARM_PRS = 2;
/** The sampler starts a poll this often. With a tick each minute, a new check waits at most 6 min for its poll. */
const POLL_EVERY_MS = 5 * MINUTE;
/** Under POLL_EVERY_MS, so polls never overlap. 6 min plus this stays inside the 10 min the alert promises. */
const POLL_TIMEOUT_MS = 2 * MINUTE;
const READ_TIMEOUT_MS = 60_000,
	SEND_TIMEOUT_MS = 10_000;

type Bucket = "pass" | "fail" | "pending" | "skipping" | "cancel";
type OpenPr = { number: number; head: string; checks: Array<{ name: string; bucket: Bucket }> };
type AlarmKind = "new" | "red";
const ALARM_EVENT: Record<AlarmKind, string> = { new: "ci_new_check_alarm", red: "ci_nonrequired_red_alarm" };
type Alarm = { kind: AlarmKind; check: string; prs: number[]; eventId: number; notified: boolean | null };
export type PollResult = {
	baseline: boolean;
	firstSeen: string[];
	red: Array<{ check: string; prs: number[] }>;
	alarms: Array<Omit<Alarm, "eventId">>;
};

/** The bucket of a rollup item, by the rule `gh pr checks` applies. A check run has status and conclusion, a status context has state. */
function bucketOf(item: { state?: unknown; status?: unknown; conclusion?: unknown }): Bucket {
	const state = item.state || (item.status === "COMPLETED" ? item.conclusion : item.status);
	switch (state) {
		case "SUCCESS":
			return "pass";
		case "SKIPPED":
		case "NEUTRAL":
			return "skipping";
		case "ERROR":
		case "FAILURE":
		case "TIMED_OUT":
		case "ACTION_REQUIRED":
		case "STARTUP_FAILURE":
			return "fail";
		case "CANCELLED":
			return "cancel";
		default:
			return "pending";
	}
}

const timeOf = (value: unknown) => (typeof value === "string" && Date.parse(value)) || 0;

/**
 * The checks of one PR head. A rollup can hold a name twice in one workflow, one run per trigger, and only the latest
 * counts: `gh pr checks` drops the older runs too. Two workflows may share a name, and each keeps its own run.
 */
function checksOf(rollup: unknown[]): OpenPr["checks"] {
	const latest = new Map<string, { name: string; bucket: Bucket; started: number; completed: number }>();
	for (const raw of rollup) {
		const item = raw as Record<string, unknown> | null;
		const name = item?.name || item?.context;
		if (typeof name !== "string") throw new Error("a rollup item has no check name");
		const key = `${String(item!.workflowName ?? "")}\0${name}`,
			started = timeOf(item!.startedAt),
			completed = timeOf(item!.completedAt),
			held = latest.get(key);
		if (!held || started > held.started || (started === held.started && completed >= held.completed))
			latest.set(key, { name, bucket: bucketOf(item!), started, completed });
	}
	return [...latest.values()].map(({ name, bucket }) => ({ name, bucket }));
}

function readOpenPrs(root: string): OpenPr[] {
	const r = run(
		"gh",
		["pr", "list", "--state", "open", "--limit", "1000", "--json", "number,headRefOid,statusCheckRollup"],
		{ cwd: root, timeoutMs: READ_TIMEOUT_MS },
	);
	if (r.code !== 0) throw new Error(`gh pr list failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
	const parsed: unknown = JSON.parse(r.stdout);
	if (!Array.isArray(parsed)) throw new Error("gh pr list did not print a list");
	return parsed.map((raw: { number?: unknown; headRefOid?: unknown; statusCheckRollup?: unknown }) => {
		if (typeof raw?.number !== "number" || typeof raw.headRefOid !== "string")
			throw new Error("gh pr list printed a PR with no number or head");
		return {
			number: raw.number,
			head: raw.headRefOid,
			checks: checksOf(Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []),
		};
	});
}

/**
 * Stamp this poll's start unless a poll started under POLL_EVERY_MS ago. True when this call stamped it. The sampler
 * starts a poll only on true. A manual poll in that window leaves the stamp, so it cannot delay the sampler's next poll.
 */
export function claimPoll(db: DatabaseSync, nowMs: number): boolean {
	return (
		db
			.prepare(
				`INSERT INTO check_poll (id, last_attempt_at) VALUES (1, :now)
				ON CONFLICT (id) DO UPDATE SET last_attempt_at = :now WHERE last_attempt_at <= :due`,
			)
			.run({ now: new Date(nowMs).toISOString(), due: new Date(nowMs - POLL_EVERY_MS).toISOString() }).changes > 0
	);
}

type NameRow = {
	name: string;
	first_seen_at: string;
	last_seen_at: string;
	prs: string;
	new_state: "baseline" | "watching" | "alarmed";
	red_alarmed: number;
};

/** Add what this poll read to the store, in one transaction, so two polls at once cannot raise one alarm twice. */
function writePoll(db: DatabaseSync, required: string[], prs: OpenPr[], nowMs: number) {
	const at = new Date(nowMs).toISOString();
	const seen = new Map<string, Set<number>>(),
		red = new Map<string, Array<{ pr: number; head: string }>>();
	for (const pr of prs)
		for (const { name, bucket } of pr.checks) {
			if (!seen.has(name)) seen.set(name, new Set());
			seen.get(name)!.add(pr.number);
			if ((bucket !== "fail" && bucket !== "cancel") || required.includes(name)) continue;
			if (!red.has(name)) red.set(name, []);
			if (!red.get(name)!.some((r) => r.pr === pr.number)) red.get(name)!.push({ pr: pr.number, head: pr.head });
		}
	const alarms: Alarm[] = [],
		firstSeen: string[] = [];
	const raise = (kind: AlarmKind, check: string, alarmPrs: number[]) => {
		const words = kind === "new" ? "New check" : "Non-required check red:";
		record(db, null, null, ALARM_EVENT[kind], {
			check,
			prs: alarmPrs,
			raisedAt: at,
			notified: null,
			summary: `${words} ${check} on ${prList(alarmPrs)}`,
		});
		const { id } = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
		alarms.push({ kind, check, prs: alarmPrs, eventId: id, notified: null });
	};
	db.exec("BEGIN IMMEDIATE");
	try {
		const { last_ok_at: lastOk } = (db.prepare("SELECT last_ok_at FROM check_poll").get() ?? {}) as {
				last_ok_at?: string | null;
			},
			{ n: known } = db.prepare("SELECT COUNT(*) AS n FROM check_names").get() as { n: number };
		const baseline = known === 0 || (!!lastOk && nowMs - Date.parse(lastOk) > WEEK);

		const readName = db.prepare("SELECT * FROM check_names WHERE name = ?");
		const writeName = db.prepare(
			`INSERT OR REPLACE INTO check_names (name, first_seen_at, last_seen_at, prs, new_state, red_alarmed)
			VALUES (?, ?, ?, ?, ?, ?)`,
		);
		for (const [name, current] of seen) {
			const row = readName.get(name) as NameRow | undefined;
			const fresh = !row || nowMs - Date.parse(row.last_seen_at) > WEEK;
			if (fresh) firstSeen.push(name);
			const firstAt = fresh ? at : row.first_seen_at;
			const namePrs = [...new Set([...(fresh ? [] : (JSON.parse(row.prs) as number[])), ...current])].sort(
				(a, b) => a - b,
			);
			let state: NameRow["new_state"] = fresh ? (baseline ? "baseline" : "watching") : row.new_state;
			if (state === "watching" && namePrs.length >= NEW_ALARM_PRS && nowMs - Date.parse(firstAt) < WEEK) {
				state = "alarmed";
				raise("new", name, namePrs);
			}
			writeName.run(name, firstAt, at, JSON.stringify(namePrs), state, row?.red_alarmed ?? 0);
		}

		const recorded = new Set(
			(
				db.prepare("SELECT payload FROM events WHERE type = 'ci_nonrequired_red'").all() as Array<{ payload: string }>
			).map(({ payload }) => {
				const { check, pr, head } = JSON.parse(payload) as { check: string; pr: number; head: string };
				return JSON.stringify([check, pr, head]);
			}),
		);
		for (const [check, reds] of red) {
			for (const { pr, head } of reds)
				if (!recorded.has(JSON.stringify([check, pr, head])))
					record(db, null, null, "ci_nonrequired_red", { check, pr, head, firstSeenAt: at });
			const row = readName.get(check) as unknown as NameRow;
			if (!baseline && reds.length >= RED_ALARM_PRS && !row.red_alarmed) {
				db.prepare("UPDATE check_names SET red_alarmed = 1 WHERE name = ?").run(check);
				raise(
					"red",
					check,
					reds.map((r) => r.pr).sort((a, b) => a - b),
				);
			}
		}
		for (const { name } of db.prepare("SELECT name FROM check_names WHERE red_alarmed = 1").all() as Array<{
			name: string;
		}>)
			if (!red.has(name)) db.prepare("UPDATE check_names SET red_alarmed = 0 WHERE name = ?").run(name);

		db.prepare("UPDATE check_poll SET last_ok_at = ? WHERE id = 1").run(at);
		db.exec("COMMIT");
		return { baseline, firstSeen, red, alarms };
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}

const prList = (prs: number[]) => prs.map((pr) => `#${pr}`).join(", ");

/** The notification holdTask sends, with a timeout. False when it fails, which never fails the poll. */
function sendAlarm({ kind, check, prs }: Alarm): boolean {
	const [title, body] =
		kind === "new"
			? [`New check: ${check}`, `${check} appeared on PRs ${prList(prs)}. It blocks nothing. Decide if it belongs.`]
			: [
					`Non-required check red: ${check}`,
					`${check} is red on PRs ${prList(prs)}. It is not required, so the ci stage ignores it. Decide if it belongs.`,
				];
	return (
		run("herdr", ["notification", "show", title, "--body", body, "--sound", "request"], { timeoutMs: SEND_TIMEOUT_MS })
			.code === 0
	);
}

/**
 * One poll. A failed read throws through `fail` before the first write of what it read, and only the start stamp stays.
 * An alarm's event commits with its state, then the send runs, then the event gets the result: a poll killed between
 * them leaves `notified` null and never sends twice.
 */
export function pollChecks(root: string, clock: Clock = REAL_CLOCK): PollResult {
	const db = openWorkDb(root);
	try {
		const nowMs = clock.now();
		claimPoll(db, nowMs);
		let required: string[], prs: OpenPr[];
		try {
			required = requiredCheckNames(root, nameWithOwner(root), loadConfig(root).baseBranch);
			prs = readOpenPrs(root);
		} catch (e) {
			fail(
				`check-alarm: a GitHub read failed, so this poll recorded nothing: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		const { baseline, firstSeen, red, alarms } = writePoll(db, required, prs, nowMs);
		for (const alarm of alarms) {
			alarm.notified = sendAlarm(alarm);
			db.prepare("UPDATE events SET payload = json_set(payload, '$.notified', json(?)) WHERE id = ?").run(
				String(alarm.notified),
				alarm.eventId,
			);
		}
		return {
			baseline,
			firstSeen,
			red: [...red].map(([check, reds]) => ({ check, prs: reds.map((r) => r.pr).sort((a, b) => a - b) })),
			alarms: alarms.map(({ eventId: _eventId, ...alarm }) => alarm),
		};
	} finally {
		db.close();
	}
}

/** `evf check-alarm`: one poll and what it found. */
export function checkAlarm(root: string, json: boolean): number {
	const result = pollChecks(root);
	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return 0;
	}
	if (result.baseline)
		console.log(
			"Baseline poll: the store has no names, or no poll worked in more than 7 days. It records names and raises no alarm.",
		);
	console.log(`First seen: ${result.firstSeen.join(", ") || "none"}.`);
	if (!result.red.length) console.log("Red non-required checks: none.");
	for (const { check, prs } of result.red) console.log(`Red non-required check: ${check} on ${prList(prs)}.`);
	if (!result.alarms.length) console.log("Alarms raised: none.");
	for (const { kind, check, prs, notified } of result.alarms)
		console.log(`Alarm (${kind}): ${check} on ${prList(prs)}. Notification ${notified ? "sent" : "failed"}.`);
	return 0;
}

const evfArgs = (root: string, ...args: string[]) => {
	// A sampler runs the home checkout's code, which outlives a worktree (see spawnSampler).
	const home = join(root, "tools/evf/main.ts");
	return [
		"--disable-warning=ExperimentalWarning",
		existsSync(home) ? home : join(import.meta.dirname, "main.ts"),
		...args,
	];
};

/** The internal `evf check-alarm sampled`: one poll with a timeout, in a process nothing waits for. */
export function runSampledPoll(root: string, timeoutMs = POLL_TIMEOUT_MS): number {
	return run(process.execPath, evfArgs(root, "check-alarm"), { cwd: root, timeoutMs }).code;
}

const LAUNCHER = `require("node:child_process").spawn(process.execPath,process.argv.slice(1),{detached:true,stdio:"ignore"}).unref()`;

/**
 * Start a poll and return at once, so a slow GitHub read cannot stretch a sampler tick. The sampler's event loop never
 * turns, so it could not reap a direct child and each poll would leave a zombie. A short launcher starts the poll and
 * exits, and the system adopts the poll. A test's sampler sets EVF_NO_CHECK_POLL (tests/fixtures.ts).
 */
export function startPoll(root: string, launchTimeoutMs: number): void {
	if (process.env.EVF_NO_CHECK_POLL) return;
	const r = run(process.execPath, ["-e", LAUNCHER, "--", ...evfArgs(root, "check-alarm", "sampled")], {
		cwd: root,
		timeoutMs: launchTimeoutMs,
	});
	if (r.code !== 0) throw new Error(`The check poll did not start: ${r.stderr.trim()}`);
}
