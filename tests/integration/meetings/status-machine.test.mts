import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import {
	allows,
	coverage,
	meetingStatusMachine as machine,
	refusals,
} from "../../../packages/contracts/src/machines/index.ts";
import { meetingsWriter as meetings } from "../../../packages/domain/src/meetings/index.ts";
import { fixture, ok, refused } from "../../support/fixture.mts";

const database = await fixture({ prefix: "machine", max: 4 });
const db = database.pools.runtime;
const ctx = { session: database.actors.owner.session, selected: { kind: "plant", id: database.tenant.id } };
const run = (op, input) => db.transaction((tx) => op(tx, ctx, { requestKey: randomUUID(), ...input }));
const day = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const heldAt = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const reason = "Model-based walk";

after(() => database.close());

async function stored(id) {
	const r = await database.admin.execute(
		sql`SELECT id, revision::text AS revision, status FROM meeting WHERE id = ${id}`,
	);
	return r.rows[0];
}

async function schedule(subject) {
	const created = ok(
		await run(meetings.schedule, {
			input: { type: machine.subjects[subject].type, date: day(30), time: "18:30" },
		}),
	);
	return stored(created.meeting.id);
}

let held = 1;
function fire(row, event, to) {
	const base = { expectedRevision: row.revision };
	const meetingId = row.id;
	switch (event) {
		case "meetings.changeStatus":
			return run(meetings.changeStatus, { ...base, input: { meetingId, to } });
		case "meetings.completePractice":
			return run(meetings.completePractice, { ...base, input: { meetingId, occurredAt: heldAt(held++) } });
		case "meetings.correctPracticeOccurrence":
			return run(meetings.correctPracticeOccurrence, {
				...base,
				input:
					to === "completed"
						? { meetingId, state: "completed", occurredAt: heldAt(held++), reason }
						: { meetingId, state: "not_completed", reason },
			});
		case "meetings.correctOccurrence":
			return run(meetings.correctOccurrence, { ...base, input: { meetingId, voided: true, reason } });
		case "meetings.schedule":
			throw Error("schedule creates a meeting; it has no from state");
	}
}

function pathTo(subject, goal) {
	const s = machine.subjects[subject];
	const routes = new Map([[machine.initial.to, []]]);
	const queue = [machine.initial.to];
	for (let at = queue.shift(); at !== undefined; at = queue.shift())
		for (const t of machine.transitions)
			if (t.from === at && !routes.has(t.to) && allows(machine, t.event, t.from, t.to, s)) {
				routes.set(t.to, [...routes.get(at), { event: t.event, to: t.to }]);
				queue.push(t.to);
			}
	const route = routes.get(goal);
	assert.ok(route, `${subject} cannot reach ${goal}`);
	return route;
}

async function meetingIn(subject, state) {
	let row = await schedule(subject);
	for (const step of pathTo(subject, state)) {
		ok(await fire(row, step.event, step.to));
		row = await stored(row.id);
		assert.equal(row.status, step.to);
	}
	return row;
}

test("INV-machine: meeting status follows its declared transitions and refuses every other move", async (t) => {
	const observations = [];
	const observe = (o) => observations.push({ machine: machine.id, ...o });
	const subjects = Object.keys(machine.subjects);

	for (const subject of subjects) {
		const row = await schedule(subject);
		observe({ kind: "edge", subject, event: machine.initial.event, from: null, to: row.status });
	}

	for (const edge of machine.transitions)
		for (const subject of subjects) {
			if (!allows(machine, edge.event, edge.from, edge.to, machine.subjects[subject])) continue;
			const before = await meetingIn(subject, edge.from);
			ok(await fire(before, edge.event, edge.to));
			const after = await stored(before.id);
			assert.equal(after.status, edge.to, `${subject} ${edge.event} ${edge.from} -> ${edge.to}`);
			observe({ kind: "edge", subject, event: edge.event, from: before.status, to: after.status });
		}

	for (const stay of machine.stays)
		for (const state of stay.in)
			for (const subject of subjects) {
				const before = await meetingIn(subject, state);
				ok(await fire(before, stay.event, state));
				const after = await stored(before.id);
				assert.equal(after.status, state);
				observe({ kind: "stay", subject, event: stay.event, from: before.status, to: after.status });
			}

	for (const r of refusals(machine)) {
		const subject = r.subject;
		const before = await meetingIn(subject, r.from);
		refused(await fire(before, r.event, r.to), machine.refusal);
		const after = await stored(before.id);
		assert.deepEqual(after, before, `${subject} ${r.event} ${r.from} -> ${r.to} left the row unchanged`);
		observe({ kind: "refusal", subject, event: r.event, from: before.status, to: r.to });
	}

	const report = coverage(machine, refusals(machine), observations);
	if (process.env.EVF_MACHINE_COVERAGE)
		appendFileSync(process.env.EVF_MACHINE_COVERAGE, observations.map((o) => `${JSON.stringify(o)}\n`).join(""));
	t.diagnostic(report.line);
	assert.deepEqual(report.missing, []);
});
