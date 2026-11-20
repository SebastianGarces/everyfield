import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import {
	allows,
	coverage,
	enters,
	holds,
	invitationMachine as machine,
	refusals,
	skips,
} from "../../../packages/contracts/src/machines/index.ts";
import { owner } from "../../../packages/contracts/src/common/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { pipelineDataWriter } from "../../../packages/domain/src/organizations/data.ts";
import { pipelineWriter, readPipelineBoard } from "../../../packages/domain/src/organizations/pipeline.ts";
import { seeds } from "../../support/fixture.mts";
import { fixture, key } from "./invitations-support.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

let f, seed, associations;
const proofs = new Map();
before(async () => {
	f = await fixture();
	seed = seeds(f.admin);
	associations = createOrganizationAdapter(
		{
			async invitation(tx, v, writes) {
				proofs.set(v.invitationId, v.proof);
				await f.mail.append(
					tx,
					{
						owner: v.owner,
						purpose: "relationship_invitation",
						logicalKey: `relationship/${v.invitationId}/${v.operationId}`,
						recipient: null,
						address: v.recipientEmail,
						content: { subject: v.inviterDescription, text: "A relationship request" },
						operation: v.operationId,
						notice: null,
						eligibleAt: new Date().toISOString(),
					},
					writes,
				);
			},
			invalidate: (_tx, v) =>
				sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${v.sourceId} AND kind='digest' AND state IN ('ready','retry_wait','claimed')`,
		},
		{ candidates: () => sql`SELECT NULL::uuid WHERE false` },
	);
});
after(() => f?.close());

const command = (input, expectedRevision) => ({ requestKey: key(), expectedRevision, input });
const authority = (who) => f.actor(who.session);
const relate = (name, who, input) =>
	gatedTransaction(f.db, async (tx) => {
		if (!(await RequestActor.claimWrite(tx, who.session, who.selected))) throw Error("unavailable");
		return associations[name](tx, who.session, who.selected, input);
	});
async function settle(promise) {
	try {
		const value = await promise;
		return value?.status === "refused" ? { refused: value.refusal?.code ?? value.error?.code } : { ok: value };
	} catch (error) {
		return { refused: error.value?.code ?? error.message };
	}
}

async function stored(id) {
	const r = await f.admin.execute(sql`SELECT id, revision::text AS revision, state FROM invitation WHERE id = ${id}`);
	return r.rows[0];
}
const age = (id, fresh) =>
	f.admin.execute(
		sql`UPDATE invitation SET created_at = clock_timestamp() - ${fresh ? "2 minutes" : "721 hours"}::interval WHERE id = ${id}`,
	);
async function rootRevision(tenant) {
	const table = tenant.kind === "plant" ? sql`plant` : sql`organization`;
	const r = await f.admin.execute(sql`SELECT revision::text AS revision FROM ${table} WHERE id = ${tenant.id}`);
	return r.rows[0].revision;
}
async function pipelinePerson(world) {
	const personId = randomUUID();
	const board = await readPipelineBoard(f.db, await authority(world.sender), {});
	const stageId = board.value.stages[0].id;
	const added = await pipelineWriter.addPerson(f.db, await authority(world.sender), {
		personId,
		displayName: "Synthetic resident",
		email: null,
		responsibleSeatId: null,
		stageId,
	});
	assert.equal(added.status, "ok", JSON.stringify(added));
	return personId;
}

async function relationshipWorld(kind) {
	const church = owner.parse(await seed.organization("sending_church"));
	const subjectTenant = kind === "plant" ? owner.parse(await seed.plant()) : kind === "sending_church" ? church : null;
	const organization = kind === "sending_church" ? owner.parse(await seed.organization("sending_network")) : church;
	const sender = await seed.actor(subjectTenant, "owner");
	const receiver = await seed.actor(organization, "owner");
	if (kind === "discovery") await f.admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${sender.id})`);
	const pair =
		kind === "discovery"
			? { kind, accountId: sender.id, organization }
			: { kind, subject: subjectTenant, organization };
	const sent = await relate("associations.invite", sender, command({ pair, recipientEmail: receiver.email }, "1"));
	return { tenant: subjectTenant, sender, receiver, email: receiver.email, id: sent.invitationId };
}

const worlds = {
	async seat(s) {
		const w = await f.setup(s.tenant === "plant" ? "plant" : "sending_church");
		const i = await f.invitation(w);
		return {
			tenant: w.w,
			sender: w.sender,
			recipient: w.recipient,
			email: w.recipient.email,
			id: i.result.invitation.invitationId,
			proof: i.proof,
		};
	},
	async residency_link() {
		const w = await f.setup("sending_church");
		const world = { tenant: w.w, sender: w.sender, recipient: w.recipient, email: w.recipient.email };
		const person = await pipelinePerson(world);
		const i = await f.invitation(w, person);
		return { ...world, person, id: i.result.invitation.invitationId, proof: i.proof };
	},
	plant_church: () => relationshipWorld("plant"),
	church_network: () => relationshipWorld("sending_church"),
	discovery_church: () => relationshipWorld("discovery"),
};

function fire(world, row, event, to) {
	const at = row.revision,
		invitationId = row.id;
	switch (event) {
		case "seats.invite":
			return rootRevision(world.tenant).then(async (revision) =>
				f.invitations.invite(
					await authority(world.sender),
					command({ workspace: world.tenant, role: "member", recipientEmail: world.email }, revision),
				),
			);
		case "residency.invite":
			return pipelinePerson(world).then(async (personId) =>
				f.invitations.inviteResident(
					await authority(world.sender),
					command(
						{ organization: world.tenant, personId, recipientEmail: world.email },
						await rootRevision(world.tenant),
					),
				),
			);
		case "seats.resendInvitation":
			return authority(world.sender).then((a) => f.invitations.resend(a, command({ invitationId }, at)));
		case "seats.revokeInvitation":
			return authority(world.sender).then((a) => f.invitations.revoke(a, command({ invitationId }, at)));
		case "seats.acceptInvitation":
			return f.invitations.accept(world.recipient.session, command({ invitationId, proof: world.proof }, at));
		case "residency.respondInvitation":
			return f.invitations.respondResident(
				world.recipient.session,
				command(
					to === "declined"
						? { invitationId, proof: world.proof, decision: "decline" }
						: {
								invitationId,
								proof: world.proof,
								decision: "accept",
								choices: { shareFoundations: false, shareMilestones: false },
							},
					at,
				),
			);
		case "pipeline.removePerson":
			return f.admin
				.execute(sql`SELECT revision::text AS revision FROM pipeline_person WHERE person_id = ${world.person}`)
				.then(async (r) =>
					pipelineDataWriter.removePerson(f.db, await authority(world.sender), {
						personId: world.person,
						expectedRevision: r.rows[0].revision,
					}),
				);
		case "associations.resendInvitation":
		case "associations.revokeInvitation":
			return relate(event, world.sender, command({ invitationId }, at));
		case "associations.acceptInvitation":
			return relate(
				event,
				world.receiver,
				command({ invitationId, proof: proofs.get(invitationId), decision: "accept" }, at),
			);
		case "associations.respondInvitation":
			return relate(
				event,
				world.receiver,
				command(
					{ invitationId, proof: proofs.get(invitationId), decision: to === "declined" ? "decline" : "accept" },
					at,
				),
			);
		case "associations.declineInvitation":
			return relate(event, world.receiver, command({ invitationId, decision: "decline" }, at));
	}
	throw Error(`no operation for ${event}`);
}

const variant = (subject, fresh) => ({ ...machine.subjects[subject], fresh });
const allowedAt = (subject, t) =>
	[true, false].find((fresh) => allows(machine, t.event, t.from, t.to, variant(subject, fresh)));

function pathTo(subject, goal) {
	const [entry] = enters(machine, machine.subjects[subject]);
	const routes = new Map([[entry.to, []]]);
	const queue = [entry.to];
	for (let at = queue.shift(); at !== undefined; at = queue.shift())
		for (const t of machine.transitions)
			if (t.from === at && !routes.has(t.to) && allowedAt(subject, t) !== undefined) {
				routes.set(t.to, [...routes.get(at), t]);
				queue.push(t.to);
			}
	const route = routes.get(goal);
	assert.ok(route, `${subject} cannot reach ${goal}`);
	return route;
}

async function invitationIn(subject, state) {
	const sample = machine.subjects[subject];
	const world = await worlds[sample.purpose](sample);
	let row = await stored(world.id);
	assert.equal(row.state, "pending");
	for (const step of pathTo(subject, state)) {
		await age(row.id, allowedAt(subject, step));
		const reply = await settle(fire(world, row, step.event, step.to));
		assert.ok(reply.ok, `${subject} ${step.event} ${step.from} -> ${step.to}: ${JSON.stringify(reply)}`);
		row = await stored(row.id);
		assert.equal(row.state, step.to);
	}
	await age(row.id, sample.fresh);
	return { world, row };
}

test("INV-machine: invitation state follows its declared transitions and refuses every other move", async (t) => {
	const observations = [];
	const observe = (o) => observations.push({ machine: machine.id, ...o });
	const subjects = Object.keys(machine.subjects);

	for (const subject of subjects) {
		const [entry] = enters(machine, machine.subjects[subject]);
		const { row } = await invitationIn(subject, entry.to);
		observe({ kind: "edge", subject, event: entry.event, from: null, to: row.state });
	}

	for (const edge of machine.transitions)
		for (const subject of subjects) {
			if (!allows(machine, edge.event, edge.from, edge.to, machine.subjects[subject])) continue;
			const { world, row: before } = await invitationIn(subject, edge.from);
			const reply = await settle(fire(world, before, edge.event, edge.to));
			assert.ok(reply.ok, `${subject} ${edge.event} ${edge.from} -> ${edge.to}: ${JSON.stringify(reply)}`);
			const after = await stored(before.id);
			assert.equal(after.state, edge.to, `${subject} ${edge.event} ${edge.from} -> ${edge.to}`);
			observe({ kind: "edge", subject, event: edge.event, from: before.state, to: after.state });
		}

	for (const stay of machine.stays)
		for (const state of stay.in)
			for (const subject of subjects) {
				if (!holds(machine, stay.event, state, machine.subjects[subject])) continue;
				const { world, row: before } = await invitationIn(subject, state);
				const reply = await settle(fire(world, before, stay.event, state));
				assert.ok(reply.ok, `${subject} ${stay.event} stays in ${state}: ${JSON.stringify(reply)}`);
				const after = await stored(before.id);
				assert.equal(after.state, state);
				observe({ kind: "stay", subject, event: stay.event, from: before.state, to: after.state });
			}

	for (const r of refusals(machine)) {
		const { world, row: before } = await invitationIn(r.subject, r.from);
		const reply = await settle(fire(world, before, r.event, r.to));
		assert.equal(reply.refused, r.code, `${r.subject} ${r.event} ${r.from} -> ${r.to}: ${JSON.stringify(reply)}`);
		assert.deepEqual(await stored(before.id), before, `${r.subject} ${r.event} ${r.from} -> ${r.to} left the row`);
		observe({ kind: "refusal", subject: r.subject, event: r.event, from: before.state, to: r.to });
	}

	for (const s of skips(machine)) {
		const { world, row: before } = await invitationIn(s.subject, s.from);
		await settle(fire(world, before, s.event, s.to));
		assert.deepEqual(await stored(before.id), before, `${s.subject} ${s.event} left ${s.from} as it was`);
		observe({ kind: "skip", subject: s.subject, event: s.event, from: before.state, to: s.to });
	}

	const report = coverage(machine, observations);
	if (process.env.EVF_MACHINE_COVERAGE)
		appendFileSync(process.env.EVF_MACHINE_COVERAGE, observations.map((o) => `${JSON.stringify(o)}\n`).join(""));
	t.diagnostic(report.line);
	assert.deepEqual(report.missing, []);
});
