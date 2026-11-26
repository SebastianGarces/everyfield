import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { accountId, sessionId, tenantId } from "../../../packages/contracts/src/common/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { readSharedFoundations } from "../../../packages/domain/src/organizations/index.ts";
import { CATALOG, createTaskWriter, taskReader, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import type { OnboardingContext, OnboardingProducer } from "../../../packages/contracts/src/onboarding/server.ts";
import type { Tx } from "../../../packages/domain/src/onboarding/core.ts";
import { testDatabase } from "../../support/test-database.mts";
import { ok, refused } from "../../support/fixture.mts";

const database = await testDatabase({ prefix: "t665", max: 4 });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

const STARTER = CATALOG.checklists.find((k) => k.key === "discernment-and-preparation") ?? assert.fail("no Phase 0");
const KEYS = STARTER.items.map((i) => i.key);
const [FIRST, SECOND, THIRD] = KEYS as [string, string, string];
let faults = false;
let api: OnboardingProducer<Tx>;
before(() => {
	api = createOnboardingProducer({
		relationships: async () => {},
		async enqueue() {
			if (faults) throw Error("required_intent_fault");
		},
	});
});

type Account = { id: string; session: string };
type Selected = OnboardingContext["selected"];
const ctx = (a: Account, selected: Selected = { kind: "account", id: accountId.parse(a.id) }): OnboardingContext => ({
	session: sessionId.parse(a.session),
	selected,
});
const steps = (a: Account, selected?: Selected) =>
	gatedTransaction(db, (tx) => api.getDiscoverySteps(tx, ctx(a, selected), {}));
const command = (input: object, expectedRevision: string, requestKey = randomUUID()) => ({
	requestKey,
	expectedRevision,
	input,
});
const setStep = (a: Account, q: object, selected?: Selected) =>
	gatedTransaction(db, (tx) => api.setDiscoveryStep(tx, ctx(a, selected), q));
const tick = (a: Account, view: { discoveryId: string; revision: string }, stepKey: string, done = true) =>
	setStep(a, command({ discoveryId: view.discoveryId, stepKey, done }, view.revision));

async function account(kind: "planter" | "discovery" | "sending_church", name = "Synthetic Planter") {
	const a = { id: randomUUID(), user: randomUUID(), session: randomUUID() };
	await admin.execute(
		sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES(${a.user},${name},${a.user + "@example.test"},true)`,
	);
	await admin.execute(sql`INSERT INTO account(id,auth_user_id,registration_kind,registration_state)
		VALUES(${a.id},${a.user},${kind},'active')`);
	await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${a.session},${a.user},${randomUUID()},clock_timestamp()+interval '1 day')`);
	return a;
}
async function planter(name?: string) {
	const a = await account("discovery", name);
	await admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${a.id})`);
	return a;
}
async function sendingChurch(planterAccount: Account) {
	const org = randomUUID();
	await admin.execute(sql`INSERT INTO organization(id,kind,name,timezone,material_revision)
		VALUES(${org},'sending_church','Grace Church','UTC',1)`);
	const director = await account("sending_church", "Dana Director");
	await admin.execute(sql`INSERT INTO seat(account_id,organization_id,role,accepted_at)
		VALUES(${director.id},${org},'owner',clock_timestamp())`);
	const link = randomUUID();
	await admin.execute(sql`INSERT INTO affiliation(id,account_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings,share_foundations)
		VALUES(${link},${planterAccount.id},${org},clock_timestamp(),false,false,false,false,false,false,false,true)`);
	return { org, director, link };
}
const stored = async (a: Account) =>
	(
		await admin.execute(
			sql`SELECT steps, steps_revision::text AS revision FROM discovery WHERE account_id=${a.id}::uuid`,
		)
	).rows[0];
const auditCount = async (a: Account) =>
	(await admin.execute(sql`SELECT count(*)::int AS n FROM audit_event WHERE actor_id=${a.id}::uuid`)).rows[0];
const doneKeys = (view: { steps: { key: string; doneAt: string | null }[] }) =>
	view.steps.filter((s) => s.doneAt !== null).map((s) => s.key);

test("AC:TARGET-IDN-016 a Discovery planter reads the six Phase 0 steps, all open, with their catalog titles", async () => {
	const p = await planter();
	const view = ok(await steps(p));
	assert.equal(view.revision, "1");
	assert.equal(view.catalogVersion, CATALOG.version);
	assert.deepEqual(
		view.steps,
		STARTER.items.map((i) => ({ key: i.key, title: i.title, description: i.description, doneAt: null })),
	);
	assert.equal(view.steps.length, 6);
});

test("AC:TARGET-IDN-016 a step ticks and unticks; a retry, a stale revision and an unknown key change nothing", async () => {
	const p = await planter();
	const first = ok(await steps(p));
	const q = command({ discoveryId: first.discoveryId, stepKey: FIRST, done: true }, first.revision);
	const ticked = ok(await setStep(p, q));
	assert.equal(ticked.revision, "2");
	assert.deepEqual(doneKeys(ticked), [FIRST]);
	assert.deepEqual(ok(await steps(p)), ticked, "a fresh read shows the step done");
	const saved = await stored(p);
	assert.deepEqual(saved?.steps, [
		{ key: FIRST, catalogVersion: CATALOG.version, doneAt: ticked.steps[0]?.doneAt ?? assert.fail("no doneAt") },
	]);

	const audits = await auditCount(p);
	assert.deepEqual(ok(await setStep(p, q)), ticked, "a retry answers the first result");
	assert.deepEqual(await stored(p), saved);
	assert.deepEqual(await auditCount(p), audits);

	refused(await tick(p, first, SECOND), "conflict");
	refused(
		await setStep(p, command({ discoveryId: first.discoveryId, stepKey: "not-a-step", done: true }, "2")),
		"invalid_input",
	);
	refused(
		await setStep(p, command({ discoveryId: first.discoveryId, stepKey: "Not A Key", done: true }, "2")),
		"invalid_input",
	);
	assert.deepEqual(await stored(p), saved);
	assert.deepEqual(await auditCount(p), audits);

	const again = ok(await tick(p, ticked, FIRST));
	assert.deepEqual(again, ticked, "ticking a done step again changes nothing");
	assert.deepEqual(await stored(p), saved);

	const unticked = ok(await tick(p, ticked, FIRST, false));
	assert.equal(unticked.revision, "3");
	assert.deepEqual(doneKeys(unticked), []);
	assert.deepEqual(doneKeys(ok(await steps(p))), []);
});

test("AC:TARGET-IDN-016 INV-privacy: only the planter reads or changes their steps; a director never sees them", async () => {
	const p = await planter();
	const view = ok(await steps(p));
	ok(await tick(p, view, FIRST));
	const { director, link } = await sendingChurch(p);
	const other = await planter();
	const seatless = await account("planter");
	const seated = await account("planter");
	const plant = randomUUID();
	await admin.execute(sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision)
		VALUES(${plant},'Other Church','America/Chicago',7,14,1,8,1,1)`);
	await admin.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${seated.id},${plant},'owner',clock_timestamp())`,
	);
	const before = await stored(p);
	const theirs = { kind: "account" as const, id: accountId.parse(p.id) };
	const change = command({ discoveryId: view.discoveryId, stepKey: SECOND, done: true }, "2");

	for (const who of [other, seatless, seated, director]) {
		refused(await steps(who, theirs));
		refused(await setStep(who, change, theirs));
		refused(await setStep(who, { ...change, requestKey: randomUUID() }));
	}
	assert.deepEqual(doneKeys(ok(await steps(other))), [], "another planter reads only their own steps");
	for (const who of [seatless, seated, director]) refused(await steps(who));
	refused(await steps(seated, { kind: "plant", id: tenantId.parse(plant) }));
	assert.deepEqual(await stored(p), before);

	const directorActor = await gatedTransaction(db, (tx) => RequestActor.resolve(tx, sessionId.parse(director.session)));
	assert.ok(directorActor instanceof RequestActor);
	assert.deepEqual(await readSharedFoundations(db, directorActor), { [link]: { completed: [], total: 6 } });
	await admin.execute(sql`UPDATE affiliation SET share_foundations=false WHERE id=${link}::uuid`);
	assert.deepEqual(await readSharedFoundations(db, directorActor), {});
});

async function conversion(p: Account) {
	const profile = ok(await gatedTransaction(db, (tx) => api.getDiscoveryProfile(tx, ctx(p), {})));
	if (profile.status !== "active") assert.fail(JSON.stringify(profile));
	const { discoveryId, revision } = profile.profile;
	return command({ discoveryId, name: "New Hope", confirmed: true, relationships: [], ended: [] }, revision);
}
const convert = async (p: Account, q?: object) =>
	gatedTransaction(db, async (tx) => api.convertDiscovery(tx, ctx(p), q ?? (await conversion(p))));
const tasksOf = async (plant: string) =>
	(
		await admin.execute(sql`SELECT t.id, t.title, t.description, t.status, t.priority, t.category, t.due_kind,
		to_char(t.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at, t.revision::text AS revision, array_agg(a.account_id::text) AS assignees
		FROM task t LEFT JOIN task_assignee a ON a.task_id=t.id WHERE t.plant_id=${plant}::uuid
		GROUP BY t.id ORDER BY t.title`)
	).rows as {
		id: string;
		title: string;
		description: string;
		status: string;
		priority: string;
		category: string;
		due_kind: string;
		completed_at: string | null;
		revision: string;
		assignees: string[];
	}[];

test("AC:TARGET-IDN-016 AC:TARGET-TSK-015 conversion carries every step into the church as an ordinary task, once", async () => {
	const p = await planter("Jo Planter");
	let view = ok(await steps(p));
	view = ok(await tick(p, view, FIRST));
	view = ok(await tick(p, view, THIRD));
	const doneAt = new Map(view.steps.map((s) => [s.title, s.doneAt]));
	const q = await conversion(p);
	const converted = ok(await convert(p, q));
	if (converted.status !== "converted") assert.fail(JSON.stringify(converted));
	const plant = converted.plant.id;
	const carried = await tasksOf(plant);
	assert.deepEqual(
		carried.map((r) => [r.title, r.status, r.due_kind, r.category, r.assignees]),
		[...STARTER.items]
			.sort((a, b) => (a.title < b.title ? -1 : 1))
			.map((i) => [
				i.title,
				i.key === FIRST || i.key === THIRD ? "complete" : "not_started",
				"undated",
				"administrative",
				[p.id],
			]),
	);
	for (const r of carried) assert.equal(r.completed_at, doneAt.get(r.title));

	const replay = ok(await convert(p, q));
	assert.equal(replay.status, "existing");
	assert.equal((await tasksOf(plant)).length, 6, "a repeated conversion adds no tasks");

	refused(await steps(p));
	refused(await tick(p, view, SECOND));

	const owner = await gatedTransaction(db, (tx) => RequestActor.resolve(tx, sessionId.parse(p.session)));
	assert.ok(owner instanceof RequestActor);
	const done = carried.find((r) => r.status === "complete") ?? assert.fail("no done task");
	const history = ok(
		await gatedTransaction(db, (tx) => taskReader.statusHistory(tx, owner, { taskId: done.id, page: 1, limit: 20 })),
	);
	assert.deepEqual(
		history.items.map((h) => [h.from, h.to, h.occurredAt, h.actor]),
		[[null, "complete", done.completed_at, { kind: "account", accountId: p.id, displayName: "Jo Planter" }]],
	);

	const writer = createTaskWriter({ reminders: async () => {} });
	const open = carried.find((r) => r.status === "not_started") ?? assert.fail("no open task");
	const act = (op: "reopen" | "complete", r: { id: string; revision: string }) =>
		withTaskWrite(db, owner, (tx, c) =>
			writer[op](tx, c, { requestKey: randomUUID(), expectedRevision: r.revision, input: { taskId: r.id } }),
		);
	ok(await act("reopen", done));
	ok(await act("complete", open));
	const after = new Map((await tasksOf(plant)).map((r) => [r.id, r.status]));
	assert.equal(after.get(done.id), "not_started");
	assert.equal(after.get(open.id), "complete");
});

test("AC:TARGET-IDN-016 a conversion that fails carries no task and keeps the steps", async () => {
	const p = await planter();
	ok(await tick(p, ok(await steps(p)), FIRST));
	const before = await stored(p);
	const tasks = async () => (await admin.execute(sql`SELECT count(*)::int AS n FROM task`)).rows[0];
	const count = await tasks();
	faults = true;
	try {
		await assert.rejects(convert(p), /required_intent_fault/);
	} finally {
		faults = false;
	}
	assert.deepEqual(await tasks(), count);
	assert.deepEqual(await stored(p), before);
	assert.deepEqual(doneKeys(ok(await steps(p))), [FIRST]);
});
