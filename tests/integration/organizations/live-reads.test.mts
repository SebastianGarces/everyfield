import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { eq } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { liveAccess } from "../../../packages/domain/src/access/session.ts";
import {
	namesFor,
	pendingFor,
	residencyLinks,
	subjectFacts,
	targetsFor,
} from "../../../packages/domain/src/organizations/reads.ts";
import { fixture, key } from "../identity/invitations-support.mts";

// C13: every organization read checks the request actor's live access in its own statement. A read made with a
// RequestActor resolved before its seat ended, or before its session ended, returns no tenant data.
let f;
before(async () => {
	f = await fixture();
});
after(async () => {
	await f?.close();
});

const viewerOf = (authority, kind) => ({
	kind,
	session: authority.session,
	accountId: authority.actor.accountId,
	selected: authority.actor.context.owner,
	canManage: true,
	access: liveAccess(authority),
});

/** Each read with the answer it gives a live viewer, and the answer that holds no tenant data. */
async function answers(db, viewer, ids) {
	return {
		namesFor: await namesFor(db, viewer, [ids.subject]),
		pendingFor: (await pendingFor(db, viewer)).map((p) => p.invitationId),
		// The pages ask for targets only for a viewer who can manage, which a resident never is.
		targetsFor: viewer.kind === "account" ? [] : (await targetsFor(db, viewer, new Set())).map((r) => r.name),
		subjectFacts: await subjectFacts(db, viewer),
		residencyLinks: (await residencyLinks(db, viewer)).map((l) => l.linkId),
		residencyRevision: ids.link ? ((await residencyLinks(db, viewer, ids.link))[0]?.linkRevision ?? null) : null,
	};
}

test("C13 organization reads: a plant viewer whose seat ended reads no tenant data", async () => {
	const s = await f.setup(),
		church = await f.workspace("sending_church");
	await f.admin.update(t.plant).set({ timezone: "America/Chicago" }).where(eq(t.plant.id, s.w.id));
	const invitationId = key();
	await f.admin.insert(t.invitation).values({
		id: invitationId,
		tenant_id: s.w.id,
		purpose: "plant_church",
		recipient_email: key() + "@example.test",
		token_hash: key(),
		state: "pending",
		created_at: new Date(),
		revision: "1",
	});
	await f.admin.insert(t.relationship_invitation).values({
		invitation_id: invitationId,
		plant_id: s.w.id,
		organization_id: church.id,
		inviter_description: "Synthetic inviter",
		subject_revision: "1",
	});
	const viewer = viewerOf(await f.actor(s.sender.session), "plant"),
		ids = { subject: s.w.id };

	const live = await answers(f.db, viewer, ids);
	assert.deepEqual(live.namesFor, { [s.w.id]: "Synthetic plant" });
	assert.deepEqual(live.pendingFor, [invitationId]);
	assert.ok(live.targetsFor.includes("Synthetic organization"));
	assert.deepEqual(live.subjectFacts, { revision: "1", zone: "America/Chicago" });

	await f.admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.account_id, s.sender.id));
	assert.deepEqual(await answers(f.db, viewer, ids), {
		namesFor: {},
		pendingFor: [],
		targetsFor: [],
		subjectFacts: { revision: "0", zone: "UTC" },
		residencyLinks: [],
		residencyRevision: null,
	});
});

test("C13 organization reads: a resident whose session ended reads no residency link", async () => {
	const s = await f.setup("sending_church"),
		person = await f.resident(s.w),
		i = await f.invitation(s, person);
	const accepted = await f.invitations.respondResident(s.recipient.session, {
		...i.claim,
		input: { ...i.claim.input, decision: "accept", choices: { shareFoundations: true, shareMilestones: false } },
	});
	const viewer = viewerOf(await f.actor(s.recipient.session), "account"),
		ids = { subject: s.w.id, link: accepted.linkId };

	const live = await answers(f.db, viewer, ids);
	assert.deepEqual(live.namesFor, { [s.w.id]: "Synthetic organization" });
	assert.deepEqual(live.residencyLinks, [accepted.linkId]);
	assert.equal(live.residencyRevision, "1");
	assert.equal(live.subjectFacts.zone, "UTC");
	assert.notEqual(live.subjectFacts.revision, "0");

	await f.admin
		.update(t.auth_session)
		.set({ expires_at: new Date(0) })
		.where(eq(t.auth_session.id, s.recipient.session));
	const ended = await answers(f.db, viewer, ids);
	assert.deepEqual(ended.namesFor, {});
	assert.deepEqual(ended.residencyLinks, []);
	assert.equal(ended.residencyRevision, null);
	assert.deepEqual(ended.subjectFacts, { revision: "0", zone: "UTC" });
});
