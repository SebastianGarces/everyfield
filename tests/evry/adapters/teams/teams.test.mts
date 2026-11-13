// The Ministries adapters end to end (T-320): a read answers from the team roster under the actor's own authority, and
// a reviewed write changes nothing until its exact review is approved, then runs the native teams command once.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	prepareProposal,
	readReview,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../../packages/evry/src/index.ts";
import { invokeRead } from "../../../../packages/evry/src/catalog/invoke.ts";
import { READ_DOMAINS } from "../../../../packages/evry/src/catalog/catalog.ts";
import type { ReadAdapter } from "../../../../packages/evry/src/catalog/types.ts";
import {
	teamsReader,
	teamsWriter,
	trainingWriter,
	withTeamsWrite,
} from "../../../../packages/domain/src/teams/index.ts";
import { transaction } from "../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../apps/web/src/server/jobs/queue.ts";
import { accounts, actor, admin, db, people, plant, setup, sql, teardown } from "../../runtime/support.mts";

before(setup);
after(teardown);

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
const key = () => randomUUID();
const rows = async (query: ReturnType<typeof sql>) => (await admin.execute(query)).rows as Record<string, unknown>[];
const one = async (query: ReturnType<typeof sql>) => (await rows(query))[0]!;
const adapter = (operation: string) =>
	READ_DOMAINS.teams.find((a) => a.operation === operation)! as unknown as ReadAdapter<unknown>;

/** A native teams write as the church's Owner, as the Ministries screens make it. */
async function write<T>(op: (tx: never, c: never, input: unknown) => Promise<unknown>, input: unknown): Promise<T> {
	const owner = await actor("owner");
	const reply = (await withTeamsWrite(db, owner.authority, (tx, c) => op(tx as never, c as never, input) as never)) as {
		status: string;
		value: T;
	};
	assert.equal(reply.status, "ok", JSON.stringify(reply));
	return reply.value;
}
const revision = async (table: string, id: string) =>
	String((await one(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).r);
const team = async (name: string) =>
	(await write<{ team: { id: string } }>(teamsWriter.create as never, { requestKey: key(), input: { name } })).team.id;
const role = async (teamId: string, name: string) =>
	(
		await write<{ role: { id: string } }>(teamsWriter.createRole as never, {
			requestKey: key(),
			input: { teamId, name },
		})
	).role.id;
const assign = async (teamId: string, roleId: string, personId: string) =>
	write(teamsWriter.assignRole as never, {
		requestKey: key(),
		expectedRevision: await revision("team_role", roleId),
		input: { roleId, teamId, personId },
	});

/** A running turn in a new conversation: the only place a proposal can be prepared. */
async function propose(who: EvryActor, operation: string, input: unknown) {
	const c = await createConversation(db, who, { requestKey: key() });
	await submitTurn(db, who, c.id, { requestKey: key(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	const proposal = await prepareProposal(db, who, lease, c.id, { operation, input });
	await transaction(db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	return proposal;
}
/** The trusted approval of the exact revision shown, then the effect run once through the WP-031 queue. */
async function approveAndRun(who: EvryActor, proposal: Proposal) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		noReminders,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return { outcome, review: await readReview(db, who, proposal.id) };
}
const tenures = (personId: string) =>
	rows(sql`SELECT t.name AS team, r.name AS role, tn.ended_on IS NULL AS current, tn.revision::text AS revision
		FROM team_tenure tn JOIN team_role r ON r.id=tn.role_id JOIN team t ON t.id=r.team_id
		WHERE tn.person_id=${personId} ORDER BY t.name, r.name, tn.started_on`);
const seats = async () => Number((await one(sql`SELECT count(*)::int AS n FROM seat`)).n);

let worship: string, hospitality: string, vocals: string, greeter: string, coffee: string;
test("setup: Worship with Alex Rivera on vocals; Hospitality with an open greeter role", async () => {
	worship = await team("Worship");
	hospitality = await team("Hospitality");
	vocals = await role(worship, "Vocals");
	greeter = await role(hospitality, "Greeter");
	coffee = await role(hospitality, "Coffee host");
	await assign(worship, vocals, people.alexRivera!);
});

test("AC:INH-ROLES-05 the review places Casey in the open greeter role and nothing else; approval adds one tenure and no seat", async () => {
	const owner = await actor("owner");
	const proposal = (await propose(owner, "teams.assignRole", { roleId: greeter, personId: people.casey }))!;
	assert.deepEqual(proposal.review.target, { kind: "role", id: greeter, label: "Greeter · Hospitality" });
	assert.deepEqual(proposal.review.changes, [{ field: "filledBy", before: null, after: "Casey Reed" }]);
	assert.deepEqual(await tenures(people.casey!), [], "nothing changes before approval");
	const seatsBefore = await seats();
	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	assert.equal(review.outcome, "completed");
	assert.deepEqual(
		(await tenures(people.casey!)).map((t) => [t.team, t.role, t.current]),
		[["Hospitality", "Greeter", true]],
	);
	assert.equal(await seats(), seatsBefore, "an assignment grants no account or seat");
});

test("AC:INH-TEAMS-06 adding Alex to Hospitality adds one assignment and leaves Worship untouched", async () => {
	const owner = await actor("owner");
	const before = await tenures(people.alexRivera!);
	const proposal = (await propose(owner, "teams.assignMember", {
		teamId: hospitality,
		roleId: coffee,
		personId: people.alexRivera,
	}))!;
	assert.deepEqual(proposal.review.changes, [{ field: "member", before: null, after: "Alex Rivera as Coffee host" }]);
	assert.equal((await approveAndRun(owner, proposal)).outcome, "completed");
	const after = await tenures(people.alexRivera!);
	assert.deepEqual(
		after.filter((t) => t.team === "Worship"),
		before,
		"the Worship tenure is unchanged",
	);
	assert.deepEqual(
		after.map((t) => [t.team, t.role, t.current]),
		[
			["Hospitality", "Coffee host", true],
			["Worship", "Vocals", true],
		],
	);
});

test("AC:INH-TRAINING-05 AC:SME53-009 a reported completion adds one history entry and leaves the required list as it was", async () => {
	const owner = await actor("owner");
	const program = (
		await write<{ program: { id: string } }>(trainingWriter.createProgram as never, {
			requestKey: key(),
			input: { name: "Hospitality training", required: true, teamId: hospitality },
		})
	).program.id;
	await admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
		VALUES(${plant},${program},${people.alexRivera},1,'active','2026-10-01')`);
	const applicability = () =>
		rows(
			sql`SELECT person_id,state,revision::text FROM training_assignment WHERE program_id=${program} ORDER BY person_id`,
		);
	const credits = () =>
		rows(
			sql`SELECT person_id,kind,earned_on::text AS on FROM training_credit WHERE program_id=${program} ORDER BY recorded_at`,
		);
	const required = await applicability();
	const proposal = (await propose(owner, "teams.attestCompletion", {
		personId: people.alexRivera,
		programId: program,
		earnedOn: "2026-10-13",
	}))!;
	assert.deepEqual(proposal.review.target, { kind: "training", id: program, label: "Hospitality training" });
	assert.deepEqual(proposal.review.changes, [
		{ field: "person", before: null, after: "Alex Rivera" },
		{ field: "completedOn", before: null, after: "2026-10-13" },
	]);
	assert.deepEqual(await credits(), [], "nothing is recorded before approval");
	assert.equal((await approveAndRun(owner, proposal)).outcome, "completed");
	assert.deepEqual(await credits(), [{ person_id: people.alexRivera, kind: "earned", on: "2026-10-13" }]);
	assert.deepEqual(await applicability(), required, "the required list is unchanged");
	// A completion is one named person's: the reviewed write takes exactly one person, never a group.
	await assert.rejects(
		propose(owner, "teams.attestCompletion", { personIds: [people.alexRivera, people.casey], programId: program }),
	);
});

test("AC:SME53-009 INV-stale-review: approving after the role or the person changed applies nothing and shows the refusal", async () => {
	const owner = await actor("owner");
	const usher = await role(hospitality, "Usher");
	const proposal = (await propose(owner, "teams.assignRole", { roleId: usher, personId: people.alexChen }))!;
	// The role is renamed after the review was prepared.
	await write(teamsWriter.editRole as never, {
		requestKey: key(),
		expectedRevision: await revision("team_role", usher),
		input: { roleId: usher, name: "Door usher" },
	});
	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "refused");
	assert.deepEqual([review.outcome, review.receipt?.code], ["refused", "revision_conflict"]);
	assert.deepEqual(await tenures(people.alexChen!), [], "nothing was assigned");

	// The person is removed from the church after the review was prepared.
	const parker = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${parker},${plant},${plant},'Parker Lane','other',clock_timestamp(),'attendee','unknown','unknown',500,'live')`);
	const second = (await propose(owner, "teams.assignRole", { roleId: usher, personId: parker }))!;
	await admin.execute(sql`UPDATE person SET state='retired', retired_at=clock_timestamp() WHERE id=${parker}`);
	const run = await approveAndRun(owner, second);
	assert.equal(run.outcome, "refused");
	assert.equal(run.review.receipt?.code, "invalid_subject");
	assert.deepEqual(await tenures(parker), []);
});

test("INV-authority: a Member reads the roster their Ministries screen shows and may not prepare a change", async () => {
	const member = await actor("member");
	const result = await invokeRead(db, member, adapter("teams.get"), { teamId: worship });
	const screen = await teamsReader.listMembers(db, member.authority, { teamId: worship });
	assert.equal(screen.status, "ok");
	const roster = screen.status === "ok" ? screen.value.members.map((m) => m.name) : [];
	assert.deepEqual(
		result.rows.filter((r) => r.kind === "person").map((r) => r.label),
		roster,
		"the same current people as the native read",
	);
	assert.deepEqual(roster, ["Alex Rivera"]);
	// A Member who leads no ministry prepares no ministry change; the Owner's own review of the same ask is prepared.
	assert.equal(
		await propose(member, "teams.assignRole", { roleId: coffee, personId: people.alexChen }).catch(() => null),
		null,
	);
	const other = await actor("foreign");
	assert.equal((await invokeRead(db, other, adapter("teams.get"), { teamId: worship })).status, "not_found");
	assert.ok(accounts.member);
});
