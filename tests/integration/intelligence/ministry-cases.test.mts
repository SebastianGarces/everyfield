import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as c from "../../../packages/contracts/src/intelligence/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import type { WriteTx } from "../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	createAssessments,
	createFacts,
	createSignals,
	criteriaOf,
	readingOf,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { readCatalog } from "../../../packages/domain/src/phases/index.ts";
import { teamsWriter, trainingReader, trainingWriter } from "../../../packages/domain/src/teams/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok, refused } from "../../support/fixture.mts";
import { caseOf, type Case } from "../target/sql/core/support.mts";
import { church, type Church, type ChurchPlant } from "./assessment-church.mts";

const K = (id: string) => caseOf("intelligence", id) as Case & { clock: { now: string } };
const arg = <T,>(k: Case, name: string) => k.action.arguments[name] as T;
const NOW = K("B01-002").clock.now;
const HOUR = 3_600_000;
const clock = { now: () => NOW as never };
const facts = createFacts({ clock });
const signals = createSignals({ clock });
const assessments = createAssessments({ clock });
const job = createAssessmentJob({ clock });

let w: Church;
before(async () => {
	w = await church("pib01", { clock: new Date(Date.parse(NOW) - HOUR) });
	await w.release("methodology-2026.10");
});
after(() => w?.database.close());

type Op = (tx: WriteTx, context: never, raw: unknown) => Promise<{ status: string; value?: unknown }>;
const run = <V,>(p: ChurchPlant, op: unknown, raw: object) =>
	gatedTransaction(w.db, (t) => (op as Op)(t, p.ctx as never, raw)) as Promise<{ status: "ok"; value: V }>;
const created = <V,>(p: ChurchPlant, op: unknown, input: object) =>
	run<V>(p, op, { requestKey: randomUUID(), input }).then(ok);
const revision = async (table: string, id: string) =>
	(await w.one<{ r: string }>(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).r;
const read = async (p: ChurchPlant) => ok(await facts.readFacts(w.db, p.actor, {}));
const exit = async (p: ChurchPlant, phase: number) =>
	Object.fromEntries(
		criteriaOf(await readCatalog(), phase, await read(p)).map((x) => [x.key, { ...x, reading: readingOf(x) }]),
	);
const teamCount = async (p: ChurchPlant) =>
	(await w.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM team WHERE plant_id=${p.id}`)).n;

async function imported(p: ChurchPlant, keys: string[]) {
	const selections = keys.map((teamKey) => ({
		teamKey,
		roleKeys: teamKey === "administration" ? [] : [`${teamKey === "childrens_ministry" ? "childrens" : teamKey}_lead`],
	}));
	return created<{ newSelectedRoles: number }>(p, teamsWriter.initialize, {
		expectedVersion: "2",
		mode: "import",
		selections,
	});
}
async function custom(p: ChurchPlant, team: string, role: string) {
	const made = await created<{ team: { id: string } }>(p, teamsWriter.create, { name: team });
	const slot = await created<{ role: { id: string } }>(p, teamsWriter.createRole, {
		teamId: made.team.id,
		name: role,
	});
	return { teamId: made.team.id, roleId: slot.role.id };
}
const templateRole = async (p: ChurchPlant, key: string) =>
	w.one<{ roleId: string; teamId: string }>(
		sql`SELECT id AS "roleId", team_id AS "teamId" FROM team_role WHERE plant_id=${p.id} AND template_key=${key}`,
	);
async function assign(p: ChurchPlant, slot: { roleId: string; teamId: string }, personId: string) {
	return ok(
		await run<{ tenureId: string }>(p, teamsWriter.assignRole, {
			requestKey: randomUUID(),
			expectedRevision: await revision("team_role", slot.roleId),
			input: { roleId: slot.roleId, teamId: slot.teamId, personId },
		}),
	);
}
async function program(p: ChurchPlant, name: string, teamId: string | null) {
	return (await created<{ program: { id: string } }>(p, trainingWriter.createProgram, { name, required: true, teamId }))
		.program.id;
}
async function roster(p: ChurchPlant, programId: string, personIds: string[]) {
	const seen = ok(await trainingReader.readRequiredTrainingPreview(w.db, p.actor, { programId, personIds })) as {
		revision: string;
		rosterDigest: string;
	};
	return ok(
		await run(p, trainingWriter.setRequiredTrainingParticipants, {
			requestKey: randomUUID(),
			expectedRevision: seen.revision,
			input: { programId, personIds, rosterDigest: seen.rosterDigest },
		}),
	);
}
const attest = (p: ChurchPlant, key: string, value: "yes" | "not_yet", asOf?: string) =>
	signals.attest(w.db, p.actor, {
		requestKey: randomUUID(),
		expectedRevision: "0",
		input: { key, value, ...(asOf ? { asOf } : {}) },
	});
async function publish(p: ChurchPlant) {
	const requestId = randomUUID();
	ok(await assessments.requestRefresh(w.db, p.actor, { requestId }));
	await runAssessmentBatch(job, w.db, scriptedAssessmentDrafter(), 20);
	const run = await w.one<{ id: string; outcome: string }>(
		sql`SELECT id, outcome FROM assessment_run WHERE plant_id=${p.id} AND demand_key=${"manual/" + requestId}`,
	);
	assert.equal(run.outcome, "published");
	const current = ok(await assessments.readAssessment(w.db, p.actor, {})).current!;
	assert.equal(current.runId, run.id);
	return Object.fromEntries(current.lenses.map((l) => [l.key, l]));
}

test("AC:B01-002 AC:B01-018 one person on the worship and technology responsibilities fills two areas as one distinct person", async () => {
	const k2 = K("B01-002");
	const k18 = K("B01-018");
	const p = await w.plant("Two areas church");
	const pat = await w.person(p, "Pat Two Areas");
	await imported(p, ["worship", "technology"]);
	for (const area of arg<string[]>(k18, "area_assignments"))
		await assign(p, await templateRole(p, `${area}_lead`), pat.id);
	const r = await read(p);
	assert.deepEqual(
		[r.coverage.filled, r.coverage.people],
		[k2.expected.result.filled_slots, k2.expected.result.distinct_people],
	);
	assert.deepEqual(
		[r.coverage.filled, r.coverage.people],
		[k18.expected.result.filled_areas, k18.expected.result.distinct_people],
	);
	assert.deepEqual(
		r.coverage.responsibilities.filter((x) => x.people.length).map((x) => [x.key, x.people.map((h) => h.id)]),
		arg<string[]>(k18, "area_assignments").map((area) => [area, [pat.id]]),
	);
	assert.equal((await exit(p, 2)).all_team_leaders!.reading, "2 of 8 ministry responsibilities filled, by 1 person");
});

test("AC:B01-006 only an active worship assignment identifies a worship leader; a team named for worship does not", async () => {
	const k = K("B01-006");
	const p = await w.plant("Worship label church");
	const label = await custom(p, arg<string>(k, "unrelated_team_label"), "Worship lead candidate");
	await assign(p, label, (await w.person(p, "Casey Candidate")).id);
	const named = await read(p);
	assert.deepEqual(named.coverage.responsibilities.find((x) => x.key === "worship")!.people, []);
	assert.equal((await exit(p, 1)).worship_leader!.status === "met", k.expected.result.name_only_qualifies);
	await imported(p, ["worship"]);
	const lead = await w.person(p, "Jordan Worship");
	await assign(p, await templateRole(p, "worship_lead"), lead.id);
	assert.equal(arg<string>(k, "worship_assignment"), "active");
	assert.equal((await exit(p, 1)).worship_leader!.status === "met", k.expected.result.active_assignment_qualifies);
	assert.deepEqual(
		(await read(p)).coverage.responsibilities.find((x) => x.key === "worship")!.people.map((h) => h.id),
		[lead.id],
	);
});

test("AC:B01-016 AC:B01-017 eight required areas with no team imported, Prayer Leader apart, and no automatic Administration/Finance mapping", async () => {
	const k16 = K("B01-016");
	const p = await w.plant("Nothing imported church");
	const bare = await read(p);
	assert.equal(arg<number>(k16, "selected_imports"), 0);
	assert.deepEqual(
		[bare.coverage.slots, bare.coverage.responsibilities.length, bare.coverage.filled],
		[k16.expected.result.required_areas, arg<number>(k16, "methodology_area_count"), 0],
	);
	assert.equal(await teamCount(p), k16.expected.result.created_teams);
	assert.equal((await exit(p, 2)).all_team_leaders!.status, "not_met");

	const k17 = K("B01-017");
	const q = await w.plant("Prayer leader church");
	await imported(q, ["prayer", "administration"]);
	const prayer = await w.person(q, "Morgan Prayer");
	await assign(q, await templateRole(q, "prayer_lead"), prayer.id);
	const finance = await custom(q, "Admin & Finance", "Administration/Finance lead");
	await assign(q, finance, (await w.person(q, "Riley Finance")).id);
	const r = await read(q);
	assert.equal(r.coverage.slots, k17.expected.result.required_areas);
	assert.equal(r.coverage.slots, arg<number>(k17, "required_area_count"));
	assert.deepEqual(
		r.coverage.responsibilities.map((x) => x.key),
		c.MINISTRY_RESPONSIBILITIES.map((x) => x.key),
	);
	assert.equal(
		r.coverage.prayerLeader.length === 1 && r.coverage.prayerLeader[0]!.id === prayer.id,
		k17.expected.result.prayer_leader_separate,
	);
	assert.equal(arg<boolean>(k17, "PrayerLeader"), true);
	const adminFinance = r.coverage.responsibilities.find((x) => x.key === "administration_finance")!;
	assert.deepEqual(adminFinance.people, []);
	assert.equal(arg<null>(k17, "adminfinance_mapping"), k17.expected.result.adminfinance_auto_mapping);
	assert.deepEqual([r.coverage.filled, r.coverage.people], [0, 0]);
});

test("AC:B01-019 the saved roster is the obligation; a person who joins a ministry later is not assigned", async () => {
	const k = K("B01-019");
	const p = await w.plant("Saved roster church");
	const q = await w.plant("Other zone church");
	await w.admin.execute(sql`UPDATE plant SET timezone=${"America/New_York"} WHERE id=${q.id}`);
	const named = await w.person(p, "Pat Assigned");
	const later = await w.person(p, "Quinn Later");
	const programA = await program(p, "programA", null);
	await roster(p, programA, [named.id]);
	const elsewhere = await program(q, "programA", null);
	await roster(q, elsewhere, [(await w.person(q, "Other church person")).id]);
	const team = await custom(p, "Greeters", "Greeter");
	await assign(p, team, later.id);
	const r = await read(p);
	const obligations = (
		await w.rows<{ o: string }>(sql`SELECT g.name AS program, a.person_id AS person, 'P/' || g.name AS o
			FROM training_assignment a JOIN training_program g ON g.id=a.program_id
			WHERE a.plant_id=${p.id} AND a.state='active' ORDER BY g.name`)
	).map((x) => x.o);
	assert.deepEqual(obligations, k.expected.result.obligations);
	assert.deepEqual(
		r.training.programs.map((g) => [g.name, g.total]),
		[["programA", 1]],
	);
	assert.equal(r.training.total, 1);
	const qAssigned =
		(await w.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM training_assignment WHERE person_id=${later.id}`))
			.n > 0;
	assert.equal(arg<string>(k, "unassigned_person"), arg<string>(k, "later_membership_added"));
	assert.equal(qAssigned, k.expected.result.Q_implicitly_assigned);
});

test("AC:B01-020 999 of 1000 required trainings is not complete, though a rounded percent would show 100", async () => {
	const k = K("B01-020");
	const p = await w.plant("Thousand trainees church");
	const team = await custom(p, "Big team", "Member");
	const programId = await program(p, "Launch team basics", team.teamId);
	const version = (await w.one<{ v: number }>(sql`SELECT version AS v FROM training_program WHERE id=${programId}`)).v;
	const applicable = arg<number>(k, "applicable");
	const done = arg<number>(k, "valid_complete");
	await w.admin.execute(sql`WITH made AS (
			INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
				pipeline_position,state,created_at)
			SELECT gen_random_uuid(),${p.id},${p.id},'Trainee '||n,'other','launch_team','adult','unknown',0,'live',clock_timestamp()
			FROM generate_series(1,${applicable}::int) n RETURNING id)
		INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
		SELECT ${p.id},${programId},id,${version},'active',${w.day(-20)} FROM made`);
	await w.admin.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
		SELECT plant_id,person_id,program_id,'earned',version,${w.day(-5)} FROM training_assignment
		WHERE program_id=${programId} ORDER BY person_id LIMIT ${done}::int`);
	await w.admin.execute(sql`ANALYZE person, training_assignment, training_credit`);
	const r = await read(p);
	assert.deepEqual([r.training.complete, r.training.total], [done, applicable]);
	const rate = r.training.complete / r.training.total;
	assert.equal(rate, k.expected.result.actual_rate);
	assert.equal(Math.round(rate * 100), k.expected.result.display_percent);
	assert.equal(arg<number>(k, "display_rounding"), 100);
	assert.equal(r.training.status === "met", k.expected.result.complete);
	const criterion = (await exit(p, 3)).training_complete!;
	assert.deepEqual([criterion.status, criterion.reading], ["not_met", "999 of 1000 required trainings completed"]);
	const staffing = ok(await trainingReader.readStaffingFacts(w.db, p.actor, { teamId: team.teamId }));
	assert.equal(staffing.trainingRate, k.expected.result.actual_rate);
});

test("AC:B01-021 a required program nobody is assigned to is Unknown, and committed adults never fill its denominator", async () => {
	const k = K("B01-021");
	const p = await w.plant("Empty roster church");
	for (let i = 0; i < arg<number>(k, "adult_count"); i++) await w.committed(p, `Adult ${i + 1}`);
	const team = await custom(p, "Program A team", "Member");
	await program(p, arg<string>(k, "required_program"), team.teamId);
	assert.deepEqual(arg<string[]>(k, "assigned_people"), []);
	const r = await read(p);
	assert.equal(r.committedAdults.known, arg<number>(k, "adult_count"));
	assert.deepEqual([r.training.status, r.training.total, r.training.complete], ["unknown", 0, 0]);
	assert.deepEqual(
		r.training.programs.map((g) => [g.name, g.total]),
		[[arg<string>(k, "required_program"), 0]],
	);
	assert.equal(r.training.total === r.committedAdults.known, k.expected.result.adult_count_in_denominator);
	assert.equal((await exit(p, 3)).training_complete!.status, "unknown");
	const staffing = ok(await trainingReader.readStaffingFacts(w.db, p.actor, { teamId: team.teamId }));
	assert.equal(staffing.trainingRate, k.expected.result.coverage);
});

test("AC:B01-033 imported roles nobody fills leave coverage Not met, whatever a leader answer says", async () => {
	const k = K("B01-033");
	const p = await w.plant("Unfilled import church");
	const areas = [
		"worship",
		"childrens_ministry",
		"assimilation",
		"small_groups",
		"facilities",
		"promotion",
		"technology",
	];
	assert.equal((await imported(p, [...areas, "prayer"])).newSelectedRoles, areas.length + 1);
	assert.equal(arg<string>(k, "imported_role"), "unfilled");
	ok(await attest(p, "prayer_leader_assigned", "yes"));
	assert.equal(arg<boolean>(k, "coverage_attestation"), true);
	const r = await read(p);
	assert.equal(r.coverage.filled, k.expected.result.actual_assigned_areas);
	assert.equal(r.criteria.all_team_leaders, k.expected.result.coverage_criterion);
	const row = (await exit(p, 2)).all_team_leaders!;
	assert.deepEqual(
		[row.status, row.reading],
		[k.expected.result.coverage_criterion, "0 of 8 ministry responsibilities filled, by 0 people"],
	);
});

test("AC:B01-009 AC:B01-023 a chosen area or a sending relationship with no dated statement stays Unknown, and a pending request is no proof", async () => {
	const k9 = K("B01-009");
	const p = await w.plant("No area church");
	const area = (await exit(p, 1)).geographic_area!;
	assert.equal(arg<null>(k9, "area_evidence"), null);
	assert.deepEqual([area.status, area.reading, area.evidence], [k9.expected.result.criterion, null, []]);
	assert.equal(arg<null>(k9, "optional_plan"), null);
	assert.equal(k9.expected.result.plan_required, false);

	const k23 = K("B01-023");
	const q = await w.plant("Pending request church", { phase: 0 });
	const networkName = "Requested Network";
	const network = await w.network(networkName);
	const invitation = randomUUID();
	await w.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${invitation},'invitation',${q.id})`);
	await w.admin.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,inviter_id,token_hash,state,
		created_at,inviter_description) VALUES(${invitation},${q.id},'plant_network',${`network-${network.id}@example.test`},${q.owner.id},
		${randomBytes(32).toString("hex")},'pending',clock_timestamp(),${networkName})`);
	assert.deepEqual([arg<boolean>(k23, "org_name_selected"), arg<boolean>(k23, "request_pending")], [true, true]);
	const coach = (await exit(q, 0)).coach_assigned!;
	assert.equal(arg<null>(k23, "real_relationship_attestation"), null);
	assert.deepEqual([coach.status, coach.reading], [k23.expected.result.relationship_criterion, null]);
	assert.equal(coach.status === "met", k23.expected.result.pending_request_is_proof);
});

test("AC:B01-025 a technology owner is not a dry run: systems tested stays Unknown until its own dated answer", async () => {
	const k = K("B01-025");
	const p = await w.plant("Systems owner church");
	await imported(p, ["technology"]);
	await assign(p, await templateRole(p, "technology_lead"), (await w.person(p, "Sam Systems")).id);
	assert.equal(arg<boolean>(k, "systems_owner_assigned"), true);
	assert.equal(arg<null>(k, "actual_dryrun_attestation"), null);
	const systems = ok(await signals.listDefinitions({})).find((d) => d.key === "systems_tested")!;
	assert.deepEqual([systems.reaffirms, systems.windowDays], [false, null]);
	const r = await read(p);
	assert.equal(r.coverage.responsibilities.find((x) => x.key === "technology")!.people.length, 1);
	assert.equal(r.attestations.find((a) => a.key === "systems_tested")!.state, "unanswered");
	const row = (await exit(p, 3)).systems_tested!;
	assert.deepEqual([row.status, row.reading], [k.expected.result.systems_criterion, null]);
	assert.equal(row.status === "met", k.expected.result.assignment_is_dryrun);
});

test("AC:B01-024 AC:B01-027 lens evidence keeps each answer's own status, a retraction keeps its history, and the model records no answer", async () => {
	const k24 = K("B01-024");
	const p = await w.plant("Funding church");
	const funded = ok(await attest(p, "financial_base_established", "yes"));
	assert.equal(funded.signal.reference, arg<null>(k24, "funding_reference"));
	assert.equal(arg<null>(k24, "giving"), null);
	const r = await read(p);
	assert.equal(r.criteria.financial_base, k24.expected.result.funding);
	assert.equal(k24.expected.result.reference_required, false);
	const giving = r.attestations.find((a) => a.key === "core_group_giving")!;
	assert.deepEqual([giving.state, giving.renewal.status], ["unanswered", k24.expected.result.giving]);
	const funding = (await publish(p)).generosity!;
	assert.equal(funding.quality, "attested");
	assert.deepEqual(
		funding.attestations.map((a) => [a.key, a.answered]),
		[
			["core_group_giving", false],
			["financial_base_established", true],
		],
	);

	const k27 = K("B01-027");
	const q = await w.plant("Answers church");
	ok(await attest(q, "financial_base_established", "not_yet"));
	ok(await attest(q, "core_group_giving", "yes", w.day(-35)));
	const answered = ok(await attest(q, "prayer_rhythm_established", "yes", w.day(-3)));
	ok(
		await signals.correct(w.db, q.actor, {
			requestKey: randomUUID(),
			expectedRevision: answered.signal.revision,
			input: { action: "retract", key: "prayer_rhythm_established" },
		}),
	);
	const keys = {
		missing: "prayer_in_gatherings",
		false: "financial_base_established",
		true_aged: "core_group_giving",
		retracted: "prayer_rhythm_established",
	} as const;
	const s = await read(q);
	const of = (key: string) => s.attestations.find((a) => a.key === key)!;
	const statusOf = (key: string) => {
		const a = of(key);
		if (a.state === "retracted") return "retracted";
		if (a.state === "unanswered") return "unknown";
		if (a.renewal.status === "needs_renewing") return "aged";
		return a.value === "yes" ? "met" : "not_met";
	};
	const answers = arg<(keyof typeof keys)[]>(k27, "answers");
	assert.deepEqual(
		answers.map((x) => statusOf(keys[x])),
		k27.expected.result.statuses,
	);
	assert.deepEqual([of(keys.true_aged).value, of(keys.true_aged).asOf], ["yes", w.day(-35)]);
	assert.equal(s.criteria.financial_base, "not_met");
	const history = ok(await signals.getHistory(w.db, q.actor, { key: keys.retracted })).revisions;
	assert.deepEqual(
		history.map((h) => [h.kind, h.asOf]),
		[
			["retracted", w.day(0)],
			["answered", w.day(-3)],
		],
	);
	const stored = () =>
		w.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM attestation_revision WHERE plant_id=${q.id}`);
	const before = await stored();
	const tiles = await publish(q);
	assert.deepEqual(await stored(), before, "the model run records no answer");
	assert.equal(arg<string>(k27, "model_testimony"), "refused");
	assert.equal(k27.expected.result.model_testimony_allowed, false);
	assert.deepEqual(
		tiles.prayer!.attestations.map((a) => [a.key, a.answered]),
		[
			["prayer_rhythm_established", false],
			["prayer_in_gatherings", false],
		],
	);
	assert.deepEqual([tiles.prayer!.quality, tiles.prayer!.standing], ["unknown", "insufficient"]);
	assert.deepEqual(
		tiles.generosity!.attestations.map((a) => [a.key, a.answered, a.asOf, a.needsRenewing]),
		[
			["core_group_giving", true, w.day(-35), true],
			["financial_base_established", true, w.day(0), false],
		],
	);
	refused(
		await signals.attest(w.db, q.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { key: "worship_agreement", value: "yes" },
		}),
		"invalid_input",
	);
});
