import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	cancelProposal,
	createConversation,
	executeProposal,
	readConversation,
	readReview,
	retryUnresolvedEffects,
	reviseProposal,
	submitTurn,
} from "../../../packages/evry/src/index.ts";
import {
	allows,
	coverage,
	holds,
	proposalMachine as machine,
	reachable,
	refusals,
} from "../../../packages/contracts/src/machines/index.ts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../apps/web/src/server/jobs/queue.ts";
import { accounts, actor, admin, db, organization, people, setup, sql, teardown, work } from "../runtime/support.mts";

const APPROVE = "evry.approveProposal";
const EXECUTE = "evry.executeProposal";
const stages = { Prospect: randomUUID(), Core: randomUUID() };
const jordan = randomUUID();
const pipelinePerson = randomUUID();
let city = 0;

before(async () => {
	await setup();
	for (const [label, id] of Object.entries(stages))
		await admin.execute(
			sql`INSERT INTO pipeline_stage(id,organization_id,stable_kind,label,position,revision) VALUES(${id},${organization},'other',${label},${label === "Prospect" ? 0 : 1},1)`,
		);
	await admin.execute(sql`INSERT INTO person(id,tenant_id,organization_id,display_name,source,created_at,state)
		VALUES(${jordan},${organization},${organization},'Jordan Pike','other',clock_timestamp(),'live')`);
	await admin.execute(sql`INSERT INTO pipeline_person(id,organization_id,person_id,stage_id,responsible_seat_id,revision)
		SELECT ${pipelinePerson},${organization},${jordan},${stages.Prospect},s.id,1 FROM seat s
		WHERE s.account_id=${accounts.orgOwner.id} AND s.organization_id=${organization}`);
});
after(teardown);

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
const lease = (claim) => ({
	jobId: claim.id,
	tenantId: claim.tenant_id,
	leaseOwner: claim.lease_owner,
	generation: claim.claim_generation,
});
const keyOf = (row) => [row.state, row.outcome].filter(Boolean).join("_");

async function stored(id) {
	const r = await admin.execute(
		sql`SELECT state,outcome,revision::text AS revision,updated_at::text AS updated_at,job_id FROM proposal WHERE id=${id}`,
	);
	return r.rows[0];
}

async function stageOf() {
	const r = await admin.execute(sql`SELECT stage_id FROM pipeline_person WHERE id=${pipelinePerson}`);
	return r.rows[0].stage_id;
}

async function propose(subject) {
	const who = await actor(subject === "now" ? "orgOwner" : "owner");
	const current = subject === "now" ? await stageOf() : null;
	const target = current === stages.Prospect ? "Core" : "Prospect";
	const text = subject === "now" ? `Move Jordan Pike to ${target}` : `Change Casey's city to Walk ${++city}`;
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text });
	assert.equal(await work(), "succeeded");
	const page = await readConversation(db, who, c.id);
	const card = page.events.find((e) => e.kind === "tool_result" && e.body.operation === "evry.prepareProposal");
	assert.ok(card, `${subject}: no review card for "${text}"`);
	const id = card.body.result.proposalId;
	const input =
		subject === "now"
			? { operation: "pipeline.proposeStageMove", input: { personId: jordan, stageId: stages[target] } }
			: { operation: "people.updatePerson", input: { personId: people.casey, patch: { city: `Walk ${city}` } } };
	return { id, who, subject, input, claim: null };
}

const witness = async (p) => {
	const r = await readReview(db, p.who, p.id);
	return { revision: r.revision, digest: r.digest, ...(p.subject === "now" ? { reason: "Model-based walk" } : {}) };
};

async function claimFor(p) {
	const { job_id } = await stored(p.id);
	await admin.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()+interval '1 day' WHERE kind='evry_effect' AND state='ready' AND id<>${job_id}`,
	);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 120);
	assert.equal(
		claim?.id,
		job_id,
		`${p.subject} ${JSON.stringify(await stored(p.id))}: the walk claims its own effect job`,
	);
	p.claim = claim;
}

async function approveFailingMove(p) {
	await admin.execute(
		sql.raw(
			`CREATE FUNCTION sm3_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic'; END$$`,
		),
	);
	await admin.execute(
		sql.raw(
			`CREATE TRIGGER sm3_fail BEFORE INSERT OR UPDATE ON pipeline_person FOR EACH ROW EXECUTE FUNCTION sm3_fail()`,
		),
	);
	try {
		await assert.rejects(approveProposal(db, p.who, p.id, await witness(p), null), (error) => {
			assert.equal(error.cause?.message, "synthetic");
			return true;
		});
	} finally {
		await admin.execute(sql.raw(`DROP TRIGGER sm3_fail ON pipeline_person; DROP FUNCTION sm3_fail()`));
	}
}

const outcomeOf = (promise) =>
	promise.then(
		(value) => ({ value }),
		(error) => {
			if (typeof error?.code !== "string") throw error;
			return { code: error.code };
		},
	);

function fire(p, event) {
	switch (event) {
		case "evry.reviseProposal":
			return outcomeOf(
				readReview(db, p.who, p.id).then((r) => reviseProposal(db, p.who, p.id, { ...p.input, revision: r.revision })),
			);
		case APPROVE:
			return outcomeOf(witness(p).then((w) => approveProposal(db, p.who, p.id, w, null)));
		case "evry.cancelProposal":
			return outcomeOf(cancelProposal(db, p.who, p.id));
		case "evry.retryUnresolvedEffects":
			return outcomeOf(retryUnresolvedEffects(db, p.who, p.id));
		case EXECUTE:
			return executeProposal(db, lease(p.claim), noReminders).then((outcome) => ({ value: outcome }));
	}
	throw Error(`no public operation for ${event}`);
}

const lapse = (p) =>
	admin.execute(sql`UPDATE proposal SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${p.id}`);
const markFailed = (p) => admin.execute(sql`UPDATE proposal SET outcome='failed' WHERE id=${p.id}`);
const staleEffect = async (p) => {
	await admin.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '61 seconds' WHERE id=(SELECT job_id FROM proposal WHERE id=${p.id})`,
	);
};
const stalePerson = () => admin.execute(sql`UPDATE person SET revision=revision+1 WHERE id=${people.casey}`);
const staleMove = () => admin.execute(sql`UPDATE pipeline_person SET revision=revision+1 WHERE id=${pipelinePerson}`);

async function expect(p, event, value) {
	const r = await fire(p, event);
	assert.ok(!("code" in r), `${p.subject} ${event} answered ${r.code}`);
	if (value !== undefined) assert.equal(r.value, value);
	return r.value;
}

async function reach(subject, state, { claimed = false } = {}) {
	const p = await propose(subject);
	const approve = () => expect(p, APPROVE);
	const queued = subject === "queued";
	switch (state) {
		case "pending":
			if (claimed) {
				await approve();
				await claimFor(p);
				await expect(p, "evry.reviseProposal");
			}
			break;
		case "approved":
			if (queued) {
				await approve();
				if (claimed) await claimFor(p);
			} else await approveFailingMove(p);
			break;
		case "approved_completed":
			await approve();
			if (queued) {
				await claimFor(p);
				await expect(p, EXECUTE, "completed");
			}
			break;
		case "approved_refused":
			if (queued) {
				await approve();
				await claimFor(p);
				await stalePerson();
				await expect(p, EXECUTE, "refused");
			} else {
				await staleMove();
				await approve();
			}
			break;
		case "approved_failed":
			return reach(subject, "approved", { claimed }).then(async (q) => {
				await markFailed(q);
				return q;
			});
		case "cancelled":
			if (claimed) {
				await approve();
				await claimFor(p);
			}
			await expect(p, "evry.cancelProposal");
			break;
		case "expired":
			await approve();
			await claimFor(p);
			await lapse(p);
			await expect(p, EXECUTE, "expired");
			break;
		default:
			throw Error(`no route to ${state}`);
	}
	assert.equal(keyOf(await stored(p.id)), state, `${subject} reached ${state}`);
	return p;
}

async function done(p) {
	if (p.claim) await transaction(db, (tx) => finishClaim(tx, p.claim, { state: "succeeded" }));
}

const withFacts = (sample, rule) => {
	const facts = { ...sample };
	for (const g of [rule.when ?? []].flat()) if (machine.facts.includes(g)) facts[g] = true;
	for (const g of [rule.unless ?? []].flat()) if (machine.facts.includes(g)) facts[g] = false;
	return facts;
};

test("INV-machine: an Evry proposal's state and outcome follow their declared transitions and refuse every other move", async (t) => {
	const observations = [];
	const observe = (o) => observations.push({ machine: machine.id, ...o });
	const subjects = Object.keys(machine.subjects);

	for (const subject of subjects) {
		const p = await propose(subject);
		observe({ kind: "edge", subject, event: machine.entries[0].event, from: null, to: keyOf(await stored(p.id)) });
	}

	for (const edge of machine.transitions)
		for (const subject of subjects) {
			const facts = withFacts(machine.subjects[subject], edge);
			if (!reachable(machine, machine.subjects[subject]).includes(edge.from)) continue;
			if (!allows(machine, edge.event, edge.from, edge.to, facts)) continue;
			const label = `${subject} ${edge.event} ${edge.from} -> ${edge.to}`;
			if (edge.event === APPROVE && edge.from === "approved") {
				const p = await reach(subject, "pending");
				if (edge.to === "approved_refused") await staleMove();
				await expect(p, APPROVE);
				assert.equal(keyOf(await stored(p.id)), edge.to, label);
				observe({ kind: "edge", subject, event: APPROVE, from: "pending", to: "approved" });
				observe({ kind: "edge", subject, event: APPROVE, from: "approved", to: edge.to });
				continue;
			}
			const p = await reach(subject, edge.from, { claimed: edge.event === EXECUTE });
			if (facts.lapsed) await lapse(p);
			if (edge.event === "evry.retryUnresolvedEffects" && edge.from === "approved") await staleEffect(p);
			if (edge.event === EXECUTE && edge.to === "approved_refused") await stalePerson();
			if (subject === "now" && edge.event === APPROVE) await approveFailingMove(p);
			else await expect(p, edge.event);
			assert.equal(keyOf(await stored(p.id)), edge.to, label);
			observe({ kind: "edge", subject, event: edge.event, from: edge.from, to: edge.to });
			await done(p);
		}

	for (const stay of machine.stays)
		for (const state of stay.in)
			for (const subject of subjects) {
				const facts = withFacts(machine.subjects[subject], stay);
				if (!reachable(machine, machine.subjects[subject]).includes(state)) continue;
				if (!holds(machine, stay.event, state, facts)) continue;
				const p = await reach(subject, state);
				const before = await stored(p.id);
				const answer = await expect(p, stay.event);
				if (stay.event === APPROVE) assert.equal(answer.replayed, true);
				if (stay.event === "evry.cancelProposal") assert.equal(answer.cancelled, false);
				if (stay.event === "evry.retryUnresolvedEffects") assert.equal(answer.retried, false);
				assert.deepEqual(await stored(p.id), before, `${subject} ${stay.event} in ${state} wrote nothing`);
				observe({ kind: "stay", subject, event: stay.event, from: state, to: state });
				await done(p);
			}

	for (const r of refusals(machine)) {
		const p = await reach(r.subject, r.from, { claimed: r.event === EXECUTE });
		const before = await stored(p.id);
		const answer = await fire(p, r.event);
		assert.equal(r.event === EXECUTE ? answer.value : answer.code, r.code, `${r.subject} ${r.event} from ${r.from}`);
		assert.deepEqual(await stored(p.id), before, `${r.subject} ${r.event} from ${r.from} left the row unchanged`);
		observe({ kind: "refusal", subject: r.subject, event: r.event, from: r.from, to: r.to });
		await done(p);
	}

	const report = coverage(machine, observations);
	if (process.env.EVF_MACHINE_COVERAGE)
		appendFileSync(process.env.EVF_MACHINE_COVERAGE, observations.map((o) => `${JSON.stringify(o)}\n`).join(""));
	t.diagnostic(report.line);
	assert.deepEqual(report.missing, []);
});
