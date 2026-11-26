import "../../platform/setup.mts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import {
	accountId,
	recordId,
	revision,
	sessionId,
	tenantId,
} from "../../../../packages/contracts/src/common/values.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import type { OrganizationEffects } from "../../../../packages/domain/src/organizations/core.ts";
import { createOrganizationAdapter } from "../../../../packages/domain/src/organizations/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { sectionOperations } from "../../../../packages/domain/src/settings/index.ts";
import { createConversation, EvryRefusal, evryActor, type EvryActor } from "../../../../packages/evry/src/index.ts";
import { ok, refused } from "../../../support/fixture.mts";
import type { Database } from "../../../support/test-database.mts";
import { clockedWorld } from "../../tasks/world.mts";
import { schemaCase } from "./schema-probe.mts";

const c = schemaCase("SCHEMA-001");
const w = await clockedWorld("schemacases", c.clock!.now);
after(() => w.close());
const { admin } = w;
const P = w.plant.id;
const Q = (await w.plantOf()).id;
const rows = async <T extends Record<string, unknown>>(query: SQL) => (await admin.execute<T>(query)).rows;

type Failure = { code: string | undefined; constraint: string | undefined; message: string };
const failureOf = (error: unknown): Failure => {
	const cause = ((error as { cause?: unknown }).cause ?? error) as {
		code?: string;
		constraint?: string;
		message?: string;
	};
	return { code: cause.code, constraint: cause.constraint, message: String(cause.message) };
};
const ROLLBACK = Symbol("rollback");
async function rolledBack<T>(pool: Database, body: (tx: Database) => Promise<T>): Promise<T> {
	let value: T | undefined;
	await pool
		.transaction(async (tx) => {
			value = await body(tx as unknown as Database);
			throw ROLLBACK;
		})
		.catch((error: unknown) => {
			if (error !== ROLLBACK) throw error;
		});
	return value as T;
}
async function attempt(tx: Database, statement: () => Promise<unknown>): Promise<Failure | null> {
	await tx.execute(sql`SAVEPOINT probe`);
	try {
		await statement();
		await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
		return null;
	} catch (error) {
		return failureOf(error);
	} finally {
		await tx.execute(sql`ROLLBACK TO SAVEPOINT probe`);
	}
}
const schema = w.schema;
const regclass = (table: string) => `${schema}.${table}`;
async function insert(tx: Database, table: string, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	await tx.execute(
		sql`INSERT INTO ${sql.identifier(table)}(${sql.join(
			columns.map((k) => sql.identifier(k)),
			sql`,`,
		)}) VALUES(${sql.join(
			columns.map((k) => sql`${row[k]}`),
			sql`,`,
		)})`,
	);
}
async function loosen(tx: Database, table: string, keep: { constraint?: string; trigger?: string } = {}) {
	const constraints = await tx.execute<{ name: string }>(sql`SELECT conname AS name FROM pg_constraint
		WHERE conrelid=${regclass(table)}::regclass AND contype IN ('c','f','x') AND conname<>${keep.constraint ?? ""}`);
	for (const k of constraints.rows)
		await tx.execute(sql`ALTER TABLE ${sql.identifier(table)} DROP CONSTRAINT ${sql.identifier(k.name)}`);
	const required = await tx.execute<{ name: string }>(sql`SELECT a.attname AS name FROM pg_attribute a
		WHERE a.attrelid=${regclass(table)}::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
		AND NOT EXISTS(SELECT FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary AND a.attnum=ANY(i.indkey))`);
	for (const k of required.rows)
		await tx.execute(sql`ALTER TABLE ${sql.identifier(table)} ALTER COLUMN ${sql.identifier(k.name)} DROP NOT NULL`);
	await tx.execute(sql`ALTER TABLE ${sql.identifier(table)} DISABLE TRIGGER USER`);
	if (keep.trigger)
		await tx.execute(sql`ALTER TABLE ${sql.identifier(table)} ENABLE TRIGGER ${sql.identifier(keep.trigger)}`);
}
const valueOf = (type: string) =>
	type === "uuid"
		? randomUUID()
		: type === "text"
			? "k" + randomUUID().slice(0, 12)
			: type === "date"
				? "2026-10-13"
				: String(Math.floor(Math.random() * 1e9));
async function withKey(tx: Database, table: string, row: Record<string, string>) {
	const key = await tx.execute<{ name: string; type: string }>(sql`SELECT a.attname AS name,
		format_type(a.atttypid,a.atttypmod) AS type FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid
		AND a.attnum=ANY(i.indkey) WHERE i.indrelid=${regclass(table)}::regclass AND i.indisprimary`);
	const full = { ...row };
	for (const k of key.rows) full[k.name] ??= valueOf(k.type);
	return full;
}

type Reference = { name: string; child: string; parent: string; cols: string[]; rcols: string[]; types: string[] };
const references = (
	await rows<Reference>(sql`SELECT c.conname AS name, cl.relname AS child, pl.relname AS parent,
	array(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,i) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.i) AS cols,
	array(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,i) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.i) AS rcols,
	array(SELECT format_type(a.atttypid,a.atttypmod) FROM unnest(c.confkey) WITH ORDINALITY k(n,i) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.i) AS types
	FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid JOIN pg_class pl ON pl.oid=c.confrelid
	WHERE c.contype='f' AND c.connamespace=${schema}::regnamespace AND cardinality(c.conkey)>1 ORDER BY 2,1`)
).filter((r) => r.cols.slice(1).some((col) => /(^|_)(plant|tenant|organization|account|author)_id$/.test(col)));

async function ownerBound(reference: Reference) {
	return rolledBack(admin, async (tx) => {
		await loosen(tx, reference.child, { constraint: reference.name });
		if (reference.parent !== reference.child) await loosen(tx, reference.parent);
		await tx.execute(sql`SET CONSTRAINTS ${sql.identifier(reference.name)} IMMEDIATE`);
		const parentRow = () => Object.fromEntries(reference.rcols.map((col, i) => [col, valueOf(reference.types[i]!)]));
		const own = parentRow(),
			other = parentRow();
		await insert(tx, reference.parent, await withKey(tx, reference.parent, own));
		await insert(tx, reference.parent, await withKey(tx, reference.parent, other));
		const child = (source: Record<string, string>) =>
			Object.fromEntries(reference.cols.map((col, i) => [col, source[reference.rcols[i]!]!]));
		const same = await attempt(tx, async () =>
			insert(tx, reference.child, await withKey(tx, reference.child, child(own))),
		);
		const foreign = await attempt(tx, async () =>
			insert(
				tx,
				reference.child,
				await withKey(tx, reference.child, { ...child(own), [reference.cols[0]!]: other[reference.rcols[0]!]! }),
			),
		);
		return { same, foreign };
	});
}

const bindings = await rows<{ table: string; owner: string }>(sql`SELECT c.relname AS table,
	encode(t.tgargs,'escape') AS owner FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
	WHERE c.relnamespace=${schema}::regnamespace AND t.tgname='assert_record_binding' ORDER BY 1`);
async function recordBinding(table: string, ownerExpression: string) {
	const ownerColumn = ownerExpression.match(/[a-z_]+_id/)![0];
	const otherKind = table === "task" ? "meeting" : "task";
	return rolledBack(admin, async (tx) => {
		await loosen(tx, table, { trigger: "bind_record" });
		const row = async (id: string) => withKey(tx, table, { id, [ownerColumn]: P });
		const own = randomUUID(),
			foreign = randomUUID(),
			kind = randomUUID();
		await tx.execute(
			sql`INSERT INTO record(id,kind,tenant_id) VALUES(${foreign},${table},${Q}),(${kind},${otherKind},${P})`,
		);
		return {
			same: await attempt(tx, async () => insert(tx, table, await row(own))),
			foreign: await attempt(tx, async () => insert(tx, table, await row(foreign))),
			kind: await attempt(tx, async () => insert(tx, table, await row(kind))),
		};
	});
}

const PAST = "2026-10-01T12:00:00Z";
const taskRow = (values: Record<string, unknown>) => ({
	id: randomUUID(),
	plant_id: P,
	title: "Call them",
	category: "general",
	priority: "medium",
	status: "not_started",
	created_at: PAST,
	due_kind: "undated",
	...values,
});
const TIMED = {
	due_kind: "timed",
	due_date: "2026-11-01",
	due_time: "01:30",
	timezone: "America/Chicago",
	due_at: "2026-11-01T06:30:00Z",
	resolver_version: "1",
};
const taskAccepted = (values: Record<string, unknown>) =>
	rolledBack(admin, async (tx) => attempt(tx, () => insert(tx, "task", taskRow(values))));

const organizationEffects: OrganizationEffects = {
	invitation: async () => {},
	invalidate: () => sql`SELECT 1`,
};
const settings = sectionOperations({
	organizations: createOrganizationAdapter(organizationEffects, {
		candidates: () => sql`SELECT NULL::uuid WHERE false`,
	}),
	organizationEffects,
	effects: { replan: async () => assert.fail("a profile save plans no zone change") },
	suppression: async () => "unavailable",
});

test("AC:SCHEMA-001 every owner-bound reference takes its own parent and refuses a foreign one, task due and child shapes hold, profile requests refuse forged fields, and the account context grants no plant", async () => {
	const input = c.action.arguments;
	assert.deepEqual(
		[input.owner_pairs, input.due_kinds, input.child_due_kind],
		[
			[
				["P", "P"],
				["P", "Q"],
			],
			["undated", "date_only", "timed"],
			"timed",
		],
	);

	assert.ok(references.length >= 170, String(references.length));
	const wrong: string[] = [];
	const outcomes = [];
	for (const reference of references) {
		const outcome = await ownerBound(reference);
		outcomes.push(outcome);
		if (outcome.same) wrong.push(`${reference.name}: own parent refused ${outcome.same.message}`);
		if (outcome.foreign?.code !== "23503" || outcome.foreign.constraint !== reference.name)
			wrong.push(`${reference.name}: foreign parent ${JSON.stringify(outcome.foreign)}`);
	}
	assert.ok(bindings.filter((b) => /^(coalesce\()?"?[a-z_]+_id\b/.test(b.owner)).length >= 60, String(bindings.length));
	for (const binding of bindings) {
		if (!/^(coalesce\()?"?[a-z_]+_id\b/.test(binding.owner)) continue;
		const outcome = await recordBinding(binding.table, binding.owner);
		outcomes.push(outcome);
		if (outcome.same) wrong.push(`${binding.table}: own record refused ${outcome.same.message}`);
		for (const leg of ["foreign", "kind"] as const)
			if (outcome[leg]?.code !== "23514" || !/record_subtype_owner_mismatch/.test(outcome[leg].message))
				wrong.push(`${binding.table}: ${leg} record ${JSON.stringify(outcome[leg])}`);
	}
	assert.deepEqual(wrong, []);

	const network = await w.organization("sending_network");
	const church = await w.organization("sending_church");
	const shapes = await rolledBack(admin, async (tx) => ({
		double: await attempt(tx, () =>
			insert(tx, "seat", {
				account_id: w.adminActor.id,
				plant_id: P,
				organization_id: church.id,
				role: "member",
				accepted_at: PAST,
			}),
		),
		plantAsOrganization: await attempt(tx, () =>
			insert(tx, "network_intelligence_run", {
				id: randomUUID(),
				organization_id: P,
				rubric_version: "everyfield-network/v1",
			}),
		),
	}));
	assert.equal(shapes.double?.code, "23514");
	assert.equal(shapes.plantAsOrganization?.code, "23503");
	const due = {
		undated: await taskAccepted({}),
		date_only: await taskAccepted({ due_kind: "date_only", due_date: "2026-10-20" }),
		timed: await taskAccepted(TIMED),
	};
	assert.deepEqual(due, { undated: null, date_only: null, timed: null });
	const mixed = [
		{ due_date: "2026-10-20" },
		{ due_kind: "date_only" },
		{ due_kind: "date_only", due_date: "2026-10-20", due_time: "09:00" },
		{ ...TIMED, timezone: null },
		{ ...TIMED, due_at: null },
		{ ...TIMED, resolver_version: null },
		{ ...TIMED, timezone: "Mars/Olympus" },
		{ due_kind: "someday" },
	];
	const mixedOutcomes = [];
	for (const values of mixed) mixedOutcomes.push(await taskAccepted(values));
	assert.ok(
		mixedOutcomes.every((o) => o?.code === "23514"),
		JSON.stringify(mixedOutcomes),
	);

	const parent = await w.create(w.owner, { title: "Plan the launch" });
	const foreignParent = (
		await rows<{ id: string }>(sql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind)
		VALUES(${Q},'Elsewhere','general','medium','not_started',${PAST},'undated') RETURNING id`)
	)[0]!.id;
	const person = (
		await rows<{ id: string }>(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,created_at,state)
		VALUES(${P},${P},'Alex Chen','other','prospect','adult','unknown',1,${PAST},'live') RETURNING id`)
	)[0]!.id;
	const children = {
		timed: await taskAccepted({ ...TIMED, parent_id: parent.id }),
		date_only: await taskAccepted({ due_kind: "date_only", due_date: "2026-10-20", parent_id: parent.id }),
		person_hook: await taskAccepted({ parent_id: parent.id, person_id: person }),
		series: await taskAccepted({ parent_id: parent.id, occurrence_key: "2026-10-20" }),
		foreign_parent: await taskAccepted({ parent_id: foreignParent }),
		self_parent: await rolledBack(admin, async (tx) => {
			const id = randomUUID();
			return attempt(tx, () => insert(tx, "task", taskRow({ id, parent_id: id })));
		}),
		plain: await taskAccepted({ parent_id: parent.id }),
	};
	assert.equal(children.plain, null);
	for (const key of ["timed", "date_only", "person_hook", "series", "self_parent"] as const)
		assert.equal(children[key]?.code, "23514", key);
	assert.deepEqual([children.foreign_parent?.code, children.foreign_parent?.constraint], ["23503", "task_fk_7"]);

	const subtask = (
		input: Record<string, unknown>,
		parentTask: { id: string; revision: string } = parent,
		who = w.owner,
	) =>
		w.write(who, "createSubtask", {
			requestKey: randomUUID(),
			expectedRevision: parentTask.revision,
			input: { parentId: parentTask.id, title: "Book the venue", ...input },
		});
	for (const extra of [
		{ due: { kind: "resolved_instant", local: "2026-11-01T01:30:00" } },
		{ due: { kind: "local_date", date: "2026-10-20" } },
		{ zone: "America/Chicago" },
		{ instant: "2026-11-01T06:30:00Z" },
		{ recurrence: { frequency: "weekly" } },
		{ relation: { kind: "person", id: person } },
		{ predecessorId: parent.id },
	])
		assert.equal((await subtask(extra)).status, "refused", JSON.stringify(extra));
	assert.equal(
		(await subtask({}, { id: recordId.parse(foreignParent), revision: revision.parse("1") })).status,
		"refused",
	);
	const child = ok(await subtask({ assigneeIds: [] })) as { task: { id: string; revision: string } };
	const nested = await w.write(w.owner, "createSubtask", {
		requestKey: randomUUID(),
		expectedRevision: child.task.revision,
		input: { parentId: child.task.id, title: "Nested" },
	});
	assert.equal(nested.status, "refused");
	assert.deepEqual(
		await rows(sql`SELECT parent_id::text,due_kind,num_nonnulls(due_date,due_time,timezone,due_at,series_id,
		occurrence_key,predecessor_id,obligation_id,person_id,meeting_id,team_id,launch_id)::int AS hooks,
		(SELECT count(*)::int FROM task_assignee a WHERE a.task_id=t.id) AS assignees FROM task t WHERE id=${child.task.id}`),
		[{ parent_id: parent.id, due_kind: "undated", hooks: 0, assignees: 0 }],
	);

	const timed = async (local: string, offsetSeconds?: number) =>
		w.write(w.owner, "create", {
			requestKey: randomUUID(),
			input: {
				title: "Set up chairs",
				due: { kind: "resolved_instant", local, ...(offsetSeconds === undefined ? {} : { offsetSeconds }) },
			},
		});
	const earlier = ok(await timed("2026-11-01T01:30:00", -18000)) as { task: { id: string } };
	const later = ok(await timed("2026-11-01T01:30:00", -21600)) as { task: { id: string } };
	assert.deepEqual(
		await rows(sql`SELECT due_kind,due_date::text,due_time::text,timezone,to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI"Z"') AS at
		FROM task WHERE id IN (${earlier.task.id}::uuid,${later.task.id}::uuid) ORDER BY due_at`),
		[
			{
				due_kind: "timed",
				due_date: "2026-11-01",
				due_time: "01:30:00",
				timezone: "America/Chicago",
				at: "2026-11-01T06:30Z",
			},
			{
				due_kind: "timed",
				due_date: "2026-11-01",
				due_time: "01:30:00",
				timezone: "America/Chicago",
				at: "2026-11-01T07:30Z",
			},
		],
	);
	for (const [local, code] of [
		["2026-11-01T01:30:00", "ambiguous_local_time"],
		["2026-03-08T02:30:00", "nonexistent_local_time"],
	] as const)
		assert.equal(refused(await timed(local), code).code, code);
	for (const forged of [
		{ kind: "resolved_instant", local: "2026-11-01T01:30:00", offsetSeconds: 3600 },
		{ kind: "resolved_instant", local: "2026-11-01T01:30:00", zone: "America/New_York" },
		{ kind: "resolved_instant", local: "2026-11-01T01:30:00", instant: "2026-11-01T09:00:00Z" },
		{ kind: "local_date", date: "2026-10-20", local: "2026-10-20T09:00:00" },
		{ kind: "undated", date: "2026-10-20" },
	])
		assert.equal(
			(await w.write(w.owner, "create", { requestKey: randomUUID(), input: { title: "Forged", due: forged } })).status,
			"refused",
			JSON.stringify(forged),
		);

	const ctx = {
		session: sessionId.parse(w.owner.session),
		selected: { kind: "plant" as const, id: tenantId.parse(P) },
	};
	const plantRow = () =>
		rows(
			sql`SELECT revision::text,name,street,city,state_province,country,description,timezone FROM plant WHERE id=${P}`,
		);
	const profile = (patch: Record<string, unknown>, revision: string, plant: unknown = { kind: "plant", id: P }) =>
		gatedTransaction(w.db, (tx) =>
			settings.updatePlantProfile(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: revision,
				input: { plant, patch },
			}),
		);
	const set = await profile(
		{ name: "n".repeat(200), city: "Austin", street: "s".repeat(500), description: "d".repeat(5000) },
		"1",
	);
	assert.equal(set.status, "ok", JSON.stringify(set));
	const before = await plantRow();
	for (const [patch, plant] of [
		[{ city: "x".repeat(201) }, undefined],
		[{ street: "x".repeat(501) }, undefined],
		[{ description: "x".repeat(5001) }, undefined],
		[{ name: "x".repeat(201) }, undefined],
		[{}, undefined],
		[{ city: 7 }, undefined],
		[{ name: "   " }, undefined],
		[{ nickname: "Hill" }, undefined],
		[{ id: Q }, undefined],
		[{ timezone: "UTC" }, undefined],
		[{ revision: "9" }, undefined],
		[{ city: "Austin" }, { kind: "plant", id: Q }],
		[{ city: "Austin" }, { kind: "organization", id: P, organizationKind: "sending_church" }],
	] as const) {
		const reply = await profile(patch, before[0]!.revision as string, plant);
		assert.equal(reply.status, "refused", JSON.stringify([patch, plant]));
	}
	assert.deepEqual(await plantRow(), before);
	const cleared = await profile({ street: null, description: null }, before[0]!.revision as string);
	assert.equal(cleared.status, "ok", JSON.stringify(cleared));
	assert.deepEqual(
		(await plantRow()).map((r) => [r.street, r.description, r.city]),
		[[null, null, "Austin"]],
	);
	const discovery = await w.actor(null);
	const resolved = await RequestActor.resolve(w.db, discovery.session);
	assert.ok(resolved instanceof RequestActor);
	const self = evryActor(resolved);
	assert.deepEqual(
		[self.owner, self.contextKind, self.role, self.seatId],
		[{ kind: "account", id: accountId.parse(discovery.id) }, "account", null, null],
	);
	const conversation = await createConversation(w.db, self, { requestKey: randomUUID() });
	const stored = await rows(
		sql`SELECT tenant_id::text,account_id::text,context_kind FROM conversation WHERE id=${conversation.id}`,
	);
	assert.deepEqual(stored, [{ tenant_id: discovery.id, account_id: discovery.id, context_kind: "account" }]);
	const other = await w.actor(null);
	const forged = (owner: EvryActor["owner"], contextKind: EvryActor["contextKind"]): EvryActor => ({
		...self,
		owner,
		contextKind,
	});
	const refusedAs = async (actor: EvryActor) =>
		createConversation(w.db, actor, { requestKey: randomUUID() }).then(
			() => "accepted",
			(error: unknown) => (error instanceof EvryRefusal ? "refused" : String(error)),
		);
	await w.seat({ id: other.id }, church, "member");
	const mixedContexts = [
		forged({ kind: "account", id: accountId.parse(other.id) }, "account"),
		forged({ kind: "plant", id: tenantId.parse(P) }, "account"),
		forged({ kind: "plant", id: tenantId.parse(P) }, "plant"),
		forged(
			{ kind: "organization", id: tenantId.parse(church.id), organizationKind: "sending_church" },
			"sending_church",
		),
		forged(
			{ kind: "organization", id: tenantId.parse(network.id), organizationKind: "sending_network" },
			"sending_network",
		),
		forged({ kind: "account", id: accountId.parse(discovery.id) }, "plant"),
	];
	const member = await RequestActor.resolve(w.db, other.session);
	assert.ok(member instanceof RequestActor);
	const seated = evryActor(member);
	assert.deepEqual([seated.contextKind, await refusedAs(seated)], ["sending_church", "accepted"]);
	mixedContexts.push(
		{ ...seated, contextKind: "sending_network" },
		{ ...seated, owner: { ...seated.owner, organizationKind: "sending_network" } as EvryActor["owner"] },
		{ ...seated, contextKind: "plant" },
		{ ...seated, contextKind: "account" },
	);
	const contextOutcomes = [];
	for (const actor of mixedContexts) contextOutcomes.push(await refusedAs(actor));
	assert.deepEqual(
		contextOutcomes,
		mixedContexts.map(() => "refused"),
	);
	const grants = await rows<{ n: number }>(sql`SELECT (SELECT count(*)::int FROM seat WHERE account_id=${discovery.id})
		+ (SELECT count(*)::int FROM conversation WHERE account_id=${discovery.id} AND tenant_id<>${discovery.id}) AS n`);

	const columns = async (pattern: string) =>
		(
			await rows<{ column: string }>(sql`SELECT table_name||'.'||column_name AS column FROM information_schema.columns
			WHERE table_schema=${schema} AND (column_name ~* ${pattern} OR table_name ~* ${pattern}) ORDER BY 1`)
		).map((r) => r.column);

	assert.deepEqual(
		{
			state: {},
			result: {
				same_owner_insert: outcomes.every((o) => o.same === null) && due.timed === null && children.plain === null,
				foreign_owner_insert: outcomes.some((o) => o.foreign === null || ("kind" in o && o.kind === null)),
				child_timed_insert: children.timed === null,
				mixed_due_shape_insert: mixedOutcomes.some((o) => o === null),
				account_context_accepted: stored.length === 1,
				account_context_plant_grants: grants[0]!.n,
				coaching_columns: await columns("coach"),
				background_check_columns: await columns("background"),
			},
			event: null,
		},
		{ state: c.expected.state, result: c.expected.result, event: c.expected.event },
	);
});
