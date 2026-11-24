import "../platform/setup.mts";
import { openedDeletion } from "../../support/deletion-cookie.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { accountId, sessionId, tenantId } from "../../../packages/contracts/src/common/index.ts";
import { eq, sql } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import {
	allows,
	coverage,
	deletionMachine as machine,
	enters,
	holds,
	reachable,
	refusals,
	type DeletionWitness,
	type Observation,
} from "../../../packages/contracts/src/machines/index.ts";
import {
	createLifecycleCleanup,
	deletionOperations,
	type DeletionSubject,
} from "../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../packages/domain/src/settings/deletion.ts";
import { queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../ops/maintenance/restore.mts";
import { testDatabase, type Database } from "../../support/test-database.mts";
import { seeds, type Actor } from "../../support/fixture.mts";
import { codeOf } from "../identity/invitations-support.mts";
import { dropTarget, freezeClock, objectStore, operator, snapshot } from "../target/sql/knowledge/support.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const DAY = 86_400_000;
const REQUESTED = new Date("2026-10-13T16:00:00.000Z");
const BEFORE_DEADLINE = new Date(REQUESTED.getTime() + DAY);
const AFTER_DEADLINE = new Date(REQUESTED.getTime() + 31 * DAY);
const RESTORE = "maintenance.restoreWithCurrentManifest";

const database = await testDatabase({
	prefix: "machinedel",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	clock: REQUESTED,
});
const { admin, schema } = database;
const { runtime: db, cleanup } = database.pools;
const seed = seeds(admin);
const api = deletionOperations({
	queue: (tx, i) =>
		queueJobs(tx, [
			{
				tenant: i.subject.id,
				kind: "lifecycle_purge",
				subject: i.witnessId,
				key: "purge/" + i.requestId,
				revision: i.revision,
				eligibleAt: i.eligibleAt,
			},
		]),
	workspaceNotice: async () => {},
});
type Step = (typeof machine.transitions)[number];
type SubjectName = keyof typeof machine.subjects;
type Sample = DeletionWitness;
type World = { subject: DeletionSubject; requester: Actor; passed: string[] };
const command = (input: object, expectedRevision: string) => ({ input, expectedRevision, requestKey: randomUUID() });
const targets: string[] = [];

async function at(when: Date) {
	await freezeClock(admin, schema, when);
	mock.timers.setTime(when.getTime());
}
before(() => mock.timers.enable({ apis: ["Date"], now: REQUESTED.getTime() }));
after(async () => {
	mock.timers.reset();
	for (const name of targets) await dropTarget(admin, name);
	await database.close();
});

type Reply = { status: string; error?: { code: string } };
async function settle(promise: Promise<Reply>): Promise<{ ok?: Reply; refused?: string }> {
	try {
		const value = await promise;
		return value?.status === "refused" ? { refused: value.error?.code } : { ok: value };
	} catch (error) {
		assert.ok(error instanceof Error);
		const code = codeOf(error);
		return { refused: typeof code === "string" ? code : error.message };
	}
}
const stored = async (subject: { id: string }, pool: Database = admin) =>
	(
		await pool
			.select({
				id: t.lifecycle_witness.id,
				state: t.lifecycle_witness.state,
				request: t.lifecycle_witness.request_id,
				revision: t.lifecycle_witness.request_revision,
				checkpoint: t.lifecycle_witness.witness_checkpoint,
			})
			.from(t.lifecycle_witness)
			.where(eq(t.lifecycle_witness.opaque_subject_id, subject.id))
	)[0]!;
type Witness = Awaited<ReturnType<typeof stored>>;
async function signIn(account: { user: string }, pool: Database = admin) {
	const session = sessionId.parse(randomUUID());
	await pool.insert(t.auth_session).values({
		id: session,
		user_id: account.user,
		token: randomBytes(32).toString("hex"),
		expires_at: new Date(Date.now() + DAY),
	});
	return session;
}

async function world(kind: DeletionWitness["kind"]): Promise<World> {
	if (kind === "account") {
		const account = await seed.actor(null, "owner");
		return { subject: { kind: "account", id: accountId.parse(account.id) }, requester: account, passed: [] };
	}
	const plant = await seed.plant({ name: "Harvest Point" });
	const owner = await seed.actor(plant, "owner");
	return { subject: { kind: "plant", id: tenantId.parse(plant.id) }, requester: owner, passed: [] };
}

async function request(w: World, pool: Database = admin, executor: Database = db) {
	const table = w.subject.kind === "account" ? t.account : t.plant;
	const [root] = await pool.select({ revision: table.revision }).from(table).where(eq(table.id, w.subject.id));
	const session = await signIn(w.requester, pool);
	return gatedTransaction(executor, (tx) =>
		w.subject.kind === "account"
			? api.requestAccountDeletion(tx, { session, selected: w.subject }, command({ confirmed: true }, root!.revision))
			: api.requestWorkspaceDeletion(
					tx,
					{ session, selected: w.subject },
					command({ plant: w.subject, confirmed: true }, root!.revision),
				),
	);
}

async function fire(w: World, row: Witness, event: string, facts: Sample): Promise<Reply> {
	if (event === "account.requestDeletion" || event === "churches.requestWorkspaceDeletion") return request(w);
	assert.ok(row.request);
	const requestId = row.request;
	if (event === "account.cancelDeletion" || event === "churches.cancelWorkspaceDeletion") {
		const proof = await openedDeletion(
			gatedTransaction(admin, (tx) =>
				issueRestrictedDeletionSession(tx, { subject: w.subject, requestId }, async () => ({
					accountId: w.requester.id,
					provenAt: new Date(),
				})),
			),
			{ subject: w.subject, requestId },
		);
		const input = command({ subject: w.subject, requestId }, row.revision);
		return gatedTransaction(db, (tx) =>
			w.subject.kind === "account"
				? api.cancelAccountDeletion(tx, proof, input)
				: api.cancelWorkspaceDeletion(tx, proof, input),
		);
	}
	if (event === "lifecycle.purge") {
		const purge = createLifecycleCleanup(cleanup, {
			authorize: async () => true,
			async removeOwnedResources() {
				w.passed.push((await stored(w.subject)).state);
				return facts.cleaned === true;
			},
		});
		return purge({ subject: w.subject, requestId, revision: row.revision });
	}
	throw Error(`no operation for ${event}`);
}

const combos = [true, false].flatMap((beforeDeadline) => [true, false].map((cleaned) => ({ beforeDeadline, cleaned })));
const runStops = (sample: Sample, step: Step) =>
	!machine.transitions.some(
		(t) =>
			t.event === step.event &&
			t.from === step.to &&
			t.to !== step.to &&
			allows(machine, t.event, t.from, t.to, sample),
	);
function momentFor(subject: SubjectName, step: Step) {
	const sample: Sample = machine.subjects[subject]!;
	const found = combos
		.map((c): Sample => ({ ...sample, ...c }))
		.find((moment) => allows(machine, step.event, step.from, step.to, moment) && runStops(moment, step));
	assert.ok(found, `${subject} has no moment for ${step.event} ${step.from} -> ${step.to}`);
	return found;
}
const clockFor = (facts: Sample) => at(facts.beforeDeadline ? BEFORE_DEADLINE : AFTER_DEADLINE);

function pathTo(subject: SubjectName, goal: string) {
	const sample: Sample = machine.subjects[subject]!;
	const entry = enters(machine, sample)[0]!;
	const routes = new Map<string, Step[]>([[entry.to, []]]);
	const queue = [entry.to];
	const facts = (t: Step) => combos.some((c) => allows(machine, t.event, t.from, t.to, { ...sample, ...c }));
	for (let state = queue.shift(); state !== undefined; state = queue.shift())
		for (const t of machine.transitions)
			if (t.from === state && !routes.has(t.to) && facts(t)) {
				routes.set(t.to, [...routes.get(state)!, t]);
				queue.push(t.to);
			}
	const route = routes.get(goal);
	assert.ok(route, `${subject} cannot reach ${goal}`);
	return { entry, route };
}

async function witnessIn(subject: SubjectName, state: string) {
	const sample: Sample = machine.subjects[subject]!;
	await at(REQUESTED);
	const w = await world(sample.kind);
	const { route } = pathTo(subject, state);
	const entered = await settle(request(w));
	assert.ok(entered.ok, `${subject} request: ${JSON.stringify(entered)}`);
	let row = await stored(w.subject);
	for (const step of route) {
		const facts = momentFor(subject, step);
		await clockFor(facts);
		const reply = await settle(fire(w, row, step.event, facts));
		assert.ok(reply.ok, `${subject} ${step.event} ${step.from} -> ${step.to}: ${JSON.stringify(reply)}`);
		row = await stored(w.subject);
		assert.equal(row.state, step.to);
	}
	await clockFor(sample);
	w.passed = [];
	return { w, row };
}

test("INV-machine: a deletion witness follows its declared transitions and refuses every other move", async (context) => {
	const observations: Observation[] = [];
	const observe = (o: Omit<Observation, "machine">) => observations.push({ machine: machine.id, ...o });
	const subjects = Object.keys(machine.subjects);

	for (const subject of subjects) {
		const entry = enters(machine, machine.subjects[subject])[0]!;
		const { row } = await witnessIn(subject, entry.to);
		observe({ kind: "edge", subject, event: entry.event, from: null, to: row.state });
	}

	for (const edge of machine.transitions)
		for (const subject of subjects) {
			const sample = machine.subjects[subject]!;
			if (!reachable(machine, sample).includes(edge.from) || !allows(machine, edge.event, edge.from, edge.to, sample))
				continue;
			const { w, row: before } = await witnessIn(subject, edge.from);
			const reply = await settle(fire(w, before, edge.event, machine.subjects[subject]!));
			assert.ok(reply.ok, `${subject} ${edge.event} ${edge.from} -> ${edge.to}: ${JSON.stringify(reply)}`);
			const after = await stored(w.subject);
			const run = [before.state, ...w.passed, after.state];
			assert.ok(
				run.some((state, i) => i > 0 && run[i - 1] === edge.from && state === edge.to),
				`${subject} ${edge.event} ${edge.from} -> ${edge.to} went ${run.join(" -> ")}`,
			);
			observe({ kind: "edge", subject, event: edge.event, from: edge.from, to: edge.to });
		}

	for (const stay of machine.stays)
		for (const state of stay.in)
			for (const subject of subjects) {
				if (!holds(machine, stay.event, state, machine.subjects[subject]!)) continue;
				const { w, row: before } = await witnessIn(subject, state);
				const reply = await settle(fire(w, before, stay.event, machine.subjects[subject]!));
				assert.ok(reply.ok, `${subject} ${stay.event} stays in ${state}: ${JSON.stringify(reply)}`);
				assert.deepEqual(await stored(w.subject), before);
				observe({ kind: "stay", subject, event: stay.event, from: state, to: state });
			}

	for (const r of refusals(machine)) {
		const { w, row: before } = await witnessIn(r.subject, r.from);
		const reply = await settle(fire(w, before, r.event, machine.subjects[r.subject]!));
		assert.equal(reply.refused, r.code, `${r.subject} ${r.event} ${r.from} -> ${r.to}: ${JSON.stringify(reply)}`);
		assert.deepEqual(await stored(w.subject), before, `${r.subject} ${r.event} ${r.from} left the witness`);
		observe({ kind: "refusal", subject: r.subject, event: r.event, from: r.from, to: r.to });
	}

	await at(AFTER_DEADLINE);
	const copies: World[] = [];
	for (const kind of ["account", "plant"] as const) {
		const w = await world(kind);
		await signIn(w.requester);
		copies.push(w);
	}
	const source = Object.fromEntries((await admin.select().from(t.lifecycle_witness)).map((row) => [row.id, row.state]));
	assert.deepEqual([...new Set(Object.values(source))].sort(), [...machine.states].sort());
	const target = `${schema}_m`;
	targets.push(target);
	const restored = await restoreWithCurrentManifest(
		{
			admin,
			source: schema,
			targetSchema: target,
			objects: objectStore(new Map()),
			clock: () => AFTER_DEADLINE,
		},
		{
			capability: operator,
			target: "isolated",
			snapshot: await snapshot(admin, new Map(), { createdAt: AFTER_DEADLINE }),
			current: () => readCurrentManifest(admin),
		},
	);
	assert.equal(restored.restore_success, true, JSON.stringify(restored));
	const copied = (
		await admin.execute<{ id: string; state: string }>(
			sql`SELECT id, state FROM ${sql.raw(`${target}.lifecycle_witness`)}`,
		)
	).rows.map((row) => [row.id, row.state] as const);
	assert.deepEqual(Object.fromEntries(copied), source);
	for (const [, state] of copied) {
		const entered = state === "purged" ? "purging" : state;
		observe({ kind: "edge", subject: "copy", event: RESTORE, from: null, to: entered });
		if (entered === "purging") observe({ kind: "edge", subject: "copy", event: RESTORE, from: "purging", to: state });
	}
	const pool = database.connect("admin", { schema: target, max: 1 });
	for (const w of copies) {
		const reply = await settle(request(w, pool, pool));
		assert.ok(reply.ok, `${w.subject.kind} copy request: ${JSON.stringify(reply)}`);
		assert.equal((await stored(w.subject, pool)).state, "pending_deletion");
		const event = w.subject.kind === "account" ? "account.requestDeletion" : "churches.requestWorkspaceDeletion";
		observe({ kind: "edge", subject: "copy", event, from: null, to: "pending_deletion" });
	}

	const report = coverage(machine, observations);
	if (process.env.EVF_MACHINE_COVERAGE)
		appendFileSync(process.env.EVF_MACHINE_COVERAGE, observations.map((o) => `${JSON.stringify(o)}\n`).join(""));
	context.diagnostic(report.line);
	assert.deepEqual(report.missing, []);
});
