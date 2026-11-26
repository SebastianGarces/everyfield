import "../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { PgDialect } from "../../../../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import {
	captureFacts,
	createAssessmentJob,
	createAssessments,
	createFacts,
	createPrivateCare,
	runAssessmentBatch,
} from "../../../../packages/domain/src/intelligence/index.ts";
import { peopleWriter } from "../../../../packages/domain/src/people/index.ts";
import type { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { scriptedAssessmentDrafter } from "../../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok } from "../../../support/fixture.mts";
import { church, CANARY, type Church, type ChurchPlant } from "../../intelligence/assessment-church.mts";
import { schemaCase, subcaseOf } from "./schema-probe.mts";

type Executor = Parameters<typeof captureFacts>[0];
const PRIVATE_CARE = ["private_calendar", "private_week", "private_week_revision"];
const ROLLBACK = Symbol("rollback");
let clockMs = Date.now();
const clock = { now: () => new Date(clockMs).toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
let c0: Church;
before(async () => {
	c0 = await church("schema012");
	await c0.release("methodology-2026.10");
});
after(() => c0?.database.close());

const facts = createFacts();
async function state(db: Executor, plant: string, actor: RequestActor) {
	const since = await facts.readFactsSinceRun(db, actor, {});
	return JSON.stringify([await revision(db, plant), since.status === "ok" ? since.value.outOfDateRunId : since.status]);
}
const revision = async (db: Executor, plant: string) => (await captureFacts(db, plant, null))?.sourceRevision ?? null;

async function builderTables(plant: string, actor: RequestActor) {
	const texts: string[] = [];
	const recording: Executor = {
		execute: ((query: SQL) => {
			texts.push(new PgDialect().sqlToQuery(query).sql);
			return c0.admin.execute(query);
		}) as Executor["execute"],
	};
	assert.ok(await captureFacts(recording, plant, null));
	assert.equal((await facts.readFactsSinceRun(recording, actor, {})).status, "ok");
	const text = texts.map((t) => t.replace(/^WITH gate AS \(SELECT .*? AS ok\),/s, "")).join("\n");
	assert.equal(text.match(/\bgate as \(/i), null, "the access gate is not an input");
	const named = new Set([...text.matchAll(/\b(?:FROM|JOIN)\s+"?([a-z_]+)"?\s/g)].map((m) => m[1]!));
	const tables = new Set(
		(
			await c0.rows<{ name: string }>(sql`SELECT relname AS name FROM pg_class
			WHERE relnamespace=current_schema()::regnamespace AND relkind='r'`)
		).map((r) => r.name),
	);
	return { text, tables: [...named].filter((t) => tables.has(t)).sort() };
}

async function ownedTables() {
	return c0.rows<{ name: string; owner: string }>(sql`SELECT c.relname AS name, min(a.attname) AS owner
		FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname IN ('plant_id','tenant_id') AND NOT a.attisdropped
		WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind='r' GROUP BY c.relname ORDER BY 1`);
}

async function withoutRows(table: string, owner: string, plant: string, actor: RequestActor) {
	let after = "";
	await c0.admin
		.transaction(async (tx) => {
			await tx.execute(sql`SET LOCAL session_replication_role=replica`);
			const column = table === "plant" ? "id" : owner;
			await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)}=${plant}::uuid`);
			after = await state(tx, plant, actor);
			throw ROLLBACK;
		})
		.catch((error: unknown) => {
			if (error !== ROLLBACK) throw error;
		});
	return after;
}

const runs = (p: { id: string }) =>
	c0.rows<{ id: string; outcome: string; reason: string | null; source_revision: string }>(
		sql`SELECT id,outcome,reason,source_revision FROM assessment_run WHERE plant_id=${p.id} ORDER BY captured_at,id`,
	);
async function assessed(name: string, prepare: (p: ChurchPlant) => Promise<unknown> = async () => {}) {
	clockMs = Date.now();
	const p = await c0.harvest(name);
	await prepare(p);
	await job.scheduleAssessments(c0.db);
	await runAssessmentBatch(job, c0.db, scriptedAssessmentDrafter(), 20);
	assert.equal((await runs(p)).at(-1)?.outcome, "published");
	return p;
}
const people = async (p: { id: string }) =>
	(
		await c0.rows<{ h: string }>(
			sql`SELECT md5(coalesce(string_agg(x::text,'|' ORDER BY x.id),'')) AS h FROM person x WHERE x.tenant_id=${p.id}::uuid`,
		)
	)[0]!.h;

async function lateMeeting(p: ChurchPlant) {
	const meeting = randomUUID();
	await c0.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${meeting},'meeting',${p.id})`);
	await c0.admin.execute(sql`WITH run AS (SELECT as_of+interval '1 millisecond' AS at FROM assessment_run
		WHERE plant_id=${p.id} AND outcome='published' ORDER BY available_at DESC LIMIT 1)
		INSERT INTO meeting(id,plant_id,type,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision,
		actual_occurrence_at,vision_number) SELECT ${meeting},${p.id},'vision_meeting',(run.at AT TIME ZONE 'America/Chicago')::date,
		'18:00','America/Chicago',run.at,'r1','completed',1,run.at,
		(SELECT max(vision_number)+1 FROM meeting WHERE plant_id=${p.id}) FROM run`);
	const who = (
		await c0.rows<{ id: string }>(sql`SELECT person_id AS id FROM commitment WHERE plant_id=${p.id} LIMIT 1`)
	)[0]!;
	await c0.admin.execute(sql`INSERT INTO participation(plant_id,meeting_id,person_id,roster_member,presence)
		VALUES(${p.id},${meeting},${who.id},true,'attended')`);
	await c0.admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_id)
		VALUES(${p.id},${p.owner.id},'meetings.finalized','edit',${meeting})`);
}

async function enrich(p: ChurchPlant) {
	const day = c0.day;
	const adults = await c0.rows<{ id: string }>(
		sql`SELECT DISTINCT person_id AS id FROM commitment WHERE plant_id=${p.id} AND voided_at IS NULL ORDER BY 1 LIMIT 2`,
	);
	const [contact, leaving] = [adults[0]!.id, adults[1]!.id];
	const meeting = (
		await c0.rows<{ id: string }>(sql`SELECT id FROM meeting WHERE plant_id=${p.id} ORDER BY starts_at DESC LIMIT 1`)
	)[0]!.id;
	const [obligation, task] = [randomUUID(), randomUUID()];
	await c0.admin
		.execute(sql`INSERT INTO obligation(id,plant_id,meeting_id,person_id,kind,origin_at,origin_date,timezone,
		formula_version,due_date) VALUES(${obligation},${p.id},${meeting},${contact},'follow_up',clock_timestamp()-interval '72 hours',
		${day(-3)},'America/Chicago','f1',${day(-1)})`);
	await c0.admin
		.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,obligation_id,
		person_id) VALUES(${task},${p.id},'Call them','follow_up','medium','not_started',clock_timestamp()-interval '72 hours',
		'undated',${obligation},${contact})`);
	await c0.admin.execute(
		sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${p.id},${task},${p.owner.id})`,
	);
	await c0.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${randomUUID()},${p.id},${p.id},'Owner Leader',
		${randomUUID() + "@example.test"},'other','leader','adult','unknown','1','live',clock_timestamp(),${p.owner.id})`);
	await c0.admin
		.execute(sql`INSERT INTO contact_outcome(plant_id,person_id,outcome,occurred_at,recorded_at,obligation_id,
		completes_task) VALUES(${p.id},${contact},'contacted',clock_timestamp()-interval '1 hour',clock_timestamp(),${obligation},true)`);
	const program = (
		await c0.rows<{ id: string; version: number }>(sql`INSERT INTO training_program(plant_id,name,required)
			VALUES(${p.id},'Safe kids',true) RETURNING id,version`)
	)[0]!;
	await c0.admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
		VALUES(${p.id},${program.id},${contact},${program.version},'active',${day(-2)})`);
	await c0.admin
		.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on,verifier_account_id)
		VALUES(${p.id},${contact},${program.id},'earned',${program.version},${day(-1)},${p.owner.id})`);
	const attestation = randomUUID();
	await c0.admin.execute(sql`INSERT INTO attestation(id,plant_id,key,state,answer,as_of,attested_at)
		VALUES(${attestation},${p.id},'financial_base_established','answered',true,${day(-1)},clock_timestamp())`);
	await c0.admin.execute(sql`INSERT INTO attestation_revision(plant_id,attestation_id,revision,key,kind,answer,as_of,
		question_version,request_key,request_fingerprint) VALUES(${p.id},${attestation},1,'financial_base_established','answered',
		true,${day(-1)},'v1',${randomUUID()},'fingerprint')`);
	await c0.admin.execute(sql`INSERT INTO commitment_change(id,plant_id,person_id,kind,effective_on)
		VALUES(${randomUUID()},${p.id},${leaving},'withdrawn',${day(-1)})`);
	await c0.admin.execute(sql`INSERT INTO launch(plant_id,status,target_date) VALUES(${p.id},'scheduled',${day(90)})`);
}

test("AC:SCHEMA-012 every assessment input table changes the source revision, no other table does, private care stays out, and a run claimed before a change never publishes", async () => {
	const c = schemaCase("SCHEMA-012");
	assert.deepEqual(c.action.arguments, {
		mutate_table: "person",
		pause_outbox: true,
		old_run: "run",
		compare_input_builder_and_trigger_tables: true,
	});
	const p = await assessed("Material Point", enrich);
	await lateMeeting(p);
	const { text, tables: read } = await builderTables(p.id, p.actor);
	assert.ok(read.includes("reading"), "Foundational modules complete reads Discovery progress beside the inputs");
	const inputs = read.filter((t) => t !== "reading");
	assert.ok(inputs.length >= 15, inputs.join());
	const baseline = await state(c0.admin, p.id, p.actor);
	assert.notEqual(JSON.parse(baseline)[1], null, "the late, touched meeting puts the published run out of date");
	const owned = await ownedTables();
	const ownerOf = new Map(owned.map((t) => [t.name, t.owner]));
	const missing: string[] = [];
	for (const table of inputs) {
		const owner = table === "plant" ? "id" : ownerOf.get(table);
		if (!owner) {
			missing.push(`${table}: not plant-scoped`);
			continue;
		}
		if ((await withoutRows(table, owner, p.id, p.actor)) === baseline) missing.push(table);
	}
	const unexplained: string[] = [];
	for (const { name, owner } of owned) {
		if (inputs.includes(name)) continue;
		const after = await withoutRows(name, owner, p.id, p.actor);
		if (JSON.parse(after)[0] !== JSON.parse(baseline)[0] || (JSON.parse(after)[1] !== "refused" && after !== baseline))
			unexplained.push(name);
	}
	const care = createPrivateCare();
	const current = ok(await care.readCurrent(c0.db, p.actor, {}));
	ok(
		await care.save(c0.db, p.actor, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: {
				answers: { spiritual: "strained", family: "steady", financial: "steady", pace: "strained" },
				note: CANARY + "-schema012",
			},
		}),
	);
	const afterCare = await state(c0.admin, p.id, p.actor);
	const facts = JSON.stringify(await captureFacts(c0.admin, p.id, null));

	const before = await runs(p);
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	let mutated: string | null = null;
	const racing = scriptedAssessmentDrafter({
		during: AsyncResource.bind(async () => {
			if (mutated) return;
			await c0.committed(p, "Joined Mid-Draft", 0);
			mutated = await state(c0.admin, p.id, p.actor);
		}),
	});
	await runAssessmentBatch(job, c0.db, racing, 1);
	const old = (await runs(p)).slice(before.length);
	assert.equal(old.length, 1);
	assert.deepEqual(
		{
			state: {},
			result: {
				assessment_input_state: {
					different_from:
						mutated !== null && JSON.parse(mutated)[0] !== JSON.parse(baseline)[0] ? "fixture-state-11" : null,
				},
				stale_run_published: old[0]!.outcome === "published",
				missing_triggers: missing,
				unexplained_trigger_tables: unexplained,
				private_care_in_inputs:
					PRIVATE_CARE.some((t) => inputs.includes(t) || text.includes(t)) || facts.includes(CANARY),
				private_care_invalidates: afterCare !== baseline,
			},
			event: null,
		},
		c.expected,
	);
	assert.deepEqual([old[0]!.outcome, old[0]!.reason], ["superseded", "changed_input"]);
});

test("AC:SCHEMA-012 input-rollback-keeps-revision: a person change whose transaction fails before commit keeps the source revision and the person, and publishes nothing", async () => {
	const s = subcaseOf(schemaCase("SCHEMA-012"), "input-rollback-keeps-revision");
	assert.deepEqual(s.action.arguments, { mutate_table: "person", fault: "before_commit" });
	const p = await assessed("Rollback Point");
	const revisionBefore = await revision(c0.admin, p.id);
	const peopleBefore = await people(p);
	const runsBefore = await runs(p);
	const fault = "fault_" + randomUUID().replaceAll("-", "");
	await c0.admin.execute(
		sql.raw(
			`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'required_write_failed'; END $$`,
		),
	);
	await c0.admin.execute(
		sql.raw(`CREATE CONSTRAINT TRIGGER ${fault} AFTER INSERT ON person DEFERRABLE INITIALLY DEFERRED
			FOR EACH ROW EXECUTE FUNCTION ${fault}()`),
	);
	try {
		await assert.rejects(
			gatedTransaction(c0.db, (t) =>
				peopleWriter.createPerson(
					t as never,
					p.ctx as never,
					{
						requestKey: randomUUID(),
						input: { displayName: "Never Saved", adultClassification: "adult" },
					} as never,
				),
			),
			(error: Error) => /required_write_failed/.test(String(error.cause ?? error) + String(error.message)),
		);
	} finally {
		await c0.admin.execute(sql.raw(`DROP TRIGGER ${fault} ON person`));
		await c0.admin.execute(sql.raw(`DROP FUNCTION ${fault}()`));
	}
	await job.scheduleAssessments(c0.db);
	await runAssessmentBatch(job, c0.db, scriptedAssessmentDrafter(), 20);
	const now = await revision(c0.admin, p.id);
	const added = (await runs(p)).slice(runsBefore.length);
	assert.deepEqual(
		{
			state: {},
			result: {
				assessment_input_state: now === revisionBefore ? "fixture-state-11" : now,
				input_state: (await people(p)) === peopleBefore ? "fixture-state-1" : null,
				published: added.some((r) => r.outcome === "published"),
			},
			event: null,
		},
		s.expected,
	);
});
