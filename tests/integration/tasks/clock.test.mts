import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import {
	frozenClock,
	instant,
	localDate,
	localDayBounds,
	localDateTime,
	owner as ownerOf,
	resolveCalendar,
	timeZone,
} from "../../../packages/contracts/src/common/index.ts";
import { createTaskWriter } from "../../../packages/domain/src/tasks/index.ts";
import { timezoneOperations } from "../../../packages/domain/src/settings/index.ts";
import { enqueueJob } from "../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { ok, refused } from "../../support/fixture.mts";
import { recorded, untouched } from "../../support/recorded.mts";
import { clockedWorld, failingWrite, raced, rejectsWithFault } from "./world.mts";

const NOW = "2026-10-13T16:00:00Z";
const CHICAGO = timeZone.parse("America/Chicago");
type World = Awaited<ReturnType<typeof clockedWorld>>;
type Task = Awaited<ReturnType<World["create"]>>;
let w: World;
before(async () => {
	w = await clockedWorld("task_clock", "2024-01-01T12:00:00Z");
});
after(() => w?.close());

const day = (date: string) => ({ kind: "local_date", date });
const get = async (taskId: string, asOf?: string) => {
	const found = ok(await w.read(w.adminActor, "get", { taskId, ...(asOf ? { asOf } : {}) }));
	if (found.status !== "available") assert.fail(found.status);
	return found.task!;
};
const overdue = async (taskId: string, asOf: string) => {
	const listed = ok(await w.read(w.adminActor, "list", { asOf, limit: 100 })).items.find((t) => t.id === taskId);
	const value = (await get(taskId, asOf)).overdue;
	assert.equal(listed!.overdue, value);
	return value;
};
async function occurrence(due: object, frequency: string, until: string | null = null) {
	const created = await w.create(w.adminActor, { title: "Pay rent", due });
	const task = ok(await w.command(w.adminActor, "configureRecurrence", created, { rule: { frequency, until } })).task;
	const child = ok(
		await w.write(w.adminActor, "createSubtask", {
			requestKey: randomUUID(),
			expectedRevision: task.revision,
			input: { parentId: task.id, title: "Call venue" },
		}),
	).task;
	ok(
		await w.write(w.adminActor, "setSubtaskCompletion", {
			requestKey: randomUUID(),
			expectedRevision: child.revision,
			input: { parentId: task.id, taskId: child.id, complete: true },
		}),
	);
	return { task, child: child.id };
}
const completion = (t: Pick<Task, "id" | "revision">, requestKey: string = randomUUID()) =>
	w.write(w.adminActor, "completeOccurrence", {
		requestKey,
		expectedRevision: t.revision,
		input: { taskId: t.id },
	});
const series = async (task: { id: string }) => ({
	successors: (
		await w.rows<{ due: string | null }>(sql`SELECT due_date::text AS due FROM task WHERE predecessor_id=${task.id}`)
	).map((t) => t.due),
	open: (
		await w.rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM task WHERE deleted_at IS NULL
			AND series_id=(SELECT series_id FROM task WHERE id=${task.id}) AND status NOT IN ('complete','no_longer_needed')`)
	)[0]!.n,
	completions: (
		await w.rows<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${task.id} AND action='tasks.completed'`,
		)
	)[0]!.n,
});

test("AC:TARGET-TSK-007 completing an occurrence adds exactly one next task on the rule's date with a fresh checklist, and a retry adds nothing", async () => {
	type Case = {
		on: string;
		due: object;
		frequency: string;
		until?: string;
		next: string | null;
		overdue?: boolean;
	};
	const cases: Case[] = [
		{ on: "2024-02-29", due: day("2024-02-29"), frequency: "yearly", next: "2025-02-28" },
		{ on: "2026-01-20", due: day("2026-01-01"), frequency: "weekly", next: "2026-01-08", overdue: true },
		{ on: "2026-01-20", due: { kind: "undated" }, frequency: "weekly", next: "2026-01-27" },
		{ on: "2026-01-31", due: day("2026-01-31"), frequency: "monthly", next: "2026-02-28" },
		{ on: "2026-01-31", due: day("2026-01-31"), frequency: "monthly", until: "2026-02-28", next: "2026-02-28" },
		{ on: "2026-01-31", due: day("2026-01-31"), frequency: "monthly", until: "2026-02-27", next: null },
	];
	for (const c of cases) {
		const label = JSON.stringify(c);
		await w.at(`${c.on}T16:00:00Z`);
		const { task, child } = await occurrence(c.due, c.frequency, c.until);
		const kept = await w.rows(sql`SELECT to_jsonb(t) AS row FROM task t WHERE id=${child}`);
		const requestKey = randomUUID();
		const { value, added } = await recorded(w.admin, async () => ok(await completion(task, requestKey)));
		const created = c.next === null ? [] : ["tasks.changed", "tasks.changed"];
		assert.deepEqual(added, { audits: [...created, "tasks.completed"], jobs: [], notices: 0, mail: 0 }, label);
		assert.deepEqual(
			[value.outcome, value.task.status, value.task.completedAt],
			["changed", "complete", `${c.on}T16:00:00.000Z`],
		);
		assert.deepEqual(
			await series(task),
			{ successors: c.next === null ? [] : [c.next], open: c.next === null ? 0 : 1, completions: 1 },
			label,
		);
		if (c.next === null) assert.equal(value.successor, null, label);
		else {
			assert.deepEqual(
				[value.successor!.due, value.successor!.status, value.successor!.occurrenceId, value.successor!.overdue],
				[day(c.next), "not_started", "2", c.overdue ?? false],
				label,
			);
			const next = await get(value.successor!.id);
			assert.deepEqual(
				next.checklistItems.map((k) => [k.title, k.status, k.assignees]),
				[["Call venue", "not_started", []]],
				label,
			);
			assert.deepEqual(
				await w.rows(
					sql`SELECT due_kind,completed_at,obligation_id,series_id,person_id FROM task WHERE parent_id=${next.id}`,
				),
				[{ due_kind: "undated", completed_at: null, obligation_id: null, series_id: null, person_id: null }],
				label,
			);
		}
		assert.deepEqual(await w.rows(sql`SELECT to_jsonb(t) AS row FROM task t WHERE id=${child}`), kept, label);
		assert.deepEqual(await untouched(w.admin, async () => ok(await completion(task, requestKey))), value, label);
		refused(await untouched(w.admin, () => completion(task)), "conflict");
	}
});

test("AC:TARGET-TSK-007 a failed checklist copy completes nothing, two completions at once leave one, and an older occurrence stays closed beside an open one", async () => {
	await w.at("2026-01-31T16:00:00Z");
	const failing = await occurrence(day("2026-01-31"), "monthly");
	const requestKey = randomUUID();
	await untouched(w.admin, () =>
		failingWrite(
			w.admin,
			{ on: "task", event: "INSERT", when: "NEW.parent_id IS NOT NULL AND NEW.title='Call venue'" },
			() => rejectsWithFault(completion(failing.task, requestKey)),
		),
	);
	assert.equal((await get(failing.task.id)).status, "not_started");
	assert.deepEqual(await series(failing.task), { successors: [], open: 1, completions: 0 });
	const recovered = ok(await completion(failing.task, requestKey));
	assert.deepEqual(
		recovered.successor!.checklistItems.map((k) => k.title),
		["Call venue"],
	);
	assert.deepEqual(await series(failing.task), { successors: ["2026-02-28"], open: 1, completions: 1 });

	for (const sameRequest of [true, false]) {
		const { task } = await occurrence(day("2026-01-31"), "monthly");
		const keys = [randomUUID(), randomUUID()];
		const answers = await raced(
			w.admin,
			w.db,
			sql`SELECT FROM task WHERE id=${task.id} FOR UPDATE`,
			keys.map((key) => () => completion(task, sameRequest ? keys[0] : key)),
		);
		assert.equal(answers[0]!.status, "ok");
		if (sameRequest) assert.deepEqual(answers[1], answers[0]);
		else refused(answers[1], "conflict");
		assert.deepEqual(await series(task), { successors: ["2026-02-28"], open: 1, completions: 1 });
	}

	const { successor, task: closed } = recovered;
	const reopen = () => w.command(w.adminActor, "reopen", closed);
	assert.deepEqual(refused(await untouched(w.admin, reopen), "open_successor").details, { successorId: successor!.id });
	assert.equal((await get(successor!.id)).status, "not_started");
	ok(await w.command(w.adminActor, "delete", successor!));
	assert.equal(ok(await reopen()).task.status, "not_started");
});

test("AC:TARGET-TSK-008 bulk complete answers for every row, a fault at commit finishes none, the same request then finishes them and a lost reply repeats nothing", async () => {
	await w.at(NOW);
	const foreign = await w.seated(await w.plantOf(), "owner");
	const mine = { assigneeIds: [w.member.id] };
	const [t1, t2, boom] = [
		await w.create(w.adminActor, { title: "T1", ...mine }),
		await w.create(w.adminActor, { title: "T2", ...mine }),
		await w.create(w.adminActor, { title: "Boom", ...mine }),
	];
	const t3 = ok(
		await w.command(w.adminActor, "configureRecurrence", await w.create(w.adminActor, { title: "T3", ...mine }), {
			rule: { frequency: "weekly", until: null },
		}),
	).task;
	const waived = ok(
		await w.command(w.adminActor, "waive", await w.create(w.adminActor, { title: "Waived", ...mine })),
	).task;
	const others = await w.create(w.adminActor, { title: "Others" });
	const changed = await w.create(w.adminActor, { title: "Changed", ...mine });
	ok(await w.command(w.adminActor, "edit", changed, { patch: { title: "Changed again" } }));
	const theirs = await w.create(foreign, { title: "Theirs" });
	const missing = { id: randomUUID(), revision: "1" };
	const request = {
		requestKey: randomUUID(),
		items: [t1, t2, t3, t3, waived, changed, theirs, missing, others, boom].map((t) => ({
			taskId: t.id,
			expectedRevision: t.revision,
		})),
	};
	const bulk = () => w.write(w.adminActor, "bulkComplete", request);
	await untouched(w.admin, () =>
		failingWrite(
			w.admin,
			{ on: "task", event: "UPDATE", when: "NEW.title='Boom' AND NEW.status='complete'", atCommit: true },
			() => rejectsWithFault(bulk()),
		),
	);
	const names = new Map<string, string>(
		Object.entries({ t1, t2, t3, waived, changed, theirs, missing, others, boom }).map(([name, t]) => [t.id, name]),
	);
	const { value, added } = await recorded(w.admin, async () => ok(await bulk()));
	assert.deepEqual(
		value.items.map((i) => [names.get(i.taskId), i.outcome]),
		[
			["t1", "changed"],
			["t2", "changed"],
			["t3", "changed"],
			["waived", "closed"],
			["changed", "stale"],
			["theirs", "not_found"],
			["missing", "not_found"],
			["others", "changed"],
			["boom", "changed"],
		],
	);
	assert.deepEqual([value.changed, value.remaining], [5, [changed.id]]);
	assert.deepEqual(added, {
		audits: ["tasks.changed", ...Array<string>(5).fill("tasks.completed")],
		jobs: ["mail", "mail"],
		notices: 2,
		mail: 2,
	});
	assert.deepEqual(
		await w.rows(sql`SELECT subject_id, count(*)::int AS n FROM audit_event WHERE action='tasks.completed'
			AND subject_id IN (${t1.id},${t2.id},${t3.id},${others.id},${boom.id}) GROUP BY 1 HAVING count(*)<>1`),
		[],
	);
	const next = value.items.find((i) => i.taskId === t3.id)!.successor!;
	assert.deepEqual(next.due, day("2026-10-20"));
	assert.deepEqual(await w.reminders(next.id), [
		[w.member.id, "task_due", "2026-10-20T14:00:00Z", "pending"],
		[w.member.id, "task_overdue", "2026-10-21T14:00:00Z", "pending"],
	]);
	const statuses = async () =>
		Object.fromEntries(
			(
				await w.rows(
					sql`SELECT id, status FROM task WHERE id IN (${sql.join(
						[...names.keys()].map((id) => sql`${id}`),
						sql`,`,
					)})`,
				)
			).map((t) => [names.get(String(t.id)), t.status]),
		);
	assert.deepEqual(await statuses(), {
		t1: "complete",
		t2: "complete",
		t3: "complete",
		boom: "complete",
		others: "complete",
		waived: "no_longer_needed",
		changed: "not_started",
		theirs: "not_started",
	});
	assert.deepEqual(await untouched(w.admin, async () => ok(await bulk())), value);
	assert.deepEqual((await series(t3)).successors, ["2026-10-20"]);

	const reschedule = (date: string) =>
		w.write(w.adminActor, "bulkReschedule", {
			requestKey: randomUUID(),
			items: [{ taskId: changed.id, expectedRevision: "2" }],
			due: day(date),
		});
	refused(await untouched(w.admin, () => reschedule("2026-02-30")), "invalid_input");
	const kept = await w.rows(sql`SELECT to_jsonb(t) AS row FROM task t WHERE id<>${changed.id} ORDER BY id`);
	assert.deepEqual(
		ok(await reschedule("2026-11-28")).items.map((i) => i.outcome),
		["changed"],
	);
	assert.deepEqual((await get(changed.id)).due, day("2026-11-28"));
	assert.deepEqual(await w.rows(sql`SELECT to_jsonb(t) AS row FROM task t WHERE id<>${changed.id} ORDER BY id`), kept);
});

test("AC:TARGET-TSK-009 an import takes the chosen items at their catalog offsets, its retry adds no second set, a new import does and neither touches edited tasks", async () => {
	await w.at(NOW);
	const keep = await w.create(w.adminActor, { title: "Draft" });
	const edited = ok(await w.command(w.adminActor, "edit", keep, { patch: { title: "Keep my edits" } })).task;
	const importing = (
		itemKeys: readonly string[],
		requestKey: string = randomUUID(),
		catalogVersion = 3,
		writer?: Parameters<World["write"]>[3],
	) =>
		w.write(
			w.adminActor,
			"importTemplate",
			{ requestKey, input: { catalogVersion, checklistKey: "vision-meeting-preparation", itemKeys } },
			writer,
		);
	const chosen = ["set-date", "invite-list", "prepare-talk"];
	const expected = [
		["Set the vision meeting date and time", "high", day("2026-10-13")],
		["Write the invitation list", "high", day("2026-10-15")],
		["Prepare the vision talk", "medium", day("2026-10-23")],
	];
	refused(await untouched(w.admin, () => importing(chosen, randomUUID(), 2)), "stale_catalog");
	refused(await untouched(w.admin, () => importing([...chosen, "no-such-item"])), "invalid_input");
	const receipts = async () =>
		(
			await w.rows<{ n: number }>(
				sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_type='checklist_import' AND tenant_id=${w.plant.id}`,
			)
		)[0]!.n;
	const shape = (tasks: readonly { title: string; priority: string; due: unknown }[]) =>
		tasks.map((t) => [t.title, t.priority, t.due]);
	const requestKey = randomUUID();
	const first = await recorded(w.admin, async () => ok(await importing(chosen, requestKey)));
	assert.deepEqual(shape(first.value.tasks), expected);
	assert.deepEqual(first.added, {
		audits: Array<string>(4).fill("tasks.changed"),
		jobs: Array<string>(5).fill("mail"),
		notices: 5,
		mail: 5,
	});
	assert.equal(await receipts(), 1);
	assert.deepEqual(await untouched(w.admin, async () => ok(await importing(chosen, requestKey))), first.value);
	refused(await untouched(w.admin, () => importing(chosen.slice(1), requestKey)), "conflict");
	assert.equal(await receipts(), 1);

	const talk = first.value.tasks[2]!;
	ok(await w.command(w.adminActor, "edit", talk, { patch: { title: "Keep my edits" } }));
	const before = await w.rows(sql`SELECT to_jsonb(t) AS row FROM task t ORDER BY id`);
	const again = ok(await importing(chosen));
	assert.deepEqual(shape(again.tasks), expected);
	assert.equal(await receipts(), 2);
	const ids = new Set([...first.value.tasks, edited].map((t) => t.id));
	assert.equal(
		again.tasks.some((t) => ids.has(t.id)),
		false,
	);
	const added = again.tasks.map((t): string => t.id);
	const after = await w.rows<{ row: { id: string } }>(sql`SELECT to_jsonb(t) AS row FROM task t ORDER BY id`);
	assert.deepEqual(
		after.filter((t) => !added.includes(t.row.id)),
		before,
	);
	assert.deepEqual([(await get(edited.id)).title, (await get(talk.id)).title], ["Keep my edits", "Keep my edits"]);

	const typed =
		"First line\r\nsecond line\n\n\n\n- bring keys\n[bad](javascript:alert(1)) [map](https://example.org/map)";
	const { CATALOG } = await import("../../../packages/domain/src/tasks/index.ts");
	const custom = createTaskWriter({
		reminders: async () => {},
		catalog: {
			version: 3,
			checklists: CATALOG.checklists.map((k) => ({ ...k, items: k.items.map((i) => ({ ...i, description: typed })) })),
		},
	});
	const plain = ok(await importing(["set-date"], randomUUID(), 3, custom)).tasks[0]!;
	assert.equal(
		(await get(plain.id)).description,
		"First line\nsecond line\n\n- bring keys\nbad [map](https://example.org/map)",
	);
});

test("AC:B03-001 a date-only task is due through its whole church day and overdue at the next local midnight, on ordinary and clock-change days and whatever zone the process runs in", async () => {
	await w.at(NOW);
	const t = await w.create(w.adminActor, { due: day("2026-10-13") });
	const bounds: [string, string, boolean][] = [
		[t.id, "2026-10-13T16:00:00Z", false],
		[t.id, "2026-10-14T03:00:00Z", false],
		[t.id, "2026-10-14T04:59:59.999Z", false],
		[t.id, "2026-10-14T05:00:00Z", true],
	];
	for (const [date, last, next] of [
		["2026-03-08", "2026-03-09T04:59:59.999Z", "2026-03-09T05:00:00Z"],
		["2026-11-01", "2026-11-02T05:59:59.999Z", "2026-11-02T06:00:00Z"],
	] as const) {
		const shifted = await w.create(w.adminActor, { due: day(date) });
		bounds.push([shifted.id, last, false], [shifted.id, next, true]);
	}
	const host = process.env.TZ;
	try {
		for (const zone of ["UTC", "Pacific/Auckland", "America/Los_Angeles"]) {
			process.env.TZ = zone;
			assert.equal(
				new Date("2026-10-14T03:00:00Z").getDate(),
				{ UTC: 14, "Pacific/Auckland": 14, "America/Los_Angeles": 13 }[zone],
			);
			assert.deepEqual(
				await untouched(w.admin, async () => {
					const answers = [];
					for (const [id, asOf] of bounds) answers.push([id, asOf, await overdue(id, asOf)]);
					return answers;
				}),
				bounds,
				zone,
			);
		}
	} finally {
		if (host === undefined) delete process.env.TZ;
		else process.env.TZ = host;
	}
	assert.deepEqual((await get(t.id)).due, day("2026-10-13"));
});

test("AC:B03-003 a timed deadline turns overdue after its own instant, whether its due notice goes out early, late or on time", async () => {
	await w.at(NOW);
	const deadline = { kind: "resolved_instant", local: "2026-10-13T13:00:00" };
	const stored = {
		kind: "resolved_instant",
		local: "2026-10-13T13:00:00",
		zone: "America/Chicago",
		instant: "2026-10-13T18:00:00.000Z",
		offsetSeconds: -18000,
	};
	const timed = (title: string) => w.create(w.adminActor, { title, assigneeIds: [w.member.id], due: deadline });
	const [early, late] = [await timed("Early notice"), await timed("Late notice")];
	const due = [w.member.id, "task_due", "2026-10-13T18:00:00Z"];
	const later = [w.member.id, "task_overdue", "2026-10-14T18:00:00Z"];
	for (const t of [early, late])
		assert.deepEqual(await w.reminders(t.id), [
			[...due, "pending"],
			[...later, "pending"],
		]);
	const states = async (t: Task) => [
		await overdue(t.id, "2026-10-13T17:59:59Z"),
		await overdue(t.id, "2026-10-13T18:00:01Z"),
	];
	const sent = w.sent.length;
	await w.dispatch();
	assert.equal(w.sent.length, sent);

	await w.admin.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE id=(SELECT m.job_id FROM mail m
			JOIN notice n ON n.id=m.notice_id WHERE n.source_record_id=${early.id} AND n.logical_key LIKE '%/task_due/%')`,
	);
	await w.dispatch();
	assert.deepEqual(
		w.sent.slice(sent).map((m) => [m.to, m.subject]),
		[[w.member.email, "Task due: Early notice"]],
	);
	await w.at("2026-10-13T17:59:59Z");
	assert.deepEqual([(await get(early.id)).overdue, (await get(late.id)).overdue], [false, false]);
	assert.deepEqual(await states(early), [false, true]);

	await w.at("2026-10-13T18:00:01Z");
	assert.deepEqual([(await get(early.id)).overdue, (await get(late.id)).overdue], [true, true]);
	assert.deepEqual((await w.reminders(late.id))[0], [...due, "pending"]);
	await w.at("2026-10-13T20:00:00Z");
	await w.dispatch();
	assert.deepEqual(
		w.sent.slice(sent).map((m) => m.subject),
		["Task due: Early notice", "Task due: Late notice"],
	);
	for (const t of [early, late]) {
		assert.deepEqual(await w.reminders(t.id), [
			[...due, "accepted"],
			[...later, "pending"],
		]);
		assert.deepEqual(await states(t), [false, true]);
		const read = await get(t.id);
		assert.deepEqual([read.due, read.revision], [stored, "1"]);
	}
});

async function changeZone(zone: string) {
	const selected = ownerOf.parse(w.plant);
	assert.ok(selected.kind === "plant");
	const asOf = instant.parse(new Date().toISOString());
	const zones = timezoneOperations(
		{
			replan: (tx, i) =>
				enqueueJob(tx, {
					tenant: i.owner.id,
					kind: "digest",
					subject: i.owner.id,
					key: `settings/${i.kind}/${i.operationId}`,
					revision: i.revision,
					eligibleAt: asOf,
				}),
		},
		undefined,
		frozenClock(asOf),
	);
	const ctx = { session: w.adminActor.session, selected };
	const preview = ok(
		await gatedTransaction(w.db, (tx) =>
			zones.previewPlantTimezone(tx, ctx, { plant: selected, timeZone: timeZone.parse(zone) }),
		),
	);
	const changed = ok(
		await gatedTransaction(w.db, (tx) =>
			zones.setPlantTimezone(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: preview.expectedRevision,
				input: { plant: selected, timeZone: timeZone.parse(zone), previewId: preview.previewId },
			}),
		),
	);
	assert.equal(changed.status, "changed");
	return preview;
}

test("AC:TARGET-TSK-014 a task handed to another account and moved to a clock-change day keeps two pending reminders, both for the new assignee", async () => {
	await w.at(NOW);
	const t = await w.create(w.adminActor, {
		title: "Book the venue",
		assigneeIds: [w.adminActor.id],
		due: day("2026-10-13"),
	});
	assert.deepEqual(await w.reminders(t.id), [[w.adminActor.id, "task_overdue", "2026-10-14T14:00:00Z", "pending"]]);
	const requestKey = randomUUID();
	const edit = () =>
		w.write(w.adminActor, "edit", {
			requestKey,
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { assigneeIds: [w.member.id], due: day("2026-11-01") } },
		});
	const { value, added } = await recorded(w.admin, async () => ok(await edit()));
	assert.deepEqual(added, {
		audits: ["tasks.changed"],
		jobs: ["mail", "mail", "mail cancelled"],
		notices: 2,
		mail: 2,
	});
	assert.deepEqual(await w.reminders(t.id), [
		[w.member.id, "task_due", "2026-11-01T15:00:00Z", "pending"],
		[w.member.id, "task_overdue", "2026-11-02T15:00:00Z", "pending"],
		[w.adminActor.id, "task_overdue", "2026-10-14T14:00:00Z", "cancelled (withdrawn)"],
	]);
	assert.deepEqual(await untouched(w.admin, async () => ok(await edit())), value);

	const timed = await w.create(w.adminActor, {
		title: "Timed across the change",
		assigneeIds: [w.member.id],
		due: { kind: "resolved_instant", local: "2026-10-31T20:00:00" },
	});
	assert.deepEqual(await w.live(timed.id), [
		[w.member.id, "task_due", "2026-11-01T01:00:00Z", "pending"],
		[w.member.id, "task_overdue", "2026-11-02T01:00:00Z", "pending"],
	]);
	const quiet = [
		await w.create(w.adminActor, { title: "Undated", assigneeIds: [w.member.id] }),
		await w.create(w.adminActor, { title: "Unassigned", due: day("2026-11-01") }),
	];
	for (const q of quiet) assert.deepEqual(await w.reminders(q.id), []);

	const late = await w.create(w.adminActor, {
		title: "Reassigned at the last second",
		assigneeIds: [w.adminActor.id],
		due: day("2026-11-01"),
	});
	const queued = await w.create(w.adminActor, {
		title: "Settled after its notice was claimed",
		assigneeIds: [w.member.id],
		due: day("2026-11-01"),
	});
	const sent = w.sent.length;
	await w.at("2026-11-01T14:59:59Z");
	ok(await w.command(w.adminActor, "edit", late, { patch: { assigneeIds: [w.member.id] } }));
	const early = await w.claim();
	assert.deepEqual(
		await w.rows(sql`SELECT n.title FROM job j JOIN mail m ON m.job_id=j.id JOIN notice n ON n.id=m.notice_id
			WHERE j.id IN (${sql.join(
				early.map((c) => sql`${c.id}`),
				sql`,`,
			)}) AND n.source_record_id=${timed.id}`),
		[{ title: "Task due: Timed across the change" }],
	);
	await w.dispatch(early);
	const mine = () =>
		w.sent
			.slice(sent)
			.filter((m) => /Book the venue|Timed across|last second|was claimed/.test(m.subject))
			.map((m) => [m.to, m.subject])
			.sort();
	assert.deepEqual(mine(), [[w.member.email, "Task due: Timed across the change"]]);

	await w.at("2026-11-01T15:00:00Z");
	const claims = await w.claim();
	ok(await w.command(w.member, "complete", queued));
	await w.dispatch(claims);
	assert.deepEqual(mine(), [
		[w.member.email, "Task due: Book the venue"],
		[w.member.email, "Task due: Reassigned at the last second"],
		[w.member.email, "Task due: Timed across the change"],
	]);
	assert.deepEqual(
		(await w.reminders(queued.id)).map((n) => [n[1], n[3]]),
		[
			["task_due", "cancelled (withdrawn)"],
			["task_overdue", "cancelled (withdrawn)"],
		],
	);
	assert.equal(
		w.sent.some((m) => m.to === w.adminActor.email && /last second|Book the venue/.test(m.subject)),
		false,
	);

	await w.at("2026-11-01T18:00:00Z");
	const delivered = await w.reminders(t.id);
	assert.deepEqual(delivered[0], [w.member.id, "task_due", "2026-11-01T15:00:00Z", "accepted"]);
	await changeZone("Pacific/Honolulu");
	await w.dispatch();
	assert.deepEqual((await get(t.id)).due, day("2026-11-01"));
	const fresh = await w.create(w.adminActor, {
		title: "Due later the same day",
		assigneeIds: [w.member.id],
		due: day("2026-11-01"),
	});
	assert.deepEqual((await w.live(fresh.id))[0], [w.member.id, "task_due", "2026-11-01T19:00:00Z", "pending"]);
	const renamed = ok(
		await w.command(w.adminActor, "edit", await get(t.id), { patch: { title: "Book the venue again" } }),
	).task;
	assert.equal(renamed.revision, "3");
	assert.deepEqual(await w.live(t.id), [[w.member.id, "task_overdue", "2026-11-02T19:00:00Z", "pending"]]);
	await w.at("2026-11-01T19:00:00Z");
	await w.dispatch();
	assert.equal(w.sent.at(-1)!.subject, "Task due: Due later the same day");
	assert.deepEqual(
		mine().filter(([, subject]) => subject!.startsWith("Task due: Book the venue")),
		[[w.member.email, "Task due: Book the venue"]],
	);
	await changeZone("America/Chicago");
});

test("AC:TARGET-TSK-018 an entered time in the spring gap or the autumn fold needs a choice, days end at the church's next midnight, and a zone change leaves dates, fixed appointments and delivered reminders alone", async () => {
	await w.at(NOW);
	const entered = (local: string, offsetSeconds?: number) =>
		w.write(w.adminActor, "create", {
			requestKey: randomUUID(),
			input: { title: "Entered", due: { kind: "resolved_instant", local, offsetSeconds } },
		});
	const meeting = randomUUID();
	await w.admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision) VALUES(${meeting},${w.plant.id},'vision_meeting','Fixed appointment','2026-11-10','10:00','America/Chicago','2026-11-10T16:00:00Z','1','planning',1)`,
	);
	const host = process.env.TZ;
	const instants: (string | null)[] = [];
	try {
		for (const zone of ["UTC", "Pacific/Auckland", "America/Los_Angeles"]) {
			process.env.TZ = zone;
			assert.equal(new Date("2026-10-14T03:00:00Z").getDate(), zone === "America/Los_Angeles" ? 13 : 14);
			assert.deepEqual(
				refused(await untouched(w.admin, () => entered("2026-03-08T02:30:00")), "nonexistent_local_time").details,
				{ local: "2026-03-08T02:30:00" },
			);
			assert.deepEqual(
				refused(await untouched(w.admin, () => entered("2026-11-01T01:30:00")), "ambiguous_local_time").details,
				{
					local: "2026-11-01T01:30:00",
					choices: [
						{ instant: "2026-11-01T06:30:00.000Z", offsetSeconds: -18000 },
						{ instant: "2026-11-01T07:30:00.000Z", offsetSeconds: -21600 },
					],
				},
			);
			refused(await untouched(w.admin, () => entered("2026-11-01T01:30:00", 0)), "invalid_input");
			for (const [local, offset] of [
				["2026-03-08T03:30:00", undefined],
				["2026-11-01T01:30:00", -18000],
				["2026-11-01T01:30:00", -21600],
			] as const) {
				const saved = ok(await entered(local, offset)).task;
				const { due } = await get(saved.id);
				instants.push(due.kind === "resolved_instant" ? due.instant : null);
			}
			const gap = localDateTime.parse("2026-03-08T02:30:00"),
				fold = localDateTime.parse("2026-11-01T01:30:00");
			assert.deepEqual(
				[resolveCalendar(gap, CHICAGO, "entered").kind, resolveCalendar(fold, CHICAGO, "entered").kind],
				["gap", "fold"],
			);
			assert.deepEqual(localDayBounds(localDate.parse("2026-03-08"), CHICAGO), {
				start: "2026-03-08T06:00:00.000Z",
				end: "2026-03-09T05:00:00.000Z",
			});
			assert.deepEqual(localDayBounds(localDate.parse("2026-11-01"), CHICAGO), {
				start: "2026-11-01T05:00:00.000Z",
				end: "2026-11-02T06:00:00.000Z",
			});
		}
	} finally {
		if (host === undefined) delete process.env.TZ;
		else process.env.TZ = host;
	}
	const each = ["2026-03-08T08:30:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"];
	assert.deepEqual(instants, [...each, ...each, ...each]);

	const assigneeIds = [w.member.id];
	const [delivered, allDay, timed] = [
		await w.create(w.adminActor, { title: "Delivered", assigneeIds, due: day("2026-10-14") }),
		await w.create(w.adminActor, { title: "All day", due: day("2026-11-01") }),
		await w.create(w.adminActor, {
			title: "One time",
			due: { kind: "resolved_instant", local: "2026-11-01T01:30:00", offsetSeconds: -21600 },
		}),
	];
	await w.at("2026-10-14T14:00:00Z");
	const before = w.sent.length;
	await w.dispatch();
	const own = () =>
		w.sent
			.slice(before)
			.map((m) => m.subject)
			.filter((s) => s.startsWith("Task due: Delivered"));
	assert.deepEqual(own(), ["Task due: Delivered"]);
	const tasks = () => w.rows(sql`SELECT to_jsonb(t) AS row FROM task t ORDER BY id`);
	const kept = await tasks();
	const dueNotice = (await w.reminders(delivered.id))[0];
	assert.deepEqual(dueNotice, [w.member.id, "task_due", "2026-10-14T14:00:00Z", "accepted"]);
	const preview = await changeZone("Pacific/Auckland");
	assert.deepEqual(
		preview.preservedTaskDates
			.filter((d) => d.id === allDay.id || d.id === delivered.id)
			.map((d) => d.date)
			.sort(),
		["2026-10-14", "2026-11-01"],
	);
	assert.deepEqual(await tasks(), kept);
	assert.deepEqual(
		await w.rows(sql`SELECT timezone,local_date::text,local_time::text,
			starts_at='2026-11-10T16:00:00Z'::timestamptz AS fixed FROM meeting WHERE id=${meeting}`),
		[{ timezone: "America/Chicago", local_date: "2026-11-10", local_time: "10:00:00", fixed: true }],
	);
	const one = await get(timed.id);
	assert.deepEqual(one.due, {
		kind: "resolved_instant",
		local: "2026-11-01T01:30:00",
		zone: "America/Chicago",
		instant: "2026-11-01T07:30:00.000Z",
		offsetSeconds: -21600,
	});
	assert.deepEqual(
		[
			await overdue(allDay.id, "2026-11-01T10:59:59.999Z"),
			await overdue(allDay.id, "2026-11-01T11:00:00Z"),
			await overdue(timed.id, "2026-11-01T07:30:00Z"),
			await overdue(timed.id, "2026-11-01T07:30:01Z"),
		],
		[false, true, false, true],
	);
	ok(await w.command(w.adminActor, "edit", await get(delivered.id), { patch: { title: "Delivered, renamed" } }));
	await w.at("2026-10-14T21:00:00Z");
	await w.dispatch();
	assert.deepEqual(own(), ["Task due: Delivered"]);
	const reminded = await w.create(w.adminActor, {
		title: "After the change",
		assigneeIds,
		due: { kind: "local_date", date: "2026-10-20" },
	});
	assert.deepEqual(await w.live(reminded.id), [
		[w.member.id, "task_due", "2026-10-19T20:00:00Z", "pending"],
		[w.member.id, "task_overdue", "2026-10-20T20:00:00Z", "pending"],
	]);
});
