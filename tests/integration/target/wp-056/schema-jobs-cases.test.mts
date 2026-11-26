import "../../platform/setup.mts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import {
	claimDue,
	enqueueJob,
	finishClaim,
	finishJob,
	recoverLease,
} from "../../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../../packages/domain/src/jobs/transaction.ts";
import { ok, raced, refused } from "../../../support/fixture.mts";
import { clockedWorld, type Who } from "../../tasks/world.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const c = cases.find((x) => x.id === "SCHEMA-013") ?? assert.fail("no SCHEMA-013");
const input = c.given["case-input"]!;

const w = await clockedWorld("schema013", c.clock.now);
after(() => w.close());
const { owner, member, adminActor, write, read, create } = w;
const B = await w.seated(w.tenant, "member");
const one = async (q: SQL) => (await w.rows(q))[0] ?? assert.fail("no row");
type Versioned = { id: string; revision: string };
const get = async (who: Who, taskId: string) => {
	const found = ok(await read(who, "get", { taskId }));
	assert.ok("task" in found);
	return found.task as Versioned & { status: string; checklistItems: Versioned[] };
};
const child = (who: Who, parent: Versioned, extra: object = {}) =>
	write(who, "createSubtask", {
		requestKey: randomUUID(),
		expectedRevision: parent.revision,
		input: { parentId: parent.id, title: "Row", ...extra },
	});
const tick = (who: Who, parent: Versioned, row: Versioned, complete: boolean) =>
	write(who, "setSubtaskCompletion", {
		requestKey: randomUUID(),
		expectedRevision: row.revision,
		input: { parentId: parent.id, taskId: row.id, complete },
	});
const assigneesOf = async (id: string) =>
	(await w.rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${id} ORDER BY account_id`)).map(
		(r) => r.account_id,
	);
const footprint = () =>
	one(sql`SELECT (SELECT count(*)::int FROM task) AS tasks,(SELECT count(*)::int FROM task_assignee) AS assignees,
		(SELECT count(*)::int FROM audit_event) AS audits,(SELECT count(*)::int FROM job) AS jobs,
		(SELECT count(*)::int FROM notice) AS notices`);
async function faulted(table: string, when: string, attempt: () => Promise<unknown>) {
	const name = `schema013_fault_${table}`;
	await w.admin.execute(
		sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
			IF ${when} THEN RAISE EXCEPTION 'injected fault'; END IF; RETURN NEW; END $$`),
	);
	try {
		await w.admin.execute(
			sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`),
		);
		await assert.rejects(attempt(), (e: Error) => /injected fault/.test(String(e.cause ?? e)));
	} finally {
		await w.admin.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}; DROP FUNCTION IF EXISTS ${name}()`));
	}
}

test("AC:SCHEMA-013 jobs keep the canonical states under concurrent claims and a reclaimed lease, and child tasks follow their own duty, never finish the parent and roll back whole on a copy fault", async () => {
	const result: Record<string, unknown> = {};

	const checks = String(
		(
			await one(sql`SELECT string_agg(pg_get_constraintdef(oid),' ') AS d FROM pg_constraint
				WHERE conrelid='job'::regclass AND contype='c'`)
		).d,
	);
	const persisted = (input.persisted_states as string[]).filter((s) => checks.includes(`'${s}'`));
	result.canonical_states = persisted;
	const aliases = input.aliases as string[];
	const enums = await w.rows(sql`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
		JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=current_schema() AND e.enumlabel=ANY(${`{${aliases.join(",")}}`}::text[])`);
	const job = (state: string) =>
		w.admin.execute(sql`INSERT INTO job(tenant_id,kind,subject_record_id,producer_key,source_revision,state,eligible_at,
			attempt_count,max_attempts,claim_generation)
			VALUES(${w.tenant.id},'digest',${w.tenant.id},${"alias/" + randomUUID()},1,${state},clock_timestamp(),0,3,0)`);
	let accepted = 0;
	for (const alias of aliases)
		await job(alias).then(
			() => accepted++,
			(e: Error) => assert.match(String(e.cause ?? e), /check constraint/),
		);
	result.aliases_create_enums = enums.length > 0 || accepted > 0 || aliases.some((a) => checks.includes(`'${a}'`));

	const id = await transaction(w.db, (tx) =>
		enqueueJob(tx, {
			tenant: w.tenant.id,
			kind: "digest",
			subject: w.tenant.id,
			key: `schema-case/${randomUUID()}`,
			revision: "1",
			eligibleAt: c.clock.now,
		}),
	);
	const claims = (await Promise.all([claimDue(w.db, ["digest"], 10), claimDue(w.db, ["digest"], 10)])).flat();
	assert.equal(claims.filter((x) => x.id === id).length, 1);
	const late = claims.find((x) => x.id === id)!;
	await w.at("2026-10-13T16:10:00.000Z");
	assert.equal(await recoverLease(w.db), 1);
	assert.equal((await one(sql`SELECT state FROM job WHERE id=${id}`)).state, "retry_wait");
	await w.at("2026-10-13T16:20:00.000Z");
	const [current] = await claimDue(w.db, ["digest"], 10);
	assert.equal(current?.id, id);
	assert.deepEqual(
		[
			await finishJob(w.db, late, { state: "succeeded" }),
			await transaction(w.db, (tx) => finishClaim(tx, late, { state: "succeeded" })),
		],
		[false, false],
		"a late success after the reclaim publishes nothing",
	);
	assert.equal(await finishJob(w.db, current!, { state: "reconcile" }), true);
	assert.equal((await one(sql`SELECT state FROM job WHERE id=${id}`)).state, "reconcile");
	assert.ok(persisted.includes("reconcile"));

	const A = member;
	const parent = await create(owner, { title: "Plan picnic", assigneeIds: [A.id] });
	const inherited = ok(await child(A, parent)).task;
	assert.deepEqual(await assigneesOf(inherited.id), [A.id]);
	for (const assigneeIds of [[B.id], []])
		refused(await child(A, await get(owner, parent.id), { assigneeIds }), "access_denied");
	const forB = ok(await child(owner, await get(owner, parent.id), { assigneeIds: [B.id] })).task;
	const open = ok(await child(adminActor, await get(owner, parent.id), { assigneeIds: [] })).task;
	const omitted = ok(await child(adminActor, await get(owner, parent.id))).task;
	assert.deepEqual(
		[await assigneesOf(forB.id), await assigneesOf(open.id), await assigneesOf(omitted.id)],
		[[B.id], [], [A.id]],
	);
	const byParentOwner = await tick(A, parent, forB, true);
	result.parent_owner_can_tick_other_child = byParentOwner.status === "ok";
	refused(byParentOwner, "unavailable");
	const ticked = ok(await tick(B, parent, forB, true)).task;
	const reopened = ok(await tick(B, parent, ticked, false)).task;
	refused(
		await write(B, "edit", {
			requestKey: randomUUID(),
			expectedRevision: (await get(owner, parent.id)).revision,
			input: { taskId: parent.id, patch: { title: "Renamed by B" } },
		}),
		"unavailable",
	);
	ok(
		await write(owner, "edit", {
			requestKey: randomUUID(),
			expectedRevision: reopened.revision,
			input: { taskId: forB.id, patch: { assigneeIds: [A.id] } },
		}),
	);
	refused(await tick(B, parent, await get(owner, forB.id), true), "unavailable");
	for (const row of [inherited, await get(owner, forB.id)]) ok(await tick(A, parent, row, true));
	for (const row of [open, omitted]) ok(await tick(owner, parent, row, true));
	const after = await get(owner, parent.id);
	result.child_tick_auto_finishes_parent = after.status === "complete";
	assert.deepEqual([after.status, after.revision], ["not_started", parent.revision]);

	const doomed = await create(owner, { title: "Doomed parent" });
	const [deleted, added] = await raced(w.admin, w.db, sql`SELECT 1 FROM task WHERE id=${doomed.id} FOR UPDATE`, [
		() =>
			write(owner, "delete", {
				requestKey: randomUUID(),
				expectedRevision: doomed.revision,
				input: { taskId: doomed.id },
			}),
		() => child(owner, doomed),
	]);
	assert.deepEqual(
		[deleted, added].map((r) => r.status),
		["ok", "refused"],
		JSON.stringify([deleted, added]),
	);
	assert.equal(
		(await one(sql`SELECT count(*)::int AS n FROM task WHERE parent_id=${doomed.id} AND deleted_at IS NULL`)).n,
		0,
	);

	const series = await create(owner, {
		title: "Weekly set-up",
		assigneeIds: [A.id],
		due: { kind: "local_date", date: "2026-10-20" },
	});
	const recurring = ok(
		await write(owner, "configureRecurrence", {
			requestKey: randomUUID(),
			expectedRevision: series.revision,
			input: { taskId: series.id, rule: { frequency: "weekly", until: null } },
		}),
	).task;
	for (const title of ["Fail copy", "Set chairs"]) ok(await child(owner, await get(owner, recurring.id), { title }));
	for (const row of (await get(owner, recurring.id)).checklistItems) ok(await tick(owner, recurring, row, true));
	const ready = await get(owner, recurring.id);
	const complete = (requestKey: string) =>
		write(owner, "completeOccurrence", { requestKey, expectedRevision: ready.revision, input: { taskId: ready.id } });
	const before = await footprint();
	const retry = randomUUID();
	for (const [table, when] of [
		["task", "NEW.title='Fail copy' AND NEW.parent_id IS NOT NULL"],
		["task", "NEW.predecessor_id IS NOT NULL"],
		["task_assignee", "true"],
		["audit_event", "true"],
		["notice", "true"],
	] as const)
		await faulted(table, when, () => complete(retry));
	assert.deepEqual(await footprint(), before, "every faulted insertion rolls the completion back whole");
	result.child_copy_fault_parent_completed = (await get(owner, recurring.id)).status === "complete";
	result.child_copy_fault_new_children = Number(
		(
			await one(
				sql`SELECT count(*)::int AS n FROM task s JOIN task k ON k.parent_id=s.id WHERE s.predecessor_id=${recurring.id}`,
			)
		).n,
	);
	const done = ok(await complete(retry));
	assert.deepEqual(ok(await complete(retry)), done);
	assert.equal(done.task.status, "complete");
	assert.deepEqual(
		done.successor!.checklistItems.map((k) => [k.title, k.status]),
		ready.checklistItems.map((k) => [(k as Versioned & { title: string }).title, "not_started"]),
		"the next checklist keeps the order of the completed one",
	);
	const copies =
		await w.rows(sql`SELECT due_kind,due_date,due_time,timezone,due_at,person_id,meeting_id,team_id,launch_id,
		obligation_id,series_id,occurrence_key,predecessor_id,completed_at FROM task WHERE parent_id=${done.successor!.id}`);
	assert.equal(copies.length, 2);
	const dues = new Set(copies.map((r) => JSON.stringify([r.due_date, r.due_time, r.timezone, r.due_at])));
	const hooks = new Set(
		copies.map((r) => JSON.stringify([r.person_id, r.meeting_id, r.team_id, r.launch_id, r.obligation_id])),
	);
	assert.deepEqual(
		copies.map((r) => [r.due_kind, r.series_id, r.occurrence_key, r.predecessor_id, r.completed_at]),
		[
			["undated", null, null, null, null],
			["undated", null, null, null, null],
		],
	);
	result.successor_children_due = dues.size === 1 && dues.has("[null,null,null,null]") ? null : [...dues];
	result.successor_children_contact_hook =
		hooks.size === 1 && hooks.has("[null,null,null,null,null]") ? null : [...hooks];
	for (const forged of [
		sql`UPDATE task SET due_kind='date_only',due_date='2026-10-27' WHERE id=${done.successor!.checklistItems[0]!.id}`,
		sql`UPDATE task SET obligation_id=gen_random_uuid() WHERE id=${done.successor!.checklistItems[0]!.id}`,
	])
		await assert.rejects(w.admin.execute(forged));
	refused(await child(owner, done.successor!.checklistItems[0]!), "invalid_subject");

	assert.deepEqual(result, c.expected.result);
	assert.equal(c.expected.event, null);
});
