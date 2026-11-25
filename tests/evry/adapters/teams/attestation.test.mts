import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
	LanguageModelV4,
	LanguageModelV4StreamPart,
} from "../../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import { instant } from "../../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../../packages/db/src/query.ts";
import { RequestActor, type WriteTx } from "../../../../packages/domain/src/access/session.ts";
import { createSignals } from "../../../../packages/domain/src/intelligence/index.ts";
import {
	teamsWriter,
	trainingReader,
	trainingWriter,
	withTeamsWrite,
} from "../../../../packages/domain/src/teams/index.ts";
import {
	approveProposal,
	evryActor,
	EvryRefusal,
	readReview,
	type Proposal,
} from "../../../../packages/evry/src/index.ts";
import { PASTORAL_BOUNDARY } from "../../../../packages/evry/src/context/compile.ts";
import { scriptedModel } from "../../../../packages/evry-scripted/src/index.ts";
import { ok } from "../../../support/fixture.mts";
import { recorded } from "../../../support/recorded.mts";
import { CANARY, church, type Church, type ChurchPlant } from "../../../integration/intelligence/assessment-church.mts";
import { harness } from "../../evals/intelligence-harness.mts";

const NOW = "2026-10-13T16:00:00.000Z";
const CARE = `${CANARY}-care`;
const signals = createSignals({ clock: { now: () => instant.parse(NOW) } });
const key = () => randomUUID();
const ids = { team: "", course: "", alex: "", casey: "" };
const prompts: string[] = [];
let c: Church;
let w: ChurchPlant;
let org: Awaited<ReturnType<Church["network"]>>;

type Call = { tool: string; operation: string; input: object };
const calling = (calls: Call[]): LanguageModelV4 => {
	const usage = {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	};
	let asked = false;
	return {
		...scriptedModel(),
		async doStream(options) {
			prompts.push(JSON.stringify([options.prompt, options.tools]));
			const parts: LanguageModelV4StreamPart[] = asked
				? [
						{ type: "text-start", id: "t" },
						{ type: "text-delta", id: "t", delta: "Done looking." },
						{ type: "text-end", id: "t" },
						{ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
					]
				: [
						...calls.map(({ tool, operation, input }) => ({
							type: "tool-call" as const,
							toolCallId: randomUUID(),
							toolName: tool,
							input: JSON.stringify({ operation, input }),
						})),
						{ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
					];
			asked = true;
			return { stream: new ReadableStream({ start: (s) => (parts.forEach((p) => s.enqueue(p)), s.close()) }) };
		},
	};
};
const evry = (model: LanguageModelV4 = scriptedModel()) =>
	harness(c.db, new Date(NOW), null, { model: { status: "qualified", id: "scripted", model } });
const owner = () => evryActor(w.actor);
const actorOf = async (account: { session: Parameters<typeof RequestActor.resolve>[1] }) => {
	const found = await RequestActor.resolve(c.db, account.session);
	assert.ok(found instanceof RequestActor);
	return found;
};
const propose = (operation: string, input: object): Call => ({ tool: "propose_change", operation, input });
const read = (operation: string, input: object): Call => ({ tool: "teams_read", operation, input });
const ask = async (calls: Call[], who = owner()) => evry(calling(calls)).ask(who, "Do what the planter reported.");
const prepared = async (operation: string, input: object, who = owner()) => {
	const got = await ask([propose(operation, input)], who);
	assert.equal(got.proposals.length, 1, got.results);
	return got.proposals[0]!;
};
const approve = (proposal: Proposal, who = owner()) => evry().approveAndRun(who, proposal);
const write = async <V,>(
	op: (tx: WriteTx, ctx: never, input: unknown) => Promise<{ status: "ok"; value: V } | { status: string }>,
	input: unknown,
): Promise<V> =>
	ok(
		(await withTeamsWrite(c.db, w.actor, (tx, ctx) => op(tx, ctx as never, input) as never)) as {
			status: "ok";
			value: V;
		},
	);
const rev = async (table: string, id: string) =>
	(await c.one<{ r: string }>(sql`SELECT revision::text AS r FROM ${sql.identifier(table)} WHERE id=${id}`)).r;
const evidence = async () => ({
	credits:
		await c.rows(sql`SELECT person_id, kind, earned_on::text AS on, verifier_account_id AS by FROM training_credit
		WHERE plant_id=${w.id} ORDER BY recorded_at`),
	required: (
		await c.rows(sql`SELECT person_id FROM training_assignment WHERE program_id=${ids.course} AND state='active'`)
	).map((r) => r.person_id),
	attestations: await c.rows(sql`SELECT person_id, revision FROM attestation WHERE plant_id=${w.id}`),
});
const domainAudits = (audits: string[]) =>
	audits.filter((a) => /^(training|teams|attestation|people|phases?)\./.test(a));
async function nothing<V>(body: () => Promise<V>) {
	const before = await evidence();
	const made = await recorded(c.admin, body);
	assert.deepEqual(await evidence(), before);
	assert.deepEqual([domainAudits(made.added.audits), made.added.notices, made.added.mail], [[], 0, 0]);
	return made.value;
}

before(async () => {
	c = await church("evry_attestation", { clock: new Date(NOW) });
	org = await c.network("Evidence Network");
	w = await c.plant("Evidence Plant", { network: org });
	await c.admin.execute(
		sql`UPDATE affiliation SET share_people=true,share_ministry_teams=true WHERE id=${w.affiliation}`,
	);
	ids.alex = (await c.person(w, "Alex Attested")).id;
	ids.casey = (await c.person(w, "Casey Attested")).id;
	await c.checkIn(w);
	const made = await write(teamsWriter.create, { requestKey: key(), input: { name: "Hospitality" } });
	ids.team = (made as { team: { id: string } }).team.id;
	for (const [name, personId] of [
		["Greeter", ids.alex],
		["Usher", ids.casey],
	]) {
		const role = (await write(teamsWriter.createRole, { requestKey: key(), input: { teamId: ids.team, name } })) as {
			role: { id: string };
		};
		await write(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", role.role.id),
			input: { roleId: role.role.id, teamId: ids.team, personId },
		});
	}
	const course = await write(trainingWriter.createProgram, {
		requestKey: key(),
		input: { name: "Welcome course", required: true, teamId: ids.team },
	});
	ids.course = (course as { program: { id: string } }).program.id;
});
after(() => c?.database.close());

const reported = () => ({ personId: ids.alex, programId: ids.course, earnedOn: "2026-10-01" });

test("AC:SME53-009 Evry changes the required list and records a reported completion only as the exact review a person approved, like the native change", async () => {
	const roster = await nothing(() =>
		prepared("teams.setRequiredTrainingParticipants", { programId: ids.course, personIds: [ids.alex, ids.casey] }),
	);
	assert.deepEqual(roster.review.changes, [
		{ field: "requiredPeople", before: null, after: "Alex Attested, Casey Attested" },
	]);
	const saved = await recorded(c.admin, () => approve(roster));
	assert.deepEqual([saved.value, domainAudits(saved.added.audits)], ["completed", ["training.assigned"]]);
	assert.deepEqual((await evidence()).required.sort(), [ids.alex, ids.casey].sort());
	const completion = await nothing(() => prepared("teams.attestCompletion", reported()));
	assert.deepEqual(
		[completion.review.target?.label, completion.review.changes],
		[
			"Welcome course",
			[
				{ field: "person", before: null, after: "Alex Attested" },
				{ field: "completedOn", before: null, after: "2026-10-01" },
			],
		],
	);
	const done = await recorded(c.admin, () => approve(completion));
	assert.deepEqual([done.value, domainAudits(done.added.audits)], ["completed", ["training.completed"]]);
	assert.deepEqual((await evidence()).credits, [
		{ person_id: ids.alex, kind: "earned", on: "2026-10-01", by: w.owner.id },
	]);
	const native = ok(await trainingReader.readRequiredTrainingParticipants(c.db, w.actor, { programId: ids.course }));
	const got = await ask([read("teams.readRequiredTrainingParticipants", { programId: ids.course })]);
	assert.deepEqual(got.reads, ["teams.readRequiredTrainingParticipants"]);
	for (const p of native.people)
		assert.ok(
			got.results.includes(p.name) && got.results.includes(`"complete":"${p.complete ? "yes" : "no"}"`),
			p.name,
		);
	assert.deepEqual(
		native.people.map((p) => [p.name, p.complete]),
		[
			["Alex Attested", true],
			["Casey Attested", false],
		],
	);
	await write(trainingWriter.revokeCompletion, {
		requestKey: key(),
		expectedRevision: await rev("training_program", ids.course),
		input: { personId: ids.alex, programId: ids.course },
	});
});

test("AC:SME53-009 a review made stale by a native change, a lost seat or a changed review applies nothing", async () => {
	const completion = await prepared("teams.attestCompletion", reported());
	await write(trainingWriter.correctProgram, {
		requestKey: key(),
		expectedRevision: await rev("training_program", ids.course),
		input: { programId: ids.course, name: "Welcome course 2", required: true, reason: "New content" },
	});
	assert.equal(await nothing(() => approve(completion)), "refused");
	assert.equal((await readReview(c.db, owner(), completion.id)).receipt?.code, "revision_conflict");

	const roster = await prepared("teams.setRequiredTrainingParticipants", {
		programId: ids.course,
		personIds: [ids.alex],
	});
	await c.admin.execute(sql`UPDATE person SET revision=revision+1 WHERE id=${ids.alex}`);
	assert.equal(await nothing(() => approve(roster)), "refused");

	const changed = await prepared("teams.attestCompletion", reported());
	await nothing(() =>
		assert.rejects(
			approveProposal(c.db, owner(), changed.id, { revision: changed.revision, digest: "0".repeat(64) }, null),
			(e) => e instanceof EvryRefusal,
		),
	);
	const admin = await c.database.actor(w, "admin");
	const seated = evryActor(await actorOf(admin));
	const theirs = await prepared("teams.attestCompletion", reported(), seated);
	await c.admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${admin.id}`);
	const demoted = evryActor(await actorOf(admin));
	for (const who of [seated, demoted])
		await nothing(async () => {
			const outcome = await approve(theirs, who).catch((e: unknown) => {
				assert.ok(e instanceof EvryRefusal, String(e));
				return "refused";
			});
			assert.equal(outcome, "refused");
		});
	const again = await nothing(() => ask([propose("teams.attestCompletion", reported())], demoted));
	assert.deepEqual(again.proposals, []);
	assert.equal(await approve(changed), "completed", "the planter's own review still applies");
});

test("AC:SME53-009 Evry gives no testimony of its own: a service claim, a group, an unreported date or a candidate statement prepares nothing", async () => {
	const { earnedOn: _, ...undated } = reported();
	const signal = (name: string) => ({ key: name, value: "yes", asOf: "2026-10-13", detail: "I think so" });
	for (const call of [
		propose("teams.attestCompletion", { kind: "service", personId: ids.alex, attendanceDays: 60, volunteerDays: 60 }),
		propose("teams.attestCompletion", { ...reported(), testimony: "I am sure they finished." }),
		propose("teams.attestCompletion", {
			programId: ids.course,
			personIds: [ids.alex, ids.casey],
			earnedOn: "2026-10-01",
		}),
		propose("teams.attestCompletion", undated),
		propose("signals.attest", signal("leadership_candidate")),
		propose("signals.attestCandidate", {
			personId: ids.alex,
			periodStart: "2026-08-14",
			periodEnd: "2026-10-13",
			attended: true,
			volunteered: true,
		}),
	]) {
		const got = await nothing(() => ask([call]));
		assert.deepEqual(got.proposals, [], JSON.stringify(call));
	}
	for (const call of [
		propose("teams.attestCompletion", { ...reported(), personId: ids.casey }),
		propose("signals.attest", signal("values_documented")),
	])
		assert.equal((await ask([call])).proposals.length, 1, call.operation);
});

test("AC:SME53-005 AC:SME53-006 AC:SME53-008 AC:SME53-009 Evry shows no candidate evidence, judges nobody ready and moves no stage or phase by itself", async () => {
	ok(
		await signals.attestCandidate(c.db, w.actor, {
			requestKey: key(),
			expectedRevision: "0",
			input: {
				personId: ids.alex,
				periodStart: "2026-08-14",
				periodEnd: "2026-10-13",
				attended: true,
				volunteered: true,
				statement: "Seen at every gathering.",
			},
		}),
	);
	ok(
		await signals.attest(c.db, w.actor, {
			requestKey: key(),
			expectedRevision: "0",
			input: { key: "systems_tested", value: "yes", detail: "Dry run held." },
		}),
	);
	const history = await ask([{ tool: "signals_read", operation: "signals.getHistory", input: {} }]);
	assert.deepEqual(history.reads, ["signals.getHistory"]);
	assert.ok(history.results.includes("Dry run held.") && history.results.includes("leadership-candidate attestations"));
	for (const word of ["Seen at every gathering", "Alex Attested", ids.alex])
		assert.equal(history.results.includes(word), false);
	const person = await ask([
		read("teams.personTraining", { personId: ids.alex }),
		read("teams.trainingHistory", { personId: ids.alex }),
	]);
	assert.deepEqual(person.reads.sort(), ["teams.personTraining", "teams.trainingHistory"]);
	assert.ok(person.results.includes("Alex Attested"));
	for (const word of ["Seen at every gathering", "candidate", "ready"])
		assert.equal(person.results.includes(word), false, word);

	const state = async () => [
		await c.one(sql`SELECT stage, revision::text AS revision FROM person WHERE id=${ids.alex}`),
		await c.one(sql`SELECT phase FROM plant WHERE id=${w.id}`),
		await c.rows(sql`SELECT id, ended_on FROM team_tenure WHERE person_id=${ids.alex}`),
	];
	const before = await state();
	assert.deepEqual(before[1], { phase: 1 });
	const judged = await nothing(() => evry().ask(owner(), "Do you think Alex Attested is ready to lead a ministry?"));
	assert.deepEqual([judged.reads, judged.answer, judged.proposals], [[], PASTORAL_BOUNDARY, []]);
	const asked = await nothing(() =>
		ask([
			propose("phases.transition", { toPhase: 2, reason: "Alex served 60 days" }),
			propose("people.promoteToLeader", { personId: ids.alex }),
		]),
	);
	assert.deepEqual(
		asked.proposals.map((p) => [p.operation, p.status]),
		[["phases.transition", "pending"]],
		"a phase move waits for a person, and nobody is promoted",
	);
	assert.equal(JSON.stringify(asked.proposals).includes("leadership_candidate"), false);
	assert.deepEqual(await state(), before);
});

test("AC:SME53-009 an organization's Evry reads no person evidence, and the check-in note reaches no Evry prompt or answer", async () => {
	assert.equal((await c.one(sql`SELECT note FROM private_week WHERE author_id=${w.owner.id}`)).note, CARE);
	const director = evryActor(await actorOf(org.director));
	const calls = [
		read("teams.trainingMatrix", {}),
		read("teams.trainingHistory", { personId: ids.alex }),
		{ tool: "signals_read", operation: "signals.getHistory", input: {} },
		{ tool: "intelligence_read", operation: "privateCare.readCurrent", input: {} },
		{ tool: "oversight_read", operation: "oversight.getPlant", input: { plantId: w.id } },
	];
	prompts.splice(0);
	const theirs = await nothing(() => ask(calls, director));
	assert.deepEqual(theirs.reads, ["oversight.getPlant"]);
	assert.ok(theirs.results.includes("Evidence Plant"));
	assert.equal(theirs.results.includes(ids.alex), false);
	for (const word of ["Alex Attested", "Seen at every gathering", "Welcome course", CARE])
		assert.equal(theirs.results.includes(word) || prompts.join("").includes(word), false, word);
	prompts.splice(0);
	const mine = await nothing(() => ask(calls));
	assert.deepEqual(mine.reads.sort(), ["signals.getHistory", "teams.trainingHistory", "teams.trainingMatrix"]);
	assert.ok(mine.results.includes("Alex Attested"));
	assert.ok(prompts.length > 0);
	for (const word of [CARE, "struggling", "private_week"])
		assert.equal(mine.results.includes(word) || prompts.join("").includes(word), false, word);
});
