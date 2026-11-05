import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensureTask, findTask, openWorkDb, record, taskById, workDbPath, type Ledger } from "./db.ts";
import { fail, loadConfig, parseTask, readJson, run, type Dag, type TaskRef } from "./lib.ts";

/**
 * The owner queue (OPS-131): what waits for Sebastian, from `owner_ask` and `owner_answer` events. evf prints the
 * digest and sends nothing; Jonah sends it. Recording never changes a merge: the record* and note* functions warn and
 * go on when a write fails. An open item is a task's latest owner_ask with no owner_answer after it, on a task that is
 * not merged or abandoned.
 */

type OwnerKind =
	| "template"
	| "owner_path"
	| "wiki"
	| "design"
	| "feedback"
	| "void_approval"
	| "escalation"
	| "prototype_pick"
	| "parked";

const MINUTE = 60_000,
	DAY = 24 * 60 * MINUTE,
	QUESTION_AFTER = 48 * 60 * MINUTE,
	QUESTION = "Keep, abandon or reopen?",
	URGENT_AT = 2;

/** The one-sentence ask of each kind. `subject` is the PR, or the task where no PR exists. */
const ASKS: Record<OwnerKind, (subject: string) => string> = {
	template: (s) => `Approve the document template change in ${s}.`,
	owner_path: (s) => `Approve the landing or marketing change in ${s}.`,
	wiki: (s) => `Approve the Wiki content in ${s}.`,
	design: (s) => `Approve the design task in ${s}.`,
	feedback: (s) => `Approve the P2 or P3 feedback fix in ${s}.`,
	void_approval: (s) => `Approve the new head of ${s}, because new code voided your approval.`,
	escalation: (s) => `Decide how ${s} goes on, because it stopped and escalated.`,
	prototype_pick: (s) => `Pick one of the compared ideas for ${s}.`,
	parked: (s) => `Say what happens to ${s}, which waits with no recorded route.`,
};

type OwnerHours = { start: string; end: string };
type OwnerQueueConfig = { timeZone: string; digestTimes: string[]; ownerHours: OwnerHours | null };

const DEFAULT_DIGEST_TIMES = ["09:00", "13:00", "17:00"];
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isTime = (v: unknown): v is string => typeof v === "string" && HH_MM.test(v);
const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Parse evf.config.json `ownerQueue`. An absent key gives the default digest times and leaves ownerHours unset. */
export function parseOwnerQueue(raw: unknown): OwnerQueueConfig {
	if (raw === undefined) return { timeZone: systemZone(), digestTimes: DEFAULT_DIGEST_TIMES, ownerHours: null };
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		fail("evf.config.json ownerQueue must be an object with timeZone, digestTimes and ownerHours.");
	const { timeZone, digestTimes, ownerHours } = raw as Record<string, unknown>;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timeZone as string | undefined });
	} catch {
		fail("evf.config.json ownerQueue.timeZone must be an IANA time zone such as America/Chicago.");
	}
	if (digestTimes !== undefined) {
		const list = digestTimes as unknown[];
		if (!Array.isArray(list) || list.length !== 3 || !list.every(isTime) || !(list[0] < list[1] && list[1] < list[2]))
			fail('evf.config.json ownerQueue.digestTimes must be 3 ascending "HH:MM" values.');
	}
	if (ownerHours !== undefined) {
		const { start, end } = (ownerHours ?? {}) as Record<string, unknown>;
		if (!isTime(start) || !isTime(end) || start >= end)
			fail(
				'evf.config.json ownerQueue.ownerHours must be { start: "HH:MM", end: "HH:MM" } with start before end. A window that crosses midnight is refused.',
			);
	}
	return {
		timeZone: (timeZone as string | undefined) ?? systemZone(),
		digestTimes: (digestTimes as string[] | undefined) ?? DEFAULT_DIGEST_TIMES,
		ownerHours: (ownerHours as OwnerHours | undefined) ?? null,
	};
}

/** The wall clock of `ms` in `zone`, as the UTC time with the same fields. */
function wallClock(ms: number, zone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(ms);
	const field = (type: string) => Number(parts.find((p) => p.type === type)!.value);
	return Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
}

const offsetAt = (ms: number, zone: string) => wallClock(ms, zone) - Math.floor(ms / 1000) * 1000;

/**
 * The instant of a wall clock in `zone`. A wall clock that happens twice on the day clocks go back gives the first. One
 * that does not exist on the day clocks go forward gives the instant the same distance after the change.
 */
function instantOf(wall: number, zone: string): number {
	const before = offsetAt(wall - DAY, zone),
		after = offsetAt(wall + DAY, zone);
	return offsetAt(wall - before, zone) !== before && offsetAt(wall - after, zone) === after
		? wall - after
		: wall - before;
}

const midnightOf = (ms: number, zone: string) => {
	const wall = wallClock(ms, zone);
	return wall - (wall % DAY);
};
const wallAt = (midnight: number, time: string) => {
	const [hours, minutes] = time.split(":").map(Number) as [number, number];
	return midnight + hours * 60 * MINUTE + minutes * MINUTE;
};

/**
 * A wait in minutes inside and outside the daily ownerHours window, in `timeZone`. The two add up to the whole minutes
 * of real time between start and end, so a day with a clock change counts its true length.
 */
export function splitWait(
	start: Date,
	end: Date,
	ownerHours: OwnerHours,
	timeZone: string,
): { inside: number; outside: number } {
	const from = start.getTime(),
		to = end.getTime();
	let inside = 0;
	for (let day = midnightOf(from, timeZone); day <= midnightOf(to, timeZone); day += DAY) {
		const open = instantOf(wallAt(day, ownerHours.start), timeZone),
			close = instantOf(wallAt(day, ownerHours.end), timeZone);
		inside += Math.max(0, Math.min(to, close) - Math.max(from, open));
	}
	const total = Math.floor((to - from) / MINUTE),
		insideMinutes = Math.min(total, Math.round(inside / MINUTE));
	return { inside: insideMinutes, outside: total - insideMinutes };
}

/** The next digest slot at or after `ms`, as local date and time: `2026-11-04T13:00`. */
export function nextDigest(ms: number, q: OwnerQueueConfig): string {
	const today = midnightOf(ms, q.timeZone);
	for (let day = today; ; day += DAY)
		for (const time of q.digestTimes)
			if (instantOf(wallAt(day, time), q.timeZone) >= ms) return `${new Date(day).toISOString().slice(0, 10)}T${time}`;
}

type AskPayload = {
	task: string;
	pr: number | null;
	head: string | null;
	kind: OwnerKind;
	digestId: string | null;
	askedAt: string;
};

/** The task's latest ask when nothing answered it. */
function openAsk(db: DatabaseSync, taskId: number): AskPayload | undefined {
	const row = db
		.prepare(
			"SELECT type, payload FROM events WHERE task_id = ? AND type IN ('owner_ask', 'owner_answer') ORDER BY id DESC LIMIT 1",
		)
		.get(taskId) as { type: string; payload: string } | undefined;
	return row?.type === "owner_ask" ? (JSON.parse(row.payload) as AskPayload) : undefined;
}

/** One owner_ask, or none when the open ask has this head already. */
function ask(
	db: DatabaseSync,
	root: string,
	row: { id: number; ref: string },
	pr: number | null,
	head: string | null,
	kind: OwnerKind,
): void {
	if (openAsk(db, row.id)?.head === head) return;
	const at = Date.now();
	const payload: AskPayload = {
		task: row.ref,
		pr,
		head,
		kind,
		digestId: nextDigest(at, parseOwnerQueue(loadConfig(root).ownerQueue)),
		askedAt: new Date(at).toISOString(),
	};
	record(db, row.id, null, "owner_ask", payload);
}

/** One owner_answer for the open ask, or none. `head` is the head he answered, when the answer names one. */
function answer(db: DatabaseSync, taskId: number, head?: string): boolean {
	const open = openAsk(db, taskId);
	if (!open) return false;
	record(db, taskId, null, "owner_answer", {
		task: open.task,
		pr: open.pr,
		head: head ?? open.head,
		answeredAt: new Date().toISOString(),
	});
	return true;
}

/** A write failure warns and goes on: recording never changes what the command does (OPS-131). */
function warned(what: string, write: () => void): void {
	try {
		write();
	} catch (e) {
		console.error(`evf: warning: could not record ${what}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** The same, for a route that holds no open store. */
function warnedInStore(root: string, what: string, write: (db: DatabaseSync) => void): void {
	warned(what, () => {
		const db = openWorkDb(root);
		try {
			write(db);
		} finally {
			db.close();
		}
	});
}

/** The task's worktree head, else its pushed branch head, else null. */
function knownHead(root: string, row: { ref: string; worktree: string | null }): string | null {
	const read = (cwd: string, rev: string) => {
		const r = run("git", ["-C", cwd, "rev-parse", "--verify", "-q", rev]);
		return r.code === 0 ? r.stdout.trim() : null;
	};
	return (
		(row.worktree ? read(row.worktree, "HEAD") : null) ??
		read(root, `refs/remotes/${loadConfig(root).remote}/${parseTask(row.ref).branch}`)
	);
}

/** A route in evf ship or evf approve asks Sebastian about this PR head. */
export function recordOwnerAsk(root: string, task: TaskRef, pr: number, head: string, kind: OwnerKind): void {
	warnedInStore(root, `the owner ask of ${task.id}`, (db) => {
		ask(db, root, ensureTask(db, task, "implement"), pr, head, kind);
	});
}

/** A voided approval of PR `pr`. The refusal knows the PR and head, so the row comes from the PR number. */
export function recordVoidAsk(root: string, pr: number, head: string): void {
	warnedInStore(root, `the owner ask of PR #${pr}`, (db) => {
		const row = db
			.prepare(
				"SELECT id, ref FROM tasks WHERE pr_number = ? AND ref IS NOT NULL AND status NOT IN ('merged', 'abandoned') ORDER BY id DESC LIMIT 1",
			)
			.get(pr) as { id: number; ref: string } | undefined;
		if (!row) throw new Error(`no open task row holds PR #${pr}`);
		ask(db, root, row, pr, head, "void_approval");
	});
}

/** The drive asks Sebastian about a task row it holds open: at the task's known head. A pick has no head. */
export function noteOwnerAsk(db: DatabaseSync, root: string, taskId: number, kind: OwnerKind): void {
	warned(`the owner ask of task row ${taskId}`, () => {
		const row = taskById(db, taskId)!;
		ask(db, root, row, row.pr_number, kind === "prototype_pick" ? null : knownHead(root, row), kind);
	});
}

/** Sebastian answered the open ask of a task row. */
export function noteOwnerAnswer(db: DatabaseSync, taskId: number): void {
	warned(`the owner answer of task row ${taskId}`, () => void answer(db, taskId));
}

/** Sebastian answered the PR on this branch, at this head. A branch with no open ask records nothing. */
export function recordOwnerAnswer(root: string, branch: string, head: string): void {
	warnedInStore(root, `the owner answer of ${branch}`, (db) => {
		const rows = db
			.prepare("SELECT id FROM tasks WHERE branch = ? AND status <> 'abandoned' ORDER BY id DESC")
			.all(branch) as Array<{ id: number }>;
		for (const row of rows) if (answer(db, row.id, head)) return;
	});
}

const OPEN_ROW = "status NOT IN ('merged', 'done', 'abandoned')";

/** A package is merged when the ledger closed it, or when its rows hold a merged row and no open row. */
function packageMerged(db: DatabaseSync, ledger: Ledger, id: string): boolean {
	if (["done", "retired"].includes(ledger.packages?.[id]?.status ?? "")) return true;
	const family = db
		.prepare(
			`SELECT COALESCE(SUM(status = 'merged'), 0) AS merged, COALESCE(SUM(${OPEN_ROW}), 0) AS open FROM tasks WHERE ref = ? OR ref LIKE ?`,
		)
		.get(id, `${id}/%`) as { merged: number; open: number };
	return family.merged > 0 && family.open === 0;
}

/** The item's own task, its open follow-up rows and its direct dependent packages that are not merged. */
function blockedCount(root: string, db: DatabaseSync, taskId: number, ref: string): number {
	const { n: followUps } = db
		.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ? AND ${OPEN_ROW}`)
		.get(taskId) as { n: number };
	const wp = /^WP-\d{3}/.exec(ref)?.[0];
	if (!wp) return 1 + followUps;
	const dag = readJson<Dag>(join(root, "docs/plan/dag.json")),
		ledger = readJson<Ledger>(join(root, "docs/build-progress.json"));
	const dependents = dag.packages.filter((p) => p.depends_on.includes(wp) || (p.ui_depends_on ?? []).includes(wp));
	return 1 + followUps + dependents.filter((p) => !packageMerged(db, ledger, p.id)).length;
}

type OwnerItem = {
	task: string;
	pr: number | null;
	head: string | null;
	kind: OwnerKind;
	ask: string;
	askedAt: string;
	ageMinutes: number;
	blocked: number;
	urgent: boolean;
	question: string | null;
	digestId: string | null;
	insideMinutes?: number;
	outsideMinutes?: number;
};

function openItems(root: string, db: DatabaseSync, q: OwnerQueueConfig, now: number): OwnerItem[] {
	const rows = db
		.prepare(
			"SELECT DISTINCT t.id FROM tasks t JOIN events e ON e.task_id = t.id WHERE e.type = 'owner_ask' AND t.status NOT IN ('merged', 'abandoned')",
		)
		.all() as Array<{ id: number }>;
	const items = rows.flatMap((row): OwnerItem[] => {
		const open = openAsk(db, row.id);
		if (!open) return [];
		const asked = Date.parse(open.askedAt),
			blocked = blockedCount(root, db, row.id, open.task);
		const split = q.ownerHours && splitWait(new Date(asked), new Date(now), q.ownerHours, q.timeZone);
		return [
			{
				task: open.task,
				pr: open.pr,
				head: open.head,
				kind: open.kind,
				ask: ASKS[open.kind](open.pr ? `PR #${open.pr}` : open.task),
				askedAt: open.askedAt,
				ageMinutes: Math.floor((now - asked) / MINUTE),
				blocked,
				urgent: blocked >= URGENT_AT,
				question: now - asked > QUESTION_AFTER ? QUESTION : null,
				digestId: open.digestId,
				...(split ? { insideMinutes: split.inside, outsideMinutes: split.outside } : {}),
			},
		];
	});
	return items.sort((a, b) => Number(b.urgent) - Number(a.urgent) || Date.parse(a.askedAt) - Date.parse(b.askedAt));
}

export const prList = (prs: number[]) => prs.map((pr) => `#${pr}`).join(", ");
const ageText = (minutes: number) => `age ${Math.floor(minutes / 60)}h ${minutes % 60}m`;

type NewCheckAlarm = { check: string; prs: number[]; ageMinutes: number };

/** New check alarms raised in the last 24 h. Any 24 h holds each of the three daily digest times. They block nothing. */
function recentNewChecks(db: DatabaseSync, now: number): NewCheckAlarm[] {
	const rows = db.prepare("SELECT payload FROM events WHERE type = 'ci_new_check_alarm' ORDER BY id").all() as Array<{
		payload: string;
	}>;
	return rows.flatMap(({ payload }) => {
		const { check, prs, raisedAt } = JSON.parse(payload) as { check: string; prs: number[]; raisedAt: string };
		const age = now - Date.parse(raisedAt);
		return age <= DAY ? [{ check, prs, ageMinutes: Math.floor(age / MINUTE) }] : [];
	});
}

function itemLine(i: OwnerItem): string {
	const age = ageText(i.ageMinutes);
	return [
		...(i.urgent ? ["URGENT"] : []),
		i.pr ? `PR #${i.pr}` : "no PR",
		i.head ? i.head.slice(0, 10) : "unknown",
		i.task,
		i.ask,
		i.insideMinutes === undefined ? age : `${age} (inside ${i.insideMinutes} min, outside ${i.outsideMinutes} min)`,
		`blocks ${i.blocked}`,
		...(i.question ? [i.question] : []),
	].join(" | ");
}

const HOURS_NOT_SET = "ownerHours is not set, so ages show no inside or outside split.";

/** Print what waits for Sebastian. It opens the store read-only and sends nothing. */
export function ownerQueue(root: string, json: boolean): number {
	const q = parseOwnerQueue(loadConfig(root).ownerQueue),
		now = Date.now(),
		next = nextDigest(now, q);
	let items: OwnerItem[] = [],
		newChecks: NewCheckAlarm[] = [];
	if (existsSync(workDbPath(root))) {
		const db = openWorkDb(root, { readOnly: true });
		try {
			// The migration records the waits older than this code. A store without it would print a false empty queue.
			if (!db.prepare("SELECT 1 FROM schema_version WHERE name = 'owner-queue'").get())
				fail("The work store has no owner queue yet. Run evf db migrate, then run evf owner-queue again.");
			items = openItems(root, db, q, now);
			newChecks = recentNewChecks(db, now);
		} finally {
			db.close();
		}
	}
	if (json) {
		console.log(
			JSON.stringify(
				{ nextDigest: next, ...(q.ownerHours ? {} : { note: HOURS_NOT_SET }), items, newCheckAlarms: newChecks },
				null,
				2,
			),
		);
		return 0;
	}
	console.log(items.length ? `${items.length} waiting for Sebastian.` : "Nothing waits for Sebastian.");
	for (const item of items) console.log(itemLine(item));
	if (newChecks.length) console.log("New check alarms, for information. These are not waiting items:");
	for (const { check, prs, ageMinutes } of newChecks)
		console.log(`${check} | PRs ${prList(prs)} | ${ageText(ageMinutes)}`);
	console.log(`Next digest: ${next} (${q.timeZone}).`);
	if (!q.ownerHours) console.log(HOURS_NOT_SET);
	return 0;
}

/** `evf owner-queue ask`: put a PR on the queue that no route recorded, such as a parked PR. */
export function ownerQueueAsk(root: string, task: TaskRef, kind: string | undefined): number {
	if (kind !== "parked") fail("--kind must be parked.");
	const db = openWorkDb(root);
	try {
		const row = findTask(db, task);
		if (!row) fail(`${task.id} has no task row, so nothing can wait on it.`);
		if (!row.pr_number) fail(`${row.ref} has no PR number in the store, so no PR can be parked.`);
		const head = knownHead(root, row);
		ask(db, root, row, row.pr_number, head, kind);
		console.log(`owner-queue: ${row.ref} waits for Sebastian at ${head?.slice(0, 10) ?? "an unknown head"}.`);
		return 0;
	} finally {
		db.close();
	}
}

/** `evf owner-queue answer`: record an answer no other command records, such as a keep decision. */
export function ownerQueueAnswer(root: string, task: TaskRef): number {
	const db = openWorkDb(root);
	try {
		const rows = db
			.prepare("SELECT id FROM tasks WHERE ref = ? AND status NOT IN ('merged', 'abandoned') ORDER BY id DESC")
			.all(task.id) as Array<{ id: number }>;
		if (!rows.some((r) => answer(db, r.id))) fail(`${task.id} has no open owner ask, so there is nothing to answer.`);
		console.log(`owner-queue: recorded the answer for ${task.id}.`);
		return 0;
	} finally {
		db.close();
	}
}

/** `evf outside-setting approved`: Sebastian's words for a Vercel project, repo setting or integration, unchanged. */
export function outsideSettingApproved(root: string, what: string | undefined, words: string | undefined): number {
	if (process.env.EVF_RUN)
		fail("A seat cannot record an approval: the coordinator runs evf outside-setting approved from a human shell.");
	if (!what?.trim()) fail('Say what was approved: --what "<what>".');
	if (!words?.trim()) fail('Give Sebastian\'s words: --words "<his words>".');
	const db = openWorkDb(root);
	try {
		record(db, null, null, "outside_setting_approved", { what, words, at: new Date(Date.now()).toISOString() });
	} finally {
		db.close();
	}
	console.log(`outside-setting: recorded Sebastian's words for ${what}.`);
	return 0;
}
