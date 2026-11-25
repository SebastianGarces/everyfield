import { fixture, ok, refused, waitingOnLock, type Actor, type Workspace } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/src/query.ts";
import {
	authorityOf,
	church,
	memoryStorage,
	noReminders,
	okWith,
	plantPerson,
	reads as read,
	type Reply,
} from "./people-support.mts";
import { recorded, touched } from "../../support/recorded.mts";
import { fixture as invitationFixture } from "../identity/invitations-support.mts";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { accountId, owner, personId, revision, type Owner } from "../../../packages/contracts/src/common/index.ts";
import type { PeopleContext, PeopleReply } from "../../../packages/contracts/src/people/server.ts";
import type { WriteTx } from "../../../packages/domain/src/access/session.ts";
import { PeopleReadContext, withPeopleWrite, type Context } from "../../../packages/domain/src/people/core.ts";
import { effectiveAdult, effectiveAdultSql, plantTodaySql } from "../../../packages/domain/src/people/adult.ts";
import {
	assessments,
	commitments,
	peopleMerge,
	peopleUnmerge,
	peopleWriter as write,
	accountPersonProducer as accounts,
	getAccountLink,
	readColumnOrders,
	readPersonPage,
	personFields as fields,
	readPersonPhoto,
	readPersonPhotos,
	uploadPersonPhoto,
} from "../../../packages/domain/src/people/index.ts";
import { gatedTransaction, lockedWrite, nativeWrite } from "../../../packages/domain/src/operations/writes.ts";
import {
	createAttendanceWriter,
	guestsWriter,
	withMeetingsWrite,
	type MeetingsContext,
} from "../../../packages/domain/src/meetings/index.ts";
import {
	createTaskWriter,
	taskReader,
	withTaskWrite,
	type TaskContext,
} from "../../../packages/domain/src/tasks/index.ts";
import { runDueObjectCleanup } from "../../../packages/domain/src/jobs/object-cleanup.ts";
import { ownerLabel } from "../../../apps/web/src/features/tasks/model.ts";

const database = await fixture({ prefix: "wp011", max: 6, plant: { timezone: "America/New_York" } });
const { admin } = database;
const db = database.pools.runtime;
const cases = await fixture({
	prefix: "wp011_cases",
	max: 6,
	plant: { timezone: "America/Chicago", name: "P" },
	clock: new Date("2026-10-13T16:00:00Z"),
});
const caseDb = cases.pools.runtime;
const P = cases.tenant,
	Q = await cases.plant({ timezone: "America/New_York", name: "Q" });
const alexAccount = await cases.actor(P, "admin", { email: "alex@example.test" }),
	coauthor = await cases.actor(P, "admin"),
	seatedMember = cases.actors.member,
	casey = await cases.actor(Q, "admin", { email: "casey@example.test" });
let queries: string[] = [];
let beforeSend: ((text: string) => Promise<void>) | null = null;

const plants = [database.tenant.id, (await database.plant({ timezone: "America/New_York" })).id] as const,
	organization = (await database.organization("sending_church", { timezone: "America/New_York" })).id,
	actors = [
		database.actors.owner,
		database.actors.member,
		await database.actor({ kind: "plant", id: plants[1] }, "admin"),
		await database.actor({ kind: "organization", id: organization, organizationKind: "sending_church" }, "owner", {
			account: { registration_kind: "planter" },
		}),
		database.actors.admin,
	] as const;
type Classify = "recordAdultClassification" | "correctAdultClassification";
type Read = [string, (t: WriteTx) => Promise<PeopleReply<unknown>>];
type Expected = "ok" | "refused";
type Who = 0 | 1 | 2 | 3 | 4;
type Person = Awaited<ReturnType<typeof create>>;
type Note = Extract<Item, { kind: "note" }>;
type Item = Extract<Awaited<ReturnType<typeof read.getActivities>>, { status: "ok" }>["value"]["items"][number];
type Column = Parameters<typeof readColumnOrders>[2][number];
const columnOrder = async (t: WriteTx, column: Column) => (await readColumnOrders(t, ctx(), [column]))[0]!;
const ctx = (who: Who = 0, selected: Owner = church(plants[0])): PeopleContext => ({
	session: actors[who].session,
	selected,
});
const sendingChurch = owner.parse({ kind: "organization", id: organization, organizationKind: "sending_church" });
const orgCtx = () => ctx(3, sendingChurch);
async function tx<T>(body: (t: WriteTx) => Promise<T>) {
	return gatedTransaction(db, body);
}

async function create(name = "Jamie", fields = {}) {
	return ok(
		await tx((t) =>
			write.createPerson(t, ctx(), {
				requestKey: randomUUID(),
				input: { displayName: name, ...fields },
			}),
		),
	).person;
}
before(async () => {
	db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (this: unknown, ...args: [string | { text: string }, ...unknown[]]) {
			const text = typeof args[0] === "string" ? args[0] : args[0].text;
			queries.push(text);
			const hook = beforeSend;
			return hook ? hook(text).then(() => Reflect.apply(query, this, args)) : Reflect.apply(query, this, args);
		};
	});
});
after(async () => {
	await database.close();
	await cases.close();
});

async function seatedReader(role: "owner" | "admin" | "member", selected: Workspace) {
	const a = await database.actor(null, role, { account: { registration_kind: "planter" } });
	const seat = await database.seat(a, selected, role);
	const reader = new PeopleReadContext(await tx((t) => authorityOf(t, a)));
	return { ...a, seat, selected: owner.parse(selected), reader };
}

test("AC:TARGET-PPL-002 AC:LAUNCH46-003 AC:SEC-02 AC:TEN-002 minimal contact, explicit null, current tenancy and atomic retry", async () => {
	const input = {
		requestKey: randomUUID(),
		input: {
			displayName: "  Jamie  ",
			city: "Chicago",
			summaryNotes: "Operational",
		},
	};
	const first = ok(await tx((t) => write.createPerson(t, ctx(), input))),
		again = ok(await tx((t) => write.createPerson(t, ctx(), input)));
	assert.deepEqual(again, first);
	const replayCounts = (
		await admin.execute(
			sql`SELECT (SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM audit_event) operations,(SELECT count(*)::int FROM audit_event) events`,
		)
	).rows[0];
	for (const changed of [
		(t: WriteTx) => write.createPerson(t, ctx(), { ...input, input: { displayName: "Different request body" } }),
		(t: WriteTx) => write.createPerson(t, ctx(4), input),
		(t: WriteTx) =>
			write.updatePerson(t, ctx(), {
				requestKey: input.requestKey,
				expectedRevision: first.person.revision,
				input: { personId: first.person.id, patch: { city: "Different operation" } },
			}),
	])
		refused(await tx(changed), "conflict");
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT (SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM audit_event) operations,(SELECT count(*)::int FROM audit_event) events`,
			)
		).rows[0],
		replayCounts,
	);
	assert.equal(first.person.displayName, "Jamie");
	assert.equal(first.person.adultClassification, "unknown");
	assert.deepEqual(first.person.commitment, { state: "unknown" });
	assert.equal(first.person.firstName, null);
	const changed = ok(
		await tx((t) =>
			write.updatePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: first.person.revision,
				input: { personId: first.person.id, patch: { city: null } },
			}),
		),
	);
	assert.equal(changed.person.city, null);
	refused(
		await tx((t) =>
			write.updatePerson(t, ctx(1), {
				requestKey: randomUUID(),
				expectedRevision: changed.person.revision,
				input: { personId: first.person.id, patch: { displayName: "forged" } },
			}),
		),
	);
	refused(await tx((t) => read.getPerson(t, ctx(2), { personId: first.person.id })));
	refused(await tx((t) => read.getPerson(t, ctx(2), { personId: randomUUID() })));
	assert.equal(
		plantPerson(await tx((t) => read.getPerson(t, ctx(1), { personId: first.person.id }))).displayName,
		"Jamie",
	);
	const event = (
		await admin.execute(
			sql`SELECT actor_id,reason,metadata->'diff' AS diff FROM audit_event WHERE command_id=${sql.param(changed.receiptId)}`,
		)
	).rows[0]!;
	assert.equal(event.actor_id, actors[0].id);
	assert.equal(event.reason, null);
	assert.equal(event.diff, null);
	assert.equal(
		(await admin.execute(sql`SELECT tenant_id FROM person WHERE id=${sql.param(first.person.id)}`)).rows[0]!.tenant_id,
		plants[0],
	);
	const n = (await admin.execute(sql`SELECT count(*)::int AS n FROM person`)).rows[0]!.n;
	await assert.rejects(
		tx(async (t) => {
			ok(
				await write.createPerson(t, ctx(), {
					requestKey: randomUUID(),
					input: { displayName: "rollback" },
				}),
			);
			throw Error("required_intent_fault");
		}),
		/required_intent_fault/,
	);
	assert.equal((await admin.execute(sql`SELECT count(*)::int AS n FROM person`)).rows[0]!.n, n);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[4].id)}`);
	refused(await tx((t) => write.createPerson(t, ctx(4), input)));
	await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[4].id)}`);
});

test("AC:TARGET-PPL-001 literal search, tag intersection, full totals and page numbers past ties", async () => {
	const a = await create("Literal %_ person"),
		b = await create("Literal %_ person 2");
	await admin.execute(
		sql`UPDATE person SET created_at='2026-10-01T12:00:00Z' WHERE id=ANY(${sql.param([a.id, b.id])})`,
	);
	const req = { search: "%_", limit: 1 };
	const page = ok(await tx((t) => read.listPeople(t, ctx(1), req)));
	assert.equal(page.total, 2);
	assert.equal(page.items.length, 1);
	assert.equal(page.next, 2);
	const second = ok(await tx((t) => read.listPeople(t, ctx(1), { ...req, page: 2 })));
	assert.equal(second.items.length, 1);
	assert.notEqual(second.items[0]!.id, page.items[0]!.id);
	assert.equal(second.next, null);
	const beyond = ok(await tx((t) => read.listPeople(t, ctx(1), { ...req, page: 3 })));
	assert.deepEqual([beyond.items, beyond.total, beyond.next], [[], 2, null]);
	const other = ok(await tx((t) => read.listPeople(t, ctx(2, church(plants[1])), { ...req, page: 2 })));
	assert.deepEqual([other.items, other.total], [[], 0]);
	refused(
		await tx((t) => read.listPeople(t, ctx(), { search: "Literal", privateNote: "CANARY" } as never)),
		"invalid_input",
	);
	const tags = [randomUUID(), randomUUID()];
	for (const [i, id] of tags.entries())
		await admin.execute(
			sql`INSERT INTO tag(id,plant_id,name,normalized_name,color) VALUES(${sql.param(id)},${sql.param(plants[0])},${sql.param("tag" + i)},${sql.param("tag" + i)},'blue')`,
		);
	for (const [person, tag] of [
		[a.id, tags[0]],
		[a.id, tags[1]],
		[b.id, tags[0]],
	])
		await admin.execute(
			sql`INSERT INTO person_tag(person_id,plant_id,tag_id) VALUES(${sql.param(person)},${sql.param(plants[0])},${sql.param(tag)})`,
		);
	const tagged = ok(await tx((t) => read.listPeople(t, ctx(), { tags })));
	assert.deepEqual(
		tagged.items.map((p) => p.id),
		[a.id],
	);
});

test("INV-people: the city filter matches the recorded city whole, ignoring case, never a name, and joins the stage filter", async () => {
	const a = await create("City filter Ada", { city: "Austin" }),
		b = await create("City filter Ben", { city: "austin", stage: "attendee" });
	await create("City filter Cy", { city: "South Austin" });
	await create("City filter Austin Dee", { city: "Round Rock" });
	await create("City filter Eve");
	const ids = (page: { items: { id: string }[] }) => page.items.map((p) => p.id).sort();
	const all = ok(await tx((t) => read.listPeople(t, ctx(1), { search: "City filter", city: " AUSTIN " })));
	assert.deepEqual([ids(all), all.total, all.next], [[a.id, b.id].sort(), 2, null]);
	const prospects = ok(
		await tx((t) => read.listPeople(t, ctx(1), { search: "City filter", city: "austin", stages: ["prospect"] })),
	);
	assert.deepEqual([ids(prospects), prospects.total], [[a.id], 1]);
	const board = ok(await tx((t) => read.getPipelineData(t, ctx(), { search: "City filter", city: "Austin" })));
	assert.deepEqual(
		board.groups.map((g) => [g.column, g.total, g.cards.map((c) => c.person.id)]),
		[
			["prospect", 1, [a.id]],
			["attendee", 1, [b.id]],
			["following_up", 0, []],
			["interviewed", 0, []],
			["core_group", 0, []],
		],
	);
	refused(await tx((t) => read.listPeople(t, ctx(), { search: "City filter", city: "" })), "invalid_input");
});
test("BUG-PR110: people pages retain microseconds across 25 equal timestamp keys", async (t) => {
	const ids = Array.from({ length: 25 }, () => randomUUID()).sort();
	t.after(() => admin.execute(sql`DELETE FROM person WHERE id=ANY(${sql.param(ids)}::uuid[])`));
	for (const id of ids)
		await admin.execute(
			sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at) VALUES(${id},${plants[0]},${plants[0]},'Microsecond people','other','prospect','unknown','unknown',0,'live','2026-10-01T12:00:00.123456Z')`,
		);
	for (const view of ["list", "pipeline"] as const) {
		const first = ok(await tx((t) => read.listPeople(t, ctx(), { search: "Microsecond people", view, limit: 24 })));
		assert.equal(first.total, 25);
		assert.deepEqual(
			first.items.map((p) => p.id),
			ids.slice(0, 24),
		);
		assert.equal(first.completeness, "partial");
		const last = ok(
			await tx((t) => read.listPeople(t, ctx(), { search: "Microsecond people", view, limit: 24, page: first.next! })),
		);
		assert.deepEqual(
			last.items.map((p) => p.id),
			ids.slice(24),
		);
		assert.equal(last.total, 25);
		assert.equal(last.next, null);
		assert.equal(last.completeness, "complete");
	}
});

test("BUG-PR110: activity pages retain microseconds across equal timestamp keys", async () => {
	const p = await create("Microsecond activities");
	const ids = Array.from({ length: 25 }, () => randomUUID()).sort();
	for (const id of ids)
		await admin.execute(
			sql`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at) VALUES(${id},${plants[0]},${plants[0]},${p.id},${actors[0].id},'Microsecond note','2026-10-01T12:00:00.654321Z','2026-10-01T12:00:00.654321Z')`,
		);
	const newest = [...ids].reverse();
	const first = ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"], limit: 24 })));
	assert.deepEqual(
		first.items.map((a) => a.id),
		newest.slice(0, 24),
	);
	assert.equal(first.completeness, "partial");
	const last = ok(
		await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"], limit: 24, page: first.next! })),
	);
	assert.deepEqual(
		last.items.map((a) => a.id),
		newest.slice(24),
	);
	assert.equal(last.next, null);
	assert.equal(last.completeness, "complete");
});

test("AC:TARGET-PPL-008 person Activity is newest first and pages continue with older items without gaps or duplicates", async () => {
	const p = await create("Newest first");
	const notes = Array.from({ length: 30 }, (_, i) => ({
		id: randomUUID(),
		at: new Date(Date.UTC(2026, 9, 1, 12, i)).toISOString(),
	}));
	for (const n of [...notes].sort(() => Math.random() - 0.5))
		await admin.execute(
			sql`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at) VALUES(${n.id},${plants[0]},${plants[0]},${p.id},${actors[0].id},'Note',${n.at},${n.at})`,
		);
	const feed = async (page: number) =>
		ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"], limit: 24, page })));
	const first = await feed(1);
	const second = await feed(first.next!);
	const newest = [...notes].reverse().map((n) => n.id);
	assert.deepEqual(
		first.items.map((a) => a.id),
		newest.slice(0, 24),
	);
	assert.equal(first.next, 2);
	assert.deepEqual(
		second.items.map((a) => a.id),
		newest.slice(24),
	);
	assert.equal(second.next, null);
	const all = [...first.items, ...second.items].map((a) => a.id);
	assert.equal(new Set(all).size, 30);
	assert.deepEqual(all, newest);
	const edited = ok(
		await tx((t) =>
			write.updatePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: { personId: p.id, patch: { phone: "555-0101" } },
			}),
		),
	);
	const viewer = new PeopleReadContext(await tx((t) => authorityOf(t, actors[0])));
	const { activities } = ok(await readPersonPage(db, viewer, { personId: p.id }, 24));
	assert.ok(activities);
	const page = ok(activities);
	assert.equal(page.items.length, 24);
	assert.ok(page.items[0]?.kind === "activity");
	assert.equal(page.items[0].action, "updated");
	assert.equal(edited.person.id, p.id);
});

test("AC:TARGET-PPL-004 AC:ROLE43-003 exact account links, ambiguous contact selection and concurrent uniqueness", async () => {
	const contact = await create("Proven account", {
			email: actors[0].id + "@example.test",
		}),
		duplicate = await create("Another contact", {
			email: actors[0].id + "@example.test",
		});
	const input = {
		accountId: accountId.parse(actors[0].id),
		owner: church(plants[0]),
		selection: { kind: "resolve" as const },
	};
	const needs = okWith(await tx((t) => accounts.ensureAccountPerson(t, input)), "needs_selection");
	assert.deepEqual(new Set(needs.candidatePersonIds), new Set([contact.id, duplicate.id]));
	const selected = {
		...input,
		selection: {
			kind: "reviewed_contact" as const,
			person: {
				owner: church(plants[0]),
				personId: contact.id,
				revision: contact.revision,
				state: "live" as const,
			},
		},
	};
	const results = await Promise.all([
		tx((t) => accounts.ensureAccountPerson(t, selected)),
		tx((t) => accounts.ensureAccountPerson(t, selected)),
	]);
	for (const r of results) assert.equal(okWith(r, "linked").personId, contact.id);
	assert.equal(
		(
			await admin.execute(
				sql`SELECT count(*)::int n FROM person WHERE linked_account_id=${sql.param(actors[0].id)} AND plant_id=${sql.param(plants[0])} AND state='live'`,
			)
		).rows[0]!.n,
		1,
	);
	await assert.rejects(
		tx((t) => accounts.ensureAccountPerson(t, { ...input, selection: { kind: "first", displayName: "Second" } })),
	);
	assert.equal(
		(
			await admin.execute(
				sql`SELECT count(*)::int n FROM person WHERE linked_account_id=${sql.param(actors[0].id)} AND plant_id=${sql.param(plants[0])} AND state='live'`,
			)
		).rows[0]!.n,
		1,
	);
	assert.deepEqual(ok(await tx((t) => getAccountLink(t, ctx(), { personId: contact.id }))), {
		status: "linked",
		personId: contact.id,
	});
	assert.deepEqual(ok(await tx((t) => read.getOwnAccountPerson(t, ctx(), {}))), {
		status: "linked",
		personId: contact.id,
	});
	const dto = plantPerson(await tx((t) => read.getPerson(t, ctx(), { personId: contact.id })));
	assert.equal("linkedAccountId" in dto, false);
	assert.deepEqual(dto.commitment, { state: "unknown" });
	await tx((t) =>
		write.updatePerson(t, ctx(), {
			requestKey: randomUUID(),
			expectedRevision: dto.revision,
			input: { personId: contact.id, patch: { email: "crm@example.test" } },
		}),
	);
	assert.equal(okWith(await tx((t) => read.getOwnAccountPerson(t, ctx(), {})), "linked").personId, contact.id);
	const current = plantPerson(await tx((t) => read.getPerson(t, ctx(), { personId: contact.id })));
	const review = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: current.id }))).reviewRevision;
	const retired = ok(
		await tx((t) =>
			write.retirePerson(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision: current.revision,
					input: { personId: current.id, reason: "Retire linked Person", reviewRevision: review, handoffs: [] },
				},
				noReminders,
			),
		),
	);
	const replacement = okWith(
		await tx((t) =>
			accounts.ensureAccountPerson(t, { ...input, selection: { kind: "create", displayName: "New linked Person" } }),
		),
		"linked",
	);
	assert.notEqual(replacement.personId, current.id);
	const bootstrap = (
		await admin.execute(
			sql`SELECT stage,adult_classification,commitment_state FROM person WHERE id=${sql.param(replacement.personId)}`,
		)
	).rows[0];
	assert.deepEqual(bootstrap, { stage: "leader", adult_classification: "unknown", commitment_state: "unknown" });
	const bootstrapHistory = (
		await admin.execute(
			sql`SELECT after_value->>'stage' AS stage FROM audit_event WHERE subject_id=${sql.param(replacement.personId)}`,
		)
	).rows;
	assert.deepEqual(bootstrapHistory, [{ stage: "leader" }]);
	const request = {
		requestKey: randomUUID(),
		expectedRevision: retired.person.revision,
		input: { personId: current.id },
	};
	const counts = (
		await admin.execute(
			sql`SELECT (SELECT count(*)::int FROM audit_event) operations,(SELECT count(*)::int FROM audit_event) history,(SELECT count(*)::int FROM audit_event) events`,
		)
	).rows[0];
	await tx(async (t) => {
		const refusal = await write.restorePerson(t, ctx(), request);
		const error = refused(refusal, "conflict");
		assert.deepEqual(error.details, {});
		assert.equal(error.retry, "refresh");
		assert.equal((await t.execute(sql`SELECT 1 AS usable`)).rows[0]!.usable, 1);
	});
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT (SELECT count(*)::int FROM audit_event) operations,(SELECT count(*)::int FROM audit_event) history,(SELECT count(*)::int FROM audit_event) events`,
			)
		).rows[0],
		counts,
	);
	assert.equal(
		okWith(await tx((t) => read.getOwnAccountPerson(t, ctx(), {})), "linked").personId,
		replacement.personId,
	);
	assert.deepEqual(
		(await admin.execute(sql`SELECT state,revision,linked_account_id FROM person WHERE id=${sql.param(current.id)}`))
			.rows[0],
		{ state: "retired", revision: retired.person.revision, linked_account_id: actors[0].id },
	);
});

test("AC:TARGET-PPL-006 assigning a duty to someone already on it keeps them on it", async () => {
	const leaving = await create("Leaving"),
		stays = await create("Stays");
	await admin.execute(
		sql`UPDATE person SET linked_account_id=${sql.param(actors[1].id)} WHERE id=${sql.param(stays.id)}`,
	);
	const duty = randomUUID();
	await admin.execute(
		sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id) VALUES(${sql.param(duty)},${sql.param(plants[0])},'Visit','follow_up','medium','not_started',clock_timestamp(),'undated',${sql.param(leaving.id)})`,
	);
	await admin.execute(
		sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${sql.param(plants[0])},${sql.param(duty)},${sql.param(actors[1].id)})`,
	);
	const review = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: leaving.id }))).reviewRevision;
	ok(
		await tx((t) =>
			write.retirePerson(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision: leaving.revision,
					input: {
						personId: leaving.id,
						reason: "Retire",
						reviewRevision: review,
						handoffs: [{ kind: "assign", dutyId: duty, expectedRevision: "1", toPersonId: stays.id }],
					},
				},
				noReminders,
			),
		),
	);
	assert.deepEqual(
		(await admin.execute(sql`SELECT account_id FROM task_assignee WHERE task_id=${sql.param(duty)}`)).rows,
		[{ account_id: actors[1].id }],
	);
});

test("INV-person-lock: retiring locks the person and the review, then the duty and the member it moves to, and refuses as before", async () => {
	const leaving = await create("Hands off"),
		takes = await create("Takes over"),
		member = (await database.actor({ kind: "plant", id: plants[0] }, "member")).id;
	await admin.execute(sql`UPDATE person SET linked_account_id=${sql.param(member)} WHERE id=${sql.param(takes.id)}`);
	const duty = randomUUID();
	await admin.execute(
		sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id) VALUES(${sql.param(duty)},${sql.param(plants[0])},'Visit','follow_up','medium','not_started',clock_timestamp(),'undated',${sql.param(leaving.id)})`,
	);
	const review = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: leaving.id }))).reviewRevision;
	const retire = (reviewRevision: string, handoffs: readonly object[], expectedRevision: string = leaving.revision) =>
		tx((t) =>
			write.retirePerson(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision,
					input: { personId: leaving.id, reason: "Retire", reviewRevision, handoffs },
				},
				noReminders,
			),
		);
	const assign = [{ kind: "assign", dutyId: duty, expectedRevision: "1", toPersonId: takes.id }] as const;
	refused(await retire(review, assign, String(BigInt(leaving.revision) + 1n)), "conflict");
	refused(await retire(String(BigInt(review) + 1n), assign), "conflict");
	refused(await retire(review, []), "conflict");
	refused(await retire(review, [...assign, ...assign]), "conflict");
	refused(await retire(review, [{ ...assign[0], toPersonId: leaving.id }]), "invalid_subject");
	const { promise: held, resolve: release } = Promise.withResolvers<void>();
	const { promise: holding, resolve: locked } = Promise.withResolvers<void>();
	const other = admin.transaction(async (b) => {
		await b.execute(sql`SELECT 1 FROM person WHERE id=${sql.param(takes.id)}::uuid FOR UPDATE`);
		locked();
		await held;
	});
	await holding;
	const mine = retire(review, assign);
	assert.ok(await waitingOnLock(db), "the retirement waits for the member the duty moves to");
	release();
	await other;
	assert.equal(ok(await mine).person.lifecycle.state, "retired");
	assert.deepEqual(
		(await admin.execute(sql`SELECT account_id FROM task_assignee WHERE task_id=${sql.param(duty)}`)).rows,
		[{ account_id: member }],
	);
});

test("INV-person-lock: a reviewed contact that changed, is linked elsewhere or is no candidate is refused as before", async () => {
	const account = accountId.parse((await database.actor({ kind: "plant", id: plants[0] }, "member")).id);
	const contact = await create("Reviewed contact", { email: account + "@example.test" }),
		other = await create("Not a contact", { email: "someone-else@example.test" });
	const review = (person: Pick<Person, "id" | "revision">, revision = person.revision) =>
		tx((t) =>
			accounts.ensureAccountPerson(t, {
				accountId: account,
				owner: church(plants[0]),
				selection: {
					kind: "reviewed_contact",
					person: { owner: church(plants[0]), personId: person.id, revision, state: "live" },
				},
			}),
		);
	refused(await review(contact, revision.parse(String(BigInt(contact.revision) + 1n))), "conflict");
	refused(await review(other));
	refused(await review({ id: personId.parse(randomUUID()), revision: revision.parse("1") }));
	assert.equal(okWith(await review(contact), "linked").personId, contact.id);
	assert.deepEqual(ok(await review(other)), { status: "linked", personId: contact.id });
});

test("INV-person-lock: a second account link that waits on the account returns the Person the first one created", async () => {
	const account = accountId.parse((await database.actor({ kind: "plant", id: plants[0] }, "member")).id);
	const input = {
		accountId: account,
		owner: church(plants[0]),
		selection: { kind: "create" as const, displayName: "Linked once" },
	};
	const { promise: held, resolve: release } = Promise.withResolvers<void>();
	const { promise: holding, resolve: created } = Promise.withResolvers<void>();
	const first = tx(async (t) => {
		const r = await accounts.ensureAccountPerson(t, input);
		created();
		await held;
		return r;
	});
	await holding;
	const second = tx((t) => accounts.ensureAccountPerson(t, input));
	assert.ok(await waitingOnLock(db), "the second call waits for the account");
	release();
	const linked = okWith(await first, "linked").personId;
	assert.deepEqual(ok(await second), { status: "linked", personId: linked });
});

test("AC:TARGET-PPL-006 AC:TARGET-PPL-007 AC:TARGET-PPL-003 stage skip, no-op, complete handoffs, retirement and guarded restore", async () => {
	let p = await create("Lifecycle");
	const result = ok(
		await tx((t) =>
			write.changeStatus(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision: p.revision,
					input: {
						personId: p.id,
						stage: "leader",
						reason: "Human chose a skip",
						handoffs: [],
					},
				},
				noReminders,
			),
		),
	);
	p = result.person;
	assert.equal(p.stage, "leader");
	assert.deepEqual(p.commitment, { state: "unknown" });
	const [changed] = ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id }))).items;
	assert.ok(changed?.kind === "stage_changed");
	assert.deepEqual([changed.from, changed.to], ["prospect", "leader"]);
	const noop = ok(
		await tx((t) =>
			write.changeStatus(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision: p.revision,
					input: {
						personId: p.id,
						stage: "leader",
						reason: "Same stage",
						handoffs: [],
					},
				},
				noReminders,
			),
		),
	);
	assert.equal(noop.outcome, "noop");
	assert.equal(noop.person.revision, p.revision);
	const duty = randomUUID(),
		team = randomUUID();
	await admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source) VALUES(${sql.param(team)},${sql.param(plants[0])},'Retiring leader','active',0,${sql.param(p.id)},'explicit')`,
	);
	await admin.execute(
		sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id) VALUES(${sql.param(duty)},${sql.param(plants[0])},'Call','follow_up','medium','not_started',clock_timestamp(),'undated',${sql.param(p.id)})`,
	);
	await admin.execute(
		sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${sql.param(plants[0])},${sql.param(duty)},${sql.param(actors[0].id)})`,
	);
	const review = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: p.id }))).reviewRevision;
	refused(
		await tx((t) =>
			write.retirePerson(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision: p.revision,
					input: {
						personId: p.id,
						reason: "Retire",
						reviewRevision: review,
						handoffs: [],
					},
				},
				noReminders,
			),
		),
		"conflict",
	);
	const retired = ok(
		await tx((t) =>
			write.retirePerson(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision: p.revision,
					input: {
						personId: p.id,
						reason: "Retire",
						reviewRevision: review,
						handoffs: [{ kind: "needs_owner", dutyId: duty, expectedRevision: "1" }],
					},
				},
				noReminders,
			),
		),
	);
	assert.deepEqual(retired.needsOwner, [duty]);
	assert.equal((await admin.execute(sql`SELECT 1 FROM task_assignee WHERE task_id=${sql.param(duty)}`)).rows.length, 0);
	assert.equal(retired.person.lifecycle.state, "retired");
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT leader_person_id,leader_source,leader_role_id,revision FROM team WHERE id=${sql.param(team)}`,
			)
		).rows[0],
		{ leader_person_id: null, leader_source: null, leader_role_id: null, revision: "2" },
	);
	assert.equal(ok(await tx((t) => read.listPeople(t, ctx(), { search: "Lifecycle" }))).total, 0);
	await assert.rejects(
		admin.execute(
			sql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind,person_id) VALUES(${sql.param(plants[0])},'New','follow_up','medium','not_started',clock_timestamp(),'undated',${sql.param(p.id)})`,
		),
		(error) =>
			error instanceof Error &&
			error.cause instanceof Error &&
			"code" in error.cause &&
			error.cause.code === "23514" &&
			error.cause.message === "person_not_live",
	);
	const restored = ok(
		await tx((t) =>
			write.restorePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: retired.person.revision,
				input: { personId: p.id },
			}),
		),
	);
	assert.equal(restored.person.lifecycle.state, "live");
	const warnings = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: p.id })));
	assert.equal(warnings.hardGate, false);
	assert.equal(warnings.allowedStages.length, 7);
	const pipeline = ok(await tx((t) => read.getPipelineData(t, ctx(1), {})));
	assert.equal(pipeline.groups.length, 5);
	assert.ok(pipeline.groups.find((g) => g.column === "core_group")!.cards.some((card) => card.person.id === p.id));
	refused(
		await tx((t) =>
			write.reorderPipeline(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { column: "prospect", personId: p.id, afterId: null },
			}),
		),
		"conflict",
	);
	const survivor = await create("Survivor");
	await admin.execute(
		sql`UPDATE person SET state='merged',merged_into_person_id=${sql.param(survivor.id)},retired_at=clock_timestamp() WHERE id=${sql.param(p.id)}`,
	);
	refused(
		await tx((t) =>
			write.restorePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: restored.person.revision,
				input: { personId: p.id },
			}),
		),
		"use_reviewed_unmerge",
	);
});

function note(item: Item | undefined): Note {
	assert.ok(item?.kind === "note");
	return item;
}
const storedRevision = async (personId: string) =>
	(await admin.execute(sql`SELECT revision::text AS revision FROM person WHERE id=${personId}::uuid`)).rows[0]!
		.revision;

test("AC:TARGET-PPL-008 original author and exact note revisions preserve occurrence, tombstone and removed attribution", async () => {
	const p = await create("Notes");
	const added = ok(
		await tx((t) =>
			write.addNote(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: { personId: p.id, body: "Original operational note" },
			}),
		),
	);
	assert.equal(added.personRevision, await storedRevision(p.id));
	assert.notEqual(added.personRevision, p.revision);
	const assertNoteFeed = async (kind: string) => {
		const feed = ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id })));
		assert.deepEqual(
			feed.items.map((a) => (a.kind === "activity" ? a.action : a.kind)),
			[kind, "created"],
		);
	};
	await assertNoteFeed("note");
	const before = (
		await admin.execute(sql`SELECT occurred_at,author_id FROM person_note WHERE id=${sql.param(added.noteId)}`)
	).rows[0];
	refused(
		await tx((t) =>
			write.editNote(t, ctx(4), {
				requestKey: randomUUID(),
				expectedRevision: added.revision,
				input: {
					personId: p.id,
					noteId: added.noteId,
					body: "Not mine",
					reason: "Edit",
				},
			}),
		),
	);
	const edited = ok(
		await tx((t) =>
			write.editNote(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: added.revision,
				input: {
					personId: p.id,
					noteId: added.noteId,
					body: "Corrected operational note",
					reason: "Correction",
				},
			}),
		),
	);
	assert.equal(edited.personRevision, await storedRevision(p.id));
	assert.notEqual(edited.personRevision, added.personRevision);
	assert.deepEqual(
		(await admin.execute(sql`SELECT occurred_at,author_id FROM person_note WHERE id=${sql.param(added.noteId)}`))
			.rows[0],
		before,
	);
	const timeline = ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"] })));
	assert.equal(note(timeline.items[0]).body, "Corrected operational note");
	await assertNoteFeed("note");
	const deleted = ok(
		await tx((t) =>
			write.deleteNote(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: edited.revision,
				input: { personId: p.id, noteId: added.noteId, reason: "Remove body" },
			}),
		),
	);
	assert.equal(deleted.revision, "3");
	assert.equal(deleted.personRevision, await storedRevision(p.id));
	assert.notEqual(deleted.personRevision, edited.personRevision);
	await assertNoteFeed("note_removed");
	assert.deepEqual(
		(
			await admin.execute(sql`SELECT
			(SELECT count(*)::int FROM audit_event e JOIN audit_event o ON o.id=e.command_id WHERE e.subject_id=${p.id} AND o.request_identity->>'operation' IN ('people.addNote','people.editNote','people.deleteNote')) AS audits,
			(SELECT count(*)::int FROM audit_event WHERE subject_id=${p.id} AND metadata->>'correction'='true') AS corrections,
			(SELECT count(*)::int FROM audit_event WHERE subject_id=${p.id} AND action='people.updated' AND metadata->>'category' IS DISTINCT FROM 'note') AS updates`)
		).rows[0],
		{ audits: 3, corrections: 2, updates: 0 },
	);
	assert.equal(
		(await admin.execute(sql`SELECT body FROM person_note WHERE id=${sql.param(added.noteId)}`)).rows[0]!.body,
		"",
	);
	assert.equal(
		ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"] }))).items[0]!.kind,
		"note_removed",
	);
});

test("AC:TARGET-PPL-008 every church seat who can see a note sees its author's name, and it stays after the author's seat ends", async () => {
	const plant = await database.plant({ timezone: "America/New_York" });
	const seated = async (role: "owner" | "admin" | "member", name: string) =>
		database.actor(plant, role, { user: { name } });
	const on = (a: Actor) => ({ session: a.session, selected: church(plant.id) });
	const authors = [await seated("owner", "Ruth"), await seated("admin", "Orpah")] as const;
	const readers = [await seated("admin", "Naomi"), await seated("member", "Boaz")];
	const p = ok(
		await tx((t) =>
			write.createPerson(t, on(authors[0]), { requestKey: randomUUID(), input: { displayName: "Named notes" } }),
		),
	).person;
	let expectedRevision = p.revision;
	for (const author of authors) {
		const added = ok(
			await tx((t) =>
				write.addNote(t, on(author), {
					requestKey: randomUUID(),
					expectedRevision,
					input: { personId: p.id, body: `Note from ${author.id}` },
				}),
			),
		);
		expectedRevision = added.personRevision;
	}
	const names = async (reader: Actor) =>
		ok(await tx((t) => read.getActivities(t, on(reader), { personId: p.id, kinds: ["note"] }))).items.map((a) => [
			note(a).body,
			note(a).authorName,
		]);
	const expected = [
		[`Note from ${authors[1]!.id}`, "Orpah"],
		[`Note from ${authors[0]!.id}`, "Ruth"],
	];
	for (const reader of [...authors, ...readers]) assert.deepEqual(await names(reader), expected);
	await admin.execute(
		sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id IN (${sql.join(
			authors.map((a) => sql`${a.id}::uuid`),
			sql`,`,
		)})`,
	);
	for (const reader of readers) assert.deepEqual(await names(reader), expected);
});

test("AC:CA014 BUG-37313a5c7 explicit adult classification retains genuine historical acquisition rather than creating a join today, and refuses a day after the church's today", async () => {
	const p = await create("Historical commitment");
	const commitment = randomUUID();
	await admin.execute(
		sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at) VALUES(${sql.param(commitment)},${sql.param(plants[0])},${sql.param(p.id)},'core_group','2026-09-01',clock_timestamp())`,
	);
	await admin.execute(
		sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at) VALUES(${sql.param(randomUUID())},${sql.param(plants[0])},${sql.param(p.id)},'launch_team','2026-10-05',clock_timestamp())`,
	);
	await admin.execute(sql`UPDATE person SET commitment_state='active' WHERE id=${sql.param(p.id)}`);
	const result = ok(
		await tx((t) =>
			write.recordAdultClassification(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: {
					personId: p.id,
					classification: "adult",
					occurredOn: "2026-10-13",
					reason: "Human recorded classification",
				},
			}),
		),
	);
	assert.deepEqual(
		[result.person.adultClassification, result.person.adultClassificationSource, result.person.commitment.state],
		["adult", "recorded", "active"],
	);
	assert.equal(result.person.revision, await storedRevision(p.id));
	const before = (await admin.execute(sql`SELECT signed_on FROM commitment WHERE id=${sql.param(commitment)}`)).rows[0]!
		.signed_on;
	const corrected = ok(
		await tx((t) =>
			write.correctAdultClassification(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: result.person.revision,
				input: {
					personId: p.id,
					classification: "unknown",
					occurredOn: "2026-10-13",
					reason: "Correct unsupported classification",
				},
			}),
		),
	);
	assert.deepEqual([corrected.person.adultClassification, corrected.person.commitment.state], ["unknown", "active"]);
	assert.equal(corrected.person.revision, await storedRevision(p.id));
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT signed_on::text FROM commitment WHERE person_id=${sql.param(p.id)} ORDER BY signed_on`,
			)
		).rows.map((r) => r.signed_on),
		["2026-09-01", "2026-10-05"],
	);
	assert.deepEqual(
		(await admin.execute(sql`SELECT signed_on FROM commitment WHERE id=${sql.param(commitment)}`)).rows[0]!.signed_on,
		before,
	);
	await admin.execute(sql`UPDATE plant SET timezone='Pacific/Kiritimati' WHERE id=${plants[0]}::uuid`);
	try {
		const { today, tomorrow } = (
			await admin.execute<{ today: string; tomorrow: string }>(
				sql`SELECT (clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS today, ((clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati')::date + 1)::text AS tomorrow`,
			)
		).rows[0]!;
		const classify = (operation: Classify, occurredOn: string) =>
			tx((t) =>
				write[operation](t, ctx(), {
					requestKey: randomUUID(),
					expectedRevision: corrected.person.revision,
					input: { personId: p.id, classification: "adult", occurredOn, reason: "Church date" },
				}),
			);
		const stored = async () =>
			(await admin.execute(sql`SELECT adult_classification FROM person WHERE id=${p.id}::uuid`)).rows[0]!
				.adult_classification;
		refused(await classify("recordAdultClassification", tomorrow), "invalid_input");
		refused(await classify("correctAdultClassification", tomorrow), "invalid_input");
		assert.equal(await stored(), "unknown");
		assert.equal(ok(await classify("recordAdultClassification", today)).person.adultClassification, "adult");
		assert.equal(await stored(), "adult");
	} finally {
		await admin.execute(sql`UPDATE plant SET timezone='America/New_York' WHERE id=${plants[0]}::uuid`);
	}
});

test("INV-people: concurrent edits serialize to one current revision and one conflict without partial history", async () => {
	const p = await create("Concurrent");
	const change = (name: string) =>
		tx((t) =>
			write.updatePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: { personId: p.id, patch: { displayName: name } },
			}),
		);
	const results = await Promise.all([change("Winner A"), change("Winner B")]);
	assert.equal(results.filter((r) => r.status === "ok").length, 1);
	refused(
		results.find((r) => r.status !== "ok"),
		"conflict",
	);
	const row = plantPerson(await tx((t) => read.getPerson(t, ctx(), { personId: p.id })));
	assert.equal(BigInt(row.revision), BigInt(p.revision) + 1n);
	assert.equal(
		(
			await admin.execute(
				sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${sql.param(p.id)} AND action='people.updated'`,
			)
		).rows[0]!.n,
		1,
	);
});

test("BUG-PR124 INV-pipeline: native moves place one person, persist and retry once; a replay answers with the current order and revision", async () => {
	await create("Order A");
	await create("Order B");
	const column = async () =>
		ok(await tx((t) => read.listPeople(t, ctx(), { view: "pipeline", stages: ["prospect"], limit: 100 }))).items.map(
			(p) => p.id,
		);
	const all = await column();
	const last = all.at(-1);
	const initialPipeline = ok(await tx((t) => read.getPipelineData(t, ctx(), {})));
	const seen = initialPipeline.groups.find((g) => g.column === "prospect")!.revision;
	const order = {
		requestKey: randomUUID(),
		expectedRevision: seen,
		input: { column: "prospect", personId: last, afterId: null },
	};
	refused(await tx((t) => write.reorderPipeline(t, ctx(1), order)));
	refused(
		await tx((t) => write.reorderPipeline(t, ctx(), { ...order, input: { ...order.input, afterId: randomUUID() } })),
		"conflict",
	);
	const audits = async () =>
		(await admin.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_event`)).rows[0]!.n;
	const before = await audits();
	const saved = ok(await tx((t) => write.reorderPipeline(t, ctx(), order)));
	assert.equal(saved.outcome, "changed");
	assert.deepEqual(ok(await tx((t) => write.reorderPipeline(t, ctx(), order))), saved);
	assert.equal((await audits()) - before, 1, "one audit event for the move; the retry replays without writing");
	const first = [last, ...all.slice(0, -1)];
	assert.deepEqual(await column(), first);
	refused(await tx((t) => write.reorderPipeline(t, ctx(), { ...order, requestKey: randomUUID() })), "conflict");
	const refreshedPipeline = ok(await tx((t) => read.getPipelineData(t, ctx(), { stages: ["leader"] })));
	assert.equal(refreshedPipeline.groups.find((g) => g.column === "prospect")!.revision, String(Number(seen) + 1));
	ok(
		await tx((t) =>
			write.reorderPipeline(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: String(Number(seen) + 1),
				input: { column: "prospect", personId: all[0], afterId: null },
			}),
		),
	);
	const afterOther = await audits();
	const replay = await tx(async (t) => ({
		done: await write.reorderPipeline(t, ctx(), order),
		column: await columnOrder(t, "prospect"),
	}));
	assert.deepEqual(ok(replay.done), saved);
	assert.equal(await audits(), afterOther, "the replay writes nothing");
	assert.deepEqual(
		[replay.column.personIds, replay.column.revision],
		[[all[0], last, ...all.slice(1, -1)], String(Number(seen) + 2)],
	);
	ok(
		await tx((t) =>
			write.reorderPipeline(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: replay.column.revision,
				input: { column: "prospect", personId: last, afterId: null },
			}),
		),
	);
});

test("AC:TARGET-PPL-007 INV-stale-view: joining or leaving a column refuses a move from the older view", async () => {
	const revision = async (column: Column) => (await tx((t) => columnOrder(t, column))).revision;
	const moveWith = (rev: string, personId: string, afterId: string | null) =>
		tx((t) =>
			write.reorderPipeline(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: rev,
				input: { column: "following_up", personId, afterId },
			}),
		);
	const a = await create("Stale A", { stage: "following_up" });
	const b = await create("Stale B", { stage: "following_up" });
	const c = await create("Stale C", { stage: "following_up" });
	let seen = await revision("following_up");
	await create("Stale D", { stage: "following_up" });
	refused(await moveWith(seen, a.id, c.id), "conflict");
	seen = await revision("following_up");
	const attendeeSeen = await revision("attendee");
	const moved = ok(
		await tx((t) =>
			write.changeStatus(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision: b.revision,
					input: { personId: b.id, stage: "attendee", reason: "Stale view", handoffs: [] },
				},
				noReminders,
			),
		),
	);
	assert.notEqual(await revision("attendee"), attendeeSeen, "the column B joined moves on");
	refused(await moveWith(seen, a.id, c.id), "conflict");
	seen = await revision("following_up");
	const review = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: c.id }))).reviewRevision;
	const retired = ok(
		await tx((t) =>
			write.retirePerson(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision: c.revision,
					input: { personId: c.id, reason: "Stale view", reviewRevision: review, handoffs: [] },
				},
				noReminders,
			),
		),
	);
	refused(await moveWith(seen, a.id, null), "conflict");
	seen = await revision("following_up");
	ok(
		await tx((t) =>
			write.restorePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: retired.person.revision,
				input: { personId: c.id },
			}),
		),
	);
	refused(await moveWith(seen, a.id, null), "conflict");
	ok(await moveWith(await revision("following_up"), a.id, null));
	const core = await create("Stale core", { stage: "core_group" });
	const coreSeen = await revision("core_group");
	ok(
		await tx((t) =>
			write.changeStatus(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision: core.revision,
					input: { personId: core.id, stage: "leader", reason: "Milestone", handoffs: [] },
				},
				noReminders,
			),
		),
	);
	assert.equal(await revision("core_group"), coreSeen);
	assert.equal(moved.person.stage, "attendee");
});

test("BUG-25b8ac319: full People pages and pipeline use fixed database round trips", async (t) => {
	const ids = Array.from({ length: 101 }, () => randomUUID()).sort();
	t.after(async () => {
		await admin.execute(sql`DELETE FROM task WHERE person_id=ANY(${sql.param(ids)}::uuid[])`);
		await admin.execute(sql`DELETE FROM commitment WHERE person_id=ANY(${sql.param(ids)}::uuid[])`);
		await admin.execute(sql`DELETE FROM person WHERE id=ANY(${sql.param(ids)}::uuid[])`);
	});
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
		SELECT id,${plants[0]}::uuid,${plants[0]}::uuid,'Batch regression','other','prospect','unknown','unknown',0,'live','2026-10-01T12:00:00.123456Z'::timestamptz
		FROM unnest(${sql.param(ids)}::uuid[]) id`);
	const counts: Record<"list" | "card" | "pipeline", number[]> = { list: [], card: [], pipeline: [] };
	for (const limit of [25, 50, 100]) {
		for (const view of ["list", "card", "pipeline"] as const) {
			queries = [];
			const board =
				view === "pipeline"
					? ok(await tx((t) => read.getPipelineData(t, ctx(), { search: "Batch regression", limit })))
					: null;
			const group = board?.groups.find((g) => g.column === "prospect");
			const list =
				view === "pipeline"
					? null
					: ok(await tx((t) => read.listPeople(t, ctx(), { search: "Batch regression", limit, view })));
			counts[view].push(queries.length);
			const page = group ?? list;
			assert.ok(page);
			const items = group ? group.cards.map((c) => c.person) : list!.items;
			assert.deepEqual(
				items.map((p) => p.id),
				ids.slice(0, limit),
			);
			assert.equal(page.total, 101);
			assert.equal(page.next, 2);
			assert.deepEqual(
				items.map((p) => p.commitment),
				Array.from({ length: limit }, () => ({ state: "unknown" })),
			);
			if (group)
				assert.deepEqual(
					group.cards.map((c) => ({ duties: c.activeParentDuties, coverage: c.coverage })),
					Array.from({ length: limit }, () => ({ duties: [], coverage: "uncovered" })),
				);
		}
	}
	t.diagnostic(JSON.stringify(counts));
	assert.deepEqual(counts.list, [5, 5, 5]);
	assert.deepEqual(counts.card, counts.list);
	assert.deepEqual(counts.pipeline, [6, 6, 6]);
	queries = [];
	const more = ok(
		await tx((t) =>
			read.getPipelineData(t, ctx(), { search: "Batch regression", limit: 25, page: 2, column: "prospect" }),
		),
	);
	assert.equal(queries.length, counts.pipeline[0]);
	const prospects = more.groups.find((g) => g.column === "prospect")!;
	assert.deepEqual(
		prospects.cards.map((c) => c.person.id),
		ids.slice(25, 50),
	);
	assert.deepEqual([prospects.total, prospects.next], [101, 3]);
	assert.deepEqual(
		more.groups.filter((g) => g.column !== "prospect").map((g) => [g.cards, g.total, g.next]),
		Array.from({ length: 4 }, () => [[], null, null]),
	);
	const past = ok(await tx((t) => read.getPipelineData(t, ctx(), { search: "Batch regression", limit: 25, page: 9 })));
	assert.deepEqual(
		past.groups.map((g) => [g.column, g.cards.length, g.total, g.next]),
		[
			["prospect", 0, 101, null],
			["attendee", 0, 0, null],
			["following_up", 0, 0, null],
			["interviewed", 0, 0, null],
			["core_group", 0, 0, null],
		],
	);
	const evidence = [randomUUID(), randomUUID()].sort();
	await admin.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at)
		SELECT id,${plants[0]}::uuid,${ids[0]}::uuid,'launch_team','2099-01-01',clock_timestamp() FROM unnest(${sql.param(evidence)}::uuid[]) id`);
	await admin.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at,voided_at)
		VALUES(${randomUUID()},${plants[0]},${ids[0]},'core_group','2099-02-01',clock_timestamp(),clock_timestamp())`);
	await admin.execute(sql`UPDATE person SET commitment_state='withdrawn' WHERE id=${ids[0]}`);
	const projected = ok(await tx((t) => read.listPeople(t, ctx(), { search: "Batch regression", limit: 25 })));
	assert.deepEqual(projected.items[0]!.commitment, {
		state: "withdrawn",
		evidenceId: evidence[1],
		kind: "launch_team",
		occurredOn: "2099-01-01",
		revision: "1",
	});
	assert.deepEqual(projected.items[1]!.commitment, { state: "unknown" });
	assert.deepEqual(plantPerson(await tx((t) => read.getPerson(t, ctx(), { personId: ids[0]! }))), projected.items[0]);
	const duties = Array.from({ length: 100 }, () => randomUUID()).sort();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id)
		SELECT id,${plants[0]}::uuid,'Call','follow_up','medium','not_started',clock_timestamp(),'undated',${ids[0]}::uuid FROM unnest(${sql.param(duties)}::uuid[]) id`);
	const overdue = randomUUID();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,person_id)
		VALUES(${overdue},${plants[0]},'Call','follow_up','medium','not_started',clock_timestamp(),'date_only','2000-01-01',${ids[1]})`);
	const authority = await tx((t) => authorityOf(t, actors[0]));
	const viewer = new PeopleReadContext(authority);
	for (const column of [undefined, "prospect"] as const) {
		queries = [];
		const known = ok(
			await tx((t) => read.getPipelineData(t, viewer, { search: "Batch regression", limit: 25, column })),
		);
		assert.equal(known.groups[0]!.cards[0]!.person.commitment.state, "withdrawn");
		assert.equal(
			queries.length,
			6,
			`pipeline read with known commitments (${column ?? "all columns"}): ${queries.length} statements`,
		);
	}
	const pipeline = ok(await tx((t) => read.getPipelineData(t, ctx(), { search: "Batch regression", limit: 25 })));
	const cards = pipeline.groups.find((g) => g.column === "prospect")!.cards;
	assert.deepEqual(cards[0], {
		person: projected.items[0],
		activeParentDuties: duties.map((id) => ({ id, dueOn: null, warning: "missing_due_date" })),
		coverage: "covered",
		inactivity: { lastActivityAt: "2026-10-01T12:00:00.123Z", level: "alert" },
	});
	assert.deepEqual(cards[1]!.activeParentDuties, [{ id: overdue, dueOn: "2000-01-01", warning: "overdue" }]);
	assert.equal(cards[1]!.coverage, "covered");
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id)
		VALUES(${randomUUID()},${plants[0]},'Overflow','follow_up','medium','not_started',clock_timestamp(),'undated',${ids[0]})`);
	refused(
		await tx((t) => read.getPipelineData(t, ctx(), { search: "Batch regression", limit: 25 })),
		"source_unavailable",
	);
});

test("AC:TARGET-PPL-007 INV-move-round-trips: a pipeline move is one transaction with a constant round-trip count", async (t) => {
	const ids: string[] = Array.from({ length: 10 }, () => randomUUID()).sort();
	const insert = (some: string[], from: number) =>
		admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
			SELECT id,${plants[0]}::uuid,${plants[0]}::uuid,'Move regression','other','interviewed','unknown','unknown',${from}::int + n,'live',clock_timestamp()
			FROM unnest(${sql.param(some)}::uuid[]) WITH ORDINALITY AS t(id, n)`);
	const history = async () =>
		(await admin.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_event`)).rows[0]!.n;
	const move = async (personId: string, afterId: string | null) => {
		const column = await tx((t) => columnOrder(t, "interviewed"));
		const rows = await history();
		queries = [];
		const order = ok(
			await tx(async (t): Promise<Reply<Awaited<ReturnType<typeof columnOrder>>>> => {
				const done = await write.reorderPipeline(t, ctx(), {
					requestKey: randomUUID(),
					expectedRevision: column.revision,
					input: { column: "interviewed", personId, afterId },
				});
				return done.status === "ok" ? { status: "ok", value: await columnOrder(t, "interviewed") } : done;
			}),
		);
		const count = queries.length;
		assert.equal(order.revision, String(Number(column.revision) + 1));
		return { count, order: order.personIds, history: (await history()) - rows };
	};
	await insert(ids.slice(0, 3), 0);
	const few = await move(ids[2]!, null);
	assert.deepEqual(few.order, [ids[2], ids[0], ids[1]]);
	await insert(ids.slice(3), 3);
	const many = await move(ids[9]!, ids[0]!);
	assert.deepEqual(many.order, [ids[2], ids[0], ids[9], ids[1], ...ids.slice(3, 9)]);
	t.diagnostic(JSON.stringify({ reorder: [few.count, many.count] }));
	assert.equal(many.count, few.count, "a move in a column of 10 costs the same as in a column of 3");
	assert.deepEqual([few.history, many.history], [1, 1], "a move changes one person and writes one audit event");
	assert.equal(few.count, 10, `reorder round trips: ${few.count}`);
	const legacy = Array.from({ length: 20 }, () => randomUUID()).sort();
	ids.push(...legacy);
	await insert(legacy, 0);
	await admin.execute(sql`UPDATE person SET pipeline_position=0 WHERE id=ANY(${sql.param(ids)}::uuid[])`);
	const tied = (await tx((t) => columnOrder(t, "interviewed"))).personIds;
	await admin.execute(
		sql.raw(
			await readFile(
				new URL("../../../packages/db/migrations/0015_unique_pipeline_positions.sql", import.meta.url),
				"utf8",
			),
		),
	);
	const positions = async () =>
		new Map(
			(
				await admin.execute(
					sql`SELECT id, pipeline_position::text AS k FROM person WHERE id=ANY(${sql.param(ids)}::uuid[])`,
				)
			).rows.map((r) => [r.id, r.k]),
		);
	const spread = await positions();
	assert.equal(new Set(spread.values()).size, 30, "the migration gives every person a key of their own");
	assert.deepEqual((await tx((t) => columnOrder(t, "interviewed"))).personIds, tied, "and keeps the order");
	const [mover, anchor] = [tied[25]!, tied[3]!];
	const legacyMove = await move(mover, anchor);
	const expected = tied.filter((x) => x !== mover);
	expected.splice(expected.indexOf(anchor) + 1, 0, mover);
	assert.deepEqual(legacyMove.order, expected);
	const changedRows = [...(await positions())].filter(([pid, k]) => spread.get(pid) !== k).map(([pid]) => pid);
	assert.deepEqual(changedRows, [mover], "exactly one row changed");
	assert.equal(legacyMove.history, 1, "one audit event");
	assert.equal(legacyMove.count, few.count, "the same statements in a column of 30");
	const [top, m1, m2] = [legacyMove.order[0]!, legacyMove.order[1]!, legacyMove.order[2]!];
	let keys = await positions();
	for (let i = 0; i < 200; i++) {
		const [mover, other] = i % 2 ? [m1, m2] : [m2, m1];
		const step = await move(mover, top);
		assert.deepEqual(step.order.slice(0, 3), [top, mover, other], `move ${i + 1} keeps the requested order`);
		const now = await positions();
		assert.deepEqual(
			[...now].filter(([pid, k]) => keys.get(pid) !== k).map(([pid]) => pid),
			[mover],
			`move ${i + 1} changes one row`,
		);
		assert.equal(new Set(now.values()).size, 30, `move ${i + 1} keeps every key distinct`);
		assert.equal(step.history, 1, `move ${i + 1} writes one audit event`);
		keys = now;
	}
	const first = ok(await tx((t) => read.listPeople(t, ctx(), { search: "Move regression", limit: 1 }))).items[0]!;
	const moved = ok(
		await tx(async (t) => {
			const done = await write.changeStatus(
				t,
				ctx(),
				{
					requestKey: randomUUID(),
					expectedRevision: first.revision,
					input: { personId: first.id, stage: "attendee", reason: "Moved back", handoffs: [] },
				},
				noReminders,
			);
			return done.status === "ok"
				? { status: "ok", value: { ...done.value, column: await columnOrder(t, "attendee") } }
				: done;
		}),
	);
	assert.equal(moved.person.stage, "attendee");
	assert.ok(moved.column.personIds.includes(first.id));
	assert.equal(moved.column.personRevisions[first.id], moved.person.revision);
});

test("INV-reads: the person page and the status warnings use a fixed number of statements without locks", async () => {
	const p = await create("Reads person");
	ok(
		await tx((t) =>
			write.addNote(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: { personId: p.id, body: "A note with an actor" },
			}),
		),
	);
	const viewer = new PeopleReadContext(await tx((t) => authorityOf(t, actors[0])));
	queries = [];
	const page = ok(
		await readPersonPage(db, viewer, { personId: p.id }, 50, { fields: true, records: 10, duplicates: true }),
	);
	assert.deepEqual(page.fields, { tags: [], skills: [], household: { status: "none" }, photo: { status: "absent" } });
	assert.ok(page.records);
	assert.deepEqual(
		[page.records.assessments?.total, page.records.interviews?.total, page.records.commitments?.total],
		[0, 0, 0],
	);
	assert.deepEqual(page.duplicates, { items: [], completeness: "complete" });
	assert.ok(page.found.status === "available");
	assert.equal(page.found.person.id, p.id);
	assert.deepEqual(page.link, { status: "ok", value: { status: "unlinked" } });
	assert.deepEqual(
		ok(page.activities).items.map((a) => [a.kind === "activity" ? a.action : a.kind, a.actor.kind]),
		[
			["note", "current_account"],
			["created", "current_account"],
		],
	);
	queries = [];
	const warnings = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: p.id })));
	const warningStatements = queries.length;
	assert.deepEqual(warnings.warnings, ["assessment_not_recorded", "interview_not_recorded", "commitment_not_recorded"]);
	assert.deepEqual(warnings.openDuties, []);
	assert.equal(warningStatements, 5, `status warnings: ${warningStatements} statements`);
	assert.equal(
		queries.some((q) => /for\s+(update|share)/i.test(q)),
		false,
		"a dialog read must not lock rows",
	);
});

test("INV-tenancy (C13): a seat ended, signed out, held or demoted after the viewer lookup reads no People data", async (t) => {
	const plant = randomUUID(),
		made: string[] = [];
	t.after(async () => {
		await admin.execute(sql`DELETE FROM lifecycle_witness WHERE opaque_subject_id=ANY(${sql.param(made)}::uuid[])`);
	});
	await database.plant({ id: plant, timezone: "America/New_York" });
	const seated = (role: "owner" | "admin" | "member", selected: Workspace = { kind: "plant", id: plant }) =>
		seatedReader(role, selected);
	const owner = await seated("owner");
	const p = ok(
		await tx((t) =>
			write.createPerson(
				t,
				{ session: owner.session, selected: owner.selected },
				{
					requestKey: randomUUID(),
					input: { displayName: "C13 private person" },
				},
			),
		),
	).person;
	const orgPerson = randomUUID();
	await admin.execute(
		sql`INSERT INTO person(id,tenant_id,organization_id,display_name,source,state,created_at,revision) VALUES(${orgPerson},${organization},${organization},'C13 organization person','other','live',clock_timestamp(),1)`,
	);
	const plantReads = (v: Context): Read[] => [
		["listPeople", (t) => read.listPeople(t, v, {})],
		["getPipelineData", (t) => read.getPipelineData(t, v, {})],
		["getPerson", (t) => read.getPerson(t, v, { personId: p.id })],
		["readPersonPage", (t) => readPersonPage(t, v, { personId: p.id }, 50)],
		["getStatusWarnings", (t) => read.getStatusWarnings(t, v, { personId: p.id })],
		["getActivities", (t) => read.getActivities(t, v, { personId: p.id })],
		["getAccountLink", (t) => getAccountLink(t, v, { personId: p.id })],
		["getOwnAccountPerson", (t) => read.getOwnAccountPerson(t, v, {})],
	];
	const orgReads = (v: Context): Read[] => [
		["getPerson", (t) => read.getPerson(t, v, { personId: orgPerson })],
		["readPersonPage", (t) => readPersonPage(t, v, { personId: orgPerson }, 50)],
		["getAccountLink", (t) => getAccountLink(t, v, { personId: orgPerson })],
	];
	const org = { kind: "organization", id: organization, organizationKind: "sending_church" } as const;
	const [removed, reseated, signedOut, held, churchHeld, demoted] = [
		await seated("admin"),
		await seated("member"),
		await seated("member"),
		await seated("member"),
		await seated("member"),
		await seated("admin", org),
	];
	for (const who of [removed, reseated, signedOut, held, churchHeld])
		for (const [, run] of plantReads(who.reader)) ok(await tx(run));
	for (const [, run] of orgReads(demoted.reader)) ok(await tx(run));
	const hold = (kind: string, subject: string) =>
		admin.execute(
			sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,plant_id,request_revision,state,witness_checkpoint,cleanup_state,request_id,requested_at,cancel_until) VALUES(${kind},${subject}::uuid,CASE WHEN ${kind}='plant' THEN ${subject}::uuid END,1,'pending_deletion',1,'not_started',${randomUUID()},statement_timestamp(),statement_timestamp()+interval '720 hours')`,
		);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${removed.seat}`);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${reseated.seat}`);
	await admin.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${reseated.id},${plant},'member',clock_timestamp())`,
	);
	await admin.execute(sql`UPDATE auth_session SET expires_at=clock_timestamp() WHERE id=${signedOut.session}`);
	await hold("account", held.id);
	made.push(held.id);
	await admin.execute(sql`UPDATE seat SET role='member' WHERE id=${demoted.seat}`);
	const failures: string[] = [];
	const expectRefused = async (name: string, reads: Read[]) => {
		for (const [op, run] of reads) {
			const result = await tx(run);
			if (result.status !== "refused" || result.error.code !== "unavailable") failures.push(`${name} ${op}`);
		}
	};
	await expectRefused("seat ended:", plantReads(removed.reader));
	await expectRefused("seat replaced:", plantReads(reseated.reader));
	await expectRefused("session expired:", plantReads(signedOut.reader));
	await expectRefused("account on hold:", plantReads(held.reader));
	await expectRefused("Admin demoted:", orgReads(demoted.reader));
	await hold("plant", plant);
	made.push(plant);
	await expectRefused("church on hold:", plantReads(churchHeld.reader));
	assert.deepEqual(failures, []);
});

test("INV-reads (C22): a People read holds no lock on the reader's session, so sign-out never waits for it", async () => {
	const p = await create("C22 session lock");
	const viewer = new PeopleReadContext(await tx((t) => authorityOf(t, actors[0])));
	const member = await seatedReader("member", {
		kind: "organization",
		id: organization,
		organizationKind: "sending_church",
	});
	const orgPerson = randomUUID();
	await admin.execute(
		sql`INSERT INTO person(id,tenant_id,organization_id,display_name,source,state,created_at,revision) VALUES(${orgPerson},${organization},${organization},'C22 organization person','other','live',clock_timestamp(),1)`,
	);
	const plantReads = (c: Context): Read[] => [
		["listPeople", (t) => read.listPeople(t, c, {})],
		["getPipelineData", (t) => read.getPipelineData(t, c, {})],
		["getPerson", (t) => read.getPerson(t, c, { personId: p.id })],
		["readPersonPage", (t) => readPersonPage(t, c, { personId: p.id }, 50)],
		["getStatusWarnings", (t) => read.getStatusWarnings(t, c, { personId: p.id })],
		["getActivities", (t) => read.getActivities(t, c, { personId: p.id })],
		["getAccountLink", (t) => getAccountLink(t, c, { personId: p.id })],
		["getOwnAccountPerson", (t) => read.getOwnAccountPerson(t, c, {})],
		["listTags", (t) => fields.listTags(t, c, {})],
		["getPersonTags", (t) => fields.getPersonTags(t, c, { personId: p.id })],
		["getPersonSkills", (t) => fields.getPersonSkills(t, c, { personId: p.id })],
		["listHouseholds", (t) => fields.listHouseholds(t, c, {})],
		["getHousehold", (t) => fields.getHousehold(t, c, { personId: p.id })],
		["getHouseholdMembers", (t) => fields.getHouseholdMembers(t, c, { personId: p.id })],
		["getPersonPhoto", (t) => fields.getPersonPhoto(t, c, { personId: p.id })],
	];
	const orgReads = (c: Context, person: Expected): [...Read, Expected][] => [
		["getPerson", (t) => read.getPerson(t, c, { personId: orgPerson }), person],
		["readPersonPage", (t) => readPersonPage(t, c, { personId: orgPerson }, 50), person],
		["getAccountLink", (t) => getAccountLink(t, c, { personId: orgPerson }), person],
		["getOwnAccountPerson", (t) => read.getOwnAccountPerson(t, c, {}), "ok"],
	];
	const label = (name: string, list: ([...Read] | [...Read, Expected])[]) =>
		list.map(([op, run, expected]) => ({ op: `${name} ${op}`, run, expected }));
	const reads = [
		...label("cached", plantReads(viewer)),
		...label("plain", plantReads(ctx())),
		...label("organization Member cached", orgReads(member.reader, "refused")),
		...label("organization Member plain", orgReads({ session: member.session, selected: member.selected }, "refused")),
		...label("organization Owner plain", orgReads(orgCtx(), "ok")),
	];
	const waited: string[] = [];
	for (const { op, run, expected = "ok" } of reads)
		await tx(async (t) => {
			assert.equal((await run(t)).status, expected, op);
			try {
				await admin.transaction(async (a) => {
					await a.execute(sql`SET LOCAL lock_timeout='250ms'`);
					await a.execute(
						sql`UPDATE auth_session SET expires_at=expires_at WHERE id=ANY(${sql.param([actors[0].session, actors[3].session, member.session])}::uuid[])`,
					);
				});
			} catch {
				waited.push(op);
			}
		});
	assert.deepEqual(waited, []);
});

test("BUG-locked-actor: a second copy of the session module reads the actor the write gate locked", async () => {
	const seated = await seatedReader("admin", { kind: "plant", id: plants[0] });
	const authority = seated.reader.authority;
	const copy: string = "../../../packages/domain/src/access/session.ts?second-copy";
	const second: typeof import("../../../packages/domain/src/access/session.ts") = await import(copy);
	assert.notEqual(second.requestWrite, (await import("../../../packages/domain/src/access/session.ts")).requestWrite);
	const seen = await nativeWrite(db, authority, authority.actor.context.owner, async (tx) => {
		const locked = await lockedWrite(tx);
		return [locked?.actor.accountId, second.requestWrite(tx)?.actor.accountId, second.boundWrite(tx)?.selected];
	});
	assert.deepEqual(seen, [authority.actor.accountId, authority.actor.accountId, authority.actor.context.owner]);
});

test("INV-revocation INV-idempotency: a native write checks the seat in its own statement, and a retry replays", async () => {
	const p = await create("Native write");
	const seated = await seatedReader("admin", { kind: "plant", id: plants[0] });
	const authority = seated.reader.authority;
	const rename = (requestKey: string, displayName: string) =>
		withPeopleWrite(db, authority, (t, c) =>
			write.updatePerson(t, c, {
				requestKey,
				expectedRevision: p.revision,
				input: { personId: p.id, patch: { displayName } },
			}),
		);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${seated.seat}`);
	try {
		refused(await rename(randomUUID(), "Too late"));
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE id=${seated.seat}`);
	}
	assert.equal(plantPerson(await tx((t) => read.getPerson(t, ctx(), { personId: p.id }))).displayName, "Native write");
	const key = randomUUID();
	const audits = async () =>
		(await admin.execute(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${p.id}::uuid`)).rows[0]!.n;
	const first = ok(await rename(key, "Renamed once"));
	const before = await audits();
	const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
	assert.deepEqual(json(ok(await rename(key, "Renamed once"))), json(first));
	assert.equal(await audits(), before);
	refused(await rename(key, "Another name"), "conflict");
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${seated.seat}`);
	try {
		refused(await rename(key, "Renamed once"));
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE id=${seated.seat}`);
	}
});

test("INV-concurrency: a change committed while a native write is in flight is never overwritten", async () => {
	const p = await create("Race");
	const authority = await tx((t) => authorityOf(t, actors[0]));
	const { promise: held, resolve: release } = Promise.withResolvers<void>();
	const { promise: ready, resolve: changed } = Promise.withResolvers<void>();
	const other = admin.transaction(async (b) => {
		await b.execute(sql`UPDATE person SET display_name='Other', revision=revision+1 WHERE id=${p.id}::uuid`);
		changed();
		await held;
	});
	await ready;
	queries = [];
	const mine = withPeopleWrite(db, authority, (t, c) =>
		write.updatePerson(t, c, {
			requestKey: randomUUID(),
			expectedRevision: p.revision,
			input: { personId: p.id, patch: { displayName: "Mine" } },
		}),
	);
	await waitingOnLock(db);
	assert.ok(
		queries.some((q) => q.startsWith("/* evf:final */")),
		"the final statement is the one waiting",
	);
	release();
	await other;
	refused(await mine, "conflict");
	assert.equal(plantPerson(await tx((t) => read.getPerson(t, ctx(), { personId: p.id }))).displayName, "Other");
});

test("INV-date: an assessment runs in the gate's transaction, so a church time zone change waits for it", async () => {
	const p = await create("Zone race", { adultClassification: "adult" });
	const authority = await tx((t) => authorityOf(t, actors[0]));
	const zone = (name: string) => admin.execute(sql`UPDATE plant SET timezone=${name} WHERE id=${plants[0]}::uuid`);
	const lens = { score: 1, notes: null };
	await zone("Pacific/Kiritimati");
	let changed: Promise<unknown> | null = null;
	try {
		const day = (
			await admin.execute(sql`SELECT (clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS d`)
		).rows[0]!.d;
		beforeSend = async (text) => {
			if (!text.startsWith("/* evf:final */")) return;
			beforeSend = null;
			changed = zone("Pacific/Pago_Pago");
		};
		queries = [];
		const result = await withPeopleWrite(db, authority, (t, c) =>
			assessments.createAssessment(t, c, {
				requestKey: randomUUID(),
				input: {
					personId: p.id,
					occurredOn: day,
					committed: lens,
					compelled: lens,
					contagious: lens,
					courageous: lens,
				},
			}),
		);
		assert.equal(ok(result).assessment.occurredOn, day);
		assert.ok(/^begin$/i.test(queries[0]!), "the assessment opens its transaction first");
		await changed;
		const now = await admin.execute(sql`SELECT timezone FROM plant WHERE id=${plants[0]}::uuid`);
		assert.equal(now.rows[0]!.timezone, "Pacific/Pago_Pago");
	} finally {
		beforeSend = null;
		await changed;
		await zone("America/New_York");
	}
});

const BOUNDARIES: [string, string, "adult" | "child", string][] = [
	["2008-06-16", "2026-06-15", "child", "the day before the 18th birthday"],
	["2008-06-15", "2026-06-15", "adult", "the 18th birthday"],
	["2008-06-15", "2026-06-16", "adult", "the day after the 18th birthday"],
	["2008-02-29", "2026-02-28", "child", "a Feb 29 birth date, the day before it turns 18 in a year without Feb 29"],
	["2008-02-29", "2026-03-01", "adult", "a Feb 29 birth date turns 18 on Mar 1 in a year without Feb 29"],
	["2008-02-29", "2028-02-29", "adult", "a Feb 29 birth date on Feb 29 of a leap year"],
	["2012-02-29", "2030-02-28", "child", "17 on the day before an 18th birthday that falls on Mar 1"],
	["2012-02-29", "2030-03-01", "adult", "18 on Mar 1"],
	["1996-12-31", "2026-12-30", "adult", "a 29-year-old"],
	["2026-01-01", "2026-10-30", "child", "an infant"],
];
test("INV-adult: one rule in TypeScript and in SQL, over the same boundary cases", async () => {
	for (const [birth, today, expected, why] of BOUNDARIES) {
		assert.equal(effectiveAdult(birth, "unknown", today).value, expected, `TypeScript: ${why}`);
		const row = (
			await admin.execute(
				sql`SELECT ${effectiveAdultSql(sql`${birth}::date`, sql`'unknown'`, sql`${today}::date`)} AS value`,
			)
		).rows[0]!;
		assert.equal(row.value, expected, `SQL: ${why}`);
	}
	for (const manual of ["adult", "child", "unknown"] as const) {
		assert.deepEqual(effectiveAdult(null, manual, null), {
			value: manual,
			source: manual === "unknown" ? "not_recorded" : "recorded",
		});
		const row = (
			await admin.execute(
				sql`SELECT ${effectiveAdultSql(sql`NULL::date`, sql`${manual}::text`, sql`'2026-01-01'::date`)} AS value`,
			)
		).rows[0]!;
		assert.equal(row.value, manual);
	}
	assert.equal(effectiveAdult("2000-01-01", "child", "2026-10-30").source, "birth_date");
});

test("INV-adult: the plant-local date decides, not the UTC date", async () => {
	const instant = "2026-06-15T03:00:00Z";
	const day = async (zone: string) =>
		(
			await admin.execute<{ day: string }>(
				sql`SELECT (${instant}::timestamptz AT TIME ZONE ${zone})::date::text AS day`,
			)
		).rows[0]!.day;
	assert.equal(await day("America/Chicago"), "2026-06-14");
	assert.equal(await day("UTC"), "2026-06-15");
	assert.equal(effectiveAdult("2008-06-15", "unknown", await day("America/Chicago")).value, "child");
	assert.equal(effectiveAdult("2008-06-15", "unknown", await day("UTC")).value, "adult");
	const row = (
		await admin.execute(
			sql`SELECT ${effectiveAdultSql(sql`'2008-06-15'::date`, sql`'unknown'`, sql`(${instant}::timestamptz AT TIME ZONE 'America/Chicago')::date`)} AS value`,
		)
	).rows[0]!;
	assert.equal(row.value, "child");
	const today = (
		await admin.execute(
			sql`SELECT ${plantTodaySql(sql`${plants[0]}::uuid`)} AS day, (clock_timestamp() AT TIME ZONE 'America/New_York')::date::text AS expected`,
		)
	).rows[0]!;
	assert.equal(today.day, today.expected);
});

async function daysFromBirthday(years: number, days = 0) {
	return (
		await admin.execute<{ day: string }>(
			sql`SELECT ((${plantTodaySql(sql`${plants[0]}::uuid`)})::date - make_interval(years => ${years}) + make_interval(days => ${days}))::date::text AS day`,
		)
	).rows[0]!.day;
}
const setBirth = async (p: Person, birthDate: string | null) =>
	ok(
		await tx((t) =>
			write.updatePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: { personId: p.id, patch: { birthDate } },
			}),
		),
	).person;
const rejected = (result: Reply<unknown>, reason: string) => {
	assert.equal(refused(result, "invalid_input").details.reason, reason);
};

test("AC:REQ-PPL-026 the birth date decides adult or child and wins over a manual value, and the history stays", async () => {
	const p0 = await create("Manual then dated");
	assert.deepEqual([p0.adultClassification, p0.adultClassificationSource], ["unknown", "not_recorded"]);
	const recorded = ok(
		await tx((t) =>
			write.recordAdultClassification(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p0.revision,
				input: { personId: p0.id, classification: "child", occurredOn: "2026-10-01", reason: "Told by a parent" },
			}),
		),
	);
	assert.equal(recorded.person.adultClassification, "child");
	let p: Person = plantPerson(await tx((t) => read.getPerson(t, ctx(), { personId: p0.id })));
	assert.deepEqual([p.adultClassification, p.adultClassificationSource], ["child", "recorded"]);
	p = await setBirth(p, await daysFromBirthday(30));
	assert.deepEqual([p.adultClassification, p.adultClassificationSource], ["adult", "birth_date"]);
	const stored = async () =>
		(await admin.execute(sql`SELECT adult_classification FROM person WHERE id=${p.id}::uuid`)).rows[0]!
			.adult_classification;
	assert.equal(await stored(), "child", "the manual value stays in the store");
	const events = async () =>
		(
			await admin.execute(
				sql`SELECT action FROM audit_event WHERE subject_id=${p.id}::uuid AND action IN ('people.recorded','people.corrected')`,
			)
		).rows.length;
	assert.equal(await events(), 1, "the manual history stays");
	const feed = ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id })));
	assert.ok(feed.items.some((a) => a.kind === "activity" && a.action === "classification_recorded"));
	for (const [method, expectedRevision] of [
		["recordAdultClassification", p.revision],
		["correctAdultClassification", p.revision],
	] as const)
		rejected(
			await tx((t) =>
				write[method](t, ctx(), {
					requestKey: randomUUID(),
					expectedRevision,
					input: { personId: p.id, classification: "child", occurredOn: "2026-10-01", reason: "Try" },
				}),
			),
			"birth_date_decides",
		);
	p = await setBirth(p, null);
	assert.deepEqual([p.adultClassification, p.adultClassificationSource], ["child", "recorded"]);
	const both = await create("Both given", { adultClassification: "child", birthDate: await daysFromBirthday(40) });
	assert.deepEqual([both.adultClassification, both.adultClassificationSource], ["adult", "birth_date"]);
});

test("AC:REQ-PPL-026 adult or child dated after the church's today is refused with reason future_date", async () => {
	const p = await create("Dated tomorrow");
	const ahead = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
	for (const method of ["recordAdultClassification", "correctAdultClassification"] as const)
		rejected(
			await tx((t) =>
				write[method](t, ctx(), {
					requestKey: randomUUID(),
					expectedRevision: p.revision,
					input: { personId: p.id, classification: "adult", occurredOn: ahead, reason: "Said so" },
				}),
			),
			"future_date",
		);
});

test("AC:REQ-PPL-026 the 18th birthday turns a child into an adult without an edit, and the list filter agrees with the column", async () => {
	const names = {
		eve: await create("Birthday Eve Sam", { birthDate: await daysFromBirthday(18, 1) }),
		day: await create("Birthday Day Sam", { birthDate: await daysFromBirthday(18) }),
		older: await create("Birthday Older Sam", { birthDate: await daysFromBirthday(30) }),
		manual: await create("Birthday Manual Sam", { adultClassification: "adult" }),
		none: await create("Birthday None Sam"),
	};
	const expected = { eve: "child", day: "adult", older: "adult", manual: "adult", none: "unknown" };
	for (const key of ["eve", "day", "older", "manual", "none"] as const)
		assert.equal(names[key].adultClassification, expected[key], key);
	const listed = async (adultClassification?: "adult" | "child" | "unknown") =>
		ok(
			await tx((t) =>
				read.listPeople(t, ctx(), { search: "Birthday", ...(adultClassification ? { adultClassification } : {}) }),
			),
		);
	const column = new Map(
		(await listed()).items.map((p) => [p.displayName, [p.adultClassification, p.adultClassificationSource]]),
	);
	assert.deepEqual(column.get("Birthday Eve Sam"), ["child", "birth_date"]);
	assert.deepEqual(column.get("Birthday Day Sam"), ["adult", "birth_date"]);
	assert.deepEqual(column.get("Birthday Manual Sam"), ["adult", "recorded"]);
	assert.deepEqual(column.get("Birthday None Sam"), ["unknown", "not_recorded"]);
	for (const value of ["adult", "child", "unknown"] as const) {
		const names = (await listed(value)).items.map((p) => p.displayName).sort();
		assert.deepEqual(
			names,
			[...column]
				.filter(([, [v]]) => v === value)
				.map(([n]) => n)
				.sort(),
			`?adult=${value} agrees with the column`,
		);
	}
	assert.deepEqual(
		(await listed("child")).items.map((p) => p.displayName),
		["Birthday Eve Sam"],
	);
});

test("AC:REQ-PPL-026 a derived adult is only an input to a count: the commitment rule is unchanged", async () => {
	const stage = (stage: string) => ({ stage });
	const people = {
		adultNoCommitment: await create("Count Adult No Card", {
			...stage("core_group"),
			birthDate: await daysFromBirthday(30),
		}),
		adultLaunch: await create("Count Adult Launch", { ...stage("launch_team"), birthDate: await daysFromBirthday(30) }),
		adultCommitted: await create("Count Adult Card", { ...stage("core_group"), birthDate: await daysFromBirthday(30) }),
		childCommitted: await create("Count Child Card", { ...stage("core_group"), birthDate: await daysFromBirthday(17) }),
	};
	for (const key of ["adultCommitted", "childCommitted"] as const)
		await admin.execute(
			sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at) VALUES(${randomUUID()},${plants[0]}::uuid,${people[key].id}::uuid,'core_group',(clock_timestamp() AT TIME ZONE 'America/New_York')::date - 1,clock_timestamp())`,
		);
	await admin.execute(
		sql`UPDATE person SET commitment_state='active' WHERE id=ANY(${sql.param([people.adultCommitted.id, people.childCommitted.id])}::uuid[])`,
	);
	const items = ok(await tx((t) => read.listPeople(t, ctx(), { search: "Count " }))).items;
	const counted = items.filter((p) => p.adultClassification === "adult" && p.commitment.state === "active");
	assert.deepEqual(
		counted.map((p) => p.displayName),
		["Count Adult Card"],
	);
	const byName = Object.fromEntries(items.map((p) => [p.displayName, p]));
	assert.equal(byName["Count Adult No Card"]!.adultClassification, "adult");
	assert.equal(byName["Count Adult No Card"]!.commitment.state, "unknown");
	assert.equal(byName["Count Adult Launch"]!.commitment.state, "unknown");
	assert.equal(byName["Count Child Card"]!.adultClassification, "child");
});

const at = (who: Actor, plant: { id: string } = who === casey ? Q : P) => ({
	session: who.session,
	selected: church(plant.id),
});
const caseTx = <T,>(body: (t: WriteTx) => Promise<T>) => gatedTransaction(caseDb, body);
const caseWrite = async <T,>(who: Actor, body: Parameters<typeof withPeopleWrite<T>>[2]) =>
	withPeopleWrite(caseDb, await authorityOf(caseDb, who), body);
const envelope = (expectedRevision: string, input: object) => ({ requestKey: randomUUID(), expectedRevision, input });
const casePerson = async (displayName: string, extra: object = {}, who = alexAccount) =>
	ok(
		await caseWrite(who, (t, c) =>
			write.createPerson(t, c, { requestKey: randomUUID(), input: { displayName, ...extra } }),
		),
	).person;
const caseRevision = async (id: string) =>
	(await cases.admin.execute<{ r: string }>(sql`SELECT revision::text AS r FROM person WHERE id=${id}::uuid`)).rows[0]!
		.r;
async function seedPerson(
	displayName: string,
	{ plant = P, stage = "prospect", retired = false, createdAt = "2026-10-01T12:00:00Z", id = randomUUID() } = {},
) {
	await cases.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,retired_at,created_at) VALUES(${id},${plant.id},${plant.id},${displayName},'other',
		${stage},'unknown','unknown',0,${retired ? "retired" : "live"},${retired ? "2026-10-05T12:00:00Z" : null},${createdAt})`);
	return id;
}
async function caseMeeting(plant: { id: string } = P) {
	const id = randomUUID();
	await cases.admin.execute(sql`INSERT INTO meeting(id,plant_id,type,local_date,local_time,timezone,starts_at,
		resolver_version,status,attendance_revision) VALUES(${id},${plant.id},'vision_meeting','2026-10-12','18:00',
		'America/Chicago','2026-10-12T23:00:00Z','1','in_progress',1)`);
	return id;
}
const quiet = async () => undefined;
const attendance = createAttendanceWriter({ reminders: quiet }),
	tasks = createTaskWriter({ reminders: quiet });
const meetingWrite = async <T,>(who: Actor, body: (t: WriteTx, c: MeetingsContext) => Promise<T>) =>
	withMeetingsWrite(caseDb, await authorityOf(caseDb, who), body as never) as Promise<T>;
const taskWrite = async <T,>(who: Actor, body: (t: WriteTx, c: TaskContext) => Promise<T>) =>
	withTaskWrite(caseDb, await authorityOf(caseDb, who), body as never) as Promise<T>;
const personTask = async (personId: string, title: string, due: object = { kind: "undated" }) =>
	ok(
		await taskWrite(alexAccount, (t, c) =>
			tasks.create(t, c, {
				requestKey: randomUUID(),
				input: { title, due, relation: { kind: "person", id: personId } },
			}),
		),
	).task;
const nothing = { audits: [], jobs: [], notices: 0, mail: 0 };
async function untouched<T>(body: () => Promise<T>) {
	const { value, tables } = await touched(cases.admin, body);
	assert.deepEqual(tables, []);
	return value;
}
const refusedUntouched = async (body: () => Promise<{ status: string }>, code = "unavailable") =>
	refused(await untouched(body), code);
async function held<T>(
	start: (t: WriteTx) => Promise<T>,
	transact: (body: (t: WriteTx) => Promise<T>) => Promise<T> = caseTx,
) {
	const { promise: gate, resolve: release } = Promise.withResolvers<void>();
	const { promise: holding, resolve: ready } = Promise.withResolvers<void>();
	const first = transact(async (t) => {
		const value = await start(t);
		ready();
		await gate;
		return value;
	});
	await Promise.race([holding, first]);
	return {
		async settle<R>(rival: Promise<R>) {
			assert.ok(await waitingOnLock(caseDb), "the rival waits for the first write");
			release();
			return [await first, await rival] as const;
		},
	};
}
const retireRequest = async (id: string, handoffs: object[] = []) =>
	envelope(await caseRevision(id), {
		personId: id,
		reason: "Moved away",
		reviewRevision: ok(await caseTx((t) => read.getStatusWarnings(t, at(alexAccount), { personId: id })))
			.reviewRevision,
		handoffs,
	});
async function retireCase(id: string, handoffs: object[] = []) {
	const request = await retireRequest(id, handoffs);
	return ok(await caseWrite(alexAccount, (t, c) => write.retirePerson(t, c, request, noReminders)));
}

const okList = (reply: Awaited<ReturnType<typeof read.listPeople>>) => ok(reply);

test("AC:TARGET-PPL-001 the 25 tied people who hold both tags page once each, with no retired, foreign, wildcard or one-tag match", async () => {
	const tag = async (name: string) =>
		ok(await caseWrite(alexAccount, (t, c) => fields.createTag(t, c, { requestKey: randomUUID(), input: { name } })))
			.tag.id;
	const tags = [await tag("north"), await tag("family")];
	const assign = (person: string, tagId: string, plant: { id: string } = P) =>
		cases.admin.execute(sql`INSERT INTO person_tag(person_id,plant_id,tag_id) VALUES(${person},${plant.id},${tagId})`);
	const ids = Array.from({ length: 25 }, () => randomUUID()).sort();
	for (const [i, id] of ids.entries()) await seedPerson(`%/_ ${i + 1}`, { id });
	const retired = await seedPerson("%/_ retired", { retired: true }),
		wildcard = await seedPerson("a/bc", {}),
		northOnly = await seedPerson("%/_ north only", {}),
		familyOnly = await seedPerson("%/_ family only", {}),
		foreign = await seedPerson("%/_ foreign", { plant: Q });
	for (const id of [...ids, retired, wildcard]) for (const t of tags) await assign(id, t);
	await assign(northOnly, tags[0]!);
	await assign(familyOnly, tags[1]!);
	const request = { search: "%/_", tags, limit: 10 };
	const list = (extra: object, who = alexAccount) =>
		caseTx((t) => read.listPeople(t, at(who), { ...request, ...extra } as never));
	const { added } = await recorded(cases.admin, () =>
		untouched(async () => {
			for (const view of ["list", "card", "pipeline"] as const) {
				const seen: string[] = [];
				let page: number | null = 1;
				const sizes: number[] = [];
				while (page) {
					const reply: ReturnType<typeof okList> = okList(await list({ view, page }));
					assert.equal(reply.total, 25);
					sizes.push(reply.items.length);
					seen.push(...reply.items.map((p) => p.id));
					for (const p of reply.items)
						assert.deepEqual(
							[p.adultClassification, p.adultClassificationSource, p.birthDate],
							["unknown", "not_recorded", null],
						);
					page = reply.next;
				}
				assert.deepEqual(sizes, [10, 10, 5], view);
				assert.deepEqual(seen, ids, view);
			}
		}),
	);
	assert.deepEqual(added, nothing);
	const found = async (extra: object, who = alexAccount) => okList(await list({ limit: 100, ...extra }, who)).items;
	const idsOf = (items: { id: string }[]) => items.map((p) => p.id).sort();
	assert.deepEqual(idsOf(await found({ archived: "only" })), [retired]);
	assert.deepEqual(idsOf(await found({ search: "a/bc" })), [wildcard]);
	assert.deepEqual(idsOf(await found({ tags: [tags[0]] })), [...ids, northOnly].sort());
	assert.deepEqual(idsOf(await found({ tags: [tags[1]] })), [...ids, familyOnly].sort());
	assert.deepEqual(idsOf(await found({ stages: ["leader"] })), []);
	assert.deepEqual(idsOf(await found({ stages: ["prospect"], adultClassification: "unknown" })), ids);
	for (const adultClassification of ["adult", "child"]) assert.deepEqual(await found({ adultClassification }), []);
	assert.deepEqual(idsOf(await found({ tags: [] }, casey)), [foreign]);
	for (const page of [2, 3]) {
		assert.ok(okList(await list({ page })).items.length);
		const crossed = okList(await list({ page }, casey));
		assert.deepEqual([crossed.items, crossed.total], [[], 0]);
		await refusedUntouched(() => caseTx((t) => read.listPeople(t, at(casey, P), { ...request, page } as never)));
	}
	refused(await list({ cursor: "page-2-of-another-church" }), "invalid_input");
	refused(await list({ limit: 101 }), "invalid_input");
});

test("AC:TARGET-PPL-002 a create or edit that names an account, a file, a creator or a background check is refused whole; the same contact without it saves", async () => {
	const contact = { displayName: "Jamie", city: "Chicago", street: null };
	const create = (input: object, requestKey: string = randomUUID(), who = alexAccount) =>
		caseWrite(who, (t, c) => write.createPerson(t, c, { requestKey, input }));
	const forged: object[] = [
		{ account: casey.id },
		{ accountId: casey.id },
		{ linkedAccountId: casey.id },
		{ linked_account_id: casey.id },
		{ creatorId: casey.id },
		{ createdBy: casey.id },
		{ photoObjectId: randomUUID() },
		{ storageKey: `private/${P.id}/${randomUUID()}` },
		{ tenantId: Q.id },
		{ backgroundCheck: "passed" },
		{ background_check: "passed" },
		{ account: casey.id, background_check: "passed" },
	];
	const requestKey = randomUUID();
	for (const extra of forged)
		await refusedUntouched(() => create({ ...contact, ...extra }, requestKey), "invalid_input");
	for (const displayName of ["", "   ", "\t\n"])
		await refusedUntouched(() => create({ ...contact, displayName }, requestKey), "invalid_input");
	await refusedUntouched(() => create(contact, requestKey, seatedMember));
	await refusedUntouched(() => caseTx((t) => write.createPerson(t, at(casey, P), { requestKey, input: contact })));
	const saved = await touched(cases.admin, () => recorded(cases.admin, () => create(contact, requestKey)));
	assert.deepEqual(saved.tables, ["audit_event", "people_column", "person", "plant", "record"]);
	assert.deepEqual(saved.value.added, { ...nothing, audits: ["people.created"] });
	const person = ok(saved.value.value).person;
	assert.deepEqual(
		{ ...person, id: null, createdAt: null },
		{
			id: null,
			createdAt: null,
			revision: "1",
			displayName: "Jamie",
			firstName: null,
			lastName: null,
			email: null,
			phone: null,
			street: null,
			city: "Chicago",
			stateProvince: null,
			postalCode: null,
			country: null,
			owner: { kind: "plant", id: P.id },
			lifecycle: { state: "live" },
			stage: "prospect",
			source: "other",
			sourceDetails: null,
			summaryNotes: null,
			adultClassification: "unknown",
			adultClassificationSource: "not_recorded",
			birthDate: null,
			commitment: { state: "unknown" },
		},
	);
	const stored = (
		await cases.admin.execute(
			sql`SELECT tenant_id,linked_account_id,photo_object_id,display_name,street,city FROM person WHERE id=${person.id}::uuid`,
		)
	).rows[0];
	assert.deepEqual(stored, {
		tenant_id: P.id,
		linked_account_id: null,
		photo_object_id: null,
		display_name: "Jamie",
		street: null,
		city: "Chicago",
	});
	assert.deepEqual(
		(
			await cases.admin.execute(
				sql`SELECT actor_id,kind FROM audit_event WHERE subject_id=${person.id}::uuid AND action='people.created'`,
			)
		).rows,
		[{ actor_id: alexAccount.id, kind: "create" }],
	);
	const patch = (values: object) =>
		caseWrite(alexAccount, async (t, c) =>
			write.updatePerson(t, c, envelope(await caseRevision(person.id), { personId: person.id, patch: values })),
		);
	for (const extra of forged) await refusedUntouched(() => patch({ phone: "555-0100", ...extra }), "invalid_input");
	await refusedUntouched(() => patch({ stage: "leader" }), "invalid_input");
	await refusedUntouched(() => patch({ displayName: "  " }), "invalid_input");
	const addressed = ok(await patch({ street: "1 Main St", phone: "555-0100" })).person;
	assert.deepEqual([addressed.street, addressed.city, addressed.phone], ["1 Main St", "Chicago", "555-0100"]);
	const cleared = await recorded(cases.admin, () => patch({ street: null }));
	const kept = ok(cleared.value).person;
	assert.deepEqual([kept.street, kept.city, kept.phone], [null, "Chicago", "555-0100"]);
	assert.deepEqual(cleared.added, { ...nothing, audits: ["people.updated"] });
	assert.deepEqual(
		ok(await caseTx((t) => read.getActivities(t, at(seatedMember), { personId: person.id }))).items.map((i) =>
			i.kind === "activity" ? i.action : i.kind,
		),
		["updated", "updated", "created"],
	);
});

test("AC:TARGET-PPL-002 a Launch guest with one name becomes a prospect from the guest list with no surname, account, commitment or qualification", async () => {
	const meetingId = await caseMeeting();
	const guest = (input: object) =>
		meetingWrite(alexAccount, (t, c) =>
			guestsWriter.createGuestContact(t, c, { requestKey: randomUUID(), input: { meetingId, ...input } }),
		);
	for (const extra of [{ accountId: casey.id }, { backgroundCheck: "passed" }, { storageKey: "private/x" }])
		await refusedUntouched(() => guest({ displayName: "Jamie", ...extra }), "invalid_input");
	await refusedUntouched(() => guest({ displayName: "   " }), "invalid_input");
	const { value, tables } = await touched(cases.admin, () => guest({ displayName: " Jamie " }));
	assert.deepEqual(tables, ["audit_event", "participation", "people_column", "person", "plant", "record"]);
	const personId = ok(value).guest.person.personId;
	const person = plantPerson(await caseTx((t) => read.getPerson(t, at(alexAccount), { personId })));
	assert.deepEqual(
		[person.displayName, person.firstName, person.lastName, person.email, person.phone],
		["Jamie", null, null, null, null],
	);
	assert.deepEqual(
		[person.stage, person.source, person.adultClassification, person.commitment],
		["prospect", "meeting_guest_list", "unknown", { state: "unknown" }],
	);
	assert.deepEqual(ok(await caseTx((t) => getAccountLink(t, at(alexAccount), { personId }))), { status: "unlinked" });
});

const presenceOf = async (meetingId: string, personId: string) =>
	(
		await cases.admin.execute(
			sql`SELECT presence FROM participation WHERE meeting_id=${meetingId}::uuid AND person_id=${personId}::uuid`,
		)
	).rows.map((r) => r.presence);

test("AC:TARGET-PPL-003 retirement and a check-in race to one order, keep history and duties, and stop every new current reference", async () => {
	const p = await casePerson("Assigned Alex");
	const [pastMeeting, lateMeeting, raced] = [await caseMeeting(), await caseMeeting(), await caseMeeting()];
	const checkIn = (meetingId: string, personId: string) =>
		meetingWrite(alexAccount, (t, c) =>
			attendance.checkIn(t, c, { requestKey: randomUUID(), input: { meetingId, personId } }),
		);
	ok(await checkIn(pastMeeting, p.id));
	const note = ok(
		await caseWrite(alexAccount, async (t, c) =>
			write.addNote(t, c, envelope(await caseRevision(p.id), { personId: p.id, body: "Kept note" })),
		),
	);
	const duty = await personTask(p.id, "Call Alex");
	const handoffs = [{ kind: "needs_owner", dutyId: duty.id, expectedRevision: duty.revision }];
	const request = await retireRequest(p.id, handoffs);
	const retiring = await held((t) => write.retirePerson(t, at(alexAccount), request, noReminders));
	const [retired, late] = await retiring.settle(checkIn(lateMeeting, p.id));
	assert.deepEqual([ok(retired).person.lifecycle.state, ok(retired).needsOwner], ["retired", [duty.id]]);
	assert.deepEqual(refused(late, "invalid_subject").details, { personIds: [p.id] });
	assert.deepEqual(await presenceOf(lateMeeting, p.id), []);
	assert.deepEqual(await presenceOf(pastMeeting, p.id), ["attended"]);
	const kept = async () =>
		(
			await cases.admin.execute(sql`SELECT (SELECT person_id FROM task WHERE id=${duty.id}::uuid) AS duty,
			(SELECT status FROM task WHERE id=${duty.id}::uuid) AS status,
			(SELECT body FROM person_note WHERE id=${note.noteId}::uuid) AS note,
			(SELECT count(*)::int FROM audit_event WHERE subject_id=${p.id}::uuid AND action='people.created') AS created`)
		).rows[0];
	const history = { duty: p.id, status: "not_started", note: "Kept note", created: 1 };
	assert.deepEqual(await kept(), history);
	assert.equal(
		plantPerson(await caseTx((t) => read.getPerson(t, at(seatedMember), { personId: p.id }))).lifecycle.state,
		"retired",
	);
	const feed = ok(await caseTx((t) => read.getActivities(t, at(seatedMember), { personId: p.id }))).items;
	assert.deepEqual(
		feed.map((i) => (i.kind === "activity" ? i.action : i.kind)),
		["retired", "note", "created"],
	);

	const other = await casePerson("Attends first"),
		attending = await casePerson("Checked in while retiring");
	const retireOther = await retireRequest(attending.id);
	const entering = await held(
		(t) =>
			attendance.checkIn(t, at(alexAccount) as never, {
				requestKey: randomUUID(),
				input: { meetingId: raced, personId: attending.id },
			}),
		(body) => meetingWrite(alexAccount, body),
	);
	const [entered, after] = await entering.settle(
		caseWrite(alexAccount, (t, c) => write.retirePerson(t, c, retireOther, noReminders)),
	);
	ok(entered);
	refused(after, "conflict");
	assert.equal((await retireCase(attending.id)).person.lifecycle.state, "retired");
	assert.deepEqual(await presenceOf(raced, attending.id), ["attended"]);

	const tag = ok(
		await caseWrite(alexAccount, (t, c) =>
			fields.createTag(t, c, { requestKey: randomUUID(), input: { name: "Retire check" } }),
		),
	).tag.id;
	const head = await casePerson("Household head");
	const made = ok(
		await caseWrite(alexAccount, async (t, c) =>
			fields.createHouseholdWithHead(
				t,
				c,
				envelope(await caseRevision(head.id), { name: "Head household", headPersonId: head.id }),
			),
		),
	);
	assert.ok(made.result.status === "available");
	const householdId = made.result.household.id;
	const references: [string, (id: string) => Promise<{ status: string }>][] = [
		["invalid_subject", (id) => checkIn(lateMeeting, id)],
		[
			"invalid_subject",
			(id) =>
				taskWrite(alexAccount, (t, c) =>
					tasks.create(t, c, {
						requestKey: randomUUID(),
						input: { title: "New duty", relation: { kind: "person", id } },
					}),
				),
		],
		[
			"unavailable",
			(id) =>
				caseWrite(alexAccount, async (t, c) =>
					fields.addToHousehold(t, c, envelope(await caseRevision(id), { householdId, personId: id, role: "other" })),
				),
		],
		[
			"unavailable",
			(id) =>
				caseWrite(alexAccount, (t, c) =>
					fields.assignTag(t, c, { requestKey: randomUUID(), input: { personId: id, tagId: tag } }),
				),
		],
		[
			"unavailable",
			(id) =>
				caseWrite(alexAccount, async (t, c) =>
					write.addNote(t, c, envelope(await caseRevision(id), { personId: id, body: "Late note" })),
				),
		],
	];
	for (const [code, refer] of references) {
		refused(await untouched(() => refer(p.id)), code);
		ok(await refer(other.id));
	}
	const guests = (people: string[]) =>
		meetingWrite(alexAccount, (t, c) =>
			guestsWriter.addGuests(t, c, { requestKey: randomUUID(), input: { meetingId: raced, people } }),
		);
	const added = ok(await guests([p.id, other.id]));
	assert.deepEqual([added.notAdded, added.guests.length], [[p.id], 1]);
	assert.deepEqual(await kept(), history);
});

test("AC:TARGET-PPL-003 an ordinary retired person is restored once without seat or household; a merged source and a foreign person never are", async () => {
	const member = await cases.actor(P, "member");
	const p = await casePerson("Ordinary Alex");
	await cases.admin.execute(sql`UPDATE person SET linked_account_id=${member.id} WHERE id=${p.id}::uuid`);
	const made = ok(
		await caseWrite(alexAccount, async (t, c) =>
			fields.createHouseholdWithHead(
				t,
				c,
				envelope(await caseRevision(p.id), { name: "Alex household", headPersonId: p.id }),
			),
		),
	);
	assert.ok(made.result.status === "available");
	await retireCase(p.id);
	await cases.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${member.id}`);
	const restore = async (id: string, who = alexAccount, plant: { id: string } | undefined = undefined) => {
		const request = envelope(await caseRevision(id), { personId: id });
		return caseTx((t) => write.restorePerson(t, at(who, plant), request));
	};
	await refusedUntouched(() => restore(p.id, seatedMember));
	await refusedUntouched(() => restore(p.id, casey));
	await refusedUntouched(() => restore(p.id, casey, P));
	const foreign = await seedPerson("Foreign retired", { plant: Q, retired: true });
	await refusedUntouched(() => restore(foreign));
	refused(
		await untouched(() =>
			caseTx((t) => write.restorePerson(t, at(alexAccount), envelope("1", { personId: randomUUID() }))),
		),
	);
	refused(
		await untouched(() =>
			caseWrite(alexAccount, (t, c) => write.restorePerson(t, c, envelope("1", { personId: p.id }))),
		),
		"conflict",
	);
	const { value, added } = await recorded(cases.admin, () =>
		touched(cases.admin, async () => {
			const request = envelope(await caseRevision(p.id), { personId: p.id });
			const first = ok(await caseWrite(alexAccount, (t, c) => write.restorePerson(t, c, request)));
			assert.deepEqual(ok(await caseWrite(alexAccount, (t, c) => write.restorePerson(t, c, request))), first);
			return first;
		}),
	);
	assert.deepEqual(added, { ...nothing, audits: ["people.restored"] });
	assert.deepEqual(value.tables, ["audit_event", "people_column", "person", "plant", "record"]);
	assert.deepEqual([value.value.outcome, value.value.person.lifecycle.state], ["changed", "live"]);
	assert.deepEqual(ok(await caseTx((t) => fields.getHousehold(t, at(alexAccount), { personId: p.id }))), {
		status: "none",
	});
	assert.deepEqual(
		(
			await cases.admin.execute(sql`SELECT ended_at IS NOT NULL AS ended FROM seat WHERE account_id=${member.id}`)
		).rows.map((r) => r.ended),
		[true],
	);

	const survivor = await casePerson("Survivor Alex"),
		source = await casePerson("Merged Alex");
	const review = ok(
		await caseTx((t) =>
			peopleMerge.getMergeReview(t, at(alexAccount), { sourceId: source.id, survivorId: survivor.id }),
		),
	);
	const merged = ok(
		await caseWrite(alexAccount, (t, c) =>
			peopleMerge.mergePeople(t, c, {
				requestKey: randomUUID(),
				input: { sourceId: source.id, survivorId: survivor.id, reviewDigest: review.reviewDigest },
			}),
		),
	);
	const lifecycle = plantPerson(
		await caseTx((t) => read.getPerson(t, at(alexAccount), { personId: source.id })),
	).lifecycle;
	assert.ok(lifecycle.state === "merged");
	assert.equal(lifecycle.survivorId, survivor.id);
	await refusedUntouched(() => restore(source.id), "use_reviewed_unmerge");
	await refusedUntouched(async () => {
		const request = await retireRequest(source.id);
		return caseWrite(alexAccount, (t, c) => write.retirePerson(t, c, request, noReminders));
	}, "use_reviewed_unmerge");
	const preview = ok(
		await caseTx((t) => peopleUnmerge.previewUnmerge(t, at(alexAccount), { mergeId: merged.mergeId })),
	);
	ok(
		await caseWrite(alexAccount, (t, c) =>
			peopleUnmerge.unmergePeople(t, c, envelope(preview.reviewRevision, { mergeId: merged.mergeId })),
		),
	);
	assert.equal(
		plantPerson(await caseTx((t) => read.getPerson(t, at(alexAccount), { personId: source.id }))).lifecycle.state,
		"live",
	);
});

test("AC:TARGET-PPL-006 leader back to attendee with a declined duty changes the stage once, leaves the duty needing an owner and the commitment as it was", async () => {
	const account = await cases.actor(P, "member");
	const p = await casePerson("Leader Alex", { adultClassification: "adult" });
	await cases.admin.execute(sql`UPDATE person SET linked_account_id=${account.id} WHERE id=${p.id}::uuid`);
	ok(
		await caseWrite(alexAccount, (t, c) =>
			commitments.createCommitment(t, c, {
				requestKey: randomUUID(),
				input: { personId: p.id, kind: "core_group", occurredOn: "2026-10-01" },
			}),
		),
	);
	const person = async () => plantPerson(await caseTx((t) => read.getPerson(t, at(alexAccount), { personId: p.id })));
	const request = async (stage: string, handoffs: object[] = [], reason = "Correct actual stage") =>
		envelope(await caseRevision(p.id), { personId: p.id, stage, reason, handoffs });
	const change = (input: object, who = alexAccount) =>
		caseWrite(who, (t, c) => write.changeStatus(t, c, input, noReminders));
	const skipped = ok(await caseTx((t) => read.getStatusWarnings(t, at(alexAccount), { personId: p.id })));
	assert.deepEqual(
		[skipped.warnings, skipped.hardGate],
		[["assessment_not_recorded", "interview_not_recorded"], false],
	);
	ok(await change(await request("prospect")));
	const toLeader = await recorded(cases.admin, async () => change(await request("leader")));
	assert.deepEqual(toLeader.added, { ...nothing, audits: ["people.stage_changed"] });
	assert.equal(ok(toLeader.value).person.stage, "leader");
	const before = await person();
	assert.deepEqual([before.commitment.state, before.adultClassification], ["active", "adult"]);
	const duty = await personTask(p.id, "Open duty");
	const declined = [{ kind: "needs_owner", dutyId: duty.id, expectedRevision: duty.revision }];
	const down = await request("attendee", declined);
	await refusedUntouched(async () => change(await request("attendee")), "conflict");
	await refusedUntouched(() => change(down, seatedMember));
	await refusedUntouched(() => caseTx((t) => write.changeStatus(t, at(casey), down, noReminders)));
	await refusedUntouched(() => change({ ...down, expectedRevision: "1" }), "conflict");
	await refusedUntouched(() => change({ ...down, input: { ...down.input, stage: "elder" } }), "invalid_input");
	await refusedUntouched(() => change({ ...down, input: { ...down.input, reason: " " } }), "invalid_input");
	const moved = await recorded(cases.admin, () => touched(cases.admin, () => change(down)));
	assert.deepEqual(moved.added, { ...nothing, audits: ["people.stage_changed"] });
	assert.deepEqual(moved.value.tables, ["audit_event", "people_column", "person", "plant", "record", "task"]);
	const first = ok(moved.value.value);
	assert.deepEqual([first.outcome, first.person.stage, first.needsOwner], ["changed", "attendee", [duty.id]]);
	const again = await recorded(cases.admin, () => untouched(() => change(down)));
	assert.deepEqual(ok(again.value), first);
	assert.deepEqual(again.added, nothing);
	const same = await recorded(cases.admin, async () => change(await request("attendee")));
	assert.equal(ok(same.value).outcome, "noop");
	assert.equal(ok(same.value).person.revision, first.person.revision);
	const moves = (
		await cases.admin.execute(sql`SELECT before_value->>'stage' AS from, after_value->>'stage' AS to, reason, actor_id,
			kind FROM audit_event WHERE subject_id=${p.id}::uuid AND action='people.stage_changed' ORDER BY occurred_at,id`)
	).rows.map((r) => [r.from, r.to, r.reason, r.actor_id, r.kind]);
	assert.deepEqual(moves.slice(-2), [
		["leader", "attendee", "Correct actual stage", alexAccount.id, "edit"],
		[null, null, "Correct actual stage", alexAccount.id, "noop"],
	]);
	const feed = ok(await caseTx((t) => read.getActivities(t, at(seatedMember), { personId: p.id }))).items;
	assert.deepEqual(
		feed.flatMap((i) => (i.kind === "stage_changed" ? [[i.from, i.to]] : [])),
		[
			["leader", "attendee"],
			["prospect", "leader"],
			["core_group", "prospect"],
		],
	);
	const after = await person();
	assert.deepEqual(
		[after.commitment, after.adultClassification, after.adultClassificationSource],
		[before.commitment, "adult", "recorded"],
	);
	const shown = ok(
		await caseTx(async (t) => taskReader.get(t, await authorityOf(t, alexAccount), { taskId: duty.id })),
	);
	assert.ok(shown.status === "available" && "task" in shown);
	assert.equal(shown.task.assignees.length, 0);
	assert.equal(ownerLabel(shown.task.assignees[0] ?? null), "Needs owner");
	assert.equal(ok(await caseTx((t) => read.getOwnAccountPerson(t, at(account), {}))).status, "linked");
});

test("AC:TARGET-PPL-006 two stage changes from one reviewed state: the second waits, then is refused with no second history row", async () => {
	const p = await casePerson("Raced stage");
	const request = (stage: string) => envelope(p.revision, { personId: p.id, stage, reason: "Reviewed", handoffs: [] });
	const first = await held((t) => write.changeStatus(t, at(alexAccount), request("attendee"), noReminders));
	const [won, lost] = await first.settle(
		caseWrite(coauthor, (t, c) => write.changeStatus(t, c, request("leader"), noReminders)),
	);
	assert.equal(ok(won).person.stage, "attendee");
	refused(lost, "conflict");
	const { added } = await recorded(cases.admin, async () =>
		refused(await caseWrite(coauthor, (t, c) => write.changeStatus(t, c, request("leader"), noReminders)), "conflict"),
	);
	assert.deepEqual(added, nothing);
	assert.deepEqual(
		(
			await cases.admin.execute(
				sql`SELECT after_value->>'stage' AS stage,actor_id FROM audit_event WHERE subject_id=${p.id}::uuid AND action='people.stage_changed'`,
			)
		).rows,
		[{ stage: "attendee", actor_id: alexAccount.id }],
	);
});

test("AC:TARGET-PPL-007 seven stages fill five columns, only open parent duties warn by the church's day, and a foreign reorder changes nothing", async () => {
	const ids: Record<string, string> = {};
	const stages = ["prospect", "attendee", "following_up", "interviewed", "core_group", "launch_team", "leader"];
	for (const stage of stages)
		ids[stage] = await seedPerson(`Column ${stage}`, { stage, createdAt: "2026-10-12T12:00:00Z" });
	const foreign = await seedPerson("Column foreign", { plant: Q, stage: "core_group" }),
		anchor = await seedPerson("Column foreign anchor", { plant: Q, stage: "core_group" }),
		gone = await seedPerson("Column retired", { stage: "core_group", retired: true });
	const board = async (who = alexAccount) =>
		ok(await caseTx((t) => read.getPipelineData(t, at(who), { search: "Column " })));
	const columns = async () => (await board()).groups.map((g) => [g.column, g.cards.map((c) => c.person.stage).sort()]);
	const columnStages = [
		["prospect", ["prospect"]],
		["attendee", ["attendee"]],
		["following_up", ["following_up"]],
		["interviewed", ["interviewed"]],
		["core_group", ["core_group", "launch_team", "leader"]],
	];
	assert.deepEqual(await columns(), columnStages);
	const task = {
		undated: await personTask(ids.prospect!, "Undated"),
		overdue: await personTask(ids.prospect!, "Overdue", { kind: "local_date", date: "2026-10-12" }),
		today: await personTask(ids.prospect!, "Due today", { kind: "local_date", date: "2026-10-13" }),
		complete: await personTask(ids.attendee!, "Done", { kind: "local_date", date: "2026-10-01" }),
		waived: await personTask(ids.following_up!, "Waived", { kind: "local_date", date: "2026-10-01" }),
		deleted: await personTask(ids.interviewed!, "Deleted", { kind: "local_date", date: "2026-10-01" }),
		parent: await personTask(ids.core_group!, "Parent", { kind: "local_date", date: "2026-10-20" }),
	};
	const child = ok(
		await taskWrite(alexAccount, (t, c) =>
			tasks.createSubtask(t, c, envelope(task.parent.revision, { parentId: task.parent.id, title: "Child" })),
		),
	).task;
	const relate = envelope(child.revision, {
		taskId: child.id,
		patch: { relation: { kind: "person", id: ids.launch_team } },
	});
	await refusedUntouched(() => taskWrite(alexAccount, (t, c) => tasks.edit(t, c, relate)), "invalid_input");
	const duties = async (stage: string) => {
		const card = (await board()).groups.flatMap((g) => g.cards).find((c) => c.person.id === ids[stage]);
		assert.ok(card);
		return [
			card.activeParentDuties.map((d) => [d.id, d.dueOn, d.warning]).sort(),
			card.coverage,
			card.inactivity.level,
		];
	};
	for (const name of ["complete", "waived", "deleted"] as const)
		assert.deepEqual(await duties({ complete: "attendee", waived: "following_up", deleted: "interviewed" }[name]), [
			[[task[name].id, "2026-10-01", "overdue"]],
			"covered",
			"none",
		]);
	const one = (id: string, revision: string) => envelope(revision, { taskId: id });
	ok(await taskWrite(alexAccount, (t, c) => tasks.complete(t, c, one(task.complete.id, task.complete.revision))));
	ok(await taskWrite(alexAccount, (t, c) => tasks.waive(t, c, one(task.waived.id, task.waived.revision))));
	ok(await taskWrite(alexAccount, (t, c) => tasks.delete(t, c, one(task.deleted.id, task.deleted.revision))));
	const { added } = await recorded(cases.admin, () =>
		untouched(async () => {
			assert.deepEqual(await duties("prospect"), [
				[
					[task.undated.id, null, "missing_due_date"],
					[task.overdue.id, "2026-10-12", "overdue"],
					[task.today.id, "2026-10-13", "none"],
				].sort(),
				"covered",
				"none",
			]);
			for (const stage of ["attendee", "following_up", "interviewed", "launch_team", "leader"])
				assert.deepEqual(await duties(stage), [[], "uncovered", "none"], stage);
			assert.deepEqual(await duties("core_group"), [[[task.parent.id, "2026-10-20", "none"]], "covered", "none"]);
		}),
	);
	assert.deepEqual(added, nothing);

	const seen = async (who = alexAccount) => (await board(who)).groups.find((g) => g.column === "core_group")!.revision;
	const reorder = (who: Actor, plant: { id: string }, revision: string, personId: string, afterId: string | null) =>
		caseTx((t) =>
			write.reorderPipeline(t, at(who, plant), envelope(revision, { column: "core_group", personId, afterId })),
		);
	const own = ids.leader!;
	await refusedUntouched(async () => reorder(alexAccount, Q, await seen(casey), foreign, null));
	await refusedUntouched(async () => reorder(alexAccount, Q, await seen(casey), foreign, anchor));
	await refusedUntouched(async () => reorder(alexAccount, P, await seen(), foreign, null));
	await refusedUntouched(async () => reorder(alexAccount, P, await seen(), own, foreign), "conflict");
	await refusedUntouched(async () => reorder(alexAccount, P, await seen(), gone, null), "conflict");
	await refusedUntouched(async () => reorder(alexAccount, P, await seen(), own, gone), "conflict");
	await refusedUntouched(async () => reorder(casey, P, await seen(), own, null));
	await refusedUntouched(async () => reorder(seatedMember, P, await seen(), own, null));
	await refusedUntouched(
		async () =>
			caseTx(async (t) =>
				write.reorderPipeline(t, at(alexAccount), {
					...envelope(await seen(), {
						plant: Q.id,
						columns: ["prospect", "attendee", "contacted", "committed", "leader"],
					}),
				}),
			),
		"invalid_input",
	);
	const stale = await seen();
	const moved = await recorded(cases.admin, () =>
		touched(cases.admin, () => reorder(alexAccount, P, stale, own, null)),
	);
	ok(moved.value.value);
	assert.deepEqual(moved.value.tables, ["audit_event", "people_column", "person", "plant", "record"]);
	assert.deepEqual(moved.added, { ...nothing, audits: ["people.updated"] });
	assert.equal((await board()).groups.find((g) => g.column === "core_group")!.cards[0]!.person.id, own);
	await refusedUntouched(() => reorder(alexAccount, P, stale, ids.core_group!, null), "conflict");
	ok(await reorder(casey, Q, await seen(casey), foreign, anchor));
	assert.deepEqual(await columns(), columnStages);
});

test("AC:TARGET-PPL-008 three entries at one instant page once each, and no other author, person or church can edit or delete a note or an event", async () => {
	const p = await casePerson("Timeline Alex"),
		other = await casePerson("Another person");
	const tied = Array.from({ length: 3 }, () => randomUUID())
		.sort()
		.reverse();
	const [a1, a2, a3] = tied as [string, string, string];
	for (const [id, author] of [
		[a1, alexAccount.id],
		[a3, coauthor.id],
	])
		await cases.admin.execute(
			sql`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at) VALUES(${id},${P.id},${P.id},${p.id},${author},'Original note.','2026-10-01T12:00:00Z','2026-10-01T12:00:00Z')`,
		);
	await cases.admin.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,
		before_value,after_value,occurred_at,recorded_at) VALUES(${a2},${P.id},${alexAccount.id},'people.stage_changed','edit','person',
		${p.id},'{"stage":"prospect"}','{"stage":"attendee"}','2026-10-01T12:00:00Z','2026-10-01T12:00:00Z')`);
	await cases.admin.execute(
		sql`UPDATE audit_event SET occurred_at='2026-10-01T11:00:00Z' WHERE subject_id=${p.id}::uuid AND action='people.created'`,
	);
	const page = async (n: number, who = alexAccount) =>
		ok(await caseTx((t) => read.getActivities(t, at(who), { personId: p.id, limit: 2, page: n })));
	const { added } = await recorded(cases.admin, () =>
		untouched(async () => {
			for (const who of [alexAccount, coauthor, seatedMember]) {
				const [first, second] = [await page(1, who), await page(2, who)];
				const items = [...first.items, ...second.items];
				assert.deepEqual([first.next, second.next], [2, null]);
				assert.deepEqual(items.map((i) => i.id).slice(0, 3), [a1, a2, a3]);
				assert.equal(new Set(items.map((i) => i.id)).size, 4);
				assert.deepEqual(
					items.map((i) => i.kind),
					["note", "stage_changed", "note", "activity"],
				);
				assert.deepEqual(
					items.slice(0, 3).map((i) => [i.occurredAt, i.actor]),
					[alexAccount, alexAccount, coauthor].map((who) => [
						"2026-10-01T12:00:00.000Z",
						{ kind: "current_account", accountId: who.id },
					]),
				);
			}
		}),
	);
	assert.deepEqual(added, nothing);
	refused(await caseTx((t) => read.getActivities(t, at(casey), { personId: p.id })));

	type Change = { noteId: string; personId?: string; revision?: string; who?: Actor; plant?: { id: string } };
	const edit = ({ noteId, personId = p.id, revision = "1", who = alexAccount, plant }: Change) =>
		caseTx((t) =>
			write.editNote(
				t,
				at(who, plant),
				envelope(revision, { personId, noteId, body: "Changed note.", reason: "Correction" }),
			),
		);
	const remove = ({ noteId, personId = p.id, revision = "1", who = alexAccount, plant }: Change) =>
		caseTx((t) => write.deleteNote(t, at(who, plant), envelope(revision, { personId, noteId, reason: "Remove" })));
	const created = (
		await cases.admin.execute<{ id: string }>(
			sql`SELECT id FROM audit_event WHERE subject_id=${p.id}::uuid AND action='people.created'`,
		)
	).rows[0]!.id;
	const denied: [Change, string?][] = [
		[{ noteId: a3 }],
		[{ noteId: a1, who: coauthor }],
		[{ noteId: a1, personId: other.id }],
		[{ noteId: a3, personId: other.id, who: coauthor }],
		[{ noteId: a2 }],
		[{ noteId: created }],
		[{ noteId: randomUUID() }],
		[{ noteId: a1, who: seatedMember }],
		[{ noteId: a1, who: casey }],
		[{ noteId: a1, who: casey, plant: P }],
		[{ noteId: a1, revision: "2" }, "conflict"],
	];
	for (const [change, code] of denied)
		for (const attempt of [edit, remove]) {
			const { added } = await recorded(cases.admin, () => refusedUntouched(() => attempt(change), code));
			assert.deepEqual(added, nothing);
		}
	const stored = async (id: string) =>
		(
			await cases.admin.execute(
				sql`SELECT body,revision::text AS revision,author_id,occurred_at='2026-10-01T12:00:00Z' AS kept,removed_at IS NOT NULL AS removed FROM person_note WHERE id=${id}::uuid`,
			)
		).rows[0];
	const original = { body: "Original note.", revision: "1", author_id: coauthor.id, kept: true, removed: false };
	assert.deepEqual(await stored(a3), original);
	const blank = envelope("1", { personId: p.id, noteId: a3, reason: "Correction" });
	for (const body of ["  ", "x".repeat(5001)])
		await refusedUntouched(
			() => caseTx((t) => write.editNote(t, at(coauthor), { ...blank, input: { ...blank.input, body } })),
			"invalid_input",
		);
	const edited = await recorded(cases.admin, () => edit({ noteId: a3, who: coauthor }));
	ok(edited.value);
	assert.deepEqual(edited.added, { ...nothing, audits: ["people.updated"] });
	assert.deepEqual(await stored(a3), { ...original, body: "Changed note.", revision: "2" });
	const audit = async () =>
		(
			await cases.admin.execute(sql`SELECT actor_id,before_value,after_value,reason FROM audit_event
			WHERE subject_id=${p.id}::uuid AND metadata->>'noteId'=${a3} ORDER BY occurred_at,id`)
		).rows;
	const correction = {
		actor_id: coauthor.id,
		before_value: { body: "Original note." },
		after_value: { body: "Changed note." },
		reason: "Correction",
	};
	assert.deepEqual(await audit(), [correction]);
	const removed = await recorded(cases.admin, () => remove({ noteId: a3, revision: "2", who: coauthor }));
	ok(removed.value);
	assert.deepEqual(removed.added, { ...nothing, audits: ["people.updated"] });
	assert.deepEqual(await stored(a3), { ...original, body: "", revision: "3", removed: true });
	const feed = ok(await caseTx((t) => read.getActivities(t, at(seatedMember), { personId: p.id }))).items;
	assert.deepEqual(
		feed.map((i) => [i.id, i.kind]),
		[
			[a1, "note"],
			[a2, "stage_changed"],
			[a3, "note_removed"],
			[created, "activity"],
		],
	);
	await refusedUntouched(() => edit({ noteId: a3, revision: "3", who: coauthor }));
});

test("AC:TARGET-PPL-004 two same-email contacts are never linked for an account: racing accepts make one new linked Person, kept after the seat ends", async (t) => {
	const f = await invitationFixture();
	t.after(() => f.close());
	const s = await f.setup();
	const context = (a: { session: string }) => ({
		session: a.session as PeopleContext["session"],
		selected: church(s.w.id),
	});
	const run = <T,>(body: (t: WriteTx) => Promise<T>) => gatedTransaction(f.db, body);
	const contact = async (displayName: string) =>
		ok(
			await run((t) =>
				write.createPerson(t, context(s.sender), {
					requestKey: randomUUID(),
					input: { displayName, email: s.recipient.email },
				}),
			),
		).person;
	const contacts = [await contact("Alex"), await contact("Alex 2")];
	const alone = { accountId: s.recipient.id, owner: church(s.w.id) };
	const resolve = () => run((t) => accounts.ensureAccountPerson(t, { ...alone, selection: { kind: "resolve" } }));
	const asked = await recorded(f.admin, () => touched(f.admin, resolve));
	const candidates = contacts.map((p) => p.id).sort();
	assert.deepEqual(ok(asked.value.value), { status: "needs_selection", candidatePersonIds: candidates });
	assert.deepEqual([asked.value.tables, asked.added], [[], nothing]);
	const invitation = await f.invitation(s);
	const { promise: held, resolve: release } = Promise.withResolvers<void>();
	const { promise: holding, resolve: locked } = Promise.withResolvers<void>();
	const holder = f.admin.transaction(async (b) => {
		await b.execute(sql`SELECT 1 FROM account WHERE id=${s.recipient.id}::uuid FOR UPDATE`);
		locked();
		await held;
	});
	await holding;
	const accepts = [1, 2].map(() => f.invitations.accept(s.recipient.session, invitation.claim));
	assert.ok(await waitingOnLock(f.db, { count: 2 }), "both accepts wait");
	release();
	await holder;
	const [first, second] = await Promise.all(accepts);
	assert.deepEqual(first, second);
	assert.ok(first!.seat.kind === "plant");
	const linked = first!.seat.personId,
		seatId = first!.seat.seatId;
	const links = async () =>
		(
			await f.admin.execute(
				sql`SELECT id,linked_account_id AS account,state,email,commitment_state AS commitment FROM person WHERE plant_id=${s.w.id}::uuid ORDER BY id`,
			)
		).rows;
	const expected = [
		...contacts.map((p) => ({
			id: p.id,
			account: null,
			state: "live",
			email: s.recipient.email,
			commitment: "unknown",
		})),
		{ id: linked, account: s.recipient.id, state: "live", email: null, commitment: "unknown" },
	].sort((a, b) => (a.id < b.id ? -1 : 1));
	assert.deepEqual(await links(), expected);
	const linkAudits = async () =>
		(
			await f.admin.execute(
				sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${linked}::uuid AND action='people.created'`,
			)
		).rows[0]!.n;
	assert.equal(await linkAudits(), 1);
	const reviewed = (person: Person, account: typeof s.recipient.id) =>
		run((t) =>
			accounts.ensureAccountPerson(t, {
				...alone,
				accountId: account,
				selection: {
					kind: "reviewed_contact",
					person: { owner: church(s.w.id), personId: person.id, revision: person.revision, state: "live" },
				},
			}),
		);
	for (const again of [resolve, () => reviewed(contacts[0]!, s.recipient.id)]) {
		const kept = await recorded(f.admin, () => touched(f.admin, again));
		assert.deepEqual(ok(kept.value.value), { status: "linked", personId: linked });
		assert.deepEqual([kept.value.tables, kept.added], [[], nothing]);
	}
	const thief = await f.account();
	const linkedPerson = async () =>
		plantPerson(await run((t) => read.getPerson(t, context(s.sender), { personId: linked })));
	const taken = await touched(f.admin, async () => reviewed(await linkedPerson(), thief.id));
	refused(taken.value);
	assert.deepEqual(taken.tables, []);
	const forged = await touched(f.admin, () =>
		run((t) =>
			write.createPerson(t, context(s.sender), {
				requestKey: randomUUID(),
				input: { displayName: "Forged", accountId: s.recipient.id },
			}),
		),
	);
	refused(forged.value, "invalid_input");
	assert.deepEqual(forged.tables, []);

	ok(
		await run(async (t) =>
			write.updatePerson(t, context(s.sender), {
				requestKey: randomUUID(),
				expectedRevision: (await linkedPerson()).revision,
				input: { personId: linked, patch: { email: "crm@example.test" } },
			}),
		),
	);
	const own = () => run((t) => read.getOwnAccountPerson(t, context(s.recipient), {}));
	assert.deepEqual(ok(await own()), { status: "linked", personId: linked });
	assert.deepEqual(ok(await run((t) => read.getOwnAccountPerson(t, context(s.sender), {}))), { status: "unlinked" });
	assert.equal(
		(await f.admin.execute(sql`SELECT email FROM auth_user WHERE id=${s.recipient.user}`)).rows[0]!.email,
		s.recipient.email,
	);
	await f.seats.remove(
		await f.actor(s.sender.session),
		s.w as never,
		{
			requestKey: randomUUID(),
			expectedRevision: "1",
			input: { seatId, expectedRole: "member", handoffs: [] },
		},
		noReminders,
	);
	refused(await own());
	assert.deepEqual(
		(await links()).find((p) => p.id === linked),
		{ id: linked, account: s.recipient.id, state: "live", email: "crm@example.test", commitment: "unknown" },
	);
	assert.deepEqual(ok(await resolve()), { status: "linked", personId: linked });

	const owned = okWith(
		await run((t) =>
			accounts.ensureAccountPerson(t, {
				accountId: s.sender.id,
				owner: church(s.w.id),
				selection: { kind: "first", displayName: "Owner Person" },
			}),
		),
		"linked",
	).personId;
	const ownerPerson = async () =>
		plantPerson(await run((t) => read.getPerson(t, context(s.sender), { personId: owned })));
	const committed = async () =>
		ok(await run((t) => read.listPeople(t, context(s.sender), { commitment: "active" }))).items.map((p) => p.id);
	const bootstrap = await ownerPerson();
	assert.deepEqual(
		[bootstrap.stage, bootstrap.adultClassification, bootstrap.commitment],
		["leader", "unknown", { state: "unknown" }],
	);
	assert.deepEqual(await committed(), []);
	assert.deepEqual((await f.admin.execute(sql`SELECT id FROM commitment`)).rows, []);
	ok(
		await run((t) =>
			commitments.createCommitment(t, context(s.sender), {
				requestKey: randomUUID(),
				input: { personId: owned, kind: "core_group", occurredOn: "2026-10-01" },
			}),
		),
	);
	assert.equal((await ownerPerson()).commitment.state, "active");
	assert.deepEqual(await committed(), [owned]);
});

const photoBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);

test("AC:TARGET-PPL-005 a person's photo moves to version 2 once, a failed save keeps the old one, and no foreign, retired or stale read gets a photo, key or link", async () => {
	const storage = memoryStorage();
	const alex = await create("Photo Alex"),
		other = await create("Photo Casey");
	const native = async <T,>(who: Who, body: Parameters<typeof withPeopleWrite<T>>[2]) =>
		withPeopleWrite(db, await authorityOf(db, actors[who]), body);
	const photo = (shade: number) => Buffer.concat([photoBytes, Buffer.alloc(shade)]);
	const stage = async (personId: string, who: Who = 0, byteLength = photoBytes.length) =>
		native(who, (t, c) =>
			fields.requestPersonPhotoUpload(t, c, { requestKey: randomUUID(), personId, mime: "image/png", byteLength }),
		);
	const upload = async (personId: string, bytes: Buffer = photoBytes) => {
		const { uploadId } = ok(await stage(personId, 0, bytes.length));
		return { uploadId, stored: await uploadPersonPhoto(db, storage, ctx(), { uploadId, bytes }) };
	};
	const currentRevision = async (id: string) => String(await storedRevision(id));
	const setRequest = async (personId: string, uploadId: string) => ({
		requestKey: randomUUID(),
		expectedRevision: await currentRevision(personId),
		input: { personId, uploadId },
	});
	const set = async (personId: string, uploadId: string) => {
		const request = await setRequest(personId, uploadId);
		return native(0, (t, c) => fields.setPersonPhoto(t, c, request));
	};
	const shown = (personId: string, who: Who = 1) => tx((t) => fields.getPersonPhoto(t, ctx(who), { personId }));
	const bytesOf = async (personId: string, versionId: string, who: Who = 1) =>
		readPersonPhoto(db, storage, ctx(who), { personId, versionId });
	const reviewer = new PeopleReadContext(await tx((t) => authorityOf(t, actors[1])));
	const listed = async (personIds: string[]) => ok(await readPersonPhotos(db, reviewer, { personIds })).photos;

	const one = await upload(alex.id);
	ok(one.stored);
	ok(await set(alex.id, one.uploadId));
	const version1 = { status: "available", personId: alex.id, versionId: one.uploadId };
	assert.deepEqual(ok(await shown(alex.id)), version1);
	assert.deepEqual(Buffer.from(ok(await bytesOf(alex.id, one.uploadId)).bytes), photoBytes);

	const failed = await (async () => {
		storage.state.failPuts = true;
		try {
			return await upload(alex.id);
		} finally {
			storage.state.failPuts = false;
		}
	})();
	refused(failed.stored);
	const rejectedSet = await touched(admin, () => set(alex.id, failed.uploadId));
	refused(rejectedSet.value);
	assert.deepEqual(rejectedSet.tables, []);
	const two = await upload(alex.id, photo(1));
	ok(two.stored);
	await admin.execute(sql`CREATE FUNCTION refuse_photo_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		RAISE EXCEPTION 'synthetic_audit_failure'; END $$`);
	await admin.execute(
		sql.raw(`CREATE TRIGGER refuse_photo_audit BEFORE INSERT ON audit_event FOR EACH ROW
		WHEN (NEW.subject_id='${alex.id}') EXECUTE FUNCTION refuse_photo_audit()`),
	);
	try {
		const rolledBack = await touched(admin, async () => {
			await assert.rejects(set(alex.id, two.uploadId));
		});
		assert.deepEqual(rolledBack.tables, []);
	} finally {
		await admin.execute(sql`DROP TRIGGER refuse_photo_audit ON audit_event`);
		await admin.execute(sql`DROP FUNCTION refuse_photo_audit()`);
	}
	assert.deepEqual(ok(await shown(alex.id)), version1);
	assert.deepEqual(Buffer.from(ok(await bytesOf(alex.id, one.uploadId)).bytes), photoBytes);

	const request = await setRequest(alex.id, two.uploadId);
	const save = (who: Who = 0, selected: Owner = church(plants[0])) =>
		tx((t) => fields.setPersonPhoto(t, ctx(who, selected) as never, request));
	const attempts: (() => Promise<Reply<unknown>>)[] = [
		() => save(1),
		() => save(2),
		() => save(2, church(plants[1])),
		() => stage(alex.id, 1),
		() => stage(alex.id, 2),
	];
	for (const attempt of attempts) {
		const denied = await touched(admin, attempt);
		refused(denied.value);
		assert.deepEqual(denied.tables, []);
	}
	const replaced = await recorded(admin, () =>
		touched(admin, () => native(0, (t, c) => fields.setPersonPhoto(t, c, request))),
	);
	assert.deepEqual(replaced.added, { ...nothing, audits: ["people.updated"], jobs: ["object_cleanup"] });
	assert.deepEqual(replaced.value.tables, ["audit_event", "job", "person", "plant", "record"]);
	const saved = ok(replaced.value.value);
	const version2 = { status: "available", personId: alex.id, versionId: two.uploadId };
	assert.deepEqual(
		{ ...saved, receiptId: null },
		{
			photo: version2,
			personRevision: String(BigInt(request.expectedRevision) + 1n),
			outcome: "changed",
			receiptId: null,
		},
	);
	const again = await recorded(admin, () =>
		touched(admin, () => native(0, (t, c) => fields.setPersonPhoto(t, c, request))),
	);
	assert.deepEqual([ok(again.value.value), again.value.tables, again.added], [saved, [], nothing]);
	const versions = (
		await admin.execute(
			sql`SELECT after_value->>'photo' AS photo FROM audit_event WHERE subject_id=${alex.id}::uuid AND after_value ? 'photo' ORDER BY occurred_at,id`,
		)
	).rows.map((r) => r.photo);
	assert.deepEqual(versions, [one.uploadId, two.uploadId]);
	assert.deepEqual(ok(await shown(alex.id)), version2);
	assert.deepEqual(await listed([alex.id]), [
		{ personId: alex.id, photo: { kind: "person", personId: alex.id, versionId: two.uploadId } },
	]);
	refused(await bytesOf(alex.id, one.uploadId));
	assert.deepEqual(Buffer.from(ok(await bytesOf(alex.id, two.uploadId)).bytes), photo(1));
	for (const answer of [saved, await shown(alex.id), await listed([alex.id])]) {
		const text = JSON.stringify(answer);
		for (const hidden of ["private/", "http", "storage", "key", "synthetic-only"])
			assert.equal(text.toLowerCase().includes(hidden), false, text);
	}
	const unseen = new PeopleReadContext(await tx((t) => authorityOf(t, actors[2])));
	for (const selected of [church(plants[0]), church(plants[1])]) {
		refused(await tx((t) => fields.getPersonPhoto(t, ctx(2, selected), { personId: alex.id })));
		refused(await readPersonPhoto(db, storage, ctx(2, selected), { personId: alex.id, versionId: two.uploadId }));
	}
	assert.deepEqual(ok(await readPersonPhotos(db, unseen, { personIds: [alex.id] })).photos, []);
	refused(await bytesOf(other.id, two.uploadId));
	refused(await set(other.id, two.uploadId));

	assert.equal(storage.objects.size, 2);
	await admin.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp() WHERE kind='object_cleanup' AND subject_record_id=ANY(${sql.param([failed.uploadId, one.uploadId, two.uploadId])}::uuid[])`,
	);
	await runDueObjectCleanup(db, storage, 10);
	assert.equal(storage.objects.size, 1);
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT id,state FROM file_object WHERE id=ANY(${sql.param([failed.uploadId, one.uploadId])}::uuid[])`,
			)
		).rows
			.filter((r) => r.state === "ready" || r.state === "pending")
			.map((r) => r.id),
		[],
	);
	assert.deepEqual(Buffer.from(ok(await bytesOf(alex.id, two.uploadId)).bytes), photo(1));

	const gone = await create("Photo retired"),
		goneUpload = await upload(gone.id),
		spare = await upload(gone.id);
	ok(await set(gone.id, goneUpload.uploadId));
	ok(await bytesOf(gone.id, goneUpload.uploadId));
	const review = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: gone.id }))).reviewRevision;
	const revisionBefore = await currentRevision(gone.id);
	ok(
		await native(0, (t, c) =>
			write.retirePerson(
				t,
				c,
				{
					requestKey: randomUUID(),
					expectedRevision: revisionBefore,
					input: { personId: gone.id, reason: "Moved away", reviewRevision: review, handoffs: [] },
				},
				noReminders,
			),
		),
	);
	refused(await shown(gone.id, 0));
	refused(await bytesOf(gone.id, goneUpload.uploadId, 0));
	assert.deepEqual(await listed([gone.id]), []);
	const late = await touched(admin, () => set(gone.id, spare.uploadId));
	refused(late.value);
	assert.deepEqual(late.tables, []);
	refused(await stage(gone.id));
});

test("AC:TARGET-PPL-005 a merge can take the source's photo and keeps the other, and unmerging gives each person their own photo back", async () => {
	const storage = memoryStorage();
	const make = async (name: string, padding: number) => {
		const p = await create(name);
		const bytes = Buffer.concat([photoBytes, Buffer.alloc(padding)]);
		const { uploadId } = ok(
			await tx((t) =>
				fields.requestPersonPhotoUpload(t, ctx(), {
					requestKey: randomUUID(),
					personId: p.id,
					mime: "image/png",
					byteLength: bytes.length,
				}),
			),
		);
		ok(await uploadPersonPhoto(db, storage, ctx(), { uploadId, bytes }));
		ok(
			await withPeopleWrite(db, await authorityOf(db, actors[0]), (t, c) =>
				fields.setPersonPhoto(t, c, {
					requestKey: randomUUID(),
					expectedRevision: p.revision,
					input: { personId: p.id, uploadId },
				}),
			),
		);
		return { id: p.id, uploadId, bytes };
	};
	const survivor = await make("Merge survivor", 1),
		source = await make("Merge source", 2);
	const photoOf = async (personId: string, versionId: string) => {
		const reply = await readPersonPhoto(db, storage, ctx(1), { personId, versionId });
		return reply.status === "ok" ? Buffer.from(reply.value.bytes) : null;
	};
	const pair = { sourceId: source.id, survivorId: survivor.id };
	const review = ok(await tx((t) => peopleMerge.getMergeReview(t, ctx(), pair)));
	const merged = ok(
		await tx((t) =>
			peopleMerge.mergePeople(t, ctx(), {
				requestKey: randomUUID(),
				input: { ...pair, reviewDigest: review.reviewDigest, fieldChoices: { photo: "source" } },
			}),
		),
	);
	const shown = (personId: string) => tx((t) => fields.getPersonPhoto(t, ctx(1), { personId }));
	assert.deepEqual(ok(await shown(survivor.id)), {
		status: "available",
		personId: survivor.id,
		versionId: source.uploadId,
	});
	assert.deepEqual(await photoOf(survivor.id, source.uploadId), source.bytes);
	assert.equal(await photoOf(survivor.id, survivor.uploadId), null);
	refused(await shown(source.id));
	assert.equal(await photoOf(source.id, source.uploadId), null);
	await admin.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp() WHERE kind='object_cleanup' AND subject_record_id=ANY(${sql.param([survivor.uploadId, source.uploadId])}::uuid[])`,
	);
	await runDueObjectCleanup(db, storage, 10);
	assert.equal(storage.objects.size, 2);
	const preview = ok(await tx((t) => peopleUnmerge.previewUnmerge(t, ctx(), { mergeId: merged.mergeId })));
	assert.deepEqual([preview.conflicts, preview.fields], [[], ["photo"]]);
	ok(
		await tx((t) =>
			peopleUnmerge.unmergePeople(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: preview.reviewRevision,
				input: { mergeId: merged.mergeId },
			}),
		),
	);
	for (const own of [survivor, source]) {
		assert.deepEqual(ok(await shown(own.id)), { status: "available", personId: own.id, versionId: own.uploadId });
		assert.deepEqual(await photoOf(own.id, own.uploadId), own.bytes);
	}
	assert.equal(await photoOf(survivor.id, source.uploadId), null);
});
