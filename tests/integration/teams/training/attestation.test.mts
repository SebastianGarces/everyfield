import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { instant, tenantId } from "../../../../packages/contracts/src/common/index.ts";
import { RequestActor, type WriteTx } from "../../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	createAssessments,
	createFacts,
	createSignals,
	runAssessmentBatch,
} from "../../../../packages/domain/src/intelligence/index.ts";
import { attendanceReader } from "../../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { getPlant } from "../../../../packages/domain/src/oversight/index.ts";
import { interviews, withPeopleWrite } from "../../../../packages/domain/src/people/index.ts";
import {
	teamsReader,
	teamsWriter,
	trainingReader,
	trainingWriter,
} from "../../../../packages/domain/src/teams/index.ts";
import { scriptedAssessmentDrafter } from "../../../../packages/evry-scripted/src/scripted-assessment.ts";
import { sql } from "../../../../packages/db/src/query.ts";
import { ok, refused, type Actor } from "../../../support/fixture.mts";
import { failingWrite, recorded } from "../../../support/recorded.mts";
import { CANARY, church, type Church, type ChurchPlant } from "../../intelligence/assessment-church.mts";

const NOW = "2026-10-13T16:00:00.000Z";
const clock = { now: () => instant.parse(NOW) };
const signals = createSignals({ clock });
const factsOf = createFacts();
const key = () => randomUUID();
const NOTHING = { audits: [], jobs: [], notices: 0, mail: 0 };
const audited = (...audits: string[]) => ({ ...NOTHING, audits });

let c: Church;
let p: ChurchPlant;
before(async () => {
	c = await church("attestation", { clock: new Date(NOW) });
	await c.release("r1");
	p = await c.plant("Harbor Plant");
	await c.admin.execute(sql`UPDATE person SET display_name='Harbor Planter' WHERE linked_account_id=${p.owner.id}`);
});
after(() => c?.database.close());

type Who = { actor: RequestActor; session: Actor["session"]; id: string };
const at = (w: { id: string }, session: Actor["session"]) => ({
	session,
	selected: { kind: "plant" as const, id: tenantId.parse(w.id) },
});
const run = <V,>(
	op: (t: WriteTx, ctx: ReturnType<typeof at>, input: unknown) => Promise<V>,
	input: unknown,
	w: ChurchPlant = p,
	session: Actor["session"] = w.owner.session,
) => gatedTransaction(c.db, (t) => op(t, at(w, session), input));
const rev = async (table: string, id: string) =>
	(await c.one<{ r: string }>(sql`SELECT revision::text AS r FROM ${sql.identifier(table)} WHERE id=${id}`)).r;
const page = async (w: ChurchPlant = p) => ok(await signals.readAttestations(c.db, w.actor, {}));
type Candidate = Partial<{
	periodStart: string;
	periodEnd: string;
	attended: boolean;
	volunteered: boolean;
	statement: string;
}>;
const span = { periodStart: "2026-08-15", periodEnd: "2026-10-13", attended: true, volunteered: true };
const attest = (personId: string, fields: Candidate = {}, w: ChurchPlant = p, actor = w.actor) =>
	signals.attestCandidate(c.db, actor, {
		requestKey: key(),
		expectedRevision: "0",
		input: { personId, ...span, ...fields },
	});
const correct = (personId: string, expectedRevision: string, fields: Candidate = {}) =>
	signals.correctCandidate(c.db, p.actor, {
		requestKey: key(),
		expectedRevision,
		input: { action: "correct", personId, ...span, ...fields },
	});
const pattern = async (personId: string, w: ChurchPlant = p) => {
	const found = (await page(w)).candidates.find((x) => x.personId === personId);
	return found ? found.established : null;
};
const trail = async (personId: string) =>
	(await page()).history.filter((h) => h.personId === personId && h.key === "leadership_candidate");
const seated = async (
	w: Parameters<Church["database"]["actor"]>[0],
	role: "owner" | "admin" | "member",
): Promise<Who> => {
	const account = await c.database.actor(w, role);
	const actor = await RequestActor.resolve(c.db, account.session);
	assert.ok(actor instanceof RequestActor);
	return { actor, session: account.session, id: account.id };
};
const EFFECTS = [
	"seat",
	"person",
	"team",
	"team_role",
	"team_tenure",
	"phase_transition",
	"commitment",
	"task",
	"job",
	"notice",
	"mail",
	"interview",
	"four_cs",
	"private_week",
];
async function effects() {
	const read = EFFECTS.map(
		(t) => `(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]') FROM ${t} x) AS ${t}`,
	);
	const tables = await c.one(sql.raw(`SELECT ${read.join(",")}`));
	return { tables, plant: await c.rows(sql`SELECT id, phase FROM plant ORDER BY id`) };
}
async function unmoved<V>(body: () => Promise<V>) {
	const before = await effects();
	const made = await recorded(c.admin, body);
	assert.deepEqual(await effects(), before);
	return made;
}
async function serving(name: string, personId: string, w: ChurchPlant = p) {
	const team = ok(await run(teamsWriter.create, { requestKey: key(), input: { name } }, w)).team.id;
	const role = ok(
		await run(teamsWriter.createRole, { requestKey: key(), input: { teamId: team, name: name + " role" } }, w),
	).role.id;
	ok(
		await run(
			teamsWriter.assignRole,
			{
				requestKey: key(),
				expectedRevision: await rev("team_role", role),
				input: { roleId: role, teamId: team, personId },
			},
			w,
		),
	);
	return team;
}

test("AC:TARGET-TEAM-017 AC:SME53-007 60 days of both behaviors invite a conversation; 59 days, one behavior, no dates or a corrected contradiction do not", async () => {
	const alex = await c.person(p, "Alex Days");
	const casey = await c.person(p, "Casey Days");
	const controls = [
		[alex.id, 60, 60, true],
		[casey.id, 60, 59, false],
		[casey.id, 59, 60, false],
		[casey.id, 59, 59, false],
		[casey.id, 60, 0, false],
		[casey.id, 0, 60, false],
	] as const;
	for (const [personId, attendanceDays, volunteerDays, candidate] of controls) {
		const made = await unmoved(() =>
			run(trainingWriter.attestCompletion, {
				requestKey: key(),
				input: { kind: "service", personId, attendanceDays, volunteerDays },
			}),
		);
		assert.deepEqual([ok(made.value).candidate, made.added], [candidate, audited("training.completed")]);
	}
	const kept = ok(await trainingReader.readTrainingHistory(c.db, p.actor, { personId: casey.id })).credits;
	assert.deepEqual(
		kept.map((r) => [r.kind, r.attendanceDays, r.volunteerDays, r.verifierAccountId]),
		controls.filter(([id]) => id === casey.id).map(([, a, v]) => ["service", a, v, p.owner.id]),
	);

	const tenured = await c.person(p, "Pat Tenure");
	await c.admin.execute(sql`UPDATE person SET created_at='2026-07-15T16:00:00Z' WHERE id=${tenured.id}`);
	await serving("Tenure team", tenured.id);
	assert.equal(await pattern(tenured.id), null, "90 days on record and a role are no dated evidence");
	assert.deepEqual(ok(await trainingReader.readTrainingHistory(c.db, p.actor, { personId: tenured.id })).credits, []);

	const established: (boolean | null)[] = [];
	const rows: [string, Candidate, boolean, string[]][] = [
		["Quinn Short", { periodStart: "2026-08-16" }, false, ["period_too_short"]],
		["Riley Sixty", { statement: "I saw Riley serve every week." }, true, []],
		["Sam Attends", { volunteered: false }, false, ["volunteering_not_attested"]],
		["Sky Serves", { attended: false }, false, ["attendance_not_attested"]],
	];
	for (const [name, fields, expected, reasons] of rows) {
		const who = await c.person(p, name);
		const made = await unmoved(() => attest(who.id, fields));
		const saved = ok(made.value).candidate;
		assert.deepEqual(
			[saved.established, saved.reasons, made.added],
			[expected, reasons, audited("attestation.recorded")],
			name,
		);
		established.push(await pattern(who.id));
	}
	assert.deepEqual(established, [false, true, false, false]);
	const riley = (await page()).candidates.find((x) => x.personName === "Riley Sixty")!;
	assert.deepEqual([riley.days, riley.periodStart, riley.periodEnd], [60, "2026-08-15", "2026-10-13"]);

	const fixed = await unmoved(() => correct(riley.personId, riley.revision, { volunteered: false }));
	assert.deepEqual([ok(fixed.value).candidate.established, fixed.added], [false, audited("attestation.corrected")]);
	assert.deepEqual(
		(await trail(riley.personId)).map((h) => [
			h.revision,
			h.kind,
			h.attended,
			h.volunteered,
			h.periodStart,
			h.periodEnd,
		]),
		[
			[2, "corrected", true, false, "2026-08-15", "2026-10-13"],
			[1, "answered", true, true, "2026-08-15", "2026-10-13"],
		],
		"both sides of the contradiction stay in view",
	);
	for (const fields of [{ periodEnd: "2026-10-14" }, { periodStart: "2026-10-13", periodEnd: "2026-08-15" }]) {
		const made = await unmoved(() => attest(alex.id, fields));
		refused(made.value, "invalid_input");
		assert.deepEqual(made.added, NOTHING);
	}
	const rubric = readFileSync(new URL("../../../../docs/reference/rubric-v1.md", import.meta.url), "utf8");
	assert.match(
		rubric.replaceAll(/\s+/g, " "),
		/Leadership Candidate Signal: 60 days\*\* of unbroken attendance and volunteering/,
	);
});

test("AC:SME53-005 a dated human attestation keeps its person, period, both behaviors, question version, author and corrections, and adds no private or eighth signal", async () => {
	const w = await c.plant("Attested Plant");
	const planter = await c.person(w, "Dana Planter");
	await c.admin.execute(sql`UPDATE person SET linked_account_id=NULL WHERE linked_account_id=${w.owner.id}`);
	await c.admin.execute(sql`UPDATE person SET linked_account_id=${w.owner.id} WHERE id=${planter.id}`);
	const alex = await c.person(w, "Alex Attested");
	const signalsBefore = (await page(w)).signals;
	const measured = ok(await factsOf.readFacts(c.db, w.actor, {}));
	const input = {
		requestKey: key(),
		expectedRevision: "0",
		input: {
			personId: alex.id,
			periodStart: "2026-08-14",
			periodEnd: "2026-10-13",
			attended: true,
			volunteered: true,
			statement: "I watched every week.",
		},
	};
	const made = await unmoved(() => signals.attestCandidate(c.db, w.actor, input));
	assert.deepEqual(made.added, audited("attestation.recorded"));
	const again = await unmoved(() => signals.attestCandidate(c.db, w.actor, input));
	assert.deepEqual([again.added, ok(again.value)], [NOTHING, ok(made.value)]);
	const shown = await page(w);
	assert.deepEqual(shown.candidates, [
		{
			personId: alex.id,
			personName: "Alex Attested",
			personState: "live",
			state: "answered",
			attended: true,
			volunteered: true,
			periodStart: "2026-08-14",
			periodEnd: "2026-10-13",
			days: 61,
			established: true,
			reasons: [],
			asOf: "2026-10-13",
			statement: "I watched every week.",
			authorName: "Dana Planter",
			recordedAt: NOW,
			revision: "1",
		},
	]);
	const [entry] = shown.history;
	assert.deepEqual(
		[shown.history.length, entry!.key, entry!.kind, entry!.questionVersion, entry!.personId, entry!.authorName],
		[1, "leadership_candidate", "answered", "leadership-candidate/1", alex.id, "Dana Planter"],
	);
	assert.deepEqual(
		[entry!.attended, entry!.volunteered, entry!.periodStart, entry!.periodEnd],
		[true, true, "2026-08-14", "2026-10-13"],
	);
	assert.deepEqual(
		await c.rows(sql`SELECT actor_id, kind FROM audit_event WHERE action='attestation.recorded' AND tenant_id=${w.id}`),
		[{ actor_id: w.owner.id, kind: "create" }],
	);
	assert.deepEqual(shown.signals, signalsBefore);
	assert.deepEqual(
		ok(await signals.listDefinitions({})).map((d) => d.key),
		[
			"values_documented",
			"financial_base_established",
			"core_group_giving",
			"prayer_leader_assigned",
			"prayer_rhythm_established",
			"prayer_in_gatherings",
			"systems_tested",
		],
	);
	const eighth = await unmoved(() =>
		signals.attest(c.db, w.actor, {
			requestKey: key(),
			expectedRevision: "0",
			input: { key: "leadership_candidate", value: "yes" },
		}),
	);
	refused(eighth.value, "invalid_input");
	const now = ok(await factsOf.readFacts(c.db, w.actor, {}));
	assert.deepEqual(
		[now.attestations, now.criteria, now.sourceRevision],
		[measured.attestations, measured.criteria, measured.sourceRevision],
	);
	assert.equal((await c.one(sql`SELECT count(*)::int AS n FROM private_week_revision`)).n, 0);
	const member = await seated(w, "member");
	const other = await c.plant("Attested Elsewhere");
	for (const actor of [member.actor, other.actor]) {
		const tried = await unmoved(() => attest(alex.id, {}, w, actor));
		refused(tried.value, actor === member.actor ? "access_denied" : "not_found");
		assert.deepEqual(tried.added, NOTHING);
	}
	refused(await signals.readAttestations(c.db, member.actor, {}), "access_denied");
	assert.deepEqual((await page(other)).candidates, []);
});

test("AC:SME53-006 time on record, lifetime attendance and a role establish nothing, missing observations disprove nothing, and a corrected contradiction stays in view", async () => {
	const w = await c.plant("Evidence Plant");
	const alex = await c.person(w, "Alex Tenure");
	const quinn = await c.person(w, "Quinn Observed");
	await c.admin.execute(sql`UPDATE person SET created_at='2026-07-01T16:00:00Z' WHERE id IN (${alex.id},${quinn.id})`);
	await serving("Worship", alex.id, w);
	const meetings: string[] = [];
	for (let n = 1; n <= 40; n++) meetings.push(await c.vision(w, n, n % 10 === 0 ? [alex, quinn] : [alex]));
	const listed = ok(await attendanceReader.listAttendance(c.db, w.actor, { meetingId: meetings[0]! }));
	assert.deepEqual(
		listed.items.map((a) => [a.person.displayName, a.presence]),
		[["Alex Tenure", "attended"]],
	);
	const unknown = await unmoved(() => page(w));
	assert.deepEqual([unknown.value.candidates, unknown.value.history, unknown.added], [[], [], NOTHING]);
	assert.deepEqual(
		unknown.value.people.find((x) => x.id === alex.id)?.candidateRevision,
		"0",
		"the person can be attested and has not been",
	);
	const assessments = createAssessments({ clock });
	const drafter = scriptedAssessmentDrafter();
	const assess = async () => {
		ok(await assessments.requestRefresh(c.db, w.actor, { requestId: key() }));
		await runAssessmentBatch(createAssessmentJob({ clock }), c.db, drafter, 5);
		assert.ok(ok(await assessments.readAssessment(c.db, w.actor, {})).current);
		return JSON.stringify(drafter.calls);
	};
	const told = await assess();
	assert.ok(drafter.calls.length > 0);
	for (const word of ["Alex Tenure", "Quinn Observed", alex.id, quinn.id, "candidate"])
		assert.equal(told.includes(word), false, word);

	const made = ok(await attest(quinn.id, { statement: "Serves unseen every week." }, w)).candidate;
	assert.deepEqual(
		[made.established, await pattern(quinn.id, w)],
		[true, true],
		"four seen meetings do not disprove it",
	);
	assert.equal(await pattern(alex.id, w), null, "another person's dated evidence lends nothing");
	const edit = async (revision: string, fields: Candidate) =>
		ok(
			await signals.correctCandidate(c.db, w.actor, {
				requestKey: key(),
				expectedRevision: revision,
				input: { action: "correct", personId: quinn.id, ...span, ...fields },
			}),
		).candidate;
	const contradicted = await edit(made.revision, { attended: false });
	assert.deepEqual([contradicted.established, contradicted.reasons], [false, ["attendance_not_attested"]]);
	const settled = await edit(contradicted.revision, { statement: "Checked again with the team." });
	assert.equal(settled.established, true);
	const lines = (await page(w)).history.map((h) => [h.revision, h.kind, h.attended, h.volunteered, h.detail]);
	assert.deepEqual(lines, [
		[3, "corrected", true, true, "Checked again with the team."],
		[2, "corrected", false, true, null],
		[1, "answered", true, true, "Serves unseen every week."],
	]);
	drafter.calls.splice(0);
	const after = await assess();
	assert.ok(drafter.calls.length > 0);
	for (const word of ["Quinn Observed", quinn.id, "Serves unseen", "Checked again", "candidate"])
		assert.equal(after.includes(word), false, word);
});

test("AC:SME53-008 an established pattern is only worth a leadership conversation: no interview, 4 C's, stage, role, seat or phase follows", async () => {
	const w = await c.plant("Conversation Plant");
	const alex = await c.person(w, "Alex Ready");
	const stage = () => c.one(sql`SELECT stage, revision::text AS revision FROM person WHERE id=${alex.id}`);
	const before = await stage();
	const readiness = async () => {
		const f = ok(await factsOf.readFacts(c.db, w.actor, {}));
		return [f.humanRecords, f.criteria, f.coverage];
	};
	const measured = await readiness();
	const made = await unmoved(() => attest(alex.id, {}, w));
	assert.deepEqual([ok(made.value).candidate.established, made.added], [true, audited("attestation.recorded")]);
	const service = await unmoved(() =>
		run(
			trainingWriter.attestCompletion,
			{ requestKey: key(), input: { kind: "service", personId: alex.id, attendanceDays: 60, volunteerDays: 60 } },
			w,
		),
	);
	assert.deepEqual([ok(service.value).candidate, service.added], [true, audited("training.completed")]);
	assert.deepEqual(await stage(), before);
	assert.equal((await c.one(sql`SELECT phase FROM plant WHERE id=${w.id}`)).phase, 1);
	assert.deepEqual(await readiness(), measured);
	assert.deepEqual(measured[0], { interviews: { count: 0, latestOn: null }, fourCs: { count: 0, latestOn: null } });
	const shown = (await page(w)).candidates[0]!;
	assert.deepEqual(
		[shown.established, shown.reasons],
		[true, []],
		"a missing interview or 4 C's is no mark against the person",
	);
	const people = ok(await teamsReader.listPersonAssignments(c.db, w.actor, { personId: alex.id })).assignments;
	assert.deepEqual(people, []);
	const assessments = createAssessments({ clock });
	ok(await assessments.requestRefresh(c.db, w.actor, { requestId: key() }));
	await runAssessmentBatch(createAssessmentJob({ clock }), c.db, scriptedAssessmentDrafter(), 5);
	const runRow = await c.one<{ rubric_version: string; rubric_sha256: string }>(
		sql`SELECT rubric_version, rubric_sha256 FROM assessment_run WHERE plant_id=${w.id}`,
	);
	const rubric = readFileSync(new URL("../../../../docs/reference/rubric-v1.md", import.meta.url));
	assert.deepEqual(runRow, {
		rubric_version: "v1",
		rubric_sha256: createHash("sha256").update(rubric).digest("hex"),
	});
	assert.match(rubric.toString().replaceAll(/\s+/g, " "), /and "worth a leadership conversation"/);
	assert.equal((await c.one(sql`SELECT phase FROM plant WHERE id=${w.id}`)).phase, 1);
	assert.deepEqual(await stage(), before);
	const pass = { rating: "pass", notes: null };
	const interviewed = await withPeopleWrite(c.db, w.actor, (t, ctx) =>
		interviews.createInterview(t, ctx, {
			requestKey: key(),
			input: {
				personId: alex.id,
				occurredOn: "2026-10-12",
				maturity: pass,
				gifted: pass,
				chemistry: pass,
				rightReasons: pass,
				season: pass,
				result: "qualified",
				nextSteps: null,
			},
		}),
	);
	ok(interviewed);
	const [records, ...rest] = await readiness();
	assert.deepEqual(
		[records, rest],
		[{ interviews: { count: 1, latestOn: "2026-10-12" }, fourCs: { count: 0, latestOn: null } }, measured.slice(1)],
		"a human interview is counted as recorded and decides nothing",
	);
	assert.equal((await stage()).stage, "interviewed", "only the human interview moved the stage");
	const gone = await seated(w, "member");
	refused((await unmoved(() => attest(alex.id, {}, w, gone.actor))).value, "access_denied");
});

test("AC:SME53-009 a stale attestation, a lost seat and an organization get nothing, and the planter's check-in is in none of the evidence", async () => {
	const org = await c.network("Attesting Network");
	const w = await c.plant("Shared Plant", { network: org });
	await c.admin.execute(sql`UPDATE affiliation SET share_people=true,share_meetings=true,share_tasks=true,
		share_ministry_teams=true WHERE id=${w.affiliation}`);
	const alex = await c.person(w, "Alex Shared");
	const team = await serving("Shared team", alex.id, w);
	await c.checkIn(w);
	const note = `${CANARY}-care`;
	assert.equal((await c.one(sql`SELECT note FROM private_week WHERE author_id=${w.owner.id}`)).note, note);
	const course = ok(
		await run(
			trainingWriter.createProgram,
			{ requestKey: key(), input: { name: "Shared course", required: true, teamId: team } },
			w,
		),
	).program;
	const seen = ok(
		await trainingReader.readRequiredTrainingPreview(c.db, w.actor, { programId: course.id, personIds: [alex.id] }),
	);
	const admin = await seated(w, "admin");
	const roster = {
		requestKey: key(),
		expectedRevision: seen.revision,
		input: { programId: course.id, personIds: [alex.id], rosterDigest: seen.rosterDigest },
	};
	const credit = async () => ({
		requestKey: key(),
		expectedRevision: await rev("training_program", course.id),
		input: { kind: "program", personId: alex.id, programId: course.id, earnedOn: "2026-10-01" },
	});
	const testimony = { ...(await credit()), input: { ...(await credit()).input, testimony: "the model thinks so" } };
	const saved = await recorded(c.admin, () =>
		run(trainingWriter.setRequiredTrainingParticipants, roster, w, admin.session),
	);
	assert.deepEqual([ok(saved.value).personIds, saved.added], [[alex.id], audited("training.assigned")]);
	const old = await credit();
	old.expectedRevision = "1";
	const firstSeat = await credit();
	for (const [request, code] of [
		[testimony, "invalid_input"],
		[old, "conflict"],
	] as const) {
		const tried = await unmoved(() => run(trainingWriter.attestCompletion, request, w, admin.session));
		refused(tried.value, code);
		assert.deepEqual(tried.added, NOTHING);
	}
	const established = ok(await attest(alex.id, { statement: "Seen weekly." }, w, admin.actor)).candidate;
	const retry = await unmoved(() => attest(alex.id, {}, w, admin.actor));
	refused(retry.value, "revision_conflict");
	assert.deepEqual(retry.added, NOTHING);
	await c.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${admin.id}`);
	for (const tried of [
		await unmoved(() => run(trainingWriter.attestCompletion, firstSeat, w, admin.session)),
		await unmoved(() => attest(alex.id, {}, w, admin.actor)),
	]) {
		assert.equal((tried.value as { status: string }).status, "refused");
		assert.deepEqual(tried.added, NOTHING);
	}
	const done = await recorded(c.admin, () => run(trainingWriter.attestCompletion, firstSeat, w));
	assert.deepEqual([ok(done.value).verifierAccountId, done.added], [w.owner.id, audited("training.completed")]);

	const director = await RequestActor.resolve(c.db, org.director.session);
	assert.ok(director instanceof RequestActor);
	for (const [read, code] of [
		[() => signals.readAttestations(c.db, director, {}), "access_denied"],
		[() => signals.getHistory(c.db, director, { key: null }), "access_denied"],
		[() => trainingReader.readTrainingMatrix(c.db, director, {}), "unavailable"],
		[() => trainingReader.readTrainingHistory(c.db, director, { personId: alex.id }), "unavailable"],
		[() => trainingReader.readPersonTraining(c.db, director, { personId: alex.id }), "unavailable"],
	] as const) {
		const error = refused(await read(), code);
		assert.equal(JSON.stringify(error).includes("Alex Shared"), false);
	}
	const organization = await getPlant(c.db, director, w.id);
	const shared = JSON.stringify(organization);
	assert.ok(shared.includes("Shared Plant"));
	for (const word of ["Alex Shared", alex.id, "Seen weekly", "candidate", "Shared course", note])
		assert.equal(shared.includes(word), false, word);

	const drafter = scriptedAssessmentDrafter();
	ok(await createAssessments({ clock }).requestRefresh(c.db, w.actor, { requestId: key() }));
	await runAssessmentBatch(createAssessmentJob({ clock }), c.db, drafter, 5);
	assert.ok(drafter.calls.length > 0);
	const owned = JSON.stringify([
		await page(w),
		ok(await trainingReader.readTrainingMatrix(c.db, w.actor, {})),
		ok(await trainingReader.readTrainingHistory(c.db, w.actor, { personId: alex.id })),
		ok(await factsOf.readFacts(c.db, w.actor, {})),
		drafter.calls,
		await c.rows(
			sql`SELECT before_value, after_value, metadata, reason, result FROM audit_event WHERE tenant_id=${w.id}`,
		),
	]);
	assert.ok(owned.includes("Seen weekly.") && owned.includes(established.personId));
	assert.equal(owned.includes(CANARY), false);
	assert.equal(owned.includes("struggling"), false);
});

test("AC:SME53-003 AC:SME53-004 one list and one set of credits answer every training read, an earlier assessment keeps its own, and a failed or stale change keeps the whole list", async () => {
	const w = await c.plant("Projection Plant", { phase: 3 });
	const adults = [];
	for (let n = 1; n <= 12; n++) adults.push(await c.committed(w, `Adult ${n}`, 60));
	await c.vision(w, 5, adults.slice(0, 8));
	const alex = await c.person(w, "Alex Projection");
	const casey = await c.person(w, "Casey Projection");
	const team = await serving("Projection team", alex.id, w);
	const second = ok(
		await run(teamsWriter.createRole, { requestKey: key(), input: { teamId: team, name: "Second" } }, w),
	).role.id;
	ok(
		await run(
			teamsWriter.assignRole,
			{
				requestKey: key(),
				expectedRevision: await rev("team_role", second),
				input: { roleId: second, teamId: team, personId: casey.id },
			},
			w,
		),
	);
	const course = ok(
		await run(
			trainingWriter.createProgram,
			{ requestKey: key(), input: { name: "Projection course", required: true, teamId: team } },
			w,
		),
	).program;
	const change = async (personIds: string[]) => {
		const seen = ok(
			await trainingReader.readRequiredTrainingPreview(c.db, w.actor, { programId: course.id, personIds }),
		);
		return {
			requestKey: key(),
			expectedRevision: seen.revision,
			input: { programId: course.id, personIds, rosterDigest: seen.rosterDigest },
		};
	};
	const save = (request: unknown) => run(trainingWriter.setRequiredTrainingParticipants, request, w);
	const credit = async (
		op: "attestCompletion" | "revokeCompletion" | "recompleteTraining",
		personId: string,
		extra: object,
	) =>
		run(
			trainingWriter[op],
			{
				requestKey: key(),
				expectedRevision: await rev("training_program", course.id),
				input: { personId, programId: course.id, ...extra },
			},
			w,
		);
	const everywhere = async () => {
		const matrix = ok(await trainingReader.readTrainingMatrix(c.db, w.actor, { teamId: team })).programs.find(
			(x) => x.id === course.id,
		)!;
		const required = ok(await trainingReader.readRequiredTrainingParticipants(c.db, w.actor, { programId: course.id }));
		const health = ok(await trainingReader.readHealth(c.db, w.actor, { teamId: team }));
		const facts = ok(await factsOf.readFacts(c.db, w.actor, {}));
		const person = async (id: string) =>
			ok(await trainingReader.readPersonTraining(c.db, w.actor, { personId: id })).currentTrainingComplete;
		assert.deepEqual(health.weights, [40, 35, 25]);
		return {
			matrix: matrix.people.map((x) => [x.name, x.complete]),
			required: [required.complete, required.total],
			health: health.trainingRate,
			lens: [facts.training.status, facts.training.complete, facts.training.total],
			guidance: facts.criteria.training_complete,
			persons: [await person(alex.id), await person(casey.id)],
		};
	};
	const past = async () =>
		ok(await trainingReader.readAssignmentHistory(c.db, w.actor, { teamId: team })).assignments.map((a) => [
			a.personName,
			a.assignedOn,
			a.endedOn,
		]);
	ok(await save(await change([alex.id, casey.id])));
	ok(await credit("attestCompletion", alex.id, { kind: "program", earnedOn: "2026-10-01" }));
	const half = {
		matrix: [
			["Alex Projection", true],
			["Casey Projection", false],
		],
		required: [1, 2],
		health: 0.5,
		lens: ["not_met", 1, 2],
		guidance: "not_met",
		persons: [true, false],
	};
	assert.deepEqual(await everywhere(), half);
	ok(await createAssessments({ clock }).requestRefresh(c.db, w.actor, { requestId: key() }));
	await runAssessmentBatch(createAssessmentJob({ clock }), c.db, scriptedAssessmentDrafter(), 5);
	const assessed = () =>
		c.rows<{ training: unknown; source_revision: string }>(
			sql`SELECT facts->'training' AS training, source_revision FROM assessment_run WHERE plant_id=${w.id}`,
		);
	const recordedThen = await assessed();
	assert.deepEqual((recordedThen[0]!.training as { complete: number; total: number }).total, 2);
	const outOfDate = async () => ok(await factsOf.readFactsSinceRun(c.db, w.actor, {})).outOfDateRunId;
	assert.equal(await outOfDate(), null);

	ok(
		await run(
			teamsWriter.endMembership,
			{ requestKey: key(), expectedRevision: await rev("team", team), input: { teamId: team, personId: casey.id } },
			w,
		),
	);
	assert.deepEqual(await everywhere(), half, "leaving the ministry keeps the saved list");

	const stale = await change([alex.id]);
	const removeCasey = await change([alex.id]);
	for (const on of ["training_assignment", "plant"]) {
		const failed = await failingWrite(c.admin, { on, event: "UPDATE" }, () => unmoved(() => save(removeCasey)));
		refused(failed.value, "required_write_failed");
		assert.deepEqual([failed.added, await everywhere(), await past()], [NOTHING, half, []]);
	}
	const removed = await recorded(c.admin, () => save(removeCasey));
	assert.deepEqual([ok(removed.value).personIds, removed.added], [[alex.id], audited("training.assignment_removed")]);
	const repeat = await recorded(c.admin, () => save(removeCasey));
	assert.deepEqual([ok(repeat.value), repeat.added], [ok(removed.value), NOTHING]);
	const reviewed = await recorded(c.admin, () => save(stale));
	refused(reviewed.value, "conflict");
	assert.deepEqual(reviewed.added, NOTHING);
	const alone = {
		matrix: [["Alex Projection", true]],
		required: [1, 1],
		health: 1,
		lens: ["met", 1, 1],
		guidance: "met",
		persons: [true, false],
	};
	assert.deepEqual(await everywhere(), alone);
	assert.deepEqual(await past(), [["Casey Projection", "2026-10-13", "2026-10-13"]]);
	assert.notEqual(await outOfDate(), null);
	assert.deepEqual(await assessed(), recordedThen, "the earlier assessment keeps the list it was made from");

	ok(await save(await change([alex.id, casey.id])));
	assert.deepEqual(await everywhere(), half);
	assert.deepEqual(await past(), [["Casey Projection", "2026-10-13", "2026-10-13"]]);
	assert.deepEqual(
		await c.rows(sql`SELECT state, count(*)::int AS n FROM training_assignment WHERE program_id=${course.id}
			GROUP BY state ORDER BY state`),
		[
			{ state: "active", n: 2 },
			{ state: "removed", n: 1 },
		],
	);
	ok(await credit("revokeCompletion", alex.id, {}));
	assert.deepEqual((await everywhere()).lens, ["not_met", 0, 2]);
	ok(await credit("recompleteTraining", alex.id, { earnedOn: "2026-10-13" }));
	assert.deepEqual(await everywhere(), half);
	ok(await save(await change([casey.id])));
	const history = ok(await trainingReader.readTrainingHistory(c.db, w.actor, { personId: alex.id })).credits;
	assert.deepEqual(
		history.map((x) => [x.kind, x.earnedOn]),
		[
			["earned", "2026-10-01"],
			["revoked", null],
			["earned", "2026-10-13"],
		],
	);
	const formerly = ok(await trainingReader.readPersonTraining(c.db, w.actor, { personId: alex.id }));
	assert.deepEqual([formerly.earnedHistoryRetained, formerly.currentTrainingComplete], [true, false]);
	assert.deepEqual((await everywhere()).lens, ["not_met", 0, 1]);
	ok(await save(await change([])));
	assert.deepEqual(await everywhere(), {
		matrix: [],
		required: [0, 0],
		health: null,
		lens: ["unknown", 0, 0],
		guidance: "unknown",
		persons: [false, false],
	});
	assert.deepEqual(await assessed(), recordedThen);
});
