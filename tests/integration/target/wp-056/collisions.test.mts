import "../../platform/setup.mts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
	mergeDraft,
	pickField,
	type ConflictField,
	type Picks,
} from "../../../../apps/web/src/components/save/conflict.ts";
import { sql } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { meetingsWriter, withMeetingsWrite } from "../../../../packages/domain/src/meetings/index.ts";
import { peopleWriter, withPeopleWrite } from "../../../../packages/domain/src/people/index.ts";
import { createTaskWriter, withTaskWrite } from "../../../../packages/domain/src/tasks/index.ts";
import { teamsWriter, withTeamsWrite } from "../../../../packages/domain/src/teams/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { fixture, ok, refused, waitingOnLock, type Actor } from "../../../support/fixture.mts";

const database = await fixture({ prefix: "collisions" });
after(database.close);
const { admin } = database;
const db = database.pools.runtime;
const first = database.actors.admin;
const second = await database.actor(database.tenant, "admin");
const writer = createTaskWriter({ reminders: async () => undefined });
const key = () => randomUUID();

async function authority(who: Actor) {
	return gatedTransaction(db, async (tx) => {
		const claimed = await RequestActor.claimWrite(tx, who.session, database.tenant as never);
		assert.ok(claimed);
		return claimed.authority;
	});
}
type Text = Record<string, string>;
type Kind = {
	table: string;
	columns: Record<string, string>;
	create(): Promise<string>;
	save(who: Actor, id: string, expectedRevision: string, patch: Text): Promise<unknown>;
};
const created = (reply: unknown, name: string) =>
	(ok(reply as { status: string }) as Record<string, { id: string }>)[name]!.id;

const KINDS: Record<string, Kind> = {
	person: {
		table: "person",
		columns: { city: "city", phone: "phone", summaryNotes: "notes" },
		create: async () =>
			created(
				await withPeopleWrite(db, await authority(first), (tx, c) =>
					peopleWriter.createPerson(tx, c, {
						requestKey: key(),
						input: {
							displayName: "Ana Ruiz",
							source: "other",
							city: "Old",
							phone: "Old phone",
							summaryNotes: "Old notes",
						},
					} as never),
				),
				"person",
			),
		save: async (who, id, expectedRevision, patch) =>
			withPeopleWrite(db, await authority(who), (tx, c) =>
				peopleWriter.updatePerson(tx, c, {
					requestKey: key(),
					expectedRevision,
					input: { personId: id, patch },
				} as never),
			),
	},
	meeting: {
		table: "meeting",
		columns: { title: "title", notes: "notes" },
		create: async () =>
			created(
				await withMeetingsWrite(db, await authority(first), (tx, c) =>
					meetingsWriter.schedule(tx, c, {
						requestKey: key(),
						input: {
							type: "orientation",
							title: "Old",
							notes: "Old notes",
							date: "2027-03-02",
							time: "18:30",
							venue: { kind: "none" },
						},
					} as never),
				),
				"meeting",
			),
		save: async (who, id, expectedRevision, patch) =>
			withMeetingsWrite(db, await authority(who), (tx, c) =>
				meetingsWriter.edit(tx, c, { requestKey: key(), expectedRevision, input: { meetingId: id, patch } }),
			),
	},
	task: {
		table: "task",
		columns: { title: "title", description: "description" },
		create: async () =>
			created(
				await withTaskWrite(db, await authority(first), (tx, c) =>
					writer.create(tx, c, { requestKey: key(), input: { title: "Old", description: "Old notes" } }),
				),
				"task",
			),
		save: async (who, id, expectedRevision, patch) =>
			withTaskWrite(db, await authority(who), (tx, c) =>
				writer.edit(tx, c, { requestKey: key(), expectedRevision, input: { taskId: id, patch } }),
			),
	},
	team: {
		table: "team",
		columns: { name: "name", description: "description" },
		create: async () =>
			created(
				await withTeamsWrite(db, await authority(first), (tx, c) =>
					teamsWriter.create(tx, c, { requestKey: key(), input: { name: `Old ${key()}`, description: "Old notes" } }),
				),
				"team",
			),
		save: async (who, id, expectedRevision, patch) =>
			withTeamsWrite(db, await authority(who), (tx, c) =>
				teamsWriter.edit(tx, c, { requestKey: key(), expectedRevision, input: { teamId: id, ...patch } }),
			),
	},
};

async function stored(kind: Kind, id: string) {
	const columns = Object.entries(kind.columns).map(([field, column]) => `coalesce(${column},'') AS "${field}"`);
	const r = await admin.execute(
		sql.raw(`SELECT revision::text AS revision,${columns.join(",")} FROM ${kind.table} WHERE id='${id}'`),
	);
	const { revision, ...values } = r.rows[0] as Text & { revision: string };
	return { revision, values: values as Text };
}
async function writers(id: string) {
	const r = await admin.execute(
		sql`SELECT actor_id FROM audit_event WHERE subject_id=${id}::uuid AND request_key IS NOT NULL ORDER BY occurred_at,id`,
	);
	return r.rows.map((row) => row.actor_id);
}
async function beforeValues(id: string) {
	const r = await admin.execute(
		sql`SELECT before_value::text AS before,after_value::text AS after FROM audit_event WHERE subject_id=${id}::uuid AND request_key IS NOT NULL ORDER BY occurred_at DESC,id DESC LIMIT 1`,
	);
	return r.rows[0] as { before: string | null; after: string | null };
}
const fieldsOf = (kind: Kind): ConflictField<Text>[] =>
	Object.keys(kind.columns).map((field) => ({ key: field, label: field, text: (d) => d[field] ?? "" }));
const changed = (from: Text, to: Text) => Object.fromEntries(Object.entries(to).filter(([k, v]) => from[k] !== v));

for (const [name, kind] of Object.entries(KINDS)) {
	const [shared, theirs] = Object.keys(kind.columns) as [string, string];
	const SAVED = `First ${name}`;
	const MINE = `Second ${name}`;
	async function collide() {
		const id = await kind.create();
		const opened = await stored(kind, id);
		ok(
			(await kind.save(first, id, opened.revision, { [shared]: SAVED, [theirs]: "First notes" })) as { status: string },
		);
		refused(await kind.save(second, id, opened.revision, { [shared]: MINE }), "conflict");
		const latest = await stored(kind, id);
		assert.deepEqual([latest.values[shared], latest.values[theirs]], [SAVED, "First notes"], "the first save stands");
		const view = (picks: Picks) =>
			mergeDraft({
				base: opened.values,
				mine: { ...opened.values, [shared]: MINE },
				latest: latest.values,
				picks,
				fields: fieldsOf(kind),
			});
		return { id, opened, latest, view };
	}

	test(`INV-collision ${name}: two admins open and save one record, and the second sees both values and overwrites only what they choose`, async () => {
		const { id, opened, latest, view } = await collide();
		assert.deepEqual(view({}).rows, [
			{ field: shared, label: shared, saved: SAVED, mine: MINE, pick: null },
			{ field: theirs, label: theirs, saved: "First notes", mine: opened.values[theirs], pick: "saved" },
		]);
		assert.equal(view({}).unchosen, true, "nothing is saved before the choice");
		const chosen = view(pickField({}, latest.values, shared, "mine"));
		assert.equal(chosen.unchosen, false);
		const patch = changed(latest.values, chosen.values);
		assert.deepEqual(patch, { [shared]: MINE });
		ok((await kind.save(second, id, latest.revision, patch)) as { status: string });
		const after = await stored(kind, id);
		assert.deepEqual([after.values[shared], after.values[theirs]], [MINE, "First notes"]);
		assert.deepEqual((await writers(id)).slice(-2), [first.id, second.id]);
		const last = await beforeValues(id);
		if (kind.table === "person")
			assert.deepEqual(
				[JSON.parse(last.before ?? "null"), JSON.parse(last.after ?? "null")],
				[{}, { fields: [kind.columns[shared]] }],
				"a person audit row names the changed field and holds no value",
			);
		else assert.ok(last.before?.includes(SAVED) && last.after?.includes(MINE), JSON.stringify(last));
	});

	test(`INV-collision ${name}: the second admin keeps the saved version and nothing more is written`, async () => {
		const { id, latest, view } = await collide();
		const kept = view(pickField({}, latest.values, shared, "saved"));
		assert.deepEqual([kept.values, kept.unchosen], [latest.values, false]);
		assert.deepEqual(changed(latest.values, kept.values), {});
		assert.deepEqual(await stored(kind, id), latest);
		assert.equal((await writers(id)).at(-1), first.id);
	});

	test(`INV-collision ${name}: two saves in flight at the same moment store one and refuse the other`, async () => {
		const id = await kind.create();
		const { revision } = await stored(kind, id);
		let replies: Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> | undefined;
		await admin.transaction(async (tx) => {
			await tx.execute(sql.raw(`SELECT FROM ${kind.table} WHERE id='${id}' FOR UPDATE`));
			replies = Promise.allSettled([
				kind.save(first, id, revision, { [shared]: SAVED }),
				kind.save(second, id, revision, { [shared]: MINE }),
			]);
			await waitingOnLock(admin, { blockedBy: await pidOf(tx), count: 1 });
		});
		const results = (await replies!).map(
			(r) =>
				(r.status === "fulfilled" ? r.value : { status: String(r.reason) }) as {
					status: string;
					error?: { code: string };
				},
		);
		assert.deepEqual(results.map((r) => r.error?.code ?? r.status).sort(), ["conflict", "ok"]);
		const winner = results[0]!.status === "ok" ? SAVED : MINE;
		const saved = await stored(kind, id);
		assert.equal(saved.values[shared], winner);
		assert.equal((await writers(id)).at(-1), winner === SAVED ? first.id : second.id);
	});
}

async function pidOf(tx: { execute: typeof admin.execute }) {
	const r = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
	return Number(r.rows[0]!.pid);
}
