import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import type { RequestActor, WriteTx } from "../../../packages/domain/src/access/session.ts";
import { type Workspace, ok, raced, refused } from "../../support/fixture.mts";
import { instant, personId, requestIdentity, tenantId } from "../../../packages/contracts/src/common/index.ts";
import {
	auditTransaction,
	finishAudit,
	prepareWrite,
	gatedTransaction,
} from "../../../packages/domain/src/operations/writes.ts";
import {
	applyManagedStatus,
	authorizeTaskReminders,
	createTaskWriter,
	ensureMeetingObligations,
	reminderRecipients,
	type TaskContext,
	type TaskReminders,
	type TaskReply,
	type TaskWriter,
	taskReader,
	withTaskWrite,
} from "../../../packages/domain/src/tasks/index.ts";
import { peopleReader, peopleWriter, withPeopleWrite } from "../../../packages/domain/src/people/index.ts";
import { createMailService, type MailPayload } from "../../../packages/domain/src/jobs/mail.ts";
import { createNotificationService } from "../../../packages/domain/src/jobs/notifications.ts";
import { taskReminders } from "../../../apps/web/src/features/tasks/reminders.ts";
import { claimDue } from "../../../packages/domain/src/jobs/queue.ts";
import {
	createFollowUpWriter,
	followUpReader,
	withFollowUpWrite,
} from "../../../packages/domain/src/followups/index.ts";
import { failingWrite, recorded, untouched } from "../../support/recorded.mts";
import { createFacts } from "../../../packages/domain/src/intelligence/index.ts";
import { caseOf } from "../target/sql/core/support.mts";
import { rejectsWithFault } from "./world.mts";

type Who = { actor: RequestActor };
type Row = Record<string, unknown>;
type Answer<F> = F extends (...args: never[]) => Promise<infer V> ? V : never;
type Value<F> = F extends (...args: never[]) => Promise<TaskReply<infer V>> ? V : never;
type Writes = {
	[K in keyof TaskWriter]: (
		tx: WriteTx,
		context: TaskContext,
		raw: unknown,
	) => Promise<TaskReply<Value<TaskWriter[K]>>>;
};
type Reader = typeof taskReader;
type Reads = {
	[K in keyof Reader]: (tx: WriteTx, who: RequestActor, raw: unknown) => Promise<Answer<Reader[K]>>;
};
type Seated = Who & Awaited<ReturnType<typeof f.account>>;
type MailRow = { id: string; recipient: string | null; notice: string | null };
type Task = Awaited<ReturnType<typeof create>>;
type Versioned = { id: string; revision: string };
let f: Awaited<ReturnType<typeof fixture>>;
let writer: TaskWriter, reminders: TaskReminders, mail: ReturnType<typeof createMailService>;
let plant: ReturnType<typeof plantOf>, other: Workspace;
let owner: Seated, member: Seated, admin2: Seated, foreign: Seated;
const sent: MailPayload[] = [];
const reads: Reads = taskReader;
const write = <K extends keyof Writes>(who: Who, op: K, input: object) => {
	const writes: Writes = writer;
	return withTaskWrite(f.db, who.actor, (tx, ctx) => writes[op](tx, ctx, input));
};
const read = <K extends keyof Reads>(who: Who, op: K, input: object | undefined) =>
	gatedTransaction(f.db, (tx) => reads[op](tx, who.actor, input));
const plantOf = (w: Workspace) => ({ kind: "plant" as const, id: tenantId.parse(w.id) });
const seriesOf = (found: Extract<Answer<Reader["findOpenOccurrence"]>, { status: "ok" }>["value"]) => {
	if (found.status !== "series") assert.fail(found.status);
	return found;
};
const available = (detail: Extract<Answer<Reader["get"]>, { status: "ok" }>["value"]) => {
	const task = "task" in detail ? detail.task : undefined;
	if (!task) assert.fail(detail.status);
	return task;
};
const create = async (who: Who, input: object) =>
	ok(await write(who, "create", { requestKey: randomUUID(), input: { title: "Task", ...input } })).task;
async function recurring(
	input: object,
	rule: { frequency: string; until: string | null; localTime?: string } = { frequency: "weekly", until: null },
) {
	const t = await create(owner, input);
	return ok(
		await write(owner, "configureRecurrence", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, rule },
		}),
	).task;
}
const subtask = async (who: Who, parent: Versioned, title: string) =>
	ok(
		await write(who, "createSubtask", {
			requestKey: randomUUID(),
			expectedRevision: parent.revision,
			input: { parentId: parent.id, title },
		}),
	).task;
const rows = async <R extends Row = Row>(q: SQL) => (await f.admin.execute<R>(q)).rows;
async function person(name: string, who: Who = owner) {
	const ctx = { session: who.actor.session, selected: who.actor.actor.context.owner };
	const r = await gatedTransaction(f.db, (tx) =>
		peopleWriter.createPerson(tx, ctx, { requestKey: randomUUID(), input: { displayName: name } }),
	);
	return ok(r).person.id;
}
async function meeting(title: string, date = "2026-10-13", w: { id: string } = plant) {
	const id = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision) VALUES(${id},${w.id},'vision_meeting',${title},${date},'18:00','America/Chicago',${date + "T23:00:00Z"},'1','completed',1)`,
	);
	return id;
}
async function team(w: { id: string } = plant) {
	const id = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${id},${w.id},'Hospitality','active',1)`,
	);
	return id;
}

type MeetingObligations = Parameters<typeof ensureMeetingObligations>[3]["meetings"][number];
const finalize = (
	meetingId: string,
	input: Pick<MeetingObligations, "followUps" | "evaluation">,
	fault = false,
	origin = { at: "2026-10-13T23:00:00Z", date: "2026-10-13", zone: "America/Chicago" },
) =>
	auditTransaction(f.db, async (tx) => {
		if (!(await owner.actor.bind(tx, plant))) throw Error("unbound");
		const identity = requestIdentity.parse({
			owner: plant,
			actorId: owner.id,
			operation: "meetings.finalizeAttendance",
			requestKey: randomUUID(),
			digest: "0".repeat(64),
		});
		const claim = await prepareWrite(tx, identity);
		if (claim.kind !== "new") assert.fail(claim.kind);
		const cmd = { ...claim, actor: { accountId: owner.id, plantId: plant.id } };
		const r = await ensureMeetingObligations(tx, cmd, reminders, { meetings: [{ meetingId, origin, ...input }] });
		cmd.events.unshift({
			id: cmd.id,
			tenant_id: plant.id,
			actor_id: owner.id,
			action: "meetings.finalized",
			kind: "finalize",
			subject_type: "meeting",
			subject_id: meetingId,
		});
		await finishAudit(tx, cmd, identity, r.value);
		await r.after();
		if (fault) throw Error("outer_audit_before_commit");
		return r.value;
	});
let statements = 0;
async function counted(body: () => Promise<unknown>) {
	const start = statements;
	await body();
	return statements - start;
}

before(async () => {
	f = await fixture();
	f.db.$client.on("connect", (client) => {
		const query = client.query;
		Object.assign(client, {
			query(this: typeof client, ...args: unknown[]) {
				statements++;
				return Reflect.apply(query, this, args);
			},
		});
	});
	mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "tasks@example.test",
		authorize: authorizeTaskReminders,
		transport: {
			async send(payload) {
				sent.push(payload);
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const notifications = createNotificationService({
		mail,
		async eligible(tx, inputs) {
			const found = await reminderRecipients(
				tx,
				inputs[0]?.owner.id ?? randomUUID(),
				inputs.map((i) => i.recipient),
			);
			return inputs.map((i) => {
				const address = found.get(i.recipient);
				return address === undefined ? null : { address };
			});
		},
	});
	reminders = taskReminders(notifications);
	writer = createTaskWriter({ reminders });
	plant = plantOf(await f.workspace());
	other = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id IN (${plant.id},${other.id})`);
	const seated = async (w: Workspace, role: "owner" | "admin" | "member") => {
		const a = await f.account();
		await f.seat(a, w, role);
		return { ...a, actor: await f.actor(a.session) };
	};
	owner = await seated(plant, "owner");
	member = await seated(plant, "member");
	await f.admin.execute(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${plant.id},${plant.id},'Member Person',
		'other','core_group','unknown','unknown',0,'live',clock_timestamp(),${member.id})`);
	admin2 = await seated(plant, "admin");
	foreign = await seated(other, "owner");
});
after(() => f?.close());

test("AC:TARGET-TSK-002 AC:B03-007 AC:B03-008 AC:B03-009 AC:TARGET-TSK-018 create, edit and delete keep a valid task or change nothing", async () => {
	const foreignPerson = await person("Foreign", foreign);
	const before = await rows(sql`SELECT (SELECT count(*)::int FROM task) t,(SELECT count(*)::int FROM audit_event) a`);
	const attempt = (input: object) =>
		write(owner, "create", { requestKey: randomUUID(), input: { title: "Task", ...input } });
	const bad = {
		title: { title: "   " },
		due: { due: { kind: "local_date", date: "2026-02-30" } },
		facility: { relation: { kind: "facility", id: randomUUID() } },
	};
	const everything = { ...bad.title, ...bad.due, ...bad.facility, assigneeIds: [foreign.id] };
	for (const input of [...Object.values(bad), everything]) {
		const error = refused(await untouched(f.admin, () => attempt(input)), "invalid_input");
		assert.equal(JSON.stringify(error).includes(foreign.id), false);
	}
	refused(await untouched(f.admin, () => attempt({ assigneeIds: [foreign.id] })), "invalid_subject");
	refused(
		await untouched(f.admin, () => attempt({ relation: { kind: "person", id: foreignPerson } })),
		"invalid_subject",
	);
	const gap = refused(
		await attempt({ due: { kind: "resolved_instant", local: "2026-03-08T02:30:00" } }),
		"nonexistent_local_time",
	);
	assert.equal(gap.details.local, "2026-03-08T02:30:00");
	const fold = refused(
		await attempt({ due: { kind: "resolved_instant", local: "2026-11-01T01:30:00" } }),
		"ambiguous_local_time",
	);
	assert.deepEqual(
		fold.details.choices.map((c: { offsetSeconds: number }) => c.offsetSeconds),
		[-18000, -21600],
	);
	refused(await attempt({ parentId: randomUUID() }), "invalid_input");
	assert.deepEqual(
		await rows(sql`SELECT (SELECT count(*)::int FROM task) t,(SELECT count(*)::int FROM audit_event) a`),
		before,
	);
	const saved = [];
	for (const offsetSeconds of [-18000, -21600]) {
		const t = await create(owner, { due: { kind: "resolved_instant", local: "2026-11-01T01:30:00", offsetSeconds } });
		saved.push(available(ok(await read(owner, "get", { taskId: t.id }))).due);
	}
	assert.deepEqual(
		saved.map((due) => (due.kind === "resolved_instant" ? due.instant : due.kind)),
		["2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"],
	);

	const request = {
		requestKey: randomUUID(),
		input: { title: "  Call the venue  ", priority: "high", category: "facilities" },
	};
	const first = ok(await write(owner, "create", request));
	assert.deepEqual(ok(await write(owner, "create", request)), first);
	assert.equal(first.task.title, "Call the venue");
	assert.deepEqual([first.task.due, first.task.overdue, first.task.assignees], [{ kind: "undated" }, null, []]);
	const unknown = caseOf("intelligence", "B03-007") as ReturnType<typeof caseOf> & { clock: { now: string } };
	assert.deepEqual(unknown.action.arguments, { due_date: null, launch_date: null });
	const undated = available(ok(await read(owner, "get", { taskId: first.task.id, asOf: unknown.clock.now })));
	const listed = ok(await read(owner, "list", { asOf: unknown.clock.now, limit: 100 })).items.find(
		(x) => x.id === first.task.id,
	);
	assert.deepEqual([listed?.due, listed?.overdue], [{ kind: "undated" }, null]);
	refused(
		await untouched(f.admin, () =>
			write(owner, "edit", {
				requestKey: randomUUID(),
				expectedRevision: first.task.revision,
				input: { taskId: first.task.id, patch: { due: bad.due.due } },
			}),
		),
		"invalid_input",
	);
	assert.deepEqual(
		available(ok(await read(owner, "get", { taskId: first.task.id, asOf: unknown.clock.now }))),
		undated,
	);
	const facts = createFacts({ clock: { now: () => instant.parse(unknown.clock.now) } });
	const launchOf = async () => ok(await facts.readFacts(f.db, owner.actor)).launch;
	assert.equal((await rows(sql`SELECT count(*)::int n FROM launch WHERE plant_id=${plant.id}`))[0]!.n, 0);
	const noLaunch = await launchOf();
	assert.deepEqual(
		{
			task_due: undated.due.kind === "undated" ? null : undated.due,
			launch_countdown: noLaunch.daysToLaunch,
		},
		unknown.expected.result,
	);
	assert.deepEqual([undated.overdue, noLaunch], [null, { targetOn: null, daysToLaunch: null }]);
	refused(await write(member, "create", { requestKey: randomUUID(), input: { title: "Member task" } }), "unavailable");

	const p = await person("Alex Rivera");
	const edited = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: first.task.revision,
			input: {
				taskId: first.task.id,
				patch: {
					assigneeIds: [member.id],
					relation: { kind: "person", id: p },
					due: { kind: "local_date", date: "2026-10-20" },
				},
			},
		}),
	).task;
	assert.deepEqual(
		[edited.revision, edited.priority, edited.assignees[0]!.accountId, edited.relation, edited.due],
		[
			"2",
			"high",
			member.id,
			{ kind: "person", id: p, label: "Alex Rivera" },
			{ kind: "local_date", date: "2026-10-20" },
		],
	);
	refused(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: first.task.revision,
			input: { taskId: first.task.id, patch: { title: "Hidden change" } },
		}),
		"conflict",
	);
	const cleared = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: edited.revision,
			input: { taskId: first.task.id, patch: { relation: null, description: "Line one\r\nLine two  " } },
		}),
	).task;
	assert.deepEqual(
		[cleared.title, cleared.relation, cleared.description],
		["Call the venue", null, "Line one\nLine two"],
	);

	const editing = (expectedRevision: string, patch: object, requestKey: string = randomUUID()) =>
		write(owner, "edit", { requestKey, expectedRevision, input: { taskId: first.task.id, patch } });
	for (const patch of [
		{ title: "Hidden change", assigneeIds: [foreign.id] },
		{ title: "Hidden change", relation: { kind: "person", id: foreignPerson } },
	])
		refused(await untouched(f.admin, () => editing(cleared.revision, patch)), "invalid_subject");
	refused(
		await untouched(f.admin, () =>
			editing(cleared.revision, { title: "Hidden change", relation: bad.facility.relation }),
		),
		"invalid_input",
	);
	const prerequisites = (ids: readonly string[]) =>
		write(owner, "replacePrerequisites", {
			requestKey: randomUUID(),
			expectedRevision: cleared.revision,
			input: { taskId: first.task.id, prerequisiteIds: ids },
		});
	const theirs = await create(foreign, { title: "Theirs" });
	for (const id of [theirs.id, first.task.id])
		refused(await untouched(f.admin, () => prerequisites([id])), "invalid_subject");
	const earlier = await create(owner, { title: "Sign the lease" });
	await untouched(f.admin, () =>
		failingWrite(f.admin, { on: "audit_event", event: "INSERT", when: `NEW.subject_id='${first.task.id}'` }, () =>
			rejectsWithFault(prerequisites([earlier.id])),
		),
	);
	const key = randomUUID();
	const dated = { title: "Renamed", due: { kind: "local_date", date: "2099-04-01" } };
	await untouched(f.admin, () =>
		failingWrite(f.admin, { on: "notice", event: "INSERT", when: `NEW.source_record_id='${first.task.id}'` }, () =>
			rejectsWithFault(editing(cleared.revision, dated, key)),
		),
	);
	const renamed = ok(await editing(cleared.revision, dated, key)).task;
	assert.deepEqual([renamed.title, renamed.due], ["Renamed", dated.due]);

	const child = await subtask(owner, renamed, "Bring chairs");
	const finished = await subtask(owner, renamed, "Book chairs");
	ok(await tick(owner, renamed, finished, true));
	const withChild = available(ok(await read(owner, "get", { taskId: first.task.id })));
	assert.deepEqual(
		withChild.checklistItems.map((k) => k.id),
		[child.id, finished.id],
	);
	const evidence = () =>
		rows(
			sql`SELECT to_jsonb(a) AS row FROM audit_event a WHERE subject_id IN (${first.task.id},${child.id},${finished.id}) ORDER BY id`,
		);
	const history = await evidence();
	const removal = await recorded(f.admin, () =>
		write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: withChild.revision,
			input: { taskId: first.task.id },
		}),
	);
	ok(removal.value);
	assert.deepEqual(removal.added, {
		audits: Array<string>(3).fill("tasks.changed"),
		jobs: ["mail cancelled", "mail cancelled"],
		notices: 0,
		mail: 0,
	});
	assert.deepEqual(
		await rows(
			sql`SELECT m.state FROM mail m JOIN notice n ON n.id=m.notice_id WHERE n.source_record_id=${first.task.id} AND n.cancelled_at IS NOT NULL`,
		),
		[{ state: "cancelled" }, { state: "cancelled" }],
	);
	const ids = new Set(history.map((h) => (h.row as Versioned).id));
	assert.deepEqual(
		(await evidence()).filter((h) => ids.has((h.row as Versioned).id)),
		history,
	);
	assert.deepEqual(
		await rows(sql`SELECT status, completed_at IS NOT NULL AS performed FROM task WHERE id=${finished.id}`),
		[{ status: "complete", performed: true }],
	);
	assert.deepEqual(ok(await read(owner, "get", { taskId: first.task.id })), { status: "unavailable" });
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM task WHERE id IN (${first.task.id},${child.id}) AND deleted_at IS NOT NULL`,
		),
		[{ n: 2 }],
	);
	assert.equal(ok(await read(owner, "statusHistory", { taskId: child.id })).items.length, 1);

	const met = await meeting("Vision night");
	const [generated] = await finalize(met, { followUps: [], evaluation: { assigneeIds: [owner.id] } });
	const evaluation = await get(owner, generated!.taskId!);
	const protect = (patch: object) =>
		write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: evaluation.revision,
			input: { taskId: evaluation.id, patch: { title: "Hidden change", ...patch } },
		});
	for (const patch of [{ relation: null }, { relation: { kind: "person", id: p } }, { category: "general" }])
		refused(await untouched(f.admin, () => protect(patch)), "protected_source");
	const obligation = () => rows(sql`SELECT to_jsonb(o) AS row FROM obligation o WHERE id=${generated!.obligationId}`);
	const kept = await obligation();
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: ok(await protect({})).task.revision,
			input: { taskId: evaluation.id },
		}),
	);
	assert.deepEqual(await obligation(), kept);
});

test("AC:TARGET-TSK-001 AC:B03-001 AC:B03-002 AC:B03-003 views, stable pages, counts and due state", async () => {
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${w.id}`);
	const a = await f.account();
	await f.seat(a, w, "owner");
	const me = { ...a, actor: await f.actor(a.session) };
	const b = await f.account();
	await f.seat(b, w, "member");
	const mine = { ...b, actor: await f.actor(b.session) };
	const hospitality = await team(w);
	const foreignTeam = await team(other);
	const undated: string[] = [];
	for (let n = 0; n < 51; n++)
		undated.push(
			(
				await create(me, {
					title: "Same",
					assigneeIds: n < 6 ? [b.id] : [],
					relation: n < 3 ? { kind: "team", id: hospitality } : null,
				})
			).id,
		);
	const ordered = [...undated].sort();
	const onPage = async (page: number) => {
		const answer = ok(await read(me, "list", { view: "all", sort: "due", page, limit: 50 }));
		return { ids: answer.items.map((t) => t.id as string), total: answer.total, next: answer.next };
	};
	for (const title of ["Row one", "Row two"])
		await subtask(me, available(ok(await read(me, "get", { taskId: ordered[0]! }))), title);
	await untouched(f.admin, async () => {
		assert.deepEqual(await onPage(1), { ids: ordered.slice(0, 50), total: 51, next: 2 });
		assert.deepEqual(await onPage(2), { ids: [ordered[50]], total: 51, next: null });
		const totals = ok(await read(me, "count", {}));
		assert.deepEqual([totals.topLevelTotal, totals.childTaskTotal, totals.childTaskComplete], [51, 2, 0]);
	});
	for (const role of [owner, foreign])
		assert.deepEqual(
			ok(await read(role, "list", { view: "all", limit: 100 })).items.filter((t) => undated.includes(t.id)),
			[],
		);
	const boundary = await create(me, { title: "Same" });
	const widened = [...undated, boundary.id].sort();
	const cursor = widened[49]!;
	assert.deepEqual((await onPage(1)).ids, widened.slice(0, 50));
	ok(
		await write(me, "delete", {
			requestKey: randomUUID(),
			expectedRevision: available(ok(await read(me, "get", { taskId: cursor }))).revision,
			input: { taskId: cursor },
		}),
	);
	const left = widened.filter((id) => id !== cursor);
	assert.deepEqual(await onPage(1), { ids: left.slice(0, 50), total: 51, next: 2 });
	assert.deepEqual(await onPage(2), { ids: left.slice(50), total: 51, next: null });
	undated.splice(0, undated.length, ...left);

	const dated = await create(me, { title: "Dated", due: { kind: "local_date", date: "2026-10-13" } });
	for (const title of ["One", "Two"]) await subtask(me, dated, title);

	const pages = [1, 2].map(async (page) => ok(await read(me, "list", { sort: "due", page })));
	const [one, two] = await Promise.all(pages);
	assert.deepEqual([one!.items.length, two!.items.length, one!.total, one!.next, two!.next], [50, 2, 52, 2, null]);
	assert.equal(one!.items[0]!.id, dated.id);
	const ids = [...one!.items, ...two!.items].map((t) => t.id);
	assert.equal(new Set(ids).size, 52);
	assert.deepEqual(ids.slice(1), [...undated].sort());
	assert.deepEqual(one!.items[0]!.checklist, { total: 2, complete: 0 });

	const counts = ok(await read(mine, "count", {}));
	assert.deepEqual(
		[counts.topLevelTotal, counts.childTaskTotal, counts.childTaskComplete, counts.byStatus],
		[52, 4, 0, [{ value: "not_started", count: 52 }]],
	);
	const assigned = await rows<{ id: string; mine: boolean; team: boolean }>(
		sql`SELECT t.id, EXISTS(SELECT FROM task_assignee a WHERE a.task_id=t.id) AS mine, t.team_id IS NOT NULL AS team
			FROM task t WHERE t.plant_id=${w.id} AND t.deleted_at IS NULL AND t.parent_id IS NULL`,
	);
	const expected = (keep: (t: (typeof assigned)[number]) => boolean) =>
		assigned
			.filter(keep)
			.map((t) => t.id)
			.sort();
	const found = async (who: Who, input: object) =>
		ok(await read(who, "list", { limit: 100, ...input }))
			.items.map((t) => t.id as string)
			.sort();
	assert.ok(expected((t) => t.mine && t.team).length > 0 && expected((t) => t.mine && !t.team).length > 0);
	assert.deepEqual(
		await found(mine, { view: "my" }),
		expected((t) => t.mine),
	);
	const everyTeam = await create(me, { title: "Team duty", relation: { kind: "team", id: hospitality } });
	assert.deepEqual(
		await found(mine, { view: "my", teamId: hospitality }),
		expected((t) => t.mine && t.team),
	);
	assert.deepEqual(
		await found(mine, { view: "all", teamId: hospitality }),
		[...expected((t) => t.team), everyTeam.id].sort(),
	);
	assert.equal(
		ok(await read(mine, "count", { view: "all", teamId: hospitality })).topLevelTotal,
		expected((t) => t.team).length + 1,
	);
	const theirDuty = await create(foreign, { title: "Their duty", relation: { kind: "team", id: foreignTeam } });
	assert.deepEqual(await found(foreign, { teamId: foreignTeam }), [theirDuty.id]);
	const nowhere = await untouched(f.admin, async () => [
		ok(await read(me, "list", { view: "all", teamId: foreignTeam, page: 1, limit: 50 })),
		ok(await read(me, "list", { view: "all", teamId: randomUUID(), page: 1, limit: 50 })),
	]);
	for (const answer of nowhere)
		assert.deepEqual(answer, { items: [], total: 0, page: 1, next: null, completeness: "complete" });
	assert.equal(ok(await read(me, "count", { view: "all", teamId: foreignTeam })).topLevelTotal, 0);
	const coverage = (input: object) =>
		gatedTransaction(f.db, (tx) => followUpReader.followUpCoverage(tx, me.actor, input));
	const alma = await person("Alma Reyes", { actor: me.actor });
	await create(me, {
		title: "Call Alma",
		category: "follow_up",
		relation: { kind: "person", id: alma },
	});
	const view = ok(await coverage({}));
	assert.deepEqual(
		view.items.map((i) => [i.person.label, i.coverage, i.duties.length]),
		[["Alma Reyes", "needs_owner", 1]],
	);
	for (const teamId of [hospitality, foreignTeam]) refused(await coverage({ teamId }), "invalid_input");
	assert.equal(
		ok(await read(foreign, "list", {})).items.some((t) => ids.includes(t.id)),
		false,
	);

	const overdue = async (taskId: string, asOf: string) =>
		available(ok(await read(me, "get", { taskId, asOf }))).overdue;
	assert.deepEqual(
		[await overdue(dated.id, "2026-10-14T03:00:00Z"), await overdue(dated.id, "2026-10-14T05:00:00Z")],
		[false, true],
	);
	const clockChanges: [string, string][] = [
		["2026-03-08", "2026-03-09T05:00:00Z"],
		["2026-11-01", "2026-11-02T06:00:00Z"],
	];
	for (const [date, end] of clockChanges) {
		const t = await create(me, { due: { kind: "local_date", date } });
		const justBefore = new Date(Date.parse(end) - 1000).toISOString();
		assert.deepEqual([await overdue(t.id, justBefore), await overdue(t.id, end)], [false, true]);
		assert.deepEqual(t.due, { kind: "local_date", date });
	}
	const timed = await create(me, { due: { kind: "resolved_instant", local: "2026-10-13T13:00:00" } });
	assert.equal(timed.due.kind === "resolved_instant" ? timed.due.instant : timed.due.kind, "2026-10-13T18:00:00.000Z");
	assert.deepEqual(
		[await overdue(timed.id, "2026-10-13T17:59:59Z"), await overdue(timed.id, "2026-10-13T18:00:01Z")],
		[false, true],
	);
});

test("AC:TARGET-TSK-003 AC:TARGET-TSK-015 own-duty completion, one result per request, reopen and history", async () => {
	const command = <K extends keyof Writes>(who: Who, op: K, t: Versioned, extra: object = {}) =>
		write(who, op, { requestKey: randomUUID(), expectedRevision: t.revision, input: { taskId: t.id, ...extra } });
	const t = await create(owner, {
		title: "Welcome packs",
		assigneeIds: [admin2.id],
		relation: { kind: "person", id: await person("Jamie") },
	});
	const moved = ok(
		await write(admin2, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { assigneeIds: [member.id] } },
		}),
	).task;
	refused(await command(owner, "complete", t), "conflict");
	const others = await create(owner, { title: "Not yours", assigneeIds: [admin2.id] });
	refused(await command(member, "complete", others), "unavailable");
	refused(await command(member, "edit", moved, { patch: { title: "Renamed" } }), "unavailable");

	const started = ok(await command(member, "changeStatus", moved, { status: "in_progress" })).task;
	assert.equal(started.status, "in_progress");
	const request = { requestKey: randomUUID(), expectedRevision: started.revision, input: { taskId: t.id } };
	const done = ok(await write(member, "complete", request));
	assert.deepEqual(ok(await write(member, "complete", request)), done);
	assert.equal(done.task.status, "complete");
	assert.ok(done.task.completedAt);
	refused(await command(member, "complete", started), "conflict");
	const reopened = ok(await command(member, "reopen", done.task)).task;
	assert.deepEqual([reopened.status, reopened.completedAt], ["not_started", null]);
	const same = { requestKey: randomUUID(), expectedRevision: reopened.revision, input: { taskId: t.id } };
	const again = ok(await write(member, "reopen", same));
	assert.equal(again.outcome, "noop");
	assert.deepEqual(ok(await write(member, "reopen", same)), again);
	const keyed = (key: string) =>
		rows(
			sql`SELECT kind, subject_type, subject_id FROM audit_event WHERE tenant_id=${plant.id} AND request_key=${key}`,
		);
	const plain = await recurring({ title: "Stack chairs" });
	const unchanged: [string, string, string][] = [["reopen", same.requestKey, t.id]];
	const noops: ["edit" | "replacePrerequisites" | "configureRecurrence", object][] = [
		["edit", { patch: { title: "Stack chairs" } }],
		["replacePrerequisites", { prerequisiteIds: [] }],
		["configureRecurrence", { rule: { frequency: "weekly", until: null } }],
	];
	for (const [op, input] of noops) {
		const requestKey = randomUUID();
		const r = ok(
			await write(owner, op, { requestKey, expectedRevision: plain.revision, input: { taskId: plain.id, ...input } }),
		);
		assert.equal(r.outcome, "noop", op);
		unchanged.push([op, requestKey, plain.id]);
	}
	for (const [op, key, id] of unchanged)
		assert.deepEqual(await keyed(key), [{ kind: "noop", subject_type: "task", subject_id: id }], op);

	const history = ok(await read(member, "statusHistory", { taskId: t.id }));
	assert.deepEqual(
		history.items.map((h) => [h.from, h.to, h.actor.kind === "account" ? h.actor.accountId : h.actor.kind, h.source]),
		[
			[null, "not_started", owner.id, "person"],
			["not_started", "in_progress", member.id, "person"],
			["in_progress", "complete", member.id, "person"],
			["complete", "not_started", member.id, "person"],
		],
	);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM contact_outcome`), [{ n: 0 }]);
	refused(await read(foreign, "statusHistory", { taskId: t.id }), "unavailable");

	const seeded = randomUUID();
	await f.admin.execute(sql`INSERT INTO task (id, plant_id, title, category, priority, status, created_at, due_kind)
		VALUES (${seeded}, ${plant.id}, 'Call James', 'general', 'medium', 'not_started', now(), 'undated')`);
	for (const who of [owner, member])
		assert.deepEqual(ok(await read(who, "statusHistory", { taskId: seeded })), {
			taskId: seeded,
			items: [],
			next: null,
			completeness: "complete",
		});
	refused(await read(foreign, "statusHistory", { taskId: seeded }), "unavailable");
	refused(await read(owner, "statusHistory", { taskId: randomUUID() }), "unavailable");

	const older = await recurring({ title: "Weekly check-in", due: { kind: "local_date", date: "2026-10-05" } });
	const closed = ok(await command(owner, "completeOccurrence", older));
	const conflict = refused(await untouched(f.admin, () => command(owner, "reopen", closed.task)), "open_successor");
	assert.equal(conflict.details.successorId, closed.successor!.id);
});

test("AC:TARGET-TSK-003 a completion reviewed under another assignee is refused each time, two at once complete once, and finishing a task about a person is not a contact", async () => {
	const alex = await person("Alex Duarte");
	const t = await create(admin2, {
		title: "Mail the packet",
		assigneeIds: [admin2.id],
		relation: { kind: "person", id: alex },
	});
	const complete = (who: Who, task: Versioned, requestKey: string = randomUUID()) =>
		write(who, "complete", { requestKey, expectedRevision: task.revision, input: { taskId: task.id } });
	const moved = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { assigneeIds: [member.id] } },
		}),
	).task;
	const requestKey = randomUUID();
	for (let n = 0; n < 2; n++) refused(await untouched(f.admin, () => complete(admin2, t, requestKey)), "conflict");
	const bystander = await (async () => {
		const a = await f.account();
		await f.seat(a, plant, "member");
		return { ...a, actor: await f.actor(a.session) };
	})();
	for (const who of [bystander, foreign]) refused(await untouched(f.admin, () => complete(who, moved)), "unavailable");

	const outcomes = async () => ({
		outcomes: (await rows(sql`SELECT count(*)::int AS n FROM contact_outcome WHERE person_id=${alex}`))[0]!.n,
		contacts: ok(
			await gatedTransaction(f.db, (tx) => followUpReader.listContactHistory(tx, owner.actor, { personId: alex })),
		).lastConfirmedContactAt,
	});
	const key = randomUUID();
	const answers = await raced(f.admin, f.db, sql`SELECT FROM task WHERE id=${t.id} FOR UPDATE`, [
		() => complete(member, moved, key),
		() => complete(member, moved, key),
		() => complete(owner, moved),
	]);
	const done = ok(answers[0]!);
	assert.deepEqual(answers[1], answers[0]);
	refused(answers[2], "conflict");
	assert.deepEqual(await untouched(f.admin, async () => ok(await complete(member, moved, key))), done);
	assert.deepEqual(
		await rows(
			sql`SELECT actor_id, action FROM audit_event WHERE subject_id=${t.id} AND after_value->>'status'='complete'`,
		),
		[{ actor_id: member.id, action: "tasks.completed" }],
	);
	assert.deepEqual(await outcomes(), { outcomes: 0, contacts: null });
	const called = await create(owner, {
		title: "Call Alex",
		category: "follow_up",
		relation: { kind: "person", id: alex },
	});
	const writes = createFollowUpWriter({ reminders });
	ok(
		await withFollowUpWrite(f.db, owner.actor, (tx, ctx) =>
			writes.recordOutcome(tx, ctx, {
				requestKey: randomUUID(),
				input: {
					target: { kind: "task", taskId: called.id, expectedRevision: called.revision },
					outcome: "contacted",
					occurredAt: "2026-10-12T16:00:00Z",
					completeTask: true,
				},
			}),
		),
	);
	assert.deepEqual(await outcomes(), { outcomes: 1, contacts: "2026-10-12T16:00:00.000Z" });
});

test("AC:TARGET-TSK-015 history names who made each change, however it was made, and neither a repeat nor a corrected outcome adds to it", async () => {
	const kim = await person("Kim Osei");
	const history = async (taskId: string, who: Who = owner) =>
		ok(await read(who, "statusHistory", { taskId })).items.map((h) => [
			h.from,
			h.to,
			h.actor.kind === "account" ? h.actor.accountId : h.actor.kind,
			h.source,
		]);
	const command = <K extends keyof Writes>(who: Who, op: K, t: Versioned, requestKey: string = randomUUID()) =>
		write(who, op, { requestKey, expectedRevision: t.revision, input: { taskId: t.id } });
	const t = await create(admin2, { title: "Welcome packs", assigneeIds: [admin2.id] });
	const key = randomUUID();
	const done = ok(await command(admin2, "complete", t, key)).task;
	const created = [null, "not_started", admin2.id, "person"];
	const completed = ["not_started", "complete", admin2.id, "person"];
	assert.deepEqual(await history(t.id), [created, completed]);
	for (let n = 0; n < 2; n++) ok(await untouched(f.admin, () => command(admin2, "complete", t, key)));
	const same = await recorded(f.admin, () => command(admin2, "complete", done));
	assert.equal(ok(same.value).outcome, "noop");
	assert.deepEqual(same.added, { audits: ["tasks.changed"], jobs: [], notices: 0, mail: 0 });
	assert.deepEqual(await history(t.id), [created, completed]);
	const open = ok(await command(admin2, "reopen", done)).task;
	assert.deepEqual([open.status, open.completedAt], ["not_started", null]);
	const whole = [created, completed, ["complete", "not_started", admin2.id, "person"]];
	assert.deepEqual(await untouched(f.admin, () => history(t.id)), whole);
	assert.deepEqual(await history(t.id, member), whole);
	refused(await untouched(f.admin, () => read(foreign, "statusHistory", { taskId: t.id })), "unavailable");

	const bulk = await create(owner, { title: "Stack chairs", assigneeIds: [member.id] });
	const request = { requestKey: randomUUID(), items: [{ taskId: bulk.id, expectedRevision: bulk.revision }] };
	ok(await write(member, "bulkComplete", request));
	ok(await untouched(f.admin, () => write(member, "bulkComplete", request)));
	const bulked = [
		[null, "not_started", owner.id, "person"],
		["not_started", "complete", member.id, "bulk"],
	];
	assert.deepEqual(await history(bulk.id), bulked);

	const [generated] = await finalize(await meeting("History night"), {
		followUps: [],
		evaluation: { assigneeIds: [member.id] },
	});
	const managed = async () => {
		const value = await auditTransaction(f.db, async (tx) => {
			await owner.actor.bind(tx, plant);
			const identity = requestIdentity.parse({
				owner: plant,
				actorId: owner.id,
				operation: "meetings.recordEvaluation",
				requestKey: randomUUID(),
				digest: "2".repeat(64),
			});
			const claim = await prepareWrite(tx, identity);
			if (claim.kind !== "new") assert.fail(claim.kind);
			const cmd = { ...claim, actor: { accountId: owner.id, plantId: plant.id } };
			const r = await applyManagedStatus(tx, cmd, reminders, {
				obligationIds: [generated!.obligationId],
				status: "complete",
			});
			cmd.events.unshift({
				id: cmd.id,
				tenant_id: plant.id,
				actor_id: owner.id,
				action: "meetings.changed",
				kind: "edit",
				subject_type: "meeting",
				subject_id: generated!.meetingId,
			});
			await finishAudit(tx, cmd, identity, r.value);
			return r.value.outcome;
		});
		return value;
	};
	assert.deepEqual([await managed(), await managed()], ["changed", "noop"]);
	assert.deepEqual(await history(generated!.taskId!), [
		[null, "not_started", owner.id, "generated"],
		["not_started", "complete", owner.id, "generated"],
	]);

	const weekly = await recurring({ title: "Weekly count", due: { kind: "local_date", date: "2026-10-05" } });
	const next = ok(await command(owner, "completeOccurrence", weekly)).successor!;
	assert.deepEqual(await history(next.id), [[null, "not_started", owner.id, "recurrence"]]);
	const waived = await create(owner, { title: "Not needed" });
	ok(await command(owner, "waive", waived));
	assert.deepEqual((await history(waived.id)).at(-1), ["not_started", "no_longer_needed", owner.id, "person"]);

	const call = await create(owner, {
		title: "Call Kim",
		category: "follow_up",
		relation: { kind: "person", id: kim },
	});
	const outcomes = createFollowUpWriter({ reminders });
	const recordedOutcome = ok(
		await withFollowUpWrite(f.db, owner.actor, (tx, ctx) =>
			outcomes.recordOutcome(tx, ctx, {
				requestKey: randomUUID(),
				input: {
					target: { kind: "task", taskId: call.id, expectedRevision: call.revision },
					outcome: "contacted",
					occurredAt: "2026-10-12T16:00:00Z",
					completeTask: true,
				},
			}),
		),
	);
	const called = [
		[null, "not_started", owner.id, "person"],
		["not_started", "complete", owner.id, "person"],
	];
	assert.deepEqual(await history(call.id), called);
	const corrected = ok(
		await withFollowUpWrite(f.db, owner.actor, (tx, ctx) =>
			outcomes.correctOutcome(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: recordedOutcome.record.revision,
				input: {
					outcomeId: recordedOutcome.record.id,
					correction: { kind: "replace", outcome: "administrative_completion" },
					reason: "Left a letter instead",
				},
			}),
		),
	);
	assert.deepEqual(
		[corrected.record.outcome, corrected.previous?.state, (await get(owner, call.id)).status],
		["administrative_completion", "corrected", "complete"],
	);
	assert.deepEqual(await history(call.id), called);
	ok(await command(owner, "delete", await get(owner, call.id)));
	assert.deepEqual(await history(call.id), called);
	for (const id of [t.id, bulk.id, generated!.taskId!, next.id, waived.id, call.id])
		assert.equal(
			(await history(id)).some(([, , actor]) => actor === "former_account" || actor === "system"),
			false,
		);
});

test("AC:TARGET-TSK-017 AC:PERSONREF-TASK-PERSON-FOLLOW-UP-RETIRE generated follow-ups and evaluation never duplicate or return", async () => {
	const p1 = await person("Alex Rivera"),
		p2 = await person("Alex Chen");
	const m1 = await meeting("Vision night"),
		m2 = await meeting("Second vision night");
	const counts = () =>
		rows<{ t: number; o: number }>(
			sql`SELECT (SELECT count(*)::int FROM task WHERE obligation_id IS NOT NULL) t,(SELECT count(*)::int FROM obligation) o`,
		);
	const input = {
		followUps: [
			{ personId: p1, assigneeIds: [member.id] },
			{ personId: p2, assigneeIds: [] },
		],
		evaluation: { assigneeIds: [owner.id] },
	};
	const first = await finalize(m1, input);
	assert.deepEqual(
		first.map((r) => [r.kind, r.personId, r.outcome]),
		[
			["first_vision_follow_up", p1, "created"],
			["first_vision_follow_up", p2, "created"],
			["meeting_evaluation", null, "created"],
		],
	);
	const task = async (id: string) => available(ok(await read(owner, "get", { taskId: id })));
	const [f1, f2, evaluation] = await Promise.all(first.map((r) => task(r.taskId!)));
	assert.deepEqual(
		[f1!.title, f1!.due, f1!.assignees[0]!.accountId, f1!.managed!.kind, f2!.assignees],
		["Follow up with Alex Rivera", { kind: "local_date", date: "2026-10-15" }, member.id, "first_vision_follow_up", []],
	);
	assert.deepEqual(
		[evaluation!.relation, evaluation!.managed!.kind],
		[{ kind: "meeting", id: m1, label: "Vision night" }, "meeting_evaluation"],
	);
	assert.equal(ok(await read(owner, "statusHistory", { taskId: f1!.id })).items[0]!.source, "generated");

	const settled = await counts();
	await assert.rejects(finalize(m2, input, true), /outer_audit_before_commit/);
	assert.deepEqual(await counts(), settled);
	assert.deepEqual(
		(await finalize(m1, input)).map((r) => r.outcome),
		["existing", "existing", "existing"],
	);
	assert.deepEqual(await counts(), settled);
	const second = await finalize(m2, { followUps: [{ personId: p1, assigneeIds: [] }], evaluation: null });
	assert.notEqual(second[0]!.obligationId, first[0]!.obligationId);

	const waived = ok(
		await write(owner, "waive", {
			requestKey: randomUUID(),
			expectedRevision: f2!.revision,
			input: { taskId: f2!.id, reason: "Moved away" },
		}),
	).task;
	ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: waived.revision,
			input: { taskId: f2!.id, patch: { title: "Closed" } },
		}),
	);
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: f1!.revision,
			input: { taskId: f1!.id },
		}),
	);
	assert.deepEqual(
		(await finalize(m1, input)).map((r) => r.outcome),
		["existing", "existing", "existing"],
	);
	assert.deepEqual(
		await rows(sql`SELECT waived_at IS NOT NULL w, waiver_reason r FROM obligation WHERE id=${first[1]!.obligationId}`),
		[{ w: true, r: "Moved away" }],
	);
	assert.equal((await counts())[0]!.t, settled[0]!.t + 1);
	for (const patch of [{ relation: { kind: "meeting", id: m2 } }, { category: "general" }])
		refused(
			await write(owner, "edit", {
				requestKey: randomUUID(),
				expectedRevision: evaluation!.revision,
				input: { taskId: evaluation!.id, patch },
			}),
			"protected_source",
		);
	const recordEvaluation = () =>
		auditTransaction(f.db, async (tx) => {
			await owner.actor.bind(tx, plant);
			const identity = requestIdentity.parse({
				owner: plant,
				actorId: owner.id,
				operation: "meetings.recordEvaluation",
				requestKey: randomUUID(),
				digest: "1".repeat(64),
			});
			const claim = await prepareWrite(tx, identity);
			if (claim.kind !== "new") assert.fail(claim.kind);
			const cmd = { ...claim, actor: { accountId: owner.id, plantId: plant.id } };
			const r = await applyManagedStatus(tx, cmd, reminders, {
				obligationIds: [first[2]!.obligationId],
				status: "complete",
			});
			cmd.events.unshift({
				id: cmd.id,
				tenant_id: plant.id,
				actor_id: owner.id,
				action: "meetings.changed",
				kind: "edit",
				subject_type: "meeting",
				subject_id: m1,
			});
			await finishAudit(tx, cmd, identity, r.value);
			return r.value.outcome;
		});
	assert.deepEqual([await recordEvaluation(), await recordEvaluation()], ["changed", "noop"]);
	assert.deepEqual(
		ok(await read(owner, "statusHistory", { taskId: evaluation!.id })).items.map((h) => [h.to, h.source]),
		[
			["not_started", "generated"],
			["complete", "generated"],
		],
	);

	const ctx = { session: owner.actor.session, selected: plant };
	const review = ok(await gatedTransaction(f.db, (tx) => peopleReader.getStatusWarnings(tx, ctx, { personId: p1 })));
	ok(
		await gatedTransaction(f.db, (tx) =>
			peopleWriter.retirePerson(
				tx,
				ctx,
				{
					requestKey: randomUUID(),
					expectedRevision: review.revision,
					input: {
						personId: p1,
						reason: "Duplicate record",
						reviewRevision: review.reviewRevision,
						handoffs: review.openDuties.map((d) => ({
							kind: "needs_owner",
							dutyId: d.id,
							expectedRevision: d.revision,
						})),
					},
				},
				reminders,
			),
		),
	);
	assert.deepEqual(await rows(sql`SELECT person_id FROM task WHERE id=${second[0]!.taskId}`), [{ person_id: p1 }]);
	assert.equal(
		ok(await read(owner, "relationOptions", { kind: "person", search: "Alex" })).items.some((o) => String(o.id) === p1),
		false,
	);
	refused(
		await write(owner, "create", {
			requestKey: randomUUID(),
			input: { title: "Call", relation: { kind: "person", id: p1 } },
		}),
		"invalid_subject",
	);
	await assert.rejects(
		finalize(await meeting("Third"), { followUps: [{ personId: p1, assigneeIds: [] }], evaluation: null }),
	);
});

test("AC:TARGET-TSK-014 due and overdue reminders follow the current assignee and stop when settled", async () => {
	const notices = (task: string) =>
		rows<{
			recipient_id: string;
			purpose: string;
			cancelled: boolean;
			state: string;
			mail: string;
		}>(sql`SELECT n.recipient_id, n.purpose, n.cancelled_at IS NOT NULL cancelled, m.state, m.id mail FROM notice n
			LEFT JOIN mail m ON m.notice_id=n.id WHERE n.source_record_id=${task} ORDER BY n.recipient_id, n.eligible_at`);
	const live = async (task: string) => (await notices(task)).filter((n) => !n.cancelled);
	const t = await create(owner, {
		title: "Book the venue",
		assigneeIds: [member.id],
		due: { kind: "local_date", date: "2099-01-15" },
	});
	assert.deepEqual(
		(await live(t.id)).map((n) => [n.recipient_id, n.state]),
		[
			[member.id, "pending"],
			[member.id, "pending"],
		],
	);
	const before = (await live(t.id)).map((n) => n.mail);
	const moved = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { assigneeIds: [admin2.id] } },
		}),
	).task;
	assert.deepEqual(
		(await live(t.id)).map((n) => n.recipient_id),
		[admin2.id, admin2.id],
	);
	const mailRows = await rows<MailRow>(
		sql`SELECT id, recipient_account_id recipient, notice_id notice FROM mail WHERE notice_id IN (SELECT id FROM notice WHERE source_record_id=${t.id})`,
	);
	const allowed = await gatedTransaction(f.db, (tx) => authorizeTaskReminders(tx, mailRows));
	assert.deepEqual(
		mailRows.filter((m) => allowed.has(m.id)).map((m) => m.recipient),
		[admin2.id, admin2.id],
	);
	assert.equal(
		before.some((id) => allowed.has(id)),
		false,
	);
	const prerequisite = await create(owner, { title: "Sign the lease" });
	const blocked = ok(
		await write(owner, "replacePrerequisites", {
			requestKey: randomUUID(),
			expectedRevision: moved.revision,
			input: { taskId: t.id, prerequisiteIds: [prerequisite.id] },
		}),
	).task;
	const repeating = ok(
		await write(owner, "configureRecurrence", {
			requestKey: randomUUID(),
			expectedRevision: blocked.revision,
			input: { taskId: t.id, rule: { frequency: "weekly", until: null } },
		}),
	).task;
	const replanned = await rows<MailRow>(
		sql`SELECT m.id, m.recipient_account_id recipient, m.notice_id notice FROM mail m JOIN notice n ON n.id=m.notice_id
			WHERE n.source_record_id=${t.id} AND n.cancelled_at IS NULL`,
	);
	const sendable = await gatedTransaction(f.db, (tx) => authorizeTaskReminders(tx, replanned));
	assert.deepEqual(
		replanned.filter((m) => sendable.has(m.id)).map((m) => m.recipient),
		[admin2.id, admin2.id],
	);
	ok(
		await write(admin2, "complete", {
			requestKey: randomUUID(),
			expectedRevision: repeating.revision,
			input: { taskId: t.id },
		}),
	);
	assert.deepEqual(await live(t.id), []);
	const pending = async (task: string) => (await live(task)).map((n) => [n.recipient_id, n.state]);
	const twice = [
		[admin2.id, "pending"],
		[admin2.id, "pending"],
	];
	const once = await recurring({
		title: "Order chairs",
		assigneeIds: [admin2.id],
		due: { kind: "local_date", date: "2099-02-01" },
	});
	const done = ok(
		await write(owner, "completeOccurrence", {
			requestKey: randomUUID(),
			expectedRevision: once.revision,
			input: { taskId: once.id },
		}),
	);
	assert.deepEqual([await pending(once.id), await pending(done.successor!.id)], [[], twice]);
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: done.successor!.revision,
			input: { taskId: done.successor!.id },
		}),
	);
	ok(
		await write(owner, "reopen", {
			requestKey: randomUUID(),
			expectedRevision: done.task.revision,
			input: { taskId: once.id },
		}),
	);
	assert.deepEqual(await pending(once.id), twice);
	const undated = await create(owner, { assigneeIds: [member.id] });
	const unassigned = await create(owner, { due: { kind: "local_date", date: "2099-01-15" } });
	assert.deepEqual([await notices(undated.id), await notices(unassigned.id)], [[], []]);
});

test("INV-statements: page reads are one statement and generated work costs the same for any batch size", async () => {
	const guests: string[] = [];
	for (let n = 0; n < 6; n++) guests.push(await person("Guest " + n));
	const batch = async (n: number) => {
		const m = await meeting("Batch " + n, "2099-01-10");
		const followUps = guests.slice(0, n).map((personId) => ({ personId, assigneeIds: [member.id] }));
		const origin = { at: "2099-01-11T00:00:00Z", date: "2099-01-10", zone: "America/Chicago" };
		return counted(() => finalize(m, { followUps, evaluation: { assigneeIds: [owner.id] } }, false, origin));
	};
	const [one, five] = [await batch(1), await batch(5)];
	assert.equal(one, 8);
	assert.equal(five, one);
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM notice WHERE recipient_id=${member.id} AND cancelled_at IS NULL AND eligible_at>'2099-01-01'`,
		),
		[{ n: 12 }],
	);
	const t = await create(owner, { title: "Read me" });
	const reads = async () => [
		await counted(() => read(owner, "list", { limit: 100 })),
		await counted(() => read(owner, "count", {})),
		await counted(() => read(owner, "get", { taskId: t.id })),
		await counted(() => read(owner, "statusHistory", { taskId: t.id })),
		await counted(() => read(owner, "listSubtasks", { parentId: t.id })),
		await counted(() => read(owner, "listPrerequisites", { taskId: t.id })),
		await counted(() => read(owner, "prerequisiteCandidates", { taskId: t.id })),
		await counted(() => read(owner, "findOpenOccurrence", { taskId: t.id })),
	];
	const few = await reads();
	for (let n = 0; n < 40; n++) await create(owner, { title: "More " + n, assigneeIds: [member.id] });
	assert.deepEqual([few, await reads()], [Array(8).fill(3), Array(8).fill(3)]);

	const bulkOf = async (n: number) => {
		const items: { taskId: string; expectedRevision: string }[] = [];
		for (let i = 0; i < n; i++) {
			const task = await recurring({ assigneeIds: [member.id], due: { kind: "local_date", date: "2099-02-01" } });
			items.push({ taskId: task.id, expectedRevision: task.revision });
		}
		const changed: number[] = [];
		const count = await counted(async () => {
			changed.push(ok(await write(owner, "bulkComplete", { requestKey: randomUUID(), items })).changed);
		});
		assert.deepEqual(changed, [n]);
		return count;
	};
	const [single, twenty] = [await bulkOf(1), await bulkOf(20)];
	assert.equal(twenty, single);
});

test("AC:TARGET-TSK-014 a delivered due reminder is not sent again after the deadline moves", async () => {
	const dispatch = async () => {
		for (const claim of await claimDue(f.db, ["mail"], 10)) await mail.dispatch(claim);
	};
	const before = sent.length;
	const first = (await dbNow()) + 86_400_000;
	const t = await create(owner, {
		title: "Print programs",
		assigneeIds: [member.id],
		due: deadline(first),
	});
	await arrive(first);
	await dispatch();
	assert.equal(sent.length, before + 1);
	const second = first + 3_600_000;
	ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { due: deadline(second) } },
		}),
	);
	await arrive(second);
	await dispatch();
	assert.equal(sent.length, before + 1);
	assert.deepEqual(
		await rows(
			sql`SELECT split_part(logical_key,'/',2) slot, to_char(eligible_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000Z"') eligible_at FROM notice WHERE source_record_id=${t.id} AND cancelled_at IS NULL`,
		),
		[
			{
				slot: "task_overdue",
				eligible_at: new Date(Date.parse(new Date(second).toISOString().slice(0, 19) + "Z") + 86_400_000).toISOString(),
			},
		],
	);
});

function deadline(ms: number) {
	const local = new Intl.DateTimeFormat("sv-SE", {
		timeZone: "America/Chicago",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
		.format(ms)
		.replace(" ", "T");
	const offsetSeconds = (Date.parse(`${local}Z`) - Math.floor(ms / 1000) * 1000) / 1000;
	return { kind: "resolved_instant", local, offsetSeconds };
}
const dispatch = async () => {
	for (const claim of await claimDue(f.db, ["mail"], 10)) await mail.dispatch(claim);
};
async function dbNow() {
	return Number((await rows(sql`SELECT (extract(epoch FROM clock_timestamp())*1000)::float8 AS ms`))[0]!.ms);
}
async function arrive(ms: number) {
	await f.admin.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE kind='mail' AND state IN ('ready','retry_wait') AND eligible_at<=${new Date(ms).toISOString()}::timestamptz`,
	);
}
test("AC:TARGET-TSK-014 a duty handed off when its person leaves reminds its new assignee", async () => {
	const linked = async (name: string) => {
		const a = await f.account();
		await f.seat(a, plant, "member");
		const id = await person(name);
		await f.admin.execute(sql`UPDATE person SET linked_account_id=${a.id} WHERE id=${id}`);
		return { ...a, person: id };
	};
	const [leaving, staying, moving, taking] = [
		await linked("Leaving Member"),
		await linked("Staying Member"),
		await linked("Moving Member"),
		await linked("Taking Member"),
	];
	await f.admin.execute(sql`UPDATE person SET stage='leader' WHERE id=${moving.person}`);
	const ctx = { session: owner.actor.session, selected: plant };
	const warnings = (id: string) =>
		gatedTransaction(f.db, (tx) => peopleReader.getStatusWarnings(tx, ctx, { personId: personId.parse(id) }));
	const handTo = (duties: readonly Versioned[], to: string) =>
		duties.map((d) => ({ kind: "assign", dutyId: d.id, expectedRevision: d.revision, toPersonId: to }));
	const due = (await dbNow()) + 86_400_000;
	const dated = (assigneeId: string, title: string) =>
		create(owner, { title, assigneeIds: [assigneeId], due: deadline(due) });
	const [retired, demoted] = [await dated(leaving.id, "Set up chairs"), await dated(moving.id, "Lead worship")];
	const review = ok(await warnings(leaving.person));
	ok(
		await withPeopleWrite(f.db, owner.actor, (tx, c) =>
			peopleWriter.retirePerson(
				tx,
				c,
				{
					requestKey: randomUUID(),
					expectedRevision: review.revision,
					input: {
						personId: leaving.person,
						reason: "Moved away",
						reviewRevision: review.reviewRevision,
						handoffs: handTo(review.openDuties, staying.person),
					},
				},
				reminders,
			),
		),
	);
	const stage = ok(await warnings(moving.person));
	ok(
		await withPeopleWrite(f.db, owner.actor, (tx, c) =>
			peopleWriter.changeStatus(
				tx,
				c,
				{
					requestKey: randomUUID(),
					expectedRevision: stage.revision,
					input: {
						personId: moving.person,
						stage: "prospect",
						reason: "Stepping back",
						handoffs: handTo(stage.openDuties, taking.person),
					},
				},
				reminders,
			),
		),
	);
	await arrive(due);
	await dispatch();
	const delivered = async (task: string) =>
		rows(sql`SELECT n.recipient_id, n.cancelled_at IS NOT NULL cancelled, m.state FROM notice n LEFT JOIN mail m ON m.notice_id=n.id
			WHERE n.source_record_id=${task} ORDER BY n.cancelled_at IS NOT NULL, n.eligible_at`);
	const handoffs: [string, string, string][] = [
		[retired.id, leaving.id, staying.id],
		[demoted.id, moving.id, taking.id],
	];
	for (const [task, from, to] of handoffs)
		assert.deepEqual(
			(await delivered(task)).map((n) => [n.recipient_id, n.cancelled, n.state]),
			[
				[to, false, "accepted"],
				[to, false, "pending"],
				[from, true, "cancelled"],
				[from, true, "cancelled"],
			],
		);
});

test("AC:TARGET-TSK-014 AC:TARGET-IDN-019 a duty handed off when a seat is removed reminds its new assignee", async () => {
	const seated = async () => {
		const a = await f.account();
		return { ...a, seat: await f.seat(a, plant, "member") };
	};
	const [leaving, taking] = [await seated(), await seated()];
	const due = (await dbNow()) + 86_400_000;
	const dated = (title: string) => create(owner, { title, assigneeIds: [leaving.id], due: deadline(due) });
	const [handed, unowned] = [await dated("Print bulletins"), await dated("Order supplies")];
	const review = await f.seats.readRemoval(owner.session, plant, { seatId: leaving.seat });
	const result = await f.seats.remove(
		owner.actor,
		plant,
		{
			requestKey: randomUUID(),
			expectedRevision: review.expectedRevision,
			input: {
				seatId: review.seatId,
				expectedRole: review.expectedRole,
				handoffs: review.duties.map((d) =>
					d.dutyId === handed.id
						? { kind: "assign", dutyId: d.dutyId, expectedRevision: d.expectedRevision, recipientAccountId: taking.id }
						: { kind: "needs_owner", dutyId: d.dutyId, expectedRevision: d.expectedRevision },
				),
			},
		},
		reminders,
	);
	assert.equal(result.outcome, "changed");
	await arrive(due);
	await dispatch();
	const delivered = async (task: string) =>
		(
			await rows(sql`SELECT n.recipient_id, n.cancelled_at IS NOT NULL cancelled, m.state FROM notice n LEFT JOIN mail m ON m.notice_id=n.id
			WHERE n.source_record_id=${task} ORDER BY n.cancelled_at IS NOT NULL, n.eligible_at`)
		).map((n) => [n.recipient_id, n.cancelled, n.state]);
	assert.deepEqual(await delivered(handed.id), [
		[taking.id, false, "accepted"],
		[taking.id, false, "pending"],
		[leaving.id, true, "cancelled"],
		[leaving.id, true, "cancelled"],
	]);
	assert.deepEqual(await delivered(unowned.id), [
		[leaving.id, true, "cancelled"],
		[leaving.id, true, "cancelled"],
	]);
});

test("INV-tenancy: a seat ended, demoted or signed out after the viewer lookup reads no task data", async () => {
	const t = await create(owner, { title: "Private plan" });
	const seated = async (role: "owner" | "admin" | "member") => {
		const a = await f.account();
		const seat = await f.seat(a, plant, role);
		return { ...a, seat, actor: await f.actor(a.session) };
	};
	const reads = (): [keyof Reads, object | undefined][] => [
		["get", { taskId: t.id }],
		["list", {}],
		["count", {}],
		["statusHistory", { taskId: t.id }],
		["listSubtasks", { parentId: t.id }],
		["listPrerequisites", { taskId: t.id }],
		["findOpenOccurrence", { taskId: t.id }],
		["eligibleAssignees", undefined],
		["relationOptions", { kind: "person" }],
		["prerequisiteCandidates", { taskId: t.id }],
	];
	const [removed, demoted, signedOut] = [await seated("admin"), await seated("admin"), await seated("admin")];
	for (const who of [removed, demoted, signedOut]) for (const [op, input] of reads()) ok(await read(who, op, input));
	await f.admin.execute(sql`UPDATE seat SET ended_at=now() WHERE id=${removed.seat}`);
	await f.admin.execute(sql`UPDATE seat SET role='member' WHERE id=${demoted.seat}`);
	await f.admin.execute(sql`UPDATE auth_session SET expires_at=now() WHERE id=${signedOut.session}`);
	for (const who of [removed, signedOut])
		for (const [op, input] of reads()) refused(await read(who, op, input), "unavailable");
	assert.equal(available(ok(await read(demoted, "get", { taskId: t.id }))).id, t.id);
	for (const [op, input] of reads().slice(7)) refused(await read(demoted, op, input), "unavailable");
});

const get = async (who: Who, taskId: string) => available(ok(await read(who, "get", { taskId })));
const tick = (who: Who, parent: { id: string }, child: Versioned, complete: boolean) =>
	write(who, "setSubtaskCompletion", {
		requestKey: randomUUID(),
		expectedRevision: child.revision,
		input: { parentId: parent.id, taskId: child.id, complete },
	});

test("AC:TARGET-TSK-005 AC:EVRY-REAL-CHILD-TASK-PARITY checklist rows are one-level tasks with their own assignee and history", async () => {
	const child = (who: Who, parent: Versioned, input: object) =>
		write(who, "createSubtask", {
			requestKey: randomUUID(),
			expectedRevision: parent.revision,
			input: { parentId: parent.id, title: "Item", ...input },
		});
	const p = await create(owner, { title: "Plan picnic", assigneeIds: [admin2.id] });
	const inherited = ok(await child(owner, p, {})).task;
	const c = ok(await child(owner, p, { title: "Call venue", assigneeIds: [member.id] })).task;
	const unassigned = ok(await child(owner, p, { assigneeIds: [] })).task;
	assert.deepEqual(
		[inherited.assignees[0]!.accountId, c.assignees[0]!.accountId, unassigned.assignees],
		[admin2.id, member.id, []],
	);
	refused(await child(owner, p, { assigneeIds: [foreign.id] }), "invalid_subject");
	refused(await child(owner, c, {}), "invalid_subject");
	refused(await child(foreign, p, {}), "unavailable");
	refused(await child(owner, { ...p, revision: "9" }, {}), "conflict");
	const pa = await create(owner, { title: "Member plan", assigneeIds: [member.id] });
	const l = ok(await child(member, pa, {})).task;
	assert.equal(l.assignees[0]!.accountId, member.id);
	for (const assigneeIds of [[owner.id], [], [member.id]])
		refused(await child(member, pa, { assigneeIds }), "access_denied");
	refused(await child(member, p, {}), "unavailable");

	const ticked = ok(await tick(member, p, c, true)).task;
	assert.equal(ticked.status, "complete");
	refused(await tick(member, p, inherited, true), "unavailable");
	const pm = await create(owner, { title: "Member parent", assigneeIds: [member.id] });
	const x = await subtask(owner, pm, "Someone else's row");
	await write(owner, "edit", {
		requestKey: randomUUID(),
		expectedRevision: x.revision,
		input: { taskId: x.id, patch: { assigneeIds: [admin2.id] } },
	});
	refused(await tick(member, pm, await get(owner, x.id), true), "unavailable");
	refused(await tick(member, pa, ticked, false), "unavailable");
	for (const row of [inherited, unassigned]) ok(await tick(owner, p, row, true));
	const parent = await get(owner, p.id);
	assert.deepEqual([parent.status, parent.revision, parent.checklist], ["not_started", "1", { total: 3, complete: 3 }]);
	const reopened = ok(await tick(member, p, ticked, false)).task;
	assert.equal(reopened.status, "not_started");
	const history = ok(await read(member, "statusHistory", { taskId: c.id })).items.map((h) => [h.from, h.to]);
	assert.deepEqual(history, [
		[null, "not_started"],
		["not_started", "complete"],
		["complete", "not_started"],
	]);
	const page = ok(await read(member, "listSubtasks", { parentId: p.id }));
	assert.deepEqual(
		page.items.map((k) => k.id),
		[inherited.id, c.id, unassigned.id],
	);

	refused(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: reopened.revision,
			input: { taskId: c.id, patch: { due: { kind: "local_date", date: "2026-10-20" } } },
		}),
		"invalid_input",
	);
	await assert.rejects(
		f.admin.execute(sql`UPDATE task SET due_kind='date_only', due_date='2026-10-20' WHERE id=${c.id}`),
	);
	await assert.rejects(f.admin.execute(sql`UPDATE task SET prerequisite_ids=ARRAY[${p.id}]::uuid[] WHERE id=${c.id}`));

	const full = await create(owner, { title: "Full" });
	await f.admin
		.execute(sql`INSERT INTO task (id, plant_id, title, category, priority, status, created_at, due_kind, parent_id)
		SELECT gen_random_uuid(), ${plant.id}, 'Row ' || n, 'general', 'medium', 'not_started', now(), 'undated', ${full.id}
		FROM generate_series(1, 500) n`);
	refused(await child(owner, full, {}), "invalid_input");
	assert.equal((await get(owner, full.id)).checklistItems.length, 500);

	const remove = (who: Who, row: Versioned) =>
		write(who, "removeSubtask", {
			requestKey: randomUUID(),
			expectedRevision: row.revision,
			input: { parentId: p.id, taskId: row.id },
		});
	refused(await remove(member, reopened), "unavailable");
	ok(await remove(owner, reopened));
	const after = await get(owner, p.id);
	assert.deepEqual([after.revision, after.checklist], ["1", { total: 2, complete: 2 }]);
	assert.equal(ok(await read(owner, "statusHistory", { taskId: c.id })).items.length, 3);
});

test("AC:TARGET-TSK-006 prerequisites never form a cycle, even proposed at once, and settled or deleted ones stop blocking", async () => {
	const replace = (who: Who, task: Versioned, ids: readonly string[], requestKey: string = randomUUID()) =>
		write(who, "replacePrerequisites", {
			requestKey,
			expectedRevision: task.revision,
			input: { taskId: task.id, prerequisiteIds: ids },
		});
	const [a, b, c] = [
		await create(owner, { title: "A" }),
		await create(owner, { title: "B" }),
		await create(owner, { title: "C" }),
	];
	const key = randomUUID();
	const aNeedsB = ok(await replace(owner, a, [b.id], key));
	assert.deepEqual(ok(await replace(owner, a, [b.id], key)), aNeedsB);
	ok(await replace(owner, b, [c.id]));
	refused(await replace(owner, c, [a.id]), "dependency_cycle");
	assert.deepEqual((await get(owner, c.id)).prerequisiteIds, []);
	const gone = await create(owner, { title: "Gone" });
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: gone.revision,
			input: { taskId: gone.id },
		}),
	);
	const row = await subtask(owner, c, "Row");
	const theirs = await create(foreign, { title: "Theirs" });
	const fresh = await get(owner, c.id);
	for (const id of [c.id, theirs.id, gone.id, row.id]) refused(await replace(owner, fresh, [id]), "invalid_subject");
	refused(await replace(member, fresh, [b.id]), "unavailable");
	const named = ok(await read(owner, "listRows", { taskIds: [a.id, b.id, c.id, gone.id, theirs.id] }));
	assert.deepEqual(Object.fromEntries(named.items.map((t) => [t.title, t.openPrerequisites])), { A: 1, B: 1, C: 0 });
	assert.deepEqual(
		ok(await read(owner, "prerequisiteCandidates", { taskId: c.id })).items.filter((t) =>
			[a.id, b.id, c.id].includes(t.id),
		),
		[],
	);

	const both = async (pairs: readonly [Versioned, Versioned][]) => {
		const results = await raced(
			f.admin,
			f.db,
			sql`SELECT FROM task WHERE id IN (${sql.join(
				pairs.map(([from]) => sql`${from.id}`),
				sql`,`,
			)}) ORDER BY id FOR UPDATE`,
			pairs.map(
				([from, to]) =>
					() =>
						replace(owner, from, [to.id]),
			),
		);
		return results.map((r) => (r.status === "ok" ? "ok" : r.error.code));
	};
	const [x, y] = [await create(owner, { title: "X" }), await create(owner, { title: "Y" })];
	assert.deepEqual(
		await both([
			[x, y],
			[y, x],
		]),
		["ok", "dependency_cycle"],
	);
	const [p, q, r, s] = await Promise.all(["P", "Q", "R", "S"].map((title) => create(owner, { title })));
	const pq = ok(await replace(owner, p!, [q!.id])).task,
		rs = ok(await replace(owner, r!, [s!.id])).task;
	assert.deepEqual(
		await both([
			[q!, r!],
			[s!, p!],
		]),
		["ok", "dependency_cycle"],
	);
	assert.ok(pq && rs);

	const [open, waived, deleted] = [
		await create(owner, { title: "Open" }),
		await create(owner, { title: "Waived" }),
		await create(owner, { title: "Deleted" }),
	];
	const t = ok(
		await replace(owner, await create(owner, { title: "Dependent" }), [open.id, waived.id, deleted.id]),
	).task;
	assert.deepEqual([t.openPrerequisites, t.status], [3, "not_started"]);
	ok(
		await write(owner, "waive", {
			requestKey: randomUUID(),
			expectedRevision: waived.revision,
			input: { taskId: waived.id },
		}),
	);
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: deleted.revision,
			input: { taskId: deleted.id },
		}),
	);
	const list = ok(await read(member, "listPrerequisites", { taskId: t.id }));
	assert.deepEqual(
		list.items.map((i) => [i.title, i.deleted, i.blocking]),
		[
			["Open", false, true],
			["Waived", false, false],
			["Deleted", true, false],
		],
	);
	assert.equal((await get(owner, t.id)).openPrerequisites, 1);
	const done = ok(
		await write(owner, "complete", { requestKey: randomUUID(), expectedRevision: t.revision, input: { taskId: t.id } }),
	);
	assert.equal(done.task.status, "complete");
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM task WHERE id IN (${waived.id},${deleted.id}) AND completed_at IS NOT NULL`,
		),
		[{ n: 0 }],
	);
	assert.deepEqual(
		await rows(
			sql`SELECT before_value, after_value FROM audit_event WHERE subject_id=${a.id} AND after_value ? 'prerequisite_ids'`,
		),
		[{ before_value: { prerequisite_ids: [] }, after_value: { prerequisite_ids: [b.id] } }],
	);
});

test("AC:TARGET-TSK-005 ticking, nesting, overriding and removing a checklist row changes exactly that row and leaves its parent alone", async () => {
	const parent = await create(owner, {
		title: "Plan picnic",
		assigneeIds: [admin2.id],
		due: { kind: "local_date", date: "2026-10-13" },
		relation: { kind: "person", id: await person("Lia Costa") },
	});
	const add = (who: Who, under: Versioned, input: object) =>
		write(who, "createSubtask", {
			requestKey: randomUUID(),
			expectedRevision: under.revision,
			input: { parentId: under.id, title: "Row", ...input },
		});
	const row = async (title: string, assigneeId: string) =>
		ok(await add(admin2, parent, { title, assigneeIds: [assigneeId] })).task;
	const [call, chairs] = [await row("Call venue", member.id), await row("Bring chairs", admin2.id)];
	const plan = await create(owner, { title: "Member plan", assigneeIds: [member.id] });
	const stored = (id: string) => rows(sql`SELECT to_jsonb(t) AS row FROM task t WHERE id=${id}`);
	const kept = await stored(parent.id);
	const none = { jobs: [], notices: 0, mail: 0 };

	const ticking = {
		requestKey: randomUUID(),
		expectedRevision: call.revision,
		input: { parentId: parent.id, taskId: call.id, complete: true },
	};
	const ticked = await recorded(f.admin, () => write(admin2, "setSubtaskCompletion", ticking));
	const changed = ok(ticked.value);
	assert.deepEqual([changed.outcome, changed.task.status], ["changed", "complete"]);
	assert.deepEqual(ticked.added, { audits: ["tasks.completed"], ...none });
	assert.deepEqual(await rows(sql`SELECT subject_id, actor_id FROM audit_event WHERE id=${changed.receiptId}`), [
		{ subject_id: call.id, actor_id: admin2.id },
	]);
	assert.deepEqual(
		await rows(sql`SELECT count(*)::int AS n FROM contact_outcome WHERE task_id IN (${call.id},${parent.id})`),
		[{ n: 0 }],
	);
	assert.deepEqual(
		await untouched(f.admin, async () => ok(await write(admin2, "setSubtaskCompletion", ticking))),
		changed,
	);
	assert.deepEqual(await stored(parent.id), kept);

	for (const under of [changed.task, chairs])
		refused(await untouched(f.admin, () => add(admin2, under, { title: "Nested" })), "invalid_subject");
	for (const parentId of [parent.id, plan.id])
		refused(
			await untouched(f.admin, () =>
				write(admin2, "edit", {
					requestKey: randomUUID(),
					expectedRevision: parent.revision,
					input: { taskId: parent.id, patch: { parentId } },
				}),
			),
			"invalid_input",
		);
	for (const assigneeIds of [[admin2.id], [owner.id], []])
		refused(await untouched(f.admin, () => add(member, plan, { title: "Buy cups", assigneeIds })), "access_denied");
	const own = await recorded(f.admin, () => add(member, plan, { title: "Buy cups" }));
	assert.deepEqual(own.added, { audits: ["tasks.changed"], ...none });
	assert.deepEqual(
		ok(own.value).task.assignees.map((a) => a.accountId),
		[member.id],
	);
	refused(await untouched(f.admin, () => tick(member, parent, chairs, true)), "unavailable");
	refused(await untouched(f.admin, () => tick(foreign, parent, chairs, true)), "unavailable");
	assert.equal(ok(await tick(member, plan, ok(own.value).task, true)).task.status, "complete");

	const unowned = await recorded(f.admin, () => add(admin2, parent, { title: "Unowned", assigneeIds: [] }));
	const { task } = ok(unowned.value);
	assert.deepEqual(unowned.added, { audits: ["tasks.changed"], ...none });
	assert.deepEqual([task.assignees, task.due, task.recurrence, task.relation], [[], { kind: "undated" }, null, null]);

	const before = ok(await read(admin2, "statusHistory", { taskId: chairs.id }));
	const removing = {
		requestKey: randomUUID(),
		expectedRevision: chairs.revision,
		input: { parentId: parent.id, taskId: chairs.id },
	};
	for (const who of [member, foreign])
		refused(await untouched(f.admin, () => write(who, "removeSubtask", removing)), "unavailable");
	const removed = await recorded(f.admin, () => write(admin2, "removeSubtask", removing));
	assert.equal(ok(removed.value).task.deleted, true);
	assert.deepEqual(removed.added, { audits: ["tasks.changed"], ...none });
	assert.deepEqual(
		await untouched(f.admin, async () => ok(await write(admin2, "removeSubtask", removing))),
		ok(removed.value),
	);
	assert.deepEqual(await rows(sql`SELECT subject_id, kind FROM audit_event WHERE id=${ok(removed.value).receiptId}`), [
		{ subject_id: chairs.id, kind: "remove" },
	]);
	assert.deepEqual(ok(await read(admin2, "statusHistory", { taskId: chairs.id })), before);
	assert.equal(before.items.length, 1);
	assert.deepEqual(await rows(sql`SELECT deleted_at IS NOT NULL AS deleted FROM task WHERE id=${chairs.id}`), [
		{ deleted: true },
	]);
	assert.equal(
		(await get(admin2, parent.id)).checklistItems.some((k) => k.id === chairs.id),
		false,
	);
	assert.deepEqual(await stored(parent.id), kept);
});

test("AC:TARGET-TSK-006 a refused edge writes nothing, only open prerequisites block, and neither they nor a status set to blocked by hand stop completion", async () => {
	const replace = (task: Versioned, ids: readonly string[], requestKey: string = randomUUID()) =>
		write(admin2, "replacePrerequisites", {
			requestKey,
			expectedRevision: task.revision,
			input: { taskId: task.id, prerequisiteIds: ids },
		});
	const command = <K extends keyof Writes>(op: K, t: Versioned, input: object = {}) =>
		write(admin2, op, { requestKey: randomUUID(), expectedRevision: t.revision, input: { taskId: t.id, ...input } });
	const task = (title: string) => create(admin2, { title });
	const [ta, tb, tc] = [await task("TA"), await task("TB"), await task("TC")];
	const key = randomUUID();
	const edge = await recorded(f.admin, () => replace(ta, [tb.id], key));
	ok(edge.value);
	assert.deepEqual(edge.added, { audits: ["tasks.changed"], jobs: [], notices: 0, mail: 0 });
	assert.deepEqual(await untouched(f.admin, () => replace(ta, [tb.id], key)), edge.value);
	ok(await replace(tb, [tc.id]));
	refused(await untouched(f.admin, () => replace(tc, [ta.id])), "dependency_cycle");
	refused(await untouched(f.admin, () => replace(tc, [tb.id])), "dependency_cycle");
	refused(await untouched(f.admin, () => replace(tc, [tc.id])), "invalid_subject");
	const theirs = await create(foreign, { title: "Theirs" });
	refused(await untouched(f.admin, () => replace(tc, [theirs.id])), "invalid_subject");
	const fresh = await task("Fresh");
	refused(await untouched(f.admin, () => replace(tc, [fresh.id, theirs.id])), "invalid_subject");
	assert.deepEqual((await get(admin2, tc.id)).prerequisiteIds, []);
	assert.deepEqual(ok(await replace(tc, [fresh.id])).task.prerequisiteIds, [fresh.id]);

	const [open, waived, deleted] = [await task("Open"), await task("Waived"), await task("Deleted")];
	const d = ok(await replace(await task("D"), [open.id, waived.id, deleted.id])).task;
	assert.deepEqual([d.status, d.openPrerequisites, d.revision], ["not_started", 3, "2"]);
	ok(await command("waive", waived));
	ok(await command("delete", deleted));
	const blocking = async () => {
		const list = ok(await read(admin2, "listPrerequisites", { taskId: d.id }));
		return [list.blocked, list.items.map((i) => [i.title, i.status, i.deleted, i.blocking])];
	};
	await untouched(f.admin, async () =>
		assert.deepEqual(await blocking(), [
			true,
			[
				["Open", "not_started", false, true],
				["Waived", "no_longer_needed", false, false],
				["Deleted", "not_started", true, false],
			],
		]),
	);
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id IN (${waived.id},${deleted.id}) AND action='tasks.completed'`,
		),
		[{ n: 0 }],
	);
	const manual = ok(await command("changeStatus", open, { status: "blocked" })).task;
	assert.deepEqual([manual.status, manual.openPrerequisites], ["blocked", 0]);
	assert.equal((await blocking())[0], true);
	const badge = await get(admin2, d.id);
	assert.deepEqual([badge.status, badge.openPrerequisites, badge.revision], ["not_started", 1, "2"]);
	const done = await recorded(f.admin, () => command("complete", badge));
	assert.deepEqual([ok(done.value).outcome, ok(done.value).task.status], ["changed", "complete"]);
	assert.deepEqual(done.added, { audits: ["tasks.completed"], jobs: [], notices: 0, mail: 0 });
	assert.deepEqual(await rows(sql`SELECT subject_id FROM audit_event WHERE id=${ok(done.value).receiptId}`), [
		{ subject_id: d.id },
	]);
	assert.deepEqual((await get(admin2, d.id)).prerequisiteIds, [open.id, waived.id, deleted.id]);
	assert.equal(ok(await command("complete", manual)).task.status, "complete");
	assert.deepEqual((await blocking())[0], false);
});

test("AC:TARGET-TSK-006 a write that settles, reopens or deletes a prerequisite answers with the new counts of the tasks waiting on it", async () => {
	const command = <K extends keyof Writes>(op: K, task: Versioned, input: object = {}) =>
		write(owner, op, {
			requestKey: randomUUID(),
			expectedRevision: task.revision,
			input: { taskId: task.id, ...input },
		});
	const [one, two, three] = await Promise.all(["One", "Two", "Three"].map((title) => create(owner, { title })));
	const needs = async (title: string, ids: readonly string[]) =>
		ok(await command("replacePrerequisites", await create(owner, { title }), { prerequisiteIds: ids })).task;
	const both = await needs("Both", [one!.id, two!.id]);
	const all = await needs("All", [one!.id, two!.id, three!.id]);
	const counts = (answer: { recounted: readonly { taskId: string; openPrerequisites: number }[] }) =>
		Object.fromEntries(answer.recounted.map((r) => [r.taskId === both.id ? "Both" : "All", r.openPrerequisites]));

	const done = ok(await command("complete", one!));
	assert.deepEqual(counts(done), { Both: 1, All: 2 });
	assert.deepEqual(ok(await command("changeStatus", two!, { status: "in_progress" })).recounted, []);
	assert.deepEqual(counts(ok(await command("reopen", done.task))), { Both: 2, All: 3 });
	const fresh = await Promise.all([one, two].map((t) => get(owner, t!.id)));
	const bulk = ok(
		await write(owner, "bulkComplete", {
			requestKey: randomUUID(),
			items: fresh.map((t) => ({ taskId: t.id, expectedRevision: t.revision })),
		}),
	);
	assert.deepEqual(counts(bulk), { Both: 0, All: 1 });
	assert.deepEqual(counts(ok(await command("delete", three!))), { All: 0 });
	assert.deepEqual(
		ok(await read(owner, "listRows", { taskIds: [both.id, all.id] })).items.map((t) => t.openPrerequisites),
		[0, 0],
	);
});

test("AC:TARGET-TSK-007 AC:TARGET-TSK-018 completing a recurring task creates exactly one next task with a fresh checklist", async () => {
	const complete = (who: Who, task: Versioned, requestKey: string = randomUUID()) =>
		write(who, "completeOccurrence", { requestKey, expectedRevision: task.revision, input: { taskId: task.id } });
	const due = (date: string) => ({ kind: "local_date", date });
	const t = await recurring(
		{ title: "Pay rent", assigneeIds: [member.id], due: due("2026-01-31") },
		{ frequency: "monthly", until: null },
	);
	const item = await subtask(owner, t, "Call venue");
	ok(await tick(owner, t, item, true));
	const key = randomUUID(),
		reviewed = await get(owner, t.id);
	const first = ok(await complete(member, reviewed, key));
	assert.deepEqual(ok(await complete(member, reviewed, key)), first);
	assert.deepEqual(
		[first.task.status, first.successor!.due, first.successor!.assignees[0]!.accountId],
		["complete", due("2026-02-28"), member.id],
	);
	assert.deepEqual(
		first.successor!.checklistItems.map((k) => [k.title, k.status]),
		[["Call venue", "not_started"]],
	);
	assert.equal((await get(owner, t.id)).checklistItems[0]!.status, "complete");
	assert.deepEqual(
		await rows(sql`SELECT due_kind, completed_at, series_id FROM task WHERE parent_id=${first.successor!.id}`),
		[{ due_kind: "undated", completed_at: null, series_id: null }],
	);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM task WHERE predecessor_id=${t.id}`), [{ n: 1 }]);
	const open = ok(await read(member, "findOpenOccurrence", { taskId: t.id }));
	assert.deepEqual(seriesOf(open).open, {
		taskId: first.successor!.id,
		occurrence: 2,
		predecessorId: t.id,
		revision: "1",
	});
	refused(
		await write(owner, "reopen", {
			requestKey: randomUUID(),
			expectedRevision: first.task.revision,
			input: { taskId: t.id },
		}),
		"open_successor",
	);
	ok(
		await write(owner, "delete", {
			requestKey: randomUUID(),
			expectedRevision: first.successor!.revision,
			input: { taskId: first.successor!.id },
		}),
	);
	const reopened = ok(
		await write(owner, "reopen", {
			requestKey: randomUUID(),
			expectedRevision: first.task.revision,
			input: { taskId: t.id },
		}),
	).task;
	const again = ok(await complete(owner, reopened));
	assert.deepEqual([again.successor?.due, again.successor?.occurrenceId], [due("2026-02-28"), "2"]);
	assert.deepEqual(seriesOf(ok(await read(member, "findOpenOccurrence", { taskId: t.id }))).open, {
		taskId: again.successor!.id,
		occurrence: 2,
		predecessorId: t.id,
		revision: "1",
	});

	const cases: [object, NonNullable<Parameters<typeof recurring>[1]>, object | null][] = [
		[due("2024-02-29"), { frequency: "yearly", until: null }, due("2025-02-28")],
		[due("2026-01-31"), { frequency: "monthly", until: "2026-02-28" }, due("2026-02-28")],
		[due("2026-01-28"), { frequency: "monthly", until: "2026-02-27" }, null],
		[due("2026-01-05"), { frequency: "weekly", until: null }, due("2026-01-12")],
		[due("2026-01-05"), { frequency: "biweekly", until: null }, due("2026-01-19")],
		[due("2026-01-15"), { frequency: "quarterly", until: null }, due("2026-04-15")],
		[
			due("2026-03-07"),
			{ frequency: "daily", until: null, localTime: "02:30" },
			{
				kind: "resolved_instant",
				local: "2026-03-08T03:30:00",
				zone: "America/Chicago",
				instant: "2026-03-08T08:30:00.000Z",
				offsetSeconds: -18000,
			},
		],
	];
	for (const [from, rule, expected] of cases) {
		const task = await recurring({ due: from }, rule);
		const result = ok(await complete(owner, task));
		assert.deepEqual(result.successor?.due ?? null, expected, JSON.stringify(rule));
		if (rule.frequency === "weekly") assert.equal(result.successor!.overdue, true);
	}
	const undated = ok(await complete(owner, await recurring({})));
	const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
	const week = new Date(Date.parse(today + "T00:00:00Z") + 7 * 86_400_000).toISOString().slice(0, 10);
	assert.deepEqual(undated.successor!.due, due(week));

	const raced = await recurring({ due: due("2026-05-01") });
	const results = await Promise.all([complete(owner, raced), complete(owner, raced)]);
	assert.deepEqual(results.map((r) => (r.status === "ok" ? "ok" : r.error.code)).sort(), ["conflict", "ok"]);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM task WHERE predecessor_id=${raced.id}`), [{ n: 1 }]);

	const failing = await recurring({ due: due("2026-06-01") });
	await subtask(owner, failing, "Fail copy");
	const fault = "tasks_fail_copy";
	await f.admin.execute(
		sql.raw(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.title='Fail copy' AND NEW.parent_id IS NOT NULL AND TG_OP='INSERT' THEN RAISE EXCEPTION 'fault'; END IF; RETURN NEW; END $$`),
	);
	const retry = randomUUID();
	try {
		await f.admin.execute(
			sql.raw(`CREATE TRIGGER ${fault} BEFORE INSERT ON task FOR EACH ROW EXECUTE FUNCTION ${fault}()`),
		);
		await assert.rejects(complete(owner, failing, retry));
	} finally {
		await f.admin.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fault} ON task; DROP FUNCTION IF EXISTS ${fault}()`));
	}
	assert.equal((await get(owner, failing.id)).status, "not_started");
	const recovered = ok(await complete(owner, failing, retry));
	assert.deepEqual(
		recovered.successor!.checklistItems.map((k) => k.title),
		["Fail copy"],
	);

	const stopped = await recurring({ due: due("2026-07-01") });
	const halted = ok(
		await write(owner, "configureRecurrence", {
			requestKey: randomUUID(),
			expectedRevision: stopped.revision,
			input: { taskId: stopped.id, rule: null },
		}),
	).task;
	assert.equal(halted.recurrence!.stopped, true);
	assert.equal(ok(await complete(owner, halted)).successor, null);
	refused(
		await write(owner, "configureRecurrence", {
			requestKey: randomUUID(),
			expectedRevision: halted.revision,
			input: { taskId: stopped.id, rule: { frequency: "weekly", until: null, count: 3 } },
		}),
		"invalid_input",
	);
});

test("AC:TARGET-TSK-006 saving the same prerequisites in another order is a no-op", async () => {
	const [a, b] = [await create(owner, { title: "First" }), await create(owner, { title: "Second" })];
	const task = await create(owner, { title: "Blocked" });
	const replace = (t: Versioned, ids: readonly string[]) =>
		write(owner, "replacePrerequisites", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, prerequisiteIds: ids },
		});
	const saved = ok(await replace(task, [a.id, b.id]));
	const history = async () =>
		(
			await rows(
				sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${task.id}
				AND (before_value IS NOT NULL OR after_value IS NOT NULL)`,
			)
		)[0]!.n;
	const entries = await history();
	const reordered = ok(await replace(saved.task, [b.id, a.id]));
	assert.equal(reordered.outcome, "noop");
	const read = await get(owner, task.id);
	assert.deepEqual([read.revision, read.prerequisiteIds], [saved.task.revision, [a.id, b.id]]);
	assert.equal(await history(), entries);
});

test("AC:TARGET-TSK-007 Make it repeat on an older occurrence of a stopped series starts a new series from it", async () => {
	const complete = (task: Versioned, requestKey: string = randomUUID()) =>
		write(owner, "completeOccurrence", { requestKey, expectedRevision: task.revision, input: { taskId: task.id } });
	const configure = (task: Versioned, rule: object | null) =>
		write(owner, "configureRecurrence", {
			requestKey: randomUUID(),
			expectedRevision: task.revision,
			input: { taskId: task.id, rule },
		});
	const first = await recurring({ title: "Count offering", due: { kind: "local_date", date: "2026-09-07" } });
	const second = ok(await complete(first)).successor!;
	const third = ok(await complete(second)).successor!;
	const old = first.recurrence!.seriesId;
	ok(await configure(third, null));
	const oldSeries = async () => ({
		rule: await rows(
			sql`SELECT interval, stopped_at IS NOT NULL AS stopped, revision::text FROM recurrence WHERE id=${old}`,
		),
		tasks: await rows(
			sql`SELECT t.id, t.series_id, t.occurrence_key, t.status, t.revision::text,
				(SELECT count(*)::int FROM audit_event a WHERE a.subject_id=t.id) AS history
			FROM task t WHERE t.id IN (${first.id}, ${third.id}) ORDER BY t.occurrence_key`,
		),
	});
	const before = await oldSeries();

	const rule = { frequency: "monthly", until: null, localTime: null };
	const restarted = ok(await configure(await get(owner, second.id), rule)).task;
	assert.equal(restarted.occurrenceId, "1");
	assert.notEqual(restarted.recurrence!.seriesId, old);
	assert.deepEqual((await get(owner, second.id)).recurrence, {
		seriesId: restarted.recurrence!.seriesId,
		...rule,
		stopped: false,
	});
	assert.deepEqual(await oldSeries(), before);
	assert.equal(before.rule[0]!.stopped, true);
	assert.equal(ok(await complete(await get(owner, third.id))).successor, null);

	const reopened = ok(
		await write(owner, "reopen", {
			requestKey: randomUUID(),
			expectedRevision: restarted.revision,
			input: { taskId: second.id },
		}),
	).task;
	const key = randomUUID();
	const done = ok(await complete(reopened, key));
	assert.deepEqual(
		[done.successor!.occurrenceId, done.successor!.recurrence!.seriesId, done.successor!.due],
		["2", restarted.recurrence!.seriesId, { kind: "local_date", date: "2026-10-14" }],
	);
	assert.deepEqual(ok(await complete(reopened, key)), done);
	ok(await complete(await get(owner, second.id)));
	assert.deepEqual(
		await rows(
			sql`SELECT series_id, occurrence_key FROM task WHERE predecessor_id=${second.id} AND deleted_at IS NULL
			ORDER BY occurrence_key`,
		),
		[
			{ series_id: restarted.recurrence!.seriesId, occurrence_key: "2" },
			{ series_id: old, occurrence_key: "3" },
		],
	);
});

test("AC:TARGET-TSK-008 bulk changes report each task, commit all valid tasks or none, and never repeat on retry", async () => {
	const bulk = <K extends keyof Writes>(
		who: Who,
		op: K,
		tasks: readonly Versioned[],
		extra: object = {},
		requestKey: string = randomUUID(),
	) =>
		write(who, op, {
			requestKey,
			items: tasks.map((t) => ({ taskId: t.id, expectedRevision: t.revision })),
			...extra,
		});
	const mine = await create(owner, { title: "Mine", assigneeIds: [member.id] });
	const others = await create(owner, { title: "Others" });
	const series = await recurring({
		title: "Weekly",
		assigneeIds: [member.id],
		due: { kind: "local_date", date: "2026-10-01" },
	});
	const waived = await create(owner, { title: "Waived", assigneeIds: [member.id] });
	const w = ok(
		await write(owner, "waive", {
			requestKey: randomUUID(),
			expectedRevision: waived.revision,
			input: { taskId: waived.id },
		}),
	).task;
	const changed = await create(owner, { title: "Changed", assigneeIds: [member.id] });
	const stale = { ...changed };
	await write(owner, "edit", {
		requestKey: randomUUID(),
		expectedRevision: changed.revision,
		input: { taskId: changed.id, patch: { title: "Changed again" } },
	});
	const theirs = await create(foreign, { title: "Theirs" });
	const missing = { id: randomUUID(), revision: "1" };
	const boom = await create(owner, { title: "Boom", assigneeIds: [member.id] });
	const selection = [mine, others, series, series, w, stale, theirs, missing, boom];

	const fault = "tasks_fail_bulk";
	await f.admin.execute(
		sql.raw(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.title='Boom' AND NEW.status='complete' THEN RAISE EXCEPTION 'fault'; END IF; RETURN NEW; END $$`),
	);
	const key = randomUUID();
	try {
		await f.admin.execute(
			sql.raw(`CREATE TRIGGER ${fault} BEFORE UPDATE ON task FOR EACH ROW EXECUTE FUNCTION ${fault}()`),
		);
		await assert.rejects(bulk(member, "bulkComplete", selection, {}, key));
	} finally {
		await f.admin.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fault} ON task; DROP FUNCTION IF EXISTS ${fault}()`));
	}
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM task WHERE id IN (${mine.id},${series.id},${boom.id}) AND status='complete'`,
		),
		[{ n: 0 }],
	);
	const result = ok(await bulk(member, "bulkComplete", selection, {}, key));
	assert.deepEqual(ok(await bulk(member, "bulkComplete", selection, {}, key)), result);
	assert.deepEqual(
		result.items.map((i) => [i.taskId, i.outcome]),
		[
			[mine.id, "changed"],
			[others.id, "unauthorized"],
			[series.id, "changed"],
			[w.id, "closed"],
			[changed.id, "stale"],
			[theirs.id, "not_found"],
			[missing.id, "not_found"],
			[boom.id, "changed"],
		],
	);
	assert.deepEqual([result.changed, result.remaining], [3, [others.id, changed.id]]);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM task WHERE predecessor_id=${series.id}`), [{ n: 1 }]);
	assert.equal((await get(foreign, theirs.id)).status, "not_started");

	const quiet = [missing, w, stale, await get(owner, mine.id)];
	const quietKey = randomUUID();
	const nothing = ok(await bulk(owner, "bulkComplete", quiet, {}, quietKey));
	assert.deepEqual(
		[nothing.changed, nothing.items.map((i) => i.outcome)],
		[0, ["not_found", "closed", "stale", "noop"]],
	);
	assert.deepEqual(ok(await bulk(owner, "bulkComplete", quiet, {}, quietKey)), nothing);

	const later = await create(owner, { title: "Later" });
	const row = await subtask(owner, later, "Row");
	const done = await get(owner, mine.id);
	refused(
		await bulk(member, "bulkReschedule", [later], { due: { kind: "local_date", date: "2026-11-01" } }),
		"unavailable",
	);
	refused(
		await bulk(owner, "bulkReschedule", [later], { due: { kind: "local_date", date: "2026-02-30" } }),
		"invalid_input",
	);
	refused(await bulk(owner, "bulkReschedule", Array(101).fill(later), { due: { kind: "undated" } }), "invalid_input");
	const moved = ok(
		await bulk(owner, "bulkReschedule", [later, row, done], { due: { kind: "local_date", date: "2026-11-01" } }),
	);
	assert.deepEqual(
		moved.items.map((i) => i.outcome),
		["changed", "ineligible", "closed"],
	);
	assert.deepEqual((await get(owner, later.id)).due, { kind: "local_date", date: "2026-11-01" });
	assert.deepEqual((await get(owner, others.id)).due, { kind: "undated" });
});

test("AC:TARGET-TSK-008 AC:TARGET-TSK-007 a bulk complete names each recurring task's next occurrence once", async () => {
	const due = (date: string) => ({ kind: "local_date", date });
	const weekly = await recurring({ title: "Weekly prayer", due: due("2026-10-05") });
	const monthly = await recurring(
		{ title: "Monthly report", due: due("2026-10-31") },
		{ frequency: "monthly", until: null },
	);
	const plain = await create(owner, { title: "One-off" });
	const request = {
		requestKey: randomUUID(),
		items: [weekly, plain, monthly].map((t) => ({ taskId: t.id, expectedRevision: t.revision })),
	};
	const result = ok(await write(owner, "bulkComplete", request));
	assert.deepEqual(
		result.items.map((i) => [i.taskId, i.outcome, i.successor?.title ?? null, i.successor?.due ?? null]),
		[
			[weekly.id, "changed", "Weekly prayer", due("2026-10-12")],
			[plain.id, "changed", null, null],
			[monthly.id, "changed", "Monthly report", due("2026-11-30")],
		],
	);
	for (const i of [result.items[0], result.items[2]]) {
		const next = await get(owner, i!.successor!.id);
		assert.deepEqual([next.status, next.occurrenceId, next.revision], ["not_started", "2", i!.successor!.revision]);
	}
	assert.deepEqual(ok(await write(owner, "bulkComplete", request)), result);
	const successors = async (t: { id: string }) =>
		(await rows(sql`SELECT count(*)::int n FROM task WHERE predecessor_id=${t.id}`))[0]!.n;
	assert.deepEqual([await successors(weekly), await successors(plain), await successors(monthly)], [1, 0, 1]);
});

test("AC:TARGET-TSK-002 a list of assignees is checked as a whole, kept as a set and audited", async () => {
	const assigneeIds = async (id: string) =>
		(await rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${id} ORDER BY account_id`)).map(
			(r) => r.account_id,
		);
	const before = (await rows(sql`SELECT count(*)::int n FROM task`))[0]!.n;
	const bad = refused(
		await write(owner, "create", {
			requestKey: randomUUID(),
			input: { title: "Mixed", assigneeIds: [member.id, foreign.id] },
		}),
		"invalid_subject",
	);
	assert.equal(bad.details.accountId, foreign.id);
	assert.equal((await rows(sql`SELECT count(*)::int n FROM task`))[0]!.n, before);
	const t = await create(owner, { title: "Pair", assigneeIds: [member.id, admin2.id, member.id] });
	assert.deepEqual(t.assignees.map((a) => a.accountId).sort(), [member.id, admin2.id].sort());
	assert.deepEqual(await assigneeIds(t.id), [member.id, admin2.id].sort());
	refused(
		await write(owner, "create", {
			requestKey: randomUUID(),
			input: { title: "Crowd", assigneeIds: Array.from({ length: 11 }, () => randomUUID()) },
		}),
		"invalid_input",
	);
	const names = t.assignees.map((a) => a.displayName.toLowerCase());
	assert.deepEqual(names, [...names].sort());
	const same = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { title: "Pair, renamed" } },
		}),
	).task;
	assert.equal(same.assignees.length, 2);
	refused(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: same.revision,
			input: { taskId: t.id, patch: { assigneeIds: [admin2.id, foreign.id] } },
		}),
		"invalid_subject",
	);
	assert.deepEqual(await assigneeIds(t.id), [member.id, admin2.id].sort());
	const trimmed = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: same.revision,
			input: { taskId: t.id, patch: { assigneeIds: [admin2.id] } },
		}),
	).task;
	assert.equal(BigInt(trimmed.revision) - BigInt(same.revision), 1n);
	const audit = await rows<Record<"before_value" | "after_value", { assigneeIds: string[] }>>(
		sql`SELECT before_value, after_value FROM audit_event WHERE subject_id=${t.id} AND after_revision=${trimmed.revision}::bigint`,
	);
	assert.equal(audit.length, 1);
	assert.deepEqual(audit[0]!.before_value.assigneeIds, [member.id, admin2.id].sort());
	assert.deepEqual(audit[0]!.after_value.assigneeIds, [admin2.id]);
	const cleared = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: trimmed.revision,
			input: { taskId: t.id, patch: { assigneeIds: [] } },
		}),
	).task;
	assert.deepEqual([cleared.assignees, await assigneeIds(t.id)], [[], []]);
});

test("AC:TARGET-TSK-003 AC:TARGET-TSK-005 any assignee acts, a Member adds nobody, children and successors keep the set", async () => {
	const shared = await create(owner, { title: "Shared duty", assigneeIds: [member.id, admin2.id] });
	const stranger = await (async () => {
		const a = await f.account();
		await f.seat(a, plant, "member");
		return { ...a, actor: await f.actor(a.session) };
	})();
	refused(
		await write(stranger, "complete", {
			requestKey: randomUUID(),
			expectedRevision: shared.revision,
			input: { taskId: shared.id },
		}),
		"unavailable",
	);
	refused(
		await write(member, "createSubtask", {
			requestKey: randomUUID(),
			expectedRevision: shared.revision,
			input: { parentId: shared.id, title: "Mine", assigneeIds: [owner.id] },
		}),
		"access_denied",
	);
	const step = await subtask(member, shared, "Check the list");
	assert.deepEqual(step.assignees.map((a) => a.accountId).sort(), [member.id, admin2.id].sort());
	const weekly = await recurring({
		title: "Weekly set-up",
		assigneeIds: [member.id, admin2.id],
		due: { kind: "local_date", date: "2099-03-01" },
	});
	const next = ok(
		await write(member, "completeOccurrence", {
			requestKey: randomUUID(),
			expectedRevision: weekly.revision,
			input: { taskId: weekly.id },
		}),
	).successor;
	assert.deepEqual(next!.assignees.map((a) => a.accountId).sort(), [member.id, admin2.id].sort());
	const mine = async (who: Who) =>
		ok(
			await read(who, "list", {
				view: "my",
				search: "Shared duty",
				statuses: ["not_started", "in_progress", "blocked"],
			}),
		).items.map((t) => t.id);
	assert.ok((await mine(member)).includes(shared.id));
	assert.ok((await mine(admin2)).includes(shared.id));
	assert.equal((await mine(stranger)).includes(shared.id), false);
	assert.equal(
		ok(
			await write(member, "complete", {
				requestKey: randomUUID(),
				expectedRevision: shared.revision,
				input: { taskId: shared.id },
			}),
		).task.status,
		"complete",
	);
});

test("INV-statements: a page read sends the same statements for one assignee or three", async () => {
	const third = await (async () => {
		const a = await f.account();
		await f.seat(a, plant, "member");
		return a;
	})();
	const one = await create(owner, { title: "Solo", assigneeIds: [member.id] });
	const three = await create(owner, { title: "Trio", assigneeIds: [member.id, admin2.id, third.id] });
	assert.equal(three.assignees.length, 3);
	const each = async (id: string) => [
		await counted(() => read(owner, "list", { search: id === one.id ? "Solo" : "Trio" })),
		await counted(() => read(owner, "get", { taskId: id })),
		await counted(() => read(owner, "listSubtasks", { parentId: id })),
	];
	assert.deepEqual(await each(three.id), await each(one.id));
});

test("INV-statements: an edit, a subtask and a prerequisite change lock their task and read what they join in one statement", async () => {
	const p = await person("Jo Lane");
	const t = await create(owner, { title: "Set up" });
	const before = await create(owner, { title: "Book the room" });
	const step = async (
		op: "edit" | "createSubtask" | "replacePrerequisites",
		input: object,
		expectedRevision: string,
	) => {
		const saved: Task[] = [];
		const n = await counted(async () => {
			saved.push(ok(await write(owner, op, { requestKey: randomUUID(), expectedRevision, input })).task);
		});
		const task = saved[0]!;
		return { n, task };
	};
	const renamed = await step("edit", { taskId: t.id, patch: { title: "Set up chairs" } }, t.revision);
	const related = await step(
		"edit",
		{ taskId: t.id, patch: { relation: { kind: "person", id: p } } },
		renamed.task.revision,
	);
	const assigned = await step("edit", { taskId: t.id, patch: { assigneeIds: [member.id] } }, related.task.revision);
	const child = await step(
		"createSubtask",
		{ parentId: t.id, title: "Count chairs", assigneeIds: [admin2.id] },
		assigned.task.revision,
	);
	const blocked = await step(
		"replacePrerequisites",
		{ taskId: t.id, prerequisiteIds: [before.id] },
		assigned.task.revision,
	);
	assert.deepEqual(
		[
			related.task.relation,
			assigned.task.assignees.map((a) => a.accountId),
			child.task.assignees.map((a) => a.accountId),
			blocked.task.openPrerequisites,
		],
		[{ kind: "person", id: p, label: "Jo Lane" }, [member.id], [admin2.id], 1],
	);
	assert.deepEqual([renamed.n, related.n, assigned.n, child.n, blocked.n], [5, 5, 5, 5, 5]);
});

test("AC:TARGET-TSK-014 each assignee gets their own reminders, and removing one withdraws only theirs", async () => {
	const notices = (task: string) =>
		rows<{
			recipient_id: string;
			purpose: string;
			cancelled: boolean;
		}>(sql`SELECT n.recipient_id, n.purpose, n.cancelled_at IS NOT NULL cancelled FROM notice n
			WHERE n.source_record_id=${task} ORDER BY n.recipient_id, n.eligible_at`);
	const live = async (task: string) => (await notices(task)).filter((n) => !n.cancelled).map((n) => n.recipient_id);
	const t = await create(owner, {
		title: "Set up the room",
		assigneeIds: [member.id, admin2.id],
		due: { kind: "local_date", date: "2099-01-15" },
	});
	const both = [member.id, admin2.id].sort().flatMap((id) => [id, id]);
	assert.deepEqual(await live(t.id), both);
	const trimmed = ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, patch: { assigneeIds: [admin2.id] } },
		}),
	).task;
	assert.deepEqual(await live(t.id), [admin2.id, admin2.id]);
	const stale = await rows<MailRow>(
		sql`SELECT m.id, m.recipient_account_id recipient, m.notice_id notice FROM mail m JOIN notice n ON n.id=m.notice_id
			WHERE n.source_record_id=${t.id}`,
	);
	const allowed = await gatedTransaction(f.db, (tx) => authorizeTaskReminders(tx, stale));
	assert.deepEqual([...new Set(stale.filter((m) => allowed.has(m.id)).map((m) => m.recipient))], [admin2.id]);
	ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: trimmed.revision,
			input: { taskId: t.id, patch: { assigneeIds: [admin2.id, member.id] } },
		}),
	);
	assert.deepEqual(await live(t.id), both);
});

test("AC:TARGET-TSK-014 a seat that has not accepted yet gets no task-reminder mail", async () => {
	const t = await create(owner, {
		title: "Print the programs",
		assigneeIds: [member.id],
		due: { kind: "local_date", date: "2099-02-15" },
	});
	const mailRows = await rows<MailRow>(
		sql`SELECT id, recipient_account_id recipient, notice_id notice FROM mail WHERE notice_id IN (SELECT id FROM notice WHERE source_record_id=${t.id})`,
	);
	assert.equal(mailRows.length, 2);
	const allowed = () => gatedTransaction(f.db, (tx) => authorizeTaskReminders(tx, mailRows));
	assert.equal((await allowed()).size, 2);
	const seat = (
		await rows(sql`SELECT id, accepted_at FROM seat WHERE account_id=${member.id} AND plant_id=${plant.id}
		AND ended_at IS NULL`)
	)[0]!;
	await f.admin.execute(sql`UPDATE seat SET accepted_at=clock_timestamp()+interval '1 day' WHERE id=${seat.id}`);
	try {
		assert.equal((await allowed()).size, 0, "the seat is not accepted yet");
		const recipients = await gatedTransaction(f.db, (tx) => reminderRecipients(tx, plant.id, [member.id]));
		assert.equal(recipients.size, 0);
	} finally {
		await f.admin.execute(sql`UPDATE seat SET accepted_at=${seat.accepted_at} WHERE id=${seat.id}`);
	}
	assert.equal((await allowed()).size, 2);
});
