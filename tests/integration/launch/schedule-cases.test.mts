import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { type Workspace, ok, refused, waitingOnLock } from "../../support/fixture.mts";
import { frozenClock as pinDatabaseClock } from "../../support/test-database.mts";
import { frozenClock, instant } from "../../../packages/contracts/src/common/index.ts";
import { countdown, reviewedOf, type Milestone, type Plan } from "../../../packages/contracts/src/launch/index.ts";
import { measure, within48Hours } from "../../../packages/contracts/src/followups/values.ts";
import {
	authorizeLaunchNotices,
	createLaunchReader,
	createLaunchWriter,
} from "../../../packages/domain/src/launch/index.ts";
import { createTaskWriter, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { createFacts } from "../../../packages/domain/src/intelligence/index.ts";
import { releasedRun } from "../../../packages/domain/src/intelligence/views.ts";
import { createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import { seatedNotificationService } from "../../../packages/domain/src/jobs/seated-notifications.ts";
import { launchNotices } from "../../../apps/web/src/features/launch/notices.ts";

type Json = Record<string, ReturnType<typeof JSON.parse>>;
type Case = {
	id: string;
	given: Json;
	clock: { now: string; zone: string };
	action: { operation: string; arguments: Json };
	expected: { state: Json; result: Json; event: Json | null };
	subcases?: (Omit<Case, "id" | "subcases"> & { name: string })[];
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/launch.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const inventory: {
	milestone_count: number;
	task_count: number;
	milestones: { template_key: string; task_count: number; task_titles: string[] }[];
} = JSON.parse(
	readFileSync(new URL("../../../docs/reference/launch-template-inventory.json", import.meta.url), "utf8"),
);

const CASES = [
	"B02-001",
	"B02-002",
	"B02-003",
	"B02-004",
	"B02-005",
	"B02-006",
	"CASE-LCH-001",
	"CASE-LCH-003",
	"CASE-LCH-008",
	"CASE-LCH-009",
	"LAUNCH-SEED-001",
	"CASE-LCH-002",
	"CASE-LCH-004",
	"CASE-LCH-005",
	"CASE-LCH-010",
	"B02-017",
	"B02-018",
	"LAUNCH46-014",
];
const NOW = caseOf("B02-001").clock.now;
const ZONE = caseOf("B02-001").clock.zone;
const CLOCK = frozenClock(instant.parse(new Date(NOW).toISOString()));
const HOUR = 3_600_000;
const at = (value: string | number) => new Date(value).toISOString();
let f: Awaited<ReturnType<typeof fixture>>;
let reader: ReturnType<typeof createLaunchReader>;
let writer: ReturnType<typeof createLaunchWriter>;
let tasks: ReturnType<typeof createTaskWriter>;
const facts = createFacts({ clock: CLOCK });
type Row = Record<string, unknown>;
const rows = async <R extends Row = Row>(q: SQL) => (await f.admin.execute<R>(q)).rows;
const one = async <R extends Row = Row>(q: SQL) => (await rows<R>(q))[0]!;
type Church = Awaited<ReturnType<typeof church>>;
type Who = Church["admin"];
const plan = async (who: Who) => ok(await reader.readPlan(f.db, who.actor)).plan;
const journal = async (who: Who) => ok(await reader.readJournal(f.db, who.actor)).entries;
const schedule = (who: Who, date: string, reason: string | null, expectedRevision: string, requestKey = key()) =>
	writer.schedule(f.db, who.actor, { requestKey, expectedRevision, input: { date, reason } });
const complete = (who: Who, m: Pick<Milestone, "id" | "revision" | "tasks">, requestKey = key(), reviewed?: string) =>
	writer.completeMilestone(f.db, who.actor, {
		requestKey,
		expectedRevision: m.revision,
		input: { milestoneId: m.id, reviewed: reviewed ?? reviewedOf(m.tasks) },
	});
const reopen = (who: Who, m: Milestone) =>
	writer.reopenMilestone(f.db, who.actor, {
		requestKey: key(),
		expectedRevision: m.revision,
		input: { milestoneId: m.id },
	});
const task = (who: Who, op: "edit" | "delete" | "complete" | "reopen", input: object) =>
	withTaskWrite(f.db, who.actor, (tx, ctx) => tasks[op](tx, ctx, { requestKey: key(), ...input }));
const tick = (who: Who, t: { id: string; revision: string }, op: "complete" | "reopen") =>
	task(who, op, { expectedRevision: t.revision, input: { taskId: t.id } });
const key = () => randomUUID();
const milestone = (p: Plan, templateKey: string) => p.milestones.find((m) => m.templateKey === templateKey)!;
const completions = (entries: Awaited<ReturnType<typeof journal>>, title: string) =>
	entries.filter((e) => e.change.kind === "milestone" && e.change.event === "completed" && e.change.title === title);
const evidenceLabel = (m: Milestone) => (!m.completion ? "Not complete" : m.needsReview ? "Needs review" : "Complete");
type Footprint = {
	milestones: number;
	completed: number;
	tasks: number;
	audits: number;
	notices: number;
	phase: number;
	revision: string | null;
	target: string | null;
};
const footprint = (w: { id: string }) =>
	one<Footprint>(sql`SELECT (SELECT count(*)::int FROM launch_milestone WHERE plant_id=${w.id}) milestones,
		(SELECT count(*)::int FROM launch_milestone WHERE plant_id=${w.id} AND completed_at IS NOT NULL) completed,
		(SELECT count(*)::int FROM task WHERE plant_id=${w.id}) tasks,
		(SELECT count(*)::int FROM audit_event WHERE tenant_id=${w.id}) audits,
		(SELECT count(*)::int FROM notice WHERE tenant_id=${w.id}) notices,
		(SELECT phase FROM plant WHERE id=${w.id}) phase,
		(SELECT revision::text FROM launch WHERE plant_id=${w.id}) revision,
		(SELECT target_date::text FROM launch WHERE plant_id=${w.id}) target`);
const pinned = <T,>(instant: string, body: () => Promise<T>) => pinDatabaseClock(f.admin, f.schema, instant, body);

async function seated(w: Workspace, role: "owner" | "admin" | "member", name: string) {
	const a = await f.account();
	await f.admin.execute(
		sql`UPDATE auth_user SET name=${name} WHERE id=(SELECT auth_user_id FROM account WHERE id=${a.id})`,
	);
	await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
async function church() {
	const w = await f.workspace("plant");
	await f.admin.execute(sql`UPDATE plant SET name='Harvest Point', timezone=${ZONE}, phase=1 WHERE id=${w.id}`);
	const owner = await seated(w, "owner", "Olivia Owner");
	const admin = await seated(w, "admin", "Alex Admin");
	const member = await seated(w, "member", "Mia Member");
	return { w, owner, admin, member };
}
async function foreign() {
	const q = await f.workspace("plant");
	await f.admin.execute(sql`UPDATE plant SET timezone='America/New_York' WHERE id=${q.id}`);
	return seated(q, "admin", "Casey Foreign");
}
async function scheduled(date = "2026-11-10") {
	const c = await church();
	ok(await schedule(c.admin, date, null, "1"));
	return { ...c, plan: await plan(c.admin) };
}
async function practices(w: { id: string }, n: number) {
	for (let i = 0; i < n; i++)
		await f.admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
			resolver_version,status,attendance_revision,actual_occurrence_at)
			VALUES(${key()},${w.id},'prelaunch_practice','Practice','2026-10-04','10:00',${ZONE},'2026-10-04T15:00:00Z',
			'1','completed',1,'2026-10-04T15:00:00Z')`);
}
const duplicates = (w: { id: string }) =>
	one(sql`SELECT (SELECT count(*)::int FROM (SELECT template_key FROM launch_milestone WHERE plant_id=${w.id}
		GROUP BY template_key HAVING count(*)>1) d) milestones,
		(SELECT count(*)::int FROM (SELECT launch_task_key FROM task WHERE plant_id=${w.id} AND launch_task_key IS NOT NULL
		GROUP BY launch_task_key HAVING count(*)>1) d) tasks`);
async function scrub(account: { id: string }) {
	await f.admin
		.execute(sql`UPDATE audit_event SET actor_token=coalesce(actor_token,encode(sha256(convert_to(tenant_id::text||'/'||${account.id}::text,'UTF8')),'hex')),
		actor_id=NULL,request_identity=NULL,result=NULL WHERE actor_id=${account.id}`);
	await f.admin.execute(sql`UPDATE launch_milestone SET completed_by=NULL WHERE completed_by=${account.id}`);
	await f.admin.execute(sql`DELETE FROM seat WHERE account_id=${account.id}`);
}

function window(p: Plan) {
	const cd = countdown(p.launch, p.today);
	const days = cd.kind === "today" ? 0 : cd.kind === "ahead" ? cd.days : cd.kind === "overdue" ? -cd.days : null;
	const inWindow = cd.kind === "today" || (cd.kind === "ahead" && cd.window);
	return { cd, days, inWindow };
}

before(async () => {
	f = await fixture({ clock: new Date(NOW) });
	const mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "launch@example.test",
		authorize: authorizeLaunchNotices,
		transport: {
			async send() {
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	reader = createLaunchReader(CLOCK);
	writer = createLaunchWriter({ notices: launchNotices(seatedNotificationService(mail)), clock: CLOCK });
	tasks = createTaskWriter({ reminders: async () => {} });
});
after(() => f?.close());

test("AC:B02-001 AC:CASE-LCH-008 the countdown and the launch-window criterion count church-local days: 0 and 28 qualify, 29 and overdue do not, no date is unknown", async () => {
	const b02 = caseOf("B02-001");
	const lch = caseOf("CASE-LCH-008");
	for (const id of CASES) {
		const k = caseOf(id);
		for (const step of [k, ...(k.subcases ?? [])]) assert.deepEqual(step.clock, { now: NOW, zone: ZONE }, id);
	}
	const read = async (target: string | null) => {
		const c = await church();
		if (target) ok(await schedule(c.admin, target, null, "1"));
		const before = await footprint(c.w);
		const p = await plan(c.admin);
		const seen = await plan(c.member);
		const pi = ok(await facts.readFacts(f.db, c.admin.actor));
		assert.deepEqual(await footprint(c.w), before, "reading the countdown writes nothing");
		assert.equal(p.today, "2026-10-13");
		assert.deepEqual(window(seen), window(p));
		const w = window(p);
		const criterion = pi.criteria.launch_window;
		assert.equal(pi.launch.daysToLaunch, w.days);
		assert.equal(criterion === undefined ? null : criterion === "met", target === null ? null : w.inWindow);
		return { days: w.days, in_window: w.inWindow, within: target === null ? null : w.inWindow };
	};
	const within = [];
	for (const target of b02.action.arguments.target_dates as (string | null)[]) within.push((await read(target)).within);
	assert.deepEqual(within, b02.expected.result.within_28_days);

	const main = await read(lch.given.L.planned_date);
	assert.deepEqual({ days: main.days, in_window: main.in_window }, lch.expected.result);
	for (const sub of lch.subcases!) {
		if (sub.action.operation !== "launch.readCountdown") continue;
		const r = await read(sub.given.L.planned_date);
		assert.deepEqual({ days: r.days, in_window: r.in_window }, sub.expected.result, sub.name);
	}

	const off = await scheduled();
	ok(
		await writer.postpone(f.db, off.admin.actor, {
			requestKey: key(),
			expectedRevision: "2",
			input: { reason: "Venue fell through" },
		}),
	);
	const postponed = window(await plan(off.admin));
	assert.deepEqual([postponed.cd.kind, postponed.days, postponed.inWindow], ["postponed", null, false]);
	assert.equal(ok(await facts.readFacts(f.db, off.admin.actor)).criteria.launch_window, undefined);
});

test("AC:CASE-LCH-008 a recorded zero attendance reads as a known 0, a blank count stays unknown, and a completed launch has no countdown", async () => {
	const sub = caseOf("CASE-LCH-008").subcases!.find((s) => s.name === "known-zero-attendance")!;
	assert.equal(sub.action.operation, "launch.readWorkspace");
	const L = sub.given.L;
	const counted = async (attendance: number | null) => {
		const c = await scheduled(L.planned_date);
		const p = await plan(c.admin);
		assert.equal(window(p).cd.kind, "overdue");
		ok(
			await writer.recordOutcome(f.db, c.admin.actor, {
				requestKey: key(),
				expectedRevision: p.revision,
				input: { actualDate: L.actual_date, attendance, decisions: null, note: null },
			}),
		);
		const after = await plan(c.admin);
		const member = await plan(c.member);
		assert.deepEqual(member.outcome?.attendance, after.outcome?.attendance);
		assert.equal(after.outcome!.actualDate, L.actual_date);
		assert.equal(after.launch!.targetDate, L.planned_date);
		assert.deepEqual([window(after).cd.kind, window(after).days, window(after).inWindow], ["completed", null, false]);
		return {
			actual_attendance: after.outcome!.attendance,
			attendance_known: after.outcome!.attendance !== null,
		};
	};
	assert.deepEqual(await counted(L.actual_attendance), sub.expected.result);
	assert.deepEqual(await counted(null), { actual_attendance: null, attendance_known: false });
});

test("AC:B02-002 a passed target is overdue; one reviewed move, sent twice, moves it once and writes no phase or task date", async () => {
	const k = caseOf("B02-002");
	const args = k.action.arguments;
	const c = await scheduled(args.target);
	const p = await plan(c.admin);
	const old = window(p);
	assert.equal(p.launch!.status, "scheduled");
	assert.equal(old.cd.kind, "overdue");
	const before = await footprint(c.w);
	const requestKey = key();
	const replies = [];
	for (let n = 0; n < args.repeat; n++)
		replies.push(ok(await schedule(c.admin, args.move_to, "The hall was not ready", p.revision, requestKey)));
	assert.deepEqual(
		replies.map((r) => r.outcome),
		["changed", "changed"],
	);
	const now = await plan(c.admin);
	const after = await footprint(c.w);
	const moves = (await journal(c.admin)).filter((e) => e.change.kind === "date" && e.change.event === "moved");
	assert.deepEqual(
		moves.map((e) => e.change),
		[{ kind: "date", event: "moved", from: args.target, to: args.move_to, reason: "The hall was not ready" }],
	);
	assert.deepEqual(
		{
			old_status: old.cd.kind,
			target: now.launch!.targetDate,
			phase: `Phase${after.phase}`,
			move_history_count: moves.length,
		},
		k.expected.result,
	);
	assert.deepEqual([after.audits, after.phase, after.tasks], [before.audits + 1, before.phase, before.tasks]);
	assert.deepEqual(
		await rows(sql`SELECT count(*)::int n FROM task WHERE plant_id=${c.w.id} AND due_date IS NOT NULL`),
		[{ n: 0 }],
	);
	refused(await schedule(c.admin, "2026-11-24", "Stale retry", p.revision), "conflict");
	assert.deepEqual(await footprint(c.w), after);
});

test("AC:B02-003 the 28-day launch window counts calendar days across the DST change, apart from the 72 elapsed release hours and the 48 hour contact clock", async () => {
	const k = caseOf("B02-003");
	const args = k.action.arguments;
	const c = await scheduled(args.launch_target);
	const p = await plan(c.admin);
	const w = window(p);
	const pi = ok(await facts.readFacts(f.db, c.admin.actor));
	assert.equal(pi.launch.daysToLaunch, w.days);
	assert.equal(pi.criteria.launch_window, "met");
	const elapsed = (Date.parse("2026-11-10T06:00:00Z") - Date.parse("2026-10-13T05:00:00Z")) / HOUR;
	assert.equal(elapsed, 28 * 24 + 1, "Chicago leaves daylight time inside the window");

	const run = key();
	await f.admin
		.execute(sql`INSERT INTO assessment_run(id,plant_id,as_of,phase,source_revision,formula_version,rubric_version,
		rubric_sha256,model,outcome,grounding,facts,model_input,drafts,result,attempts,input_tokens,output_tokens,demand,demand_key,
		captured_at,deadline_at,settled_at,available_at)
		VALUES(${run},${c.w.id},${args.assessment_available},1,'r','f','v1','s','m','published','grounded','{}','{}','[]','{}',1,0,0,
		'manual',${`manual/${run}`},${args.assessment_available},${args.assessment_available},${args.assessment_available},
		${args.assessment_available})`);
	const released = async (ms: number) =>
		(
			await one<{ found: boolean }>(
				sql`SELECT EXISTS(SELECT FROM ${releasedRun(sql`${c.w.id}::uuid`, sql`${new Date(ms).toISOString()}::timestamptz`)} rr) AS found`,
			)
		).found;
	const available = Date.parse(args.assessment_available);
	const releaseHours =
		(await released(available + 72 * HOUR)) && !(await released(available + 72 * HOUR - 1)) ? 72 : null;
	assert.equal(await released(Date.parse(NOW)), true);
	assert.equal(
		await released(Date.parse(NOW) - 1),
		false,
		"three calendar days early by one millisecond is not released",
	);

	const origin = instant.parse(at(args.contact_origin));
	const asOf = (ms: number) => instant.parse(new Date(ms).toISOString());
	const open = { originAt: origin, state: "open" as const, completion: null };
	assert.deepEqual(measure(open, asOf(Date.parse(NOW) - 1)), { eligible: false, success: null, reason: "immature" });
	assert.deepEqual(measure(open, asOf(Date.parse(NOW))), { eligible: true, success: false, reason: "measured" });
	const contactHours =
		within48Hours(origin, asOf(Date.parse(origin) + 48 * HOUR)) &&
		!within48Hours(origin, asOf(Date.parse(origin) + 48 * HOUR + 1))
			? 48
			: null;

	assert.deepEqual(
		{ launch_days: w.days, assessment_release_hours: releaseHours, contact_hours: contactHours },
		k.expected.result,
	);
	assert.equal(w.inWindow, true);
});

async function seededShape(c: Church) {
	const p = await plan(c.admin);
	const stored = await rows<{
		key: string;
		title: string;
		milestone: string;
	}>(sql`SELECT k.launch_task_key AS key,k.title,
		split_part(k.launch_task_key,'/',1) AS milestone FROM task k WHERE k.plant_id=${c.w.id} AND k.launch_task_key IS NOT NULL
		ORDER BY split_part(k.launch_task_key,'/',1),split_part(k.launch_task_key,'/',2)::int`);
	return { p, stored };
}

test("AC:B02-004 AC:CASE-LCH-003 the first schedule seeds the nine milestones and the 23 source tasks from the frozen inventory once; edits, deletions and ticks are kept and nothing completes itself", async () => {
	const k = caseOf("CASE-LCH-003");
	const b04 = caseOf("B02-004");
	assert.equal(k.action.arguments.seed_source, "docs/reference/launch-template-inventory.json");
	const c = await church();
	const requestKey = key();
	for (let n = 0; n < k.action.arguments.repeat; n++)
		assert.equal(ok(await schedule(c.admin, k.given.L.planned_date, null, "1", requestKey)).outcome, "changed");
	let { p, stored } = await seededShape(c);
	assert.deepEqual(
		p.milestones.map((m) => [m.templateKey, m.tasks.map((t) => t.title)]),
		inventory.milestones.map((m) => [m.template_key, m.task_titles]),
	);
	assert.equal(stored.length, inventory.task_count);
	const [T1, T2] = milestone(p, inventory.milestones[0]!.template_key).tasks;
	ok(
		await task(c.admin, "edit", {
			expectedRevision: T1!.revision,
			input: { taskId: T1!.id, patch: { title: k.given.T1.title } },
		}),
	);
	ok(await task(c.admin, "delete", { expectedRevision: T2!.revision, input: { taskId: T2!.id } }));
	for (const t of milestone(p, "launch_team.pre_launch_services").tasks) ok(await tick(c.admin, t, "complete"));
	const quiet = await footprint(c.w);
	const repeats = [];
	for (let n = 0; n < k.action.arguments.repeat; n++)
		repeats.push(ok(await writer.ensureReadiness(f.db, c.admin.actor)));
	assert.deepEqual(repeats, [
		{ milestones: 0, tasks: 0 },
		{ milestones: 0, tasks: 0 },
	]);
	assert.deepEqual(await footprint(c.w), quiet);
	({ p, stored } = await seededShape(c));
	const services = milestone(p, "launch_team.pre_launch_services");
	assert.deepEqual(
		services.tasks.map((t) => t.status),
		["complete", "complete", "complete"],
	);
	const first = milestone(p, inventory.milestones[0]!.template_key);
	assert.deepEqual(
		{
			milestone_count: p.milestones.length,
			canonical_task_identities: new Set(stored.map((r) => r.key)).size,
			task_counts: inventory.milestones.map((m) => stored.filter((r) => r.milestone === m.template_key).length),
			duplicate_rows: Object.values(await duplicates(c.w)).reduce((a, b) => Number(a) + Number(b), 0),
			T1_title: first.tasks.find((t) => t.id === T1!.id)!.title,
			T2_recreated: first.tasks.some((t) => t.title === T2!.title),
			actual_practices_from_ticks: services.practices!.held,
		},
		k.expected.result,
	);
	assert.equal(first.tasks.length, 2);

	await practices(c.w, b04.action.arguments.count_update);
	for (const m of (await plan(c.admin)).milestones)
		for (const t of m.tasks) if (t.status !== "complete") ok(await tick(c.admin, t, "complete"));
	const counted = await plan(c.admin);
	assert.equal(
		milestone(counted, "launch_team.pre_launch_services").practices!.held,
		b04.action.arguments.count_update,
	);
	assert.ok(counted.milestones.every((m) => m.tasks.every((t) => t.status === "complete")));
	const auto = await one<{ n: number }>(sql`SELECT count(*)::int n FROM audit_event WHERE tenant_id=${c.w.id}
		AND subject_type='launch_milestone' AND kind='complete'`);
	assert.deepEqual(
		{
			milestone_count: counted.milestones.length,
			task_count: (await seededShape(c)).stored.length,
			automatic_completions: counted.milestones.filter((m) => m.completion).length + auto.n,
		},
		b04.expected.result,
	);
	assert.deepEqual(b04.given["launch-inputs"].tasks.length, inventory.task_count);
	assert.deepEqual(b04.given["launch-inputs"].milestones.length, inventory.milestone_count);
});

test("AC:LAUNCH-SEED-001 repair imports the exact nine keys and 23 titles, adds only what is missing, keeps the edited task and never resurrects a deleted one", async () => {
	const k = caseOf("LAUNCH-SEED-001");
	assert.equal(k.action.arguments.repair, true);
	const c = await scheduled(k.given.L.planned_date);
	assert.deepEqual(
		inventory.milestones.map((m) => m.task_count),
		k.given.seed.task_counts,
	);
	assert.equal(inventory.milestones.length, k.given.seed.milestones);
	const full = await seededShape(c);
	assert.deepEqual(
		full.stored.map((r) => [r.key, r.title]).toSorted(),
		inventory.milestones.flatMap((m) => m.task_titles.map((t, n) => [`${m.template_key}/${n + 1}`, t])).toSorted(),
	);
	const [T1, T2] = milestone(full.p, inventory.milestones[0]!.template_key).tasks;
	ok(
		await task(c.admin, "edit", {
			expectedRevision: T1!.revision,
			input: { taskId: T1!.id, patch: { title: k.given.T1.title } },
		}),
	);
	ok(await task(c.admin, "delete", { expectedRevision: T2!.revision, input: { taskId: T2!.id } }));
	const lost = inventory.milestones[8]!.template_key;
	await f.admin.execute(sql`DELETE FROM task WHERE plant_id=${c.w.id} AND launch_task_key LIKE ${`${lost}/%`}`);
	await f.admin.execute(sql`DELETE FROM launch_milestone WHERE plant_id=${c.w.id} AND template_key=${lost}`);
	await f.admin.execute(sql`DELETE FROM task WHERE plant_id=${c.w.id} AND launch_task_key='promotion.plan/2'`);
	assert.equal(ok(await reader.readPlan(f.db, c.admin.actor)).repair, true);

	const repeats = [];
	for (let n = 0; n < k.action.arguments.repeat; n++)
		repeats.push(ok(await writer.ensureReadiness(f.db, c.admin.actor)));
	assert.deepEqual(repeats, [
		{ milestones: 1, tasks: inventory.milestones[8]!.task_count + 1 },
		{ milestones: 0, tasks: 0 },
	]);
	assert.equal(ok(await reader.readPlan(f.db, c.admin.actor)).repair, false);
	const { p, stored } = await seededShape(c);
	const first = milestone(p, inventory.milestones[0]!.template_key);
	assert.deepEqual(
		{
			milestone_count: p.milestones.length,
			canonical_task_identities: new Set(stored.map((r) => r.key)).size,
			task_counts: inventory.milestones.map((m) => stored.filter((r) => r.milestone === m.template_key).length),
			duplicate_rows: Object.values(await duplicates(c.w)).reduce((a, b) => Number(a) + Number(b), 0),
			T1_title: first.tasks.find((t) => t.id === T1!.id)!.title,
			T2_recreated: first.tasks.some((t) => t.title === T2!.title),
			actual_practices_from_ticks: milestone(p, "launch_team.pre_launch_services").practices!.held,
		},
		k.expected.result,
	);
	assert.deepEqual(
		stored.map((r) => [r.key, r.title]),
		full.stored.map((r) => [
			r.key,
			r.key === `${inventory.milestones[0]!.template_key}/1` ? k.given.T1.title : r.title,
		]),
	);
	assert.deepEqual(
		milestone(p, lost).tasks.map((t) => t.title),
		inventory.milestones[8]!.task_titles,
	);
	const repaired =
		await one(sql`SELECT metadata->>'event' AS event,after_value FROM audit_event WHERE tenant_id=${c.w.id}
		AND subject_type='launch' AND metadata->>'event'='readiness_repaired'`);
	assert.deepEqual(repaired, {
		event: "readiness_repaired",
		after_value: { milestonesSeeded: 1, tasksSeeded: inventory.milestones[8]!.task_count + 1 },
	});
});

test("AC:CASE-LCH-009 a repair that fails before commit leaves nothing; the retry, sent twice, adds the missing milestone once and keeps the completed milestone and the edited task", async () => {
	const k = caseOf("CASE-LCH-009");
	assert.equal(k.action.arguments.fault, "required_write_before_commit");
	const c = await scheduled(k.given.L.planned_date);
	const [M1, M2] = c.plan.milestones;
	const T1 = M1!.tasks[0]!;
	ok(await tick(c.admin, T1, "complete"));
	const done = ok(await complete(c.admin, milestone(await plan(c.admin), M1!.templateKey))).milestone;
	const edited = ok(
		await task(c.admin, "edit", {
			expectedRevision: (await one<{ r: string }>(sql`SELECT revision::text r FROM task WHERE id=${T1.id}`)).r,
			input: { taskId: T1.id, patch: { title: "Order the chairs", due: { kind: "local_date", date: "2026-11-01" } } },
		}),
	).task;
	await f.admin.execute(sql`DELETE FROM launch_milestone WHERE plant_id=${c.w.id} AND template_key=${M2!.templateKey}`);
	const taskRow = () => one(sql`SELECT title,due_date::text,status,revision::text FROM task WHERE id=${T1.id}`);
	const m1Row = () =>
		one(
			sql`SELECT completed_at,completed_by,completed_task_ids,revision::text FROM launch_milestone WHERE id=${M1!.id}`,
		);
	const [t0, m0, before] = [await taskRow(), await m1Row(), await footprint(c.w)];

	await assert.rejects(
		f.db.transaction(async (tx) => {
			assert.deepEqual(ok(await writer.ensureReadiness(tx, c.admin.actor)), { milestones: 1, tasks: 0 });
			throw Error(k.action.arguments.fault);
		}),
		{ message: k.action.arguments.fault },
	);
	assert.deepEqual(await footprint(c.w), before);
	assert.equal(ok(await reader.readPlan(f.db, c.admin.actor)).repair, true);

	const ids = new Set(
		(await rows<{ id: string }>(sql`SELECT id FROM launch_milestone WHERE plant_id=${c.w.id}`)).map((r) => r.id),
	);
	const repeats = [];
	for (let n = 0; n < k.action.arguments.repeat; n++)
		repeats.push(ok(await writer.ensureReadiness(f.db, c.admin.actor)));
	assert.deepEqual(repeats, [
		{ milestones: 1, tasks: 0 },
		{ milestones: 0, tasks: 0 },
	]);
	const created = await rows<{ id: string; template_key: string }>(
		sql`SELECT id,template_key FROM launch_milestone WHERE plant_id=${c.w.id} ORDER BY position`,
	);
	const after = await plan(c.admin);
	const dup = await duplicates(c.w);
	const [t1, m1] = [await taskRow(), await m1Row()];
	assert.deepEqual(
		{
			created_keys: created.filter((r) => !ids.has(r.id)).map((r) => r.template_key),
			duplicates: Number(dup.milestones) + Number(dup.tasks),
			M1_completion_reset: JSON.stringify(m1) !== JSON.stringify(m0),
			T1_edited_fields_reset: JSON.stringify(t1) !== JSON.stringify(t0),
			new_auto_completions: after.milestones.filter((m) => m.completion && m.id !== M1!.id).length,
		},
		{ ...k.expected.result, created_keys: [M2!.templateKey] },
	);
	assert.deepEqual(k.expected.result.created_keys, k.action.arguments.missing_keys);
	assert.deepEqual(milestone(after, M1!.templateKey).completion, done.completion);
	assert.equal(milestone(after, M1!.templateKey).tasks[0]!.title, edited.title);
	assert.equal(milestone(after, M2!.templateKey).tasks.length, M2!.tasks.length);
	assert.equal(after.milestones.length, 9);
});

async function priorCompletion(completedAt: string) {
	const c = await church();
	await f.admin.execute(
		sql`UPDATE seat SET accepted_at=${at(Date.parse(completedAt) - 24 * HOUR)} WHERE plant_id=${c.w.id}`,
	);
	await pinned(at(Date.parse(completedAt) - HOUR), async () => ok(await schedule(c.admin, "2026-11-10", null, "1")));
	const M1 = milestone(await plan(c.admin), "promotion.plan");
	const T1 = M1.tasks[0]!;
	ok(await pinned(at(Date.parse(completedAt) - 60_000), () => tick(c.admin, T1, "complete")));
	const ready = milestone(await plan(c.admin), "promotion.plan");
	const done = ok(await pinned(at(completedAt), () => complete(c.admin, ready))).milestone;
	return { ...c, M1: done, T1: milestone(await plan(c.admin), "promotion.plan").tasks[0]! };
}

test("AC:B02-005 AC:CASE-LCH-010 AC:CASE-LCH-004 reopening linked work makes the milestone Needs review and keeps its earlier completion, also under a scrubbed actor; reconfirming adds a new completion", async () => {
	const k = caseOf("B02-005");
	const h = caseOf("CASE-LCH-010");
	const sub = caseOf("CASE-LCH-004").subcases!.find((s) => s.name === "reopened-task-needs-review")!;
	const completedAt = k.action.arguments.completed_at;
	assert.equal(h.action.arguments.completed_at, completedAt);
	assert.equal(sub.given.M1.completed_at, completedAt);
	const c = await priorCompletion(completedAt);
	assert.equal(c.M1.completion!.at, at(completedAt));
	const before = completions(await journal(c.admin), c.M1.title);

	const reopened = ok(await tick(c.admin, c.T1, "reopen")).task;
	const m = milestone(await plan(c.admin), "promotion.plan");
	const entries = completions(await journal(c.admin), c.M1.title);
	assert.equal(reopened.status, "not_started");
	assert.deepEqual(
		{
			current_evidence: m.needsReview ? "needs_review" : "current",
			completion_history: entries.map((e) => e.at),
		},
		{ ...k.expected.result, completion_history: k.expected.result.completion_history.map(at) },
	);
	assert.deepEqual(
		{
			milestone_evidence: evidenceLabel(m),
			prior_completed_at: m.completion!.at,
			completion_history_removed: before.length - entries.length,
		},
		{ ...sub.expected.result, prior_completed_at: at(sub.expected.result.prior_completed_at) },
	);
	assert.equal((await one(sql`SELECT status FROM task WHERE id=${c.T1.id}`)).status, sub.expected.state.T1.status);
	assert.equal(m.completion!.by!.accountId, c.admin.id);

	await scrub(c.admin);
	const read = milestone(await plan(c.owner), "promotion.plan");
	const scrubbed = completions(await journal(c.owner), c.M1.title);
	assert.deepEqual(
		{ current: evidenceLabel(read), prior_completed_at: read.completion!.at },
		{ ...h.expected.result, prior_completed_at: at(h.expected.result.prior_completed_at) },
	);
	assert.equal(read.completion!.by, null);
	assert.deepEqual(
		scrubbed.map((e) => [e.at, e.actor]),
		[[at(completedAt), null]],
	);
	assert.equal(JSON.stringify(scrubbed).includes("Alex"), false);
	assert.equal(
		(
			await one(sql`SELECT actor_token IS NOT NULL AS kept FROM audit_event WHERE tenant_id=${c.w.id}
			AND subject_type='launch_milestone' AND kind='complete'`)
		).kept,
		true,
	);

	const again = ok(await complete(c.owner, read)).milestone;
	assert.deepEqual([evidenceLabel(again), again.tasks[0]!.status], ["Complete", "not_started"]);
	const history = completions(await journal(c.owner), c.M1.title);
	assert.equal(history.length, 2);
	assert.equal(history.at(-1)!.at, at(completedAt));
	assert.equal(history[0]!.actor!.accountId, c.owner.id);
});

async function openWithHistory(completedAt: string) {
	const c = await church();
	await f.admin.execute(
		sql`UPDATE seat SET accepted_at=${at(Date.parse(completedAt) - 24 * HOUR)} WHERE plant_id=${c.w.id}`,
	);
	await pinned(at(Date.parse(completedAt) - HOUR), async () => ok(await schedule(c.admin, "2026-11-10", null, "1")));
	const first = milestone(await plan(c.admin), "promotion.plan");
	const done = ok(await pinned(at(completedAt), () => complete(c.admin, first))).milestone;
	const open = ok(await pinned(at(Date.parse(completedAt) + HOUR), () => reopen(c.admin, done))).milestone;
	return { ...c, M1: open, T1: open.tasks[0]! };
}
const notices = (w: { id: string }) =>
	rows<{ recipient_id: string; purpose: string }>(sql`SELECT recipient_id,purpose FROM notice WHERE tenant_id=${w.id}`);
const auditFor = (w: { id: string }, requestKey: string) =>
	rows(sql`SELECT kind,subject_type FROM audit_event WHERE tenant_id=${w.id} AND request_key=${requestKey}`);

test("AC:B02-006 AC:CASE-LCH-004 re-confirming an open milestone with a fresh linked-task view completes it once with its task still open; the repeat is a replay and old history stays", async () => {
	for (const id of ["B02-006", "CASE-LCH-004"]) {
		const k = caseOf(id);
		const args = k.action.arguments;
		const prior = k.given.M1.history[0].completed_at;
		const c = await openWithHistory(prior);
		assert.equal(c.M1.completion, null);
		assert.deepEqual(
			c.M1.tasks.map((t) => t.status),
			["not_started", "not_started"],
		);
		assert.equal(args.reviewed_task_rows[0].status, c.T1.status);
		const sent = (await notices(c.w)).length;
		const replies = [];
		const counts = [];
		for (let n = 0; n < args.repeat; n++) {
			replies.push(ok(await complete(c.admin, c.M1, args.request_key)));
			counts.push(completions(await journal(c.admin), c.M1.title).length);
		}
		assert.deepEqual(replies[1], replies[0]);
		const p = await plan(c.admin);
		const m = milestone(p, "promotion.plan");
		const history = completions(await journal(c.admin), m.title);
		const t1 = await one<{ status: string }>(sql`SELECT status FROM task WHERE id=${c.T1.id}`);
		assert.deepEqual(
			{
				completed: m.completion !== null && !m.needsReview,
				linked_task_status: t1.status === "not_started" ? "pending" : t1.status,
				completion_count: history.length,
				replay_new_completion_count: counts[1]! - counts[0]!,
			},
			k.expected.result,
		);
		assert.deepEqual(
			{ M1: { status: m.completion ? "completed" : "open" }, T1: { status: t1.status } },
			k.expected.state,
		);
		assert.deepEqual(history.map((e) => e.at).at(-1), at(prior));
		const events = await auditFor(c.w, args.request_key);
		const added = (await notices(c.w)).slice(sent);
		assert.deepEqual(events, [{ kind: "complete", subject_type: "launch_milestone" }]);
		assert.deepEqual(
			added.map((n) => [n.recipient_id, n.purpose]),
			[[c.owner.id, "launch_milestone"]],
		);
		assert.deepEqual({ kind: "milestone_completed", subject: "M1", count: events.length }, k.expected.event);
	}
});

test("AC:B02-006 AC:CASE-LCH-004 a stale linked-task view is refused and the milestone stays open with nothing written", async () => {
	for (const id of ["B02-006", "CASE-LCH-004"]) {
		const sub = caseOf(id).subcases!.find((s) => s.name === "stale-linked-task-view")!;
		assert.equal(sub.given.T1.status, "complete");
		assert.equal(sub.action.arguments.reviewed_task_rows[0].status, "not_started");
		const c = await openWithHistory(sub.given.M1.history[0].completed_at);
		const reviewed = reviewedOf(c.M1.tasks);
		ok(await tick(c.admin, c.T1, "complete"));
		const before = await footprint(c.w);
		const stale = refused(await complete(c.admin, c.M1, key(), reviewed), "stale_review");
		const m = milestone(await plan(c.admin), "promotion.plan");
		assert.deepEqual(
			{ state: { M1: { status: m.completion ? "completed" : "open" } }, error_code: "stale_linked_task_view" },
			{ state: sub.expected.state, error_code: sub.expected.result.error_code },
		);
		assert.equal(stale.details.milestone.tasks[0].status, "complete");
		assert.deepEqual(await footprint(c.w), before);
	}
});

test("AC:CASE-LCH-004 a milestone completion waiting on its lock while a linked task reopens on another connection is refused as a stale view, and the fresh view then completes", async () => {
	const k = caseOf("CASE-LCH-004");
	const c = await openWithHistory(k.given.M1.history[0].completed_at);
	ok(await tick(c.admin, c.T1, "complete"));
	const view = milestone(await plan(c.admin), "promotion.plan");
	const T1 = view.tasks[0]!;
	const sent = await notices(c.w);
	let release!: () => void;
	const hold = new Promise<void>((resolve) => (release = resolve));
	let locked!: () => void;
	const lockTaken = new Promise<void>((resolve) => (locked = resolve));
	let pid = 0;
	const holder = f.admin.transaction(async (tx) => {
		await tx.execute(sql`SELECT id FROM launch_milestone WHERE id=${view.id} FOR UPDATE`);
		pid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
		locked();
		await hold;
	});
	await lockTaken;
	const completion = complete(c.admin, view, key());
	await waitingOnLock(f.admin, { blockedBy: pid });
	const reopened = ok(await tick(c.admin, T1, "reopen")).task;
	release();
	await holder;
	const reply = await completion;
	const m = milestone(await plan(c.admin), "promotion.plan");
	assert.equal(reopened.status, "not_started");
	assert.equal(m.tasks[0]!.status, "not_started");
	const stale = refused(reply, "stale_review");
	assert.equal(stale.details.milestone.tasks[0].status, "not_started");
	assert.deepEqual([m.completion, evidenceLabel(m)], [null, "Not complete"]);
	assert.equal(completions(await journal(c.admin), m.title).length, 1);
	assert.deepEqual(await notices(c.w), sent);
	const fresh = ok(await complete(c.admin, m)).milestone;
	assert.deepEqual([evidenceLabel(fresh), fresh.tasks[0]!.status], ["Complete", "not_started"]);
	assert.equal(completions(await journal(c.admin), m.title).length, 2);
});

test("AC:CASE-LCH-004 AC:LAUNCH46-014 Guest data entered and Debrief done follow the submitted debrief; a manual checkbox is refused with nothing written while other milestones stay editable", async () => {
	const k = caseOf("LAUNCH46-014");
	const subs = caseOf("CASE-LCH-004").subcases!.filter((s) => s.name.endsWith("-cannot-be-checkbox-override"));
	assert.equal(subs.length, 2);
	const c = await scheduled("2026-10-11");
	let p = await plan(c.admin);
	ok(
		await writer.recordOutcome(f.db, c.admin.actor, {
			requestKey: key(),
			expectedRevision: p.revision,
			input: { actualDate: "2026-10-11", attendance: 40, decisions: 2, note: null },
		}),
	);
	p = ok(
		await writer.submitDebrief(f.db, c.admin.actor, {
			requestKey: key(),
			expectedRevision: "0",
			input: {
				draftId: null,
				answers: {
					wentWell: "Welcome",
					toChange: "Parking",
					operations: "Smooth",
					followUpPlan: "Calls",
					supportNeeded: "None",
					missingNames: "yes",
					missingCount: 3,
				},
			},
		}),
	).plan;
	const state = {
		guest_milestone: p.evidence.guestNamesEntered.status,
		debrief_milestone: p.evidence.debriefDone.status,
	};
	const before = await footprint(c.w);
	const ids = { guests: "guest_data_entered", debrief: "debrief_done" } as const;
	let code = "";
	for (const sub of subs) {
		const id = ids[sub.given[sub.action.arguments.milestone].kind as keyof typeof ids];
		const r = refused(
			await writer.completeMilestone(f.db, c.admin.actor, {
				requestKey: key(),
				expectedRevision: "1",
				input: { milestoneId: id, reviewed: "" },
			}),
			"derived_evidence_only",
		);
		refused(
			await writer.reopenMilestone(f.db, c.admin.actor, {
				requestKey: key(),
				expectedRevision: "1",
				input: { milestoneId: id },
			}),
			"derived_evidence_only",
		);
		code = r.code;
		const after = await footprint(c.w);
		assert.deepEqual((await plan(c.admin)).evidence, p.evidence);
		assert.deepEqual(
			{
				error_code: code === "derived_evidence_only" ? "derived_milestone_override_denied" : code,
				completed: after.completed !== before.completed,
				completion_events_added: after.audits - before.audits,
			},
			sub.expected.result,
			sub.name,
		);
	}
	assert.deepEqual(await footprint(c.w), before);
	assert.deepEqual({ ...state, manual_override_error: code }, k.expected.result);
	assert.deepEqual((await plan(c.admin)).evidence, p.evidence);
	const other = milestone(await plan(c.admin), "promotion.plan");
	assert.equal(ok(await complete(c.admin, other)).outcome, "changed");
	assert.equal((await footprint(c.w)).phase, before.phase);
});

test("AC:CASE-LCH-005 a Member completes the Task assigned to them and nothing else; progress follows live tasks and keeps the earlier milestone completion", async () => {
	const k = caseOf("CASE-LCH-005");
	assert.equal(k.action.arguments.caller_role, "Member");
	const c = await scheduled(k.given.L.planned_date);
	const B = await foreign();
	const m0 = milestone(c.plan, "launch_team.ministry_training");
	const done = ok(await complete(c.admin, m0)).milestone;
	const [t1, t2, t3] = done.tasks;
	const T1 = ok(
		await task(c.admin, "edit", {
			expectedRevision: t1!.revision,
			input: { taskId: t1!.id, patch: { assigneeIds: [c.member.id] } },
		}),
	).task;
	const T2 = ok(
		await task(c.admin, "edit", {
			expectedRevision: t2!.revision,
			input: { taskId: t2!.id, patch: { assigneeIds: [c.admin.id] } },
		}),
	).task;
	const before = await footprint(c.w);
	refused(await tick(B, T1, "complete"));
	const other = await tick(c.member, T2, "complete");
	const otherAllowed = other.status === "ok";
	assert.equal(otherAllowed, false);
	refused(await complete(c.member, milestone(await plan(c.member), m0.templateKey)), "access_denied");
	assert.deepEqual(await footprint(c.w), before);
	const mine = await tick(c.member, T1, "complete");
	const history0 = completions(await journal(c.admin), done.title).length;

	ok(await tick(c.admin, T2, "complete"));
	ok(await task(c.admin, "delete", { expectedRevision: t3!.revision, input: { taskId: t3!.id } }));
	let m = milestone(await plan(c.admin), m0.templateKey);
	assert.deepEqual(
		m.tasks.map((t) => [t.title, t.status]),
		[
			[t1!.title, "complete"],
			[t2!.title, "complete"],
		],
	);
	const fresh = m.tasks.find((t) => t.id === T1.id)!;
	ok(await tick(c.member, fresh, "reopen"));
	m = milestone(await plan(c.admin), m0.templateKey);
	assert.deepEqual(
		m.tasks.map((t) => t.status),
		["not_started", "complete"],
	);
	assert.deepEqual(m.completion, done.completion);
	const history = completions(await journal(c.admin), done.title).length;
	assert.deepEqual(
		{
			T1_complete_allowed: mine.status === "ok",
			T2_complete_allowed: otherAllowed,
			history_removed: history0 - history,
			milestone_manual_bypass: (await footprint(c.w)).completed !== before.completed,
		},
		k.expected.result,
	);
});

test("AC:CASE-LCH-001 a stale reviewed state refuses a move with nothing changed; a repeated receipt replays; moves, postponement and recommitment keep the edited task date and the phase", async () => {
	const k = caseOf("CASE-LCH-001");
	const args = k.action.arguments;
	const c = await church();
	const first = key();
	ok(await schedule(c.admin, args.planned_date, null, "1", first));
	const seeded = await footprint(c.w);
	assert.equal(ok(await schedule(c.admin, args.planned_date, null, "1", first)).outcome, "changed");
	assert.deepEqual(await footprint(c.w), seeded);
	const p = await plan(c.admin);
	const t = milestone(p, "promotion.plan").tasks[0]!;
	ok(
		await task(c.admin, "edit", {
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { due: { kind: "local_date", date: args.edited_task_due_date } } },
		}),
	);
	const due = () => one<{ due: string }>(sql`SELECT due_date::text due FROM task WHERE id=${t.id}`);
	const before = await footprint(c.w);
	const stale = await schedule(c.admin, args.new_date, "Gym booked", "1");
	const after = await footprint(c.w);
	assert.deepEqual(
		{
			error_code: stale.status === "refused" && stale.error.code === "conflict" ? "revision_conflict" : stale.status,
			launch_changes: after.audits - before.audits + (after.revision === before.revision ? 0 : 1),
			task_due_date: (await due()).due,
			phase_changes: after.phase === before.phase ? 0 : 1,
		},
		k.expected.result,
	);
	assert.deepEqual(after, before);

	const moved = ok(await schedule(c.admin, args.new_date, "Gym booked", p.revision));
	assert.deepEqual(moved.plan.launch, { status: "scheduled", targetDate: args.new_date, revision: "3" });
	const off = ok(
		await writer.postpone(f.db, c.admin.actor, {
			requestKey: key(),
			expectedRevision: "3",
			input: { reason: "Pastor ill" },
		}),
	);
	assert.deepEqual(off.plan.launch, { status: "postponed", targetDate: null, revision: "4" });
	const back = ok(await schedule(c.admin, "2026-12-06", null, "4"));
	assert.deepEqual(back.plan.launch, { status: "scheduled", targetDate: "2026-12-06", revision: "5" });
	assert.equal((await due()).due, args.edited_task_due_date);
	const end = await footprint(c.w);
	assert.deepEqual([end.phase, end.milestones, end.tasks], [before.phase, before.milestones, before.tasks]);
	assert.deepEqual(
		(await journal(c.admin)).filter((e) => e.change.kind === "date").map((e) => "event" in e.change && e.change.event),
		["rescheduled", "postponed", "moved", "scheduled"],
	);
});

test("AC:CASE-LCH-002 the journal keeps both date events with minimal attribution after the actor's account is deleted, and a foreign church reads none of it", async () => {
	const k = caseOf("CASE-LCH-002");
	const args = k.action.arguments;
	const c = await church();
	const [first, second] = args.events as { date: string }[];
	ok(await schedule(c.admin, first!.date, null, "1"));
	ok(await schedule(c.admin, second!.date, "Gym booked", "2"));
	const named = (await journal(c.admin)).filter((e) => e.change.kind === "date");
	assert.deepEqual(
		named.map((e) => e.actor),
		[
			{ accountId: c.admin.id, displayName: "Alex Admin" },
			{ accountId: c.admin.id, displayName: "Alex Admin" },
		],
	);
	await scrub(c.admin);
	const entries = (await journal(c.owner)).filter((e) => e.change.kind === "date").toReversed();
	const B = await foreign();
	const theirs = await reader.readJournal(f.db, B.actor);
	const ids = new Set(entries.map((e) => e.id));
	const leaked = theirs.status === "ok" ? theirs.value.entries.filter((e) => ids.has(e.id)) : [];
	const tokens = await rows<{ token: string | null }>(sql`SELECT actor_token AS token FROM audit_event
		WHERE tenant_id=${c.w.id} AND subject_type='launch'`);
	assert.deepEqual(
		{
			event_dates: entries.map((e) => (e.change.kind === "date" ? e.change.to : null)),
			actor_account: entries.find((e) => e.actor)?.actor ?? null,
			minimal_attribution_retained: tokens.length === 2 && tokens.every((r) => typeof r.token === "string"),
			foreign_journal: leaked.length ? leaked : null,
		},
		k.expected.result,
	);
	assert.deepEqual(
		entries.map((e) => e.at),
		named.map((e) => e.at).toReversed(),
	);
	const text = JSON.stringify(entries);
	assert.equal(text.includes("Alex"), false);
	assert.equal(text.includes(c.admin.email), false);
	refused(await reader.readJournal(f.db, c.member.actor), "access_denied");
});

test("AC:B02-017 AC:B02-018 promotion is met only by the human attestation that the chosen plan ran, with no channel required; one sent email and a ticked prep task stay unknown", async () => {
	const attested = caseOf("B02-017");
	const partial = caseOf("B02-018");
	const criterion = (m: Milestone) => (m.completion && !m.needsReview ? "met" : "unknown");
	const a = await scheduled();
	const chosen = ok(await complete(a.admin, milestone(a.plan, "promotion.plan"))).milestone;
	assert.ok(chosen.completion);
	const ran = milestone(await plan(a.admin), "promotion.implemented");
	const done = ok(await complete(a.admin, ran)).milestone;
	assert.deepEqual(
		{
			promotion_criterion: criterion(done),
			required_channels: done.tasks.filter((t) => t.status === "complete").map((t) => t.title),
		},
		attested.expected.result,
	);
	assert.deepEqual(
		done.tasks.map((t) => t.status),
		["not_started", "not_started", "not_started"],
	);
	assert.deepEqual(attested.given["launch-inputs"].reference_ids, []);

	const b = await scheduled();
	ok(await complete(b.admin, milestone(b.plan, "promotion.plan")));
	const blast = milestone(b.plan, "promotion.implemented").tasks.find(
		(t) => t.title === "Run the email blast and social posts",
	)!;
	assert.equal(partial.given["launch-inputs"].email_sent, 1);
	ok(await tick(b.admin, blast, "complete"));
	const now = milestone(await plan(b.admin), "promotion.implemented");
	assert.deepEqual(
		now.tasks.map((t) => t.status),
		["not_started", "complete", "not_started"],
	);
	assert.deepEqual({ promotion_criterion: criterion(now) }, partial.expected.result);
	assert.equal(now.completion, null);
	assert.equal(partial.given["launch-inputs"].execution_attestation, null);
});
